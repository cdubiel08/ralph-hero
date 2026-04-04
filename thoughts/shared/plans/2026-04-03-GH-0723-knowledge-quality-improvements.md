---
date: 2026-04-03
status: draft
type: plan
tags: [ralph-knowledge, graph-tools, embeddings, fts, indexing]
github_issue: 723
github_issues: [723]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/723
primary_issue: 723
---

# ralph-knowledge Quality Improvements Plan

## Prior Work

- builds_on:: [[2026-04-03-knowledge-implementation-comparison-obra-vs-ralph]]
- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]
- builds_on:: [[2026-03-24-GH-0671-knowledge-communities-louvain]]
- builds_on:: [[2026-03-24-GH-0672-centrality-tools]]

## Overview

Four improvements to ralph-knowledge addressing scaling, discoverability, embedding quality, and indexing efficiency. Driven by the obra/knowledge-graph comparison that identified remaining gaps after the March 2026 convergence wave.

## Current State Analysis

### Communities tool scaling
`knowledge_communities` returns ALL communities with ALL members — no `limit` param, no way to fetch a single community. With 1,026 nodes this produced a 318K character response that overflows LLM context. The `knowledge_central` tool already accepts a `community` filter param and re-runs Louvain internally — a pattern to reuse.

### No subgraph extraction
`knowledge_traverse` walks directional edge chains (outgoing OR incoming) and returns a flat array of edges. It doesn't return the inter-node edges between results — you can't see how the neighborhood connects to itself. obra has `kg_subgraph` returning nodes + edges for N-hop neighborhoods.

### Embedding text truncation
`prepareTextForEmbedding(title, content)` concatenates `title + "\n" + content` and truncates to 500 chars. Tags (available as `parsed.tags` at the call site) are never included. obra uses `title + tags + first_paragraph` — tags carry important semantic signal and first paragraph is a more meaningful boundary than arbitrary character count.

### FTS full rebuild
Every reindex run does `DROP TABLE IF EXISTS documents_fts` + full `CREATE` + bulk `INSERT ... SELECT FROM documents`, even when only one file changed. The code comment says "FTS5 content tables don't support partial sync" — this is incorrect. FTS5 `content=` tables support per-row delete/insert commands.

## Desired End State

1. `knowledge_communities` accepts `limit` param, returns compact summaries. New `knowledge_community` (singular) tool fetches one community's full details by ID.
2. `knowledge_subgraph` tool returns N-hop neighborhood as deduplicated `{ nodes[], edges[] }` with edge context preserved.
3. Embeddings use `title + tags + first_paragraph` for better semantic representation.
4. FTS updates are per-document during incremental reindex, with full rebuild only on first index or explicit request.

### Key Discoveries:
- `GraphBuilder` (`graph-builder.ts:51-57`) does NOT select the `context` column from `relationships` — subgraph tool needs direct DB query or GraphBuilder modification
- `parsed.tags` is already populated at the embedding call site (`reindex.ts:112`) but never passed to `prepareTextForEmbedding()`
- FTS table uses `content='documents'` external content (`search.ts:30-38`) — supports per-row `INSERT INTO documents_fts(documents_fts, rowid, ...) VALUES('delete', ...)` commands
- Louvain determinism via `rng: () => 0.5` (`graph-tools.ts:248`) ensures community IDs are stable within a session

## What We're NOT Doing

- Community persistence (unnecessary at current scale — recompute on demand)
- 8-bit quantized embeddings (`dtype: 'q8'`) — deferred, revisit later
- Write tools (kg_create_node/annotate/add_link) — skills handle file creation
- Fuzzy node resolution — skills resolve names before calling knowledge tools

---

## Phase 1: Improve Communities — Add Limit + Singular Tool

### Overview
Fix the 318K response scaling problem by adding pagination to `knowledge_communities` and a new `knowledge_community` (singular) tool for fetching one community by ID.

### Changes Required:

#### 1. Add `limit` param to `knowledge_communities`
**File**: `plugin/ralph-knowledge/src/graph-tools.ts`

Add to the schema object (after `resolution` param, around line 188):
```typescript
limit: z
  .number()
  .int()
  .min(1)
  .optional()
  .describe("Max communities to return, sorted by size descending (default: all)."),
```

After both sort sites (Louvain path at line 278, no-edges path at line 231), apply the limit:
```typescript
const sliced = args.limit ? communities.slice(0, args.limit) : communities;
```

