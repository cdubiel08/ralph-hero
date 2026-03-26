---
date: 2026-03-25
status: complete
type: plan
tags: [ralph-knowledge, bug-fix, esm-cjs, schema-migration, reindex]
github_issue: 682
github_issues: [682]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/682
primary_issue: 682
---

# ralph-knowledge Three Bug Fix Plan

## Prior Work

- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]

## Overview

Fix three ralph-knowledge bugs discovered during research:
1. **P0 — CJS/ESM interop crash** blocking all remote MCP server startup
2. **P1 — Missing schema migration** for `is_stub` column on existing databases
3. **P2 — Incomplete stub creation** during incremental reindex

## Current State Analysis

### Bug 1: CJS/ESM crash (P0)
`graph-builder.ts:1` uses `import { MultiDirectedGraph } from "graphology"`. The `graphology` package is CJS-only and exposes only `default` to Node's ESM loader. Since `index.ts` → `graph-tools.ts` → `graph-builder.ts` forms the import chain, the entire MCP server crashes at module load time. This was introduced in `f1bbe25` (v0.1.15).

Vitest masks this because it has its own CJS/ESM interop layer. The bug only manifests when running compiled `dist/` output under Node's native ESM loader (i.e., every remote user via `npx`).

### Bug 2: Schema migration gap (P1)
`db.ts:102-114` uses `CREATE TABLE IF NOT EXISTS documents(... is_stub INTEGER DEFAULT 0)`. For users with a DB created before `is_stub` was added, this is a no-op — the table exists, so the column is never added. Any code referencing `is_stub` then fails:
- `upsertStubDocument()` at `db.ts:175-179`
- `upsertDocument()` at `db.ts:162-168`
- `getDocument()` at `db.ts:182-185`
- `graph-builder.ts:29` (`WHERE is_stub = 0 OR is_stub IS NULL`)

### Bug 3: Stub creation timing (P2)
`reindex.ts:126` builds `knownIds` from only the current batch (`parsedDocs`), which excludes files skipped at line 57-59 (unchanged since last index). The stub-creation loop at lines 139-146 therefore:
- Misses targets referenced by skipped files' edges (those stubs were presumably created in a prior run, but if the DB was rebuilt without them, they'd be lost)
- More importantly, `knownIds` doesn't include documents already in the DB from prior runs, so the stub check at line 142 (`!knownIds.has(targetId)`) over-creates stubs for targets that are real documents from previous indexing

The `INSERT OR IGNORE` at `db.ts:177` prevents overwriting real documents, so this is a correctness/efficiency issue rather than data corruption.

## Desired End State

1. MCP server starts successfully for remote users via `npx ralph-hero-knowledge-index@*`
2. Existing databases transparently gain the `is_stub` column on next server start
3. Stub creation during incremental reindex correctly identifies which targets need stubs by checking the database, not just the current batch

### Verification:
- `node dist/index.js` loads without error (no CJS/ESM crash)
- Opening a pre-`is_stub` database works without "no column named is_stub" errors
- Incremental reindex with skipped files creates stubs only for truly missing targets

## What We're NOT Doing

- Enabling `PRAGMA foreign_keys = ON` — the FK declarations are documentation-only today and enabling them would require reordering the entire indexing pipeline
- Changing the reindex architecture (e.g., two-pass relationship insertion)
- Adding a formal migration framework — a single `ALTER TABLE` suffices for now

## Implementation Approach

All three fixes are small, independent, and testable. They can ship in a single release.

## Phase 1: Fix CJS/ESM Interop Crash

### Overview
Change `graph-builder.ts` to use a default import for `graphology`, matching the pattern already used in `graph-tools.ts` for other CJS graphology packages.

### Changes Required:

#### 1. `plugin/ralph-knowledge/src/graph-builder.ts`
**Lines**: 1, 15, 25
**Changes**: Switch from named import to default import with destructuring.

Replace line 1:
```typescript
import { MultiDirectedGraph } from "graphology";
```

With:
```typescript
import graphology from "graphology";
const { MultiDirectedGraph } = graphology;
```

Line 15 (`export type KnowledgeGraph = ...`) and line 25 (`new MultiDirectedGraph<...>()`) remain unchanged — they reference the destructured class.

### Success Criteria:

#### Automated Verification:
- [x]`npm run build` succeeds (TypeScript compiles)
- [x]`npm test` passes
- [x]`node -e "import('./dist/graph-builder.js').then(() => console.log('OK')).catch(e => console.error('FAIL:', e.message))"` prints `OK`
- [x]`node -e "import('./dist/index.js').then(() => console.log('OK')).catch(e => console.error('FAIL:', e.message))"` prints `OK` (full server module loads)

---

## Phase 2: Add Schema Migration for `is_stub` Column

