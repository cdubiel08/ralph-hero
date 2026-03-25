---
date: 2026-03-24
github_issue: 665
github_url: https://github.com/cdubiel08/ralph-hero/issues/665
status: complete
type: research
tags: [ralph-knowledge, sqlite, incremental-indexing, performance, embeddings]
---

# Research: Incremental Indexing with mtime Tracking (GH-665)

## Prior Work

- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]

## Problem Statement

`reindex()` in `plugin/ralph-knowledge/src/reindex.ts` unconditionally calls `db.clearAll()` then re-embeds every markdown file on every run. Embedding via `Xenova/all-MiniLM-L6-v2` is the expensive step — it runs inference through a transformer model for each document. With ~200 documents this takes seconds, but identical documents produce identical embeddings: the work is wasted. As the corpus grows (toward thousands of documents), this will become a bottleneck.

The fix is a `sync` table that records `(path, mtime, indexed_at)`. On reindex, skip files whose mtime matches the stored value. Only parse, embed, and upsert changed or new files. Delete index entries for files that no longer exist on disk.

## Current State Analysis

### `reindex()` flow (`src/reindex.ts:12-99`)

```
reindex(dirs, dbPath)
  db.clearAll()              // DELETE documents, tags, relationships
  vec.dropIndex()            // DROP TABLE documents_vec
  vec.createIndex()          // RECREATE documents_vec virtual table
  for each file:
    parseDocument()
    db.upsertDocument()
    db.setTags()
    db.addRelationship()
    embed(text)              // EXPENSIVE: transformer inference
    vec.upsertEmbedding()
  fts.rebuildIndex()         // DROP + CREATE + INSERT documents_fts
```

The full-rebuild pattern at `reindex.ts:20-22` destroys all data before writing. This is correct for correctness but incorrect for efficiency.

### Key observations from code inspection

1. `db.clearAll()` at line 20 uses `DELETE FROM relationships; DELETE FROM tags; DELETE FROM documents` — it does NOT clear `outcome_events` (by design). The `sync` table must follow the same preservation rule.

2. `vec.dropIndex()` + `vec.createIndex()` at lines 21-22 completely destroys and recreates the sqlite-vec virtual table. This is needed because sqlite-vec's `vec0` virtual table does not support `DELETE`-based row removal in all versions. The incremental approach needs to keep the virtual table intact and use `upsertEmbedding()` which already does `DELETE + INSERT` per row.

3. `fts.rebuildIndex()` at line 87 (`search.ts:28-43`) also does `DROP TABLE + CREATE + INSERT`. For incremental indexing, the FTS table cannot be partially updated — it must still be rebuilt from scratch after all document changes are applied. This is a SQLite FTS5 constraint: content-rowid tables do not support efficient incremental sync. **The FTS rebuild must still happen on every reindex run** even with mtime tracking; only the embedding step is skipped for unchanged files.

4. `vec.upsertEmbedding()` at `vector-search.ts:39-47` already does `DELETE + INSERT` per document, so it is safe to call for individual files without affecting others.

5. `findMarkdownFiles()` (`file-scanner.ts:4-18`) returns absolute paths from `readdirSync` traversal. Node.js `statSync(path).mtimeMs` returns the modification time in milliseconds as a float. Storing as `INTEGER` (milliseconds, truncated) is safe and consistent.

6. The `reindex()` function signature is `async function reindex(dirs: string[], dbPath: string, generate: boolean = false)`. No parameter change is needed — incremental behavior is the default, with `clearAll()` as the forced-rebuild path (the existing behavior if the sync table is absent).

### `clearAll()` contract (`db.ts:341-344`)

```typescript
clearAll(): void {
  this.db.exec("DELETE FROM relationships; DELETE FROM tags; DELETE FROM documents;");
}
```

Must be extended to also `DELETE FROM sync` when performing a forced full rebuild. Otherwise stale sync entries could cause files to be skipped after a forced rebuild.

## Key Discoveries

### What to add to `KnowledgeDB` (`db.ts`)

**New `sync` table in schema** (add to `createSchema()` alongside existing tables):

```sql
CREATE TABLE IF NOT EXISTS sync (
  path TEXT PRIMARY KEY,
  mtime INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL
)
```