Defer `computeLabel()` calls to after slicing — currently labels are computed for ALL communities before sorting. Move label computation to after the slice to avoid unnecessary `getTags()` queries for communities that won't be returned.

#### 2. Add `knowledge_community` (singular) tool
**File**: `plugin/ralph-knowledge/src/graph-tools.ts`

New tool registered after `knowledge_communities`. Accepts:
```typescript
{
  communityId: z.number().int().describe("Community ID from knowledge_communities results."),
}
```

Implementation:
1. Build graph via `GraphBuilder`
2. Run `louvain(graph, { rng: () => 0.5 })` (same deterministic seed)
3. Extract members for the requested community ID from the partition map
4. Return single `Community` object with `{ communityId, members, size, label }`
5. Return empty result with error message if community ID not found

The pattern matches `knowledge_central`'s community filter (`graph-tools.ts:342-378`) but without the PageRank step.

#### 3. Add tests
**File**: `plugin/ralph-knowledge/src/__tests__/graph-tools.test.ts`

Add tests for:
- `knowledge_communities` with `limit` param returns correct count
- `knowledge_communities` with `limit` larger than community count returns all
- `knowledge_community` returns correct members for valid ID
- `knowledge_community` returns empty/error for invalid ID
- Label computation only runs for returned communities (verify via spy on `getTags`)

### Success Criteria:

#### Automated Verification:
- [x] All tests pass: `npm test` (from `plugin/ralph-knowledge/`)
- [x] Type checking passes: `npm run build`
- [x] `knowledge_communities` with `limit: 5` returns at most 5 communities
- [x] `knowledge_community` with valid ID returns matching community

#### Manual Verification:
- [ ] Call `knowledge_communities` with `limit: 5` from Claude Code — response is compact, no context overflow
- [ ] Call `knowledge_community` with an ID from the communities result — returns full member list

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Add `knowledge_subgraph` Tool

### Overview
New tool that extracts an N-hop neighborhood around a document as a deduplicated graph structure with nodes, edges, and edge context preserved.

### Changes Required:

#### 1. Add `context` to GraphBuilder edge query
**File**: `plugin/ralph-knowledge/src/graph-builder.ts`

The edge query at line 51 currently selects only `source_id, target_id, type`. Add `context`:
```typescript
const edges = this.db.all<{ source_id: string; target_id: string; type: string; context: string | null }>(
  `SELECT source_id, target_id, type, context FROM relationships`
);
```

Update `EdgeAttributes` interface (line 14-16) to include `context`:
```typescript
interface EdgeAttributes {
  type: string;
  context: string | null;
}
```

Update the `addDirectedEdge` call (around line 63) to include context:
```typescript
graph.addDirectedEdge(edge.source_id, edge.target_id, {
  type: edge.type,
  context: edge.context ?? null,
});
```

This enriches the graph for all tools, but existing tools that don't use context are unaffected.

#### 2. Register `knowledge_subgraph` tool
**File**: `plugin/ralph-knowledge/src/graph-tools.ts`

New tool registered after `knowledge_common`. Schema:
```typescript
{
  root: z.string().describe("Document ID to center the subgraph on."),
  depth: z.number().int().min(1).max(5).optional()
    .describe("Max hops from root (default: 1). Use 1 for immediate neighbors, 2 for neighbors-of-neighbors."),
  brief: z.boolean().optional()
    .describe("If true, omit edge context and doc content (default: false)."),
}
```

Implementation — BFS from root using graphology's `neighbors()` (direction-agnostic):
```typescript
const depth = args.depth ?? 1;
const graph = new GraphBuilder(db).buildGraph();

if (!graph.hasNode(args.root)) {
  return toolError(`Document '${args.root}' not found in graph.`);
}

// BFS to collect nodes within N hops
const visited = new Map<string, number>(); // nodeId -> distance
const queue: Array<[string, number]> = [[args.root, 0]];
visited.set(args.root, 0);

while (queue.length > 0) {
  const [current, dist] = queue.shift()!;
  if (dist >= depth) continue;
  for (const neighbor of graph.neighbors(current)) {
    if (!visited.has(neighbor)) {
      visited.set(neighbor, dist + 1);
      queue.push([neighbor, dist + 1]);
    }
  }
}

// Collect nodes
const nodes = [...visited.entries()].map(([id, dist]) => {
  const attrs = graph.getNodeAttributes(id);
  return {
    id,
    title: attrs.title ?? null,
    type: attrs.type ?? null,
    date: attrs.date ?? null,
    distance: dist,
    tags: db.getTags(id),
  };
});

// Collect edges between visited nodes
const edgeSet = new Set<string>();
const edges: Array<{source: string; target: string; type: string; context?: string | null}> = [];
for (const nodeId of visited.keys()) {
  graph.forEachOutEdge(nodeId, (edgeKey, attrs, source, target) => {
    if (visited.has(target) && !edgeSet.has(edgeKey)) {
      edgeSet.add(edgeKey);
      const entry: any = { source, target, type: attrs.type };
      if (!args.brief) entry.context = attrs.context;
      edges.push(entry);
    }
  });
}
```