### Overview
Add an `ALTER TABLE` migration after `CREATE TABLE IF NOT EXISTS` so existing databases transparently gain the `is_stub` column.

### Changes Required:

#### 1. `plugin/ralph-knowledge/src/db.ts`
**Method**: `createSchema()` (line 102)
**Changes**: After the existing `CREATE TABLE IF NOT EXISTS` block (after the closing `);` at line 158), add a migration that attempts to add the column and silently ignores the error if it already exists.

Add after line 158 (after the closing of `this.db.exec(...)`):
```typescript
    // Migration: add is_stub column for databases created before it existed.
    // SQLite has no IF NOT EXISTS for ALTER TABLE ADD COLUMN, so we catch the
    // "duplicate column" error and ignore it.
    try {
      this.db.exec("ALTER TABLE documents ADD COLUMN is_stub INTEGER DEFAULT 0");
    } catch {
      // Column already exists — expected for new databases
    }
```

### Success Criteria:

#### Automated Verification:
- [x]`npm run build` succeeds
- [x]`npm test` passes
- [x]New test: create a DB with the old schema (no `is_stub`), construct `KnowledgeDB`, verify `is_stub` column exists and `upsertStubDocument()` works
- [x]New test: create a DB with the current schema (has `is_stub`), construct `KnowledgeDB`, verify no error (idempotent)

---

## Phase 3: Fix Stub Creation for Incremental Reindex

### Overview
Replace the in-memory `knownIds` check with a database query so stub creation correctly accounts for all documents, not just the current batch.

### Changes Required:

#### 1. `plugin/ralph-knowledge/src/db.ts`
**Changes**: Add a method to check document existence.

```typescript
  documentExists(id: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM documents WHERE id = ?").get(id);
    return row !== undefined;
  }
```

#### 2. `plugin/ralph-knowledge/src/reindex.ts`
**Lines**: 125-147
**Changes**: Replace the `knownIds` set with `db.documentExists()` checks. Also collect targets from ALL documents in the DB (not just `parsedDocs`) to cover skipped files.

Replace lines 125-147:
```typescript
  // Collect all known document IDs from the indexing pass
  const knownIds = new Set(parsedDocs.map(p => p.id));

  // Collect all target IDs referenced by both typed and untyped edges
  const allTargetIds = new Set<string>();
  for (const parsed of parsedDocs) {
    for (const rel of parsed.relationships) {
      allTargetIds.add(rel.targetId);
    }
    for (const edge of parsed.untypedEdges) {
      allTargetIds.add(edge.targetId);
    }
  }

  // Create stub documents for unresolved wikilink targets
  let stubCount = 0;
  for (const targetId of allTargetIds) {
    if (!knownIds.has(targetId)) {
      db.upsertStubDocument(targetId);
      stubCount++;
    }
  }
  console.log(`  Created ${stubCount} stub documents for unresolved links`);
```

With:
```typescript
  // Collect all relationship targets from the database (covers both current batch and prior runs)
  const allTargetIds = new Set<string>(
    (db.db.prepare("SELECT DISTINCT target_id FROM relationships").all() as Array<{ target_id: string }>)
      .map(r => r.target_id)
  );

  // Create stub documents for targets that don't exist as real documents
  let stubCount = 0;
  for (const targetId of allTargetIds) {
    if (!db.documentExists(targetId)) {
      db.upsertStubDocument(targetId);
      stubCount++;
    }
  }
  console.log(`  Created ${stubCount} stub documents for unresolved links`);
```

This is correct because:
- It queries the `relationships` table for ALL targets, not just the current batch
- `documentExists()` checks the actual database, which includes documents from prior runs
- `upsertStubDocument` uses `INSERT OR IGNORE`, so it won't overwrite real documents even in race conditions

### Success Criteria:

#### Automated Verification:
- [x]`npm run build` succeeds
- [x]`npm test` passes
- [x]New test: index file A (references B), then incrementally index file C (A skipped) — verify B still has a stub
- [x]New test: index files A and B (A references B) — verify no stub created for B since it's a real document

---

## Testing Strategy

### Unit Tests (`db.test.ts`):
- Schema migration: old DB gains `is_stub` column
- Schema migration: idempotent on new DB
- `documentExists()` returns true/false correctly

### Integration Tests (`reindex.test.ts`):
- Incremental reindex creates stubs only for truly missing targets
- Full reindex with mixed real/stub documents

### Manual Verification:
- `node dist/index.js` starts without error in a clean npm install
- Existing `~/.ralph-hero/knowledge.db` works after upgrade without manual rebuild

## References

- CJS/ESM interop pattern: `graph-tools.ts:4` (louvain default import)
- `graphology` ESM exports: only `default` (verified via `node -e "import('graphology').then(m => console.log(Object.keys(m)))"`)
- Introduced in: `f1bbe25` feat: ralph-knowledge graph intelligence enhancements (#675)