**New methods needed:**
- `getSyncRecord(path: string): { path: string; mtime: number; indexed_at: number } | undefined`
- `upsertSyncRecord(path: string, mtime: number): void`
- `deleteSyncRecord(path: string): void`
- `getAllSyncPaths(): string[]` — for detecting deleted files

**Modified `clearAll()`** must add `DELETE FROM sync` to ensure forced rebuilds start clean.

### `reindex()` algorithm change (`reindex.ts`)

The new flow with incremental indexing:

```
reindex(dirs, dbPath)
  // Do NOT call db.clearAll() — preserve existing index
  // Do NOT dropIndex/createIndex — preserve documents_vec

  filesOnDisk = findMarkdownFiles(all dirs)   // Set of current paths

  // Phase 1: detect and remove deleted files
  storedPaths = db.getAllSyncPaths()
  for each storedPath not in filesOnDisk:
    db.deleteDocument(storedPath)    // CASCADE deletes tags + relationships
    vec.deleteEmbedding(storedPath)  // Remove from documents_vec
    db.deleteSyncRecord(storedPath)

  // Phase 2: process new and modified files
  for each file in filesOnDisk:
    mtime = statSync(file).mtimeMs
    syncRecord = db.getSyncRecord(file)
    if syncRecord && syncRecord.mtime === Math.trunc(mtime):
      continue   // unchanged — skip embedding

    // Process: parse, embed, upsert (same as current)
    ...
    db.upsertSyncRecord(file, Math.trunc(mtime))

  // Phase 3: FTS rebuild (always — content table requires full rebuild)
  fts.rebuildIndex()
```

### Vector index cleanup

`vec.upsertEmbedding()` already does `DELETE + INSERT`. For the delete-stale-files path, a `deleteEmbedding(id: string)` method is needed on `VectorSearch`:

```typescript
deleteEmbedding(id: string): void {
  this.ensureVecLoaded();
  this.knowledgeDb.db.prepare("DELETE FROM documents_vec WHERE id = ?").run(id);
}
```

### Document deletion from `KnowledgeDB`

Currently `KnowledgeDB` has no `deleteDocument()` method — only `clearAll()`. A targeted delete is needed:

```typescript
deleteDocument(id: string): void {
  // tags and relationships have ON DELETE CASCADE from documents(id)
  this.db.prepare("DELETE FROM documents WHERE id = ?").run(id);
}
```

The `tags` and `relationships` tables already have `ON DELETE CASCADE` on `doc_id`/`source_id`, so this is safe.

### FTS rebuild remains full

The FTS5 content table (`documents_fts`) uses `content='documents'` with `content_rowid='rowid'`. SQLite FTS5 content tables require a full rebuild to stay in sync when the backing table changes. Partial FTS updates (using `INSERT/DELETE` directly into the FTS table) are possible but fragile — the `rowid` linkage must match exactly. The safest and already-tested pattern is `rebuildIndex()` which `DROP TABLE IF EXISTS documents_fts` + recreates + bulk inserts. This will remain unchanged.

Cost: FTS rebuild is fast (pure SQL, no inference). For 200 docs it is negligible. The optimization target is embedding, not FTS.

### Mtime precision

Node's `statSync().mtimeMs` returns milliseconds as a float (e.g., `1711234567890.5`). SQLite `INTEGER` stores 64-bit integers. Storing as `Math.trunc(mtime)` is safe and avoids floating-point edge cases. The comparison must also use `Math.trunc` or integer conversion consistently.

### Test coverage required

Per acceptance criteria, tests must cover:
1. Skip unchanged file (mtime unchanged → no embed call, document unchanged)
2. Process modified file (mtime changed → embed called, document updated)
3. Process new file (not in sync table → embed called, document inserted)
4. Remove deleted file (in sync table but absent from filesystem → document deleted from all tables)
5. Full rebuild still works (`clearAll()` clears sync table → next reindex is a full rebuild)

Tests for `reindex.ts` are currently thin (only `findMarkdownFiles` is tested). The new tests will need to mock `embed()` to avoid transformer model loading in tests. Looking at the existing test pattern (`src/__tests__/reindex.test.ts`), the test file only covers `findMarkdownFiles`. The new incremental logic should be unit tested at the `KnowledgeDB` level (sync table CRUD) and integration tested with a mocked `embed` function.

## Potential Approaches

### Approach A: Add sync table + modify `reindex()` (recommended)