Return shape:
```typescript
{
  root: args.root,
  depth,
  nodes,   // deduplicated, with distance from root
  edges,   // only edges between visited nodes, with context
  graphSize: { nodes: nodes.length, edges: edges.length },
}
```

#### 3. Add tests
**File**: `plugin/ralph-knowledge/src/__tests__/graph-tools.test.ts`

Tests for:
- 1-hop subgraph returns immediate neighbors and connecting edges
- 2-hop subgraph includes neighbors-of-neighbors
- Edges only between visited nodes (no edges to nodes outside the subgraph)
- `brief: true` omits edge context
- Unknown root returns error
- `distance` field is correct for each node
- Edge context is included when not brief

### Success Criteria:

#### Automated Verification:
- [x] All tests pass: `npm test`
- [x] Type checking passes: `npm run build`
- [x] Existing graph tool tests still pass (adding context to EdgeAttributes is non-breaking)

#### Manual Verification:
- [ ] Call `knowledge_subgraph` with `root: "2026-03-24-knowledge-graph-plugin-comparison", depth: 1` — returns reasonable neighborhood
- [ ] Call with `depth: 2` — returns larger neighborhood, edges between depth-1 and depth-2 nodes are present
- [ ] Verify edge `context` is populated for untyped edges

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Embedding Text Preparation — Title + Tags + First Paragraph

### Overview
Change embedding input from `title + content[:500]` to `title + tags + first_paragraph` for better semantic representation. Requires a full re-embed of all documents.

### Changes Required:

#### 1. Update `prepareTextForEmbedding()`
**File**: `plugin/ralph-knowledge/src/embedder.ts`

Change function signature and body:
```typescript
const MAX_CHARS = 500;

export function prepareTextForEmbedding(
  title: string,
  tags: string[],
  content: string,
): string {
  const tagLine = tags.length > 0 ? tags.join(", ") : "";
  // Extract first paragraph: split on blank lines, take first non-empty segment
  const paragraphs = content.split(/\n\n+/);
  const firstParagraph = paragraphs.find(p => p.trim().length > 0)?.trim() ?? "";
  const parts = [title, tagLine, firstParagraph].filter(p => p.length > 0);
  return parts.join("\n").slice(0, MAX_CHARS);
}
```

Remove the redundant `text.slice(0, MAX_CHARS)` inside `embed()` at line 24 — the caller already handles truncation. Or keep it as a safety net; either way the double-truncation is harmless.

#### 2. Update reindex call site
**File**: `plugin/ralph-knowledge/src/reindex.ts`

Change line 112 from:
```typescript
const text = prepareTextForEmbedding(parsed.title, parsed.content);
```
To:
```typescript
const text = prepareTextForEmbedding(parsed.title, parsed.tags, parsed.content);
```

`parsed.tags` is already populated at this point (tags are set at lines 91-93).

#### 3. Update test fixtures
**File**: `plugin/ralph-knowledge/src/__tests__/` — any tests that call `prepareTextForEmbedding()` directly

