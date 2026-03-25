---
date: 2026-03-24
status: draft
type: plan
github_issue: 665
github_issues: [665]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/665
primary_issue: 665
tags: [ralph-knowledge, sqlite, incremental-indexing, performance, embeddings]
---

# Incremental Indexing with mtime Tracking - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-24-GH-0665-incremental-indexing-mtime]]
- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-665 | Incremental indexing with mtime tracking | S |

## Shared Constraints

- All new code lives in `plugin/ralph-knowledge/src/` — no changes to the MCP server or other plugins
- ESM module system: all internal imports use `.js` extensions
- The `sync` table must NOT be cleared by `clearAll()` unless explicitly extending it — but per research, `clearAll()` MUST also clear `sync` so a forced full rebuild starts clean
- `outcome_events` table must never be touched by `clearAll()` or any new deletion logic
- The FTS rebuild (`fts.rebuildIndex()`) must remain a full rebuild on every `reindex()` call — SQLite FTS5 content tables do not support partial sync
- `Math.trunc(mtime)` must be used consistently when storing and comparing mtime values to avoid floating-point edge cases
- The `embed()` function must be mockable via `vi.mock()` in tests — never call the real transformer model in unit/integration tests
- `deleteDocument(id)` relies on existing `ON DELETE CASCADE` on `tags` and `relationships` — no manual cascade needed
- `deleteEmbedding(id)` must call `ensureVecLoaded()` before operating on `documents_vec`

## Current State Analysis

`reindex()` in `src/reindex.ts` always calls `db.clearAll()` then re-embeds every markdown file unconditionally. For ~200 documents, this takes several seconds due to transformer model inference. The embedding step (`embed()` via `Xenova/all-MiniLM-L6-v2`) is the bottleneck — identical documents produce identical embeddings, making the work wasted.

Key existing patterns:
- `KnowledgeDB.clearAll()` (line 341-344) deletes documents, tags, and relationships but intentionally preserves `outcome_events`
- `VectorSearch.upsertEmbedding()` (lines 39-47) already does `DELETE + INSERT` per document — safe for targeted updates
- `vec.dropIndex()` + `vec.createIndex()` is a full virtual table destruction cycle; incremental approach keeps the table intact
- `findMarkdownFiles()` returns absolute paths; `statSync(path).mtimeMs` gives mtime in milliseconds as a float

## Desired End State

### Verification
- [x] `reindex()` skips embedding for files whose mtime is unchanged since last run
- [x] `reindex()` re-embeds files whose mtime has changed
- [x] `reindex()` embeds and indexes new files not previously seen
- [x] `reindex()` removes stale entries for files deleted from disk
- [x] `clearAll()` now also clears the `sync` table, ensuring a forced rebuild starts clean
- [x] FTS index is still rebuilt from scratch on every `reindex()` call
- [x] All 5 acceptance scenarios have passing unit/integration tests

## What We're NOT Doing

- Not switching to hash-based change detection (mtime is O(1) stat, hashing is O(file-size))
- Not partially updating the FTS index — full rebuild remains required per SQLite FTS5 constraints
- Not adding a `--force` CLI flag to `reindex()` — the current `clearAll()` path is the forced rebuild and remains accessible via direct code if needed
- Not changing the `reindex()` function signature — incremental behavior is the new default
- Not touching `outcome_events` in any deletion path

## Implementation Approach

Three code changes build on each other:

1. **`db.ts`**: Add `sync` table to schema, add 4 new sync CRUD methods, add `deleteDocument()`, extend `clearAll()` — this is the data layer foundation.
2. **`vector-search.ts`**: Add `deleteEmbedding()` — needed by the stale-file cleanup in `reindex()`.
3. **`reindex.ts`**: Replace full-rebuild loop with incremental mtime-based logic — consumes the new DB and vector methods.
4. **Tests**: `db.test.ts` gets sync table CRUD tests; `reindex.test.ts` gets 5-scenario integration tests with mocked `embed`.

---

## Phase 1: GH-665 — Incremental Indexing with mtime Tracking

### Overview

Add a `sync` table to track per-file mtime, add supporting methods to `KnowledgeDB` and `VectorSearch`, then rewrite `reindex()` to skip unchanged files. Tests cover all 5 acceptance scenarios.

### Tasks