**Pros:**
- Exactly what the issue specifies; small, focused change
- `clearAll()` can still be called explicitly for forced full rebuild
- No change to public API surface of `reindex()` — backward compatible
- ~40-60 lines of new code total

**Cons:**
- Adds a new method surface to `KnowledgeDB` (4 new methods)
- Tests need embed mock to avoid slow transformer inference

### Approach B: mtime-check without sync table (use filesystem only)

Check mtimes against `documents` table timestamps rather than a dedicated sync table. This avoids schema change but has no reliable "indexed_at" timestamp — `documents.date` is the frontmatter date, not the index timestamp.

**Cons:**
- No "when was this indexed" information
- Can't distinguish "never indexed" from "indexed before date field"
- Knowledge-graph reference implementation uses a dedicated sync table — this is the proven pattern

### Approach C: Hash-based change detection

SHA-256 hash of file content instead of mtime. More reliable across moves/copies.

**Cons:**
- Requires reading all files to hash them (defeats the cheap-check benefit of mtime)
- Two-phase: hash check then embed. Mtime is O(1) stat call vs O(file-size) hash

**Verdict:** Approach A is correct. Mtime is cheap, the sync table is clean, and the obra/knowledge-graph reference shows it works at scale.

## Risks

1. **Mtime unreliability in CI/test environments**: `git checkout` sets mtime to current time, not commit time. In test environments, files may have mtimes that appear newer than stored values, triggering unnecessary re-embeds. This is acceptable — the sync table only prevents unnecessary embeds, not required ones. A false "modified" is safe; a false "unchanged" would be a bug (requires mtime to go backward, which does not happen in normal operation).

2. **Embedding mock in tests**: The `embed()` function loads a 30MB transformer model. Tests that call `reindex()` must mock `embed`. The existing test file imports `findMarkdownFiles` directly and does not call `reindex()`. The new incremental tests will need to either mock `embed` via vitest's `vi.mock()` or test the DB layer directly without going through `reindex()`.

3. **FTS rowid stability**: `upsertDocument()` uses `INSERT ... ON CONFLICT DO UPDATE`. SQLite reassigns `rowid` on `DELETE + INSERT` but preserves it on `UPDATE`. Since `documents_fts` is rebuilt from scratch on every run anyway, rowid instability between runs is not a problem.

4. **Concurrent reindex runs**: Two simultaneous `reindex()` calls could interleave sync table writes. This is not a risk in practice — reindex is a CLI command run by one process at a time.

## Recommended Next Steps

1. Add `sync` table to `createSchema()` in `db.ts`
2. Add `deleteSyncRecord`, `upsertSyncRecord`, `getSyncRecord`, `getAllSyncPaths` to `KnowledgeDB`
3. Extend `clearAll()` to also `DELETE FROM sync`
4. Add `deleteDocument(id: string)` to `KnowledgeDB` (needed for stale file cleanup)
5. Add `deleteEmbedding(id: string)` to `VectorSearch`
6. Rewrite `reindex()` in `reindex.ts` to use incremental logic
7. Write tests covering all 5 scenarios from acceptance criteria

## Files Affected

### Will Modify
- `plugin/ralph-knowledge/src/db.ts` - Add `sync` table to schema; add `getSyncRecord`, `upsertSyncRecord`, `deleteSyncRecord`, `getAllSyncPaths`, `deleteDocument`; extend `clearAll()` to clear sync table
- `plugin/ralph-knowledge/src/reindex.ts` - Replace `clearAll()` + full rebuild with incremental mtime-based logic
- `plugin/ralph-knowledge/src/vector-search.ts` - Add `deleteEmbedding(id: string)` method
- `plugin/ralph-knowledge/src/__tests__/db.test.ts` - Add sync table CRUD tests and updated `clearAll()` test
- `plugin/ralph-knowledge/src/__tests__/reindex.test.ts` - Add incremental indexing integration tests (with mocked embed)

### Will Read (Dependencies)
- `plugin/ralph-knowledge/src/file-scanner.ts` - `findMarkdownFiles()` return type (absolute paths)
- `plugin/ralph-knowledge/src/search.ts` - `rebuildIndex()` behavior (FTS must stay full-rebuild)
- `plugin/ralph-knowledge/src/embedder.ts` - `embed()` signature for mock target in tests
- `plugin/ralph-knowledge/src/parser.ts` - `parseDocument()` contract (unchanged)