Update call sites to pass the new 3-argument signature. Add tests:
- Tags are included in the embedding text between title and first paragraph
- First paragraph extraction works (skips blank lines, skips `# Title` heading if it's the first line)
- Empty tags produce no blank line
- Long first paragraphs are truncated at 500 chars total

#### 4. Force full re-embed
**File**: `plugin/ralph-knowledge/src/reindex.ts`

After the embedding logic change, add a one-time migration: if the DB exists, clear the `sync` table to force all documents through re-embedding on next reindex:
```typescript
// After schema migration checks, before Phase 1 (stale deletion):
// Check if embeddings need regeneration (e.g., after algorithm change)
// This is a manual step — users run `npm run reindex` or the setup skill handles it
```

Actually, the cleanest approach: the setup skill and `npm run reindex` should support a `--force` flag that clears the sync table. Document this in the migration notes. Alternatively, bump an internal schema version that triggers re-embed.

Simplest: add a `schema_version` key to a new `meta` table. When the version changes, clear sync records to force re-embed. Set version to `2` with this change.

**File**: `plugin/ralph-knowledge/src/db.ts`

Add after the existing table creation:
```typescript
db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
```

In `reindex.ts`, check version before the main loop:
```typescript
const SCHEMA_VERSION = "2";
const currentVersion = db.getMeta("schema_version");
if (currentVersion !== SCHEMA_VERSION) {
  db.clearSyncRecords(); // force full re-embed
  db.setMeta("schema_version", SCHEMA_VERSION);
}
```

### Success Criteria:

#### Automated Verification:
- [x] All tests pass: `npm test`
- [x] Type checking passes: `npm run build`
- [x] `prepareTextForEmbedding("My Title", ["graphology", "search"], "First paragraph.\n\nSecond paragraph.")` returns `"My Title\ngraphology, search\nFirst paragraph."`

#### Manual Verification:
- [ ] Run `npm run reindex` — all documents are re-embedded (none skipped)
- [ ] Search results quality is reasonable after re-embed
- [ ] Subsequent `npm run reindex` with no file changes skips all documents (incremental still works)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 4: Per-Document Incremental FTS

### Overview
Replace the full FTS drop/rebuild with per-document FTS insert/delete operations during incremental reindex. Full rebuild only on first index or schema version bump.

### Changes Required:

#### 1. Add per-document FTS methods to `FtsSearch`
**File**: `plugin/ralph-knowledge/src/search.ts`

Add two new methods:

```typescript
/**
 * Remove a document's FTS entries. Must be called BEFORE the document
 * row is deleted/updated in the `documents` table, because FTS5
 * content= tables read old values from the content table during delete.
 */
deleteFtsEntry(docId: string): void {
  // Fetch the rowid and current values from documents (needed for content= delete)
  const row = this.db.get<{ rowid: number; title: string; path: string; content: string }>(
    `SELECT rowid, title, path, content FROM documents WHERE id = ?`, docId
  );
  if (!row) return;
  this.db.run(
    `INSERT INTO documents_fts(documents_fts, rowid, title, path, content) VALUES('delete', ?, ?, ?, ?)`,
    row.rowid, row.title, row.path, row.content
  );
}

/**
 * Insert/update a document's FTS entries. Must be called AFTER the
 * document row is inserted/updated in the `documents` table.
 */
upsertFtsEntry(docId: string): void {
  const row = this.db.get<{ rowid: number; title: string; path: string; content: string }>(
    `SELECT rowid, title, path, content FROM documents WHERE id = ?`, docId
  );
  if (!row) return;
  this.db.run(
    `INSERT INTO documents_fts(rowid, title, path, content) VALUES(?, ?, ?, ?)`,
    row.rowid, row.title, row.path, row.content
  );
}
```

Keep `rebuildIndex()` as-is for full rebuild scenarios (first index, schema migration).

#### 2. Update reindex flow for per-document FTS
**File**: `plugin/ralph-knowledge/src/reindex.ts`

**Phase 1 — Stale deletion** (around line 37): Before `db.deleteDocument(id)`, call `fts.deleteFtsEntry(id)`:
```typescript
fts.deleteFtsEntry(id);
db.deleteDocument(id);
vec.deleteEmbedding(id);
db.deleteSyncRecord(stalePath);
```

**Phase 2 — Changed/new files** (around line 80-89): For document upserts, the flow becomes:
```typescript
// Delete old FTS entry BEFORE upsert (only if document already exists)
if (db.documentExists(parsed.id)) {
  fts.deleteFtsEntry(parsed.id);
}
db.upsertDocument({ ... });
// Insert new FTS entry AFTER upsert
fts.upsertFtsEntry(parsed.id);
```

**Phase 3 — FTS rebuild** (line 128-129): Change from unconditional `fts.rebuildIndex()` to conditional:
```typescript
// Full FTS rebuild only when schema version changed (handled by meta table check above)
// Per-document FTS updates already applied in Phase 1 and Phase 2
```

The full `rebuildIndex()` is still called when the schema version changes (from Phase 3's meta table check), which covers first-time indexing and migration scenarios.

#### 3. Add `documentExists()` helper if not present
**File**: `plugin/ralph-knowledge/src/db.ts`

Check if `documentExists(id)` exists. If not, add:
```typescript
documentExists(id: string): boolean {
  const row = this.db.get<{ id: string }>(`SELECT id FROM documents WHERE id = ?`, id);
  return row !== undefined;
}
```

#### 4. Expose `get` and `run` on db for FtsSearch
**File**: `plugin/ralph-knowledge/src/search.ts`

`FtsSearch` currently only has access to `this.db` (a `KnowledgeDB` instance). The new methods need `db.get()` and `db.run()` which execute raw SQL. Check if `KnowledgeDB` exposes these — if the underlying `better-sqlite3` `Database` is private, add passthrough methods or pass the raw db handle to `FtsSearch`.

#### 5. Update tests
**File**: `plugin/ralph-knowledge/src/__tests__/search.test.ts` and `reindex.test.ts`

Tests for:
- `deleteFtsEntry` removes document from FTS results
- `upsertFtsEntry` makes document searchable via FTS
- Incremental reindex with one changed file only updates that file's FTS entry
- Deleted files are removed from FTS before document deletion
- Full rebuild still works when called explicitly
- New documents (not previously indexed) get FTS entries correctly

### Success Criteria:

#### Automated Verification:
- [x] All tests pass: `npm test`
- [x] Type checking passes: `npm run build`
- [x] Reindex test: change one file, verify only that file's FTS entry is updated (not a full rebuild)

#### Manual Verification:
- [ ] Run `npm run reindex` on a clean DB — full FTS rebuild occurs
- [ ] Modify one file in `thoughts/`, run `npm run reindex` again — only that file is re-indexed, FTS search still finds it
- [ ] Delete a file, run `npm run reindex` — file is removed from FTS results

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:
- Phase 1: Community limit slicing, singular community lookup, label computation deferral
- Phase 2: BFS neighborhood collection, edge deduplication, distance correctness, brief mode
- Phase 3: `prepareTextForEmbedding` with 3-arg signature, first paragraph extraction, schema version migration
- Phase 4: Per-document FTS insert/delete, ordering (delete before document mutation), full rebuild fallback

### Integration Tests:
- End-to-end reindex with all phases applied: incremental indexing, correct FTS, correct embeddings
- Graph tools still function correctly after GraphBuilder EdgeAttributes change

### Manual Testing Steps:
1. After Phase 1: Call `knowledge_communities` with `limit: 5` — verify compact response
2. After Phase 2: Call `knowledge_subgraph` on a well-connected document — verify neighborhood makes sense
3. After Phase 3: Run reindex, verify all documents re-embedded, search quality maintained
4. After Phase 4: Modify a single file, reindex, verify only that file touched

## Performance Considerations

- Phase 1: Label computation deferral avoids O(communities * members) DB queries for discarded communities
- Phase 2: BFS is O(nodes + edges) within the depth bound — fast for depth 1-2
- Phase 3: One-time full re-embed on schema version bump (~seconds for 1K documents)
- Phase 4: Per-document FTS eliminates O(N) bulk INSERT on every reindex — significant for large corpora

## Migration Notes

- Phase 3 introduces a `meta` table with `schema_version`. Bumping the version to "2" triggers a one-time full re-embed by clearing the sync table.
- Phase 4 is a code-only change — no schema migration. The FTS table structure is unchanged; only the update strategy changes.
- Phase 2 adds `context` to `EdgeAttributes` in GraphBuilder — existing tools that don't use `context` are unaffected (the attribute is simply present but unused).

## Deferred Items

- **8-bit quantized embeddings** (`dtype: 'q8'`): one-line change to embedder pipeline options. Reduces model size from ~90MB to ~22MB. Negligible quality impact for MiniLM-L6. Revisit when model loading time or disk size becomes a concern.
- **Community persistence**: Store communities in a table to avoid recomputing. Not needed at current scale (~1K nodes). Revisit when community detection becomes a bottleneck.

## References

- Research: `thoughts/shared/research/2026-04-03-knowledge-implementation-comparison-obra-vs-ralph.md`
- Prior comparison: `thoughts/shared/research/2026-03-24-knowledge-graph-plugin-comparison.md`
- obra/knowledge-graph: https://github.com/obra/knowledge-graph