#### Task 1.1: Add sync table and methods to KnowledgeDB
- **files**: `plugin/ralph-knowledge/src/db.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] `createSchema()` creates `sync` table with `(path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, indexed_at INTEGER NOT NULL)` — verified by inserting a sync record immediately after constructing a `:memory:` KnowledgeDB
  - [x] `getSyncRecord(path)` returns `{ path, mtime, indexed_at }` when record exists, `undefined` when absent
  - [x] `upsertSyncRecord(path, mtime)` inserts on first call and updates `mtime` + `indexed_at` on second call for same path; `indexed_at` is set to `Date.now()` (integer milliseconds)
  - [x] `deleteSyncRecord(path)` removes the record; subsequent `getSyncRecord` returns `undefined`
  - [x] `getAllSyncPaths()` returns all stored paths as `string[]`; returns `[]` when table is empty
  - [x] `deleteDocument(id)` deletes the document row; `tags` and `relationships` rows for that `doc_id` are also gone (CASCADE verified by inserting tags before deleting)
  - [x] Updated `clearAll()` also executes `DELETE FROM sync`; after `clearAll()`, `getAllSyncPaths()` returns `[]`
  - [x] `outcome_events` rows are NOT deleted by `clearAll()` — existing test `clearAll preserves outcome events` still passes

#### Task 1.2: Add deleteEmbedding to VectorSearch
- **files**: `plugin/ralph-knowledge/src/vector-search.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] `deleteEmbedding(id: string): void` method exists on `VectorSearch`
  - [x] Method calls `this.ensureVecLoaded()` before operating on `documents_vec`
  - [x] After `upsertEmbedding(id, vec)` followed by `deleteEmbedding(id)`, a `SELECT` on `documents_vec WHERE id = ?` returns no rows (tested with a real sqlite-vec in-memory DB)
  - [x] Calling `deleteEmbedding` for a non-existent id does not throw

#### Task 1.3: Rewrite reindex() with incremental mtime logic
- **files**: `plugin/ralph-knowledge/src/reindex.ts` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [x] `db.clearAll()` is NOT called at the start of `reindex()` — the index is preserved between runs
  - [x] `vec.dropIndex()` + `vec.createIndex()` are NOT called at the start — documents_vec virtual table is preserved
  - [x] Phase 1 (delete stale): for each path in `db.getAllSyncPaths()` that is absent from `filesOnDisk`, `db.deleteDocument()`, `vec.deleteEmbedding()`, and `db.deleteSyncRecord()` are each called once for that path
  - [x] Phase 2 (process changed/new): for each file in `filesOnDisk`, `statSync(filePath).mtimeMs` is retrieved; if `db.getSyncRecord(filePath)?.mtime === Math.trunc(mtime)`, the file is skipped (no embed call, no upsert calls); otherwise parse, embed, and upsert proceed as before, followed by `db.upsertSyncRecord(filePath, Math.trunc(mtime))`
  - [x] Phase 3 (FTS): `fts.rebuildIndex()` is still called once per `reindex()` run, after all document changes
  - [x] `statSync` is imported from `node:fs` alongside the existing `readFileSync` import
  - [x] Progress logging still reports `N/total indexed` for processed (non-skipped) files; optionally logs skipped count

#### Task 1.4: Add sync table CRUD tests to db.test.ts
- **files**: `plugin/ralph-knowledge/src/__tests__/db.test.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [x] New `describe("Sync Table")` block with tests covering: insert + getSyncRecord, update mtime via upsert, getAllSyncPaths returns all paths, deleteSyncRecord removes entry, clearAll clears sync table, clearAll still preserves outcome_events
  - [x] All existing tests in `db.test.ts` continue to pass
  - [x] `npx vitest run src/__tests__/db.test.ts` exits 0

#### Task 1.5: Add incremental reindex integration tests to reindex.test.ts
- **files**: `plugin/ralph-knowledge/src/__tests__/reindex.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.3]
- **acceptance**:
  - [x] `embed` from `../embedder.js` is mocked via `vi.mock("../embedder.js", ...)` returning a deterministic `Float32Array(384)` — no transformer model loaded
  - [x] Test scenario 1: unchanged file — after two consecutive `reindex()` calls on the same directory, `embed` is called exactly `N` times total (once per file on first run, zero additional times on second run for unchanged files)
  - [x] Test scenario 2: modified file — after first `reindex()`, a file's content is updated and its mtime bumped via `utimesSync`; second `reindex()` calls `embed` exactly once more for that file
  - [x] Test scenario 3: new file — after first `reindex()`, a new `.md` file is written; second `reindex()` calls `embed` once for the new file only
  - [x] Test scenario 4: deleted file — after first `reindex()`, a file is unlinked; second `reindex()` results in that file's `id` being absent from `db.getDocument()` and `getAllSyncPaths()`
  - [x] Test scenario 5: forced rebuild — calling `db.clearAll()` followed by `reindex()` re-embeds all files (embed call count equals file count again)
  - [x] All existing `findMarkdownFiles` tests continue to pass
  - [x] `npx vitest run src/__tests__/reindex.test.ts` exits 0

### Phase Success Criteria

#### Automated Verification:
- [x] `npm run build` — no TypeScript errors (`tsc` exits 0)
- [x] `npm test` — all tests passing (vitest run exits 0)

#### Manual Verification:
- [ ] Run `npm run reindex` against the local `thoughts/` directory twice in succession; second run logs `0 documents indexed` (all skipped) and completes noticeably faster than the first
- [ ] Modify one file, run `reindex` again; only that file is re-embedded (log shows `1/N indexed`)

**Creates for next phase**: No next phase — this is a standalone single-issue plan.

---

## Integration Testing

- [x] Full `npm test` suite passes with no regressions in `db.test.ts`, `reindex.test.ts`, and all other test files
- [x] TypeScript strict compilation via `npm run build` reports zero errors

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-24-GH-0665-incremental-indexing-mtime.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/665
- Related: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-24-knowledge-graph-plugin-comparison.md
