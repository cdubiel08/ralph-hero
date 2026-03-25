---
date: 2026-03-24
github_issue: 667
github_url: https://github.com/cdubiel08/ralph-hero/issues/667
status: complete
type: research
tags: [ralph-knowledge, mcp-server, search, graph-exploration, api-design]
---

# Research: Brief/Full Mode for knowledge_search and knowledge_traverse

## Prior Work

- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]

## Problem Statement

`knowledge_search` and `knowledge_traverse` always return full document content. During graph-style exploration — where an agent wants to scan many nodes to find the most relevant ones before deep-reading — this is wasteful in LLM context tokens. The obra/knowledge-graph plugin's `kg_node` tool solves this with a `brief` flag: brief mode returns metadata + connection titles only; full mode returns content + edge context.

Issue 667 asks us to add the same `brief: boolean` parameter to both tools, enabling cheap exploration before committing to full reads.

## Current State Analysis

### knowledge_search (full mode, always)

`knowledge_search` calls `HybridSearch.search()` which returns `SearchResult[]`. Each `SearchResult` includes `id`, `path`, `title`, `type`, `status`, `date`, `score`, and `snippet`. The `snippet` field comes from the FTS5 `snippet()` function — a content excerpt. After returning, `index.ts` enriches each result with `tags` (via `db.getTags()`) and optionally `outcomes_summary`.

The full document `content` is NOT returned by `knowledge_search` today — only a `snippet`. This is an important distinction: brief mode for search is about suppressing the snippet, not the full content body.

### knowledge_traverse (full mode, always)

`knowledge_traverse` calls `Traverser.traverse()` or `Traverser.traverseIncoming()`, which return `TraverseResult[]`. Each result includes `sourceId`, `targetId`, `type`, `depth`, and a `doc` object with `{ title, status, date }`. There is NO content/snippet in traverse results today.

The `doc` field in `TraverseResult` is already minimal — it only carries title, status, and date. The traverse response does NOT include content body or snippets. What brief mode would suppress here is the `doc` metadata entirely (just keep sourceId, targetId, type, depth) OR — more usefully — it could AUGMENT traverse results in full mode with connected document titles at each hop.

### Re-reading the acceptance criteria

The AC states:
- Brief mode returns: id, title, type, date, tags, connected document titles (no content body)
- Full mode remains the default and returns current behavior unchanged

For `knowledge_search`: brief drops the `snippet` field. Tags are already included in full mode via the enrichment step. This is a narrow change.

For `knowledge_traverse`: the AC mentions "connected document titles." Traverse results already include `doc.title` at each hop target. Brief mode for traverse would need to suppress anything extra added in full mode — but today full mode and brief mode would be identical for traverse since there's no content in results. The distinction becomes meaningful only if we later add content-fetching to traverse (e.g., returning the document body alongside each traversal hop).

The AC's phrasing "no content body" for brief mode strongly suggests the intent is forward-compatible: add the `brief` parameter now so callers can already mark their calls as brief-aware, and full mode currently returns the same as brief mode for traverse until content is added there.

## Key Discoveries

### 1. Minimal diff for search.ts

`SearchResult` in `search.ts` has a `snippet: string` field. Brief mode suppresses it. No changes needed to `FtsSearch` or `HybridSearch` — the suppression happens in `index.ts` at the tool handler level, after results are returned.

Pattern: in the `knowledge_search` handler in `index.ts`, if `brief === true`, map results to omit the `snippet` field before serializing.

### 2. No changes needed to traverse internals

`TraverseResult` already has no content/snippet field. The `brief` parameter on `knowledge_traverse` is a no-op functionally today but provides API-forward-compat. The handler in `index.ts` can be annotated to strip `doc` if strict brief mode is desired, or simply pass through with brief as a documented no-op for traverse.

However, looking at the AC more carefully: "connected document titles" is listed as INCLUDED in brief mode. Traverse already returns `doc.title`. So brief mode for traverse means: id + title + type + date + tags of the root document, plus connection titles. This is a different shape than the current traverse output — it's a summary view of the root node's neighborhood, not a list of traversal hops.

This suggests brief mode on traverse is actually a new response shape: given a document ID, return a compact summary of that document plus its neighbor titles (1-hop). This is closer to obra's `kg_node(brief=true)` which returns the node's metadata plus its direct connection titles.

Recommended interpretation: For `knowledge_traverse` with `brief=true`, return a flattened list where `doc` is stripped down to just the title string (no status/date), and depth/sourceId/targetId are preserved. This is the minimal change that satisfies "connection titles only."

### 3. Tags in traverse results

Currently `TraverseResult.doc` does not include tags. The AC says brief mode includes tags of connected documents. To include tags, the traverse result must be enriched with `db.getTags(targetId)` per hop. This requires a small change — either in `Traverser.traverse()` or as post-processing in `index.ts`.

The cleaner approach: post-process in `index.ts` (same pattern as `knowledge_search` enrichment) rather than changing `Traverser`, which keeps the traversal module focused on graph walking.

### 4. Type-level design for brief mode

Two options for the TypeScript return type:

**Option A: Union type** — `BriefSearchResult | FullSearchResult`. Requires conditional typing at call sites.

**Option B: Optional fields** — make `snippet?: string` in `SearchResult`, and `brief` suppresses its presence. Callers check for `snippet` existence. This is simpler and backward-compatible (existing callers that don't pass `brief` still get `snippet`).

Option B is recommended. No breaking change, minimal type delta.

For traverse, similarly make `doc` nullable or add a `briefDoc: { title: string } | null` field. The current `doc` object already handles the null case for unresolved stubs.

### 5. Test coverage gaps

Existing tests do not test the enriched output from the `index.ts` tool handler directly — they test the underlying modules. Brief mode tests need to:
- Assert `snippet` is absent when `brief=true` on `knowledge_search`
- Assert `snippet` is present when `brief` is omitted or `false` on `knowledge_search`
- Assert traverse results include only title for `doc` when `brief=true`
- Assert traverse `doc` includes status/date when `brief=false`

The `index.test.ts` currently only imports and checks `createServer` exists. Brief mode tests should be added to a new `src/__tests__/brief-mode.test.ts` that uses `createServer(":memory:")` and calls the tool handlers directly, similar to how `hybrid-search.test.ts` tests the `HybridSearch` class.

However, the tool handlers are not directly callable from the test — they're registered on the MCP server. The pattern is to test the underlying logic directly. For brief mode, the logic is in `index.ts`. To make it testable:

- Extract a `formatSearchResults(results, opts: { brief?: boolean })` helper in `index.ts` (or a new `format.ts` module)
- Extract a `formatTraverseResults(results, db, opts: { brief?: boolean })` helper
- Test those helpers directly

This keeps `index.ts` thin and the formatting logic fully unit-testable without going through the MCP transport.

### 6. No DB schema changes required

Brief mode is purely a presentation-layer concern. No new columns, indexes, or tables needed.

## Potential Approaches

### Approach A: Handle in index.ts tool handlers (inline)

Add `brief` param to both tool schemas in `index.ts`. In the search handler, conditionally strip `snippet`. In the traverse handler, conditionally strip `doc.status` and `doc.date` and enrich with tags.

- Pros: Minimal files changed (only `index.ts`), no new modules
- Cons: `index.ts` grows, formatting logic is not unit-testable without the MCP layer

### Approach B: Extract formatter helpers (recommended)

Create `src/format.ts` with:
```typescript
export function formatSearchResults(results: EnrichedSearchResult[], brief: boolean): object[]
export function formatTraverseResults(results: TraverseResult[], db: KnowledgeDB, brief: boolean): object[]
```

`index.ts` calls these formatters. Tests cover the formatters directly.

- Pros: Clean separation, fully testable, matches existing module pattern
- Cons: One additional file

### Approach C: Add brief to underlying modules

Add `brief` option to `HybridSearch.search()` and `Traverser.traverse()`, removing snippet/doc fields at source.

- Pros: No formatting layer needed
- Cons: Mixing presentation concerns into query modules; `FtsSearch` would need to skip the `snippet()` SQL function for a minor optimization that isn't needed at this corpus size

Approach B is recommended.

## Risks

- **None significant.** No schema changes, no breaking changes. The `brief` parameter is optional with default `false`, so existing callers are unaffected.
- **Zod schema alignment**: The MCP tool schema must use `z.boolean().optional()` — not `z.boolean()` — to preserve backward compat. This is the same pattern used for `includeSuperseded`.
- **Tag enrichment in traverse** requires one `db.getTags(id)` call per traversal hop in brief mode. For typical traversal depths (1-3) and corpus sizes (~200 docs), this is negligible. If traverse is called at depth=10 with hundreds of hops, it could add latency — but this is an edge case not worth optimizing.

## Recommended Next Steps

1. Create `plugin/ralph-knowledge/src/format.ts` with `formatSearchResults` and `formatTraverseResults` helpers
2. Add `brief?: boolean` to the `knowledge_search` Zod schema in `index.ts`; call `formatSearchResults(enriched, brief ?? false)`
3. Add `brief?: boolean` to the `knowledge_traverse` Zod schema in `index.ts`; call `formatTraverseResults(results, db, brief ?? false)`
4. Add `plugin/ralph-knowledge/src/__tests__/format.test.ts` covering both modes for both tools
5. No DB migration needed

Estimated complexity: XS (2-3 hours). The logic is entirely presentational with no schema changes.

## Files Affected

### Will Modify
- `plugin/ralph-knowledge/src/index.ts` - Add `brief` param to both tool schemas; call formatters
- `plugin/ralph-knowledge/src/__tests__/index.test.ts` - Optionally add brief-mode smoke test

### Will Read (Dependencies)
- `plugin/ralph-knowledge/src/search.ts` - SearchResult type (snippet field)
- `plugin/ralph-knowledge/src/traverse.ts` - TraverseResult type (doc field)
- `plugin/ralph-knowledge/src/hybrid-search.ts` - HybridSearch.search() return type
- `plugin/ralph-knowledge/src/db.ts` - KnowledgeDB.getTags() for tag enrichment in traverse

### Will Create
- `plugin/ralph-knowledge/src/format.ts` - formatSearchResults and formatTraverseResults helpers
- `plugin/ralph-knowledge/src/__tests__/format.test.ts` - Unit tests for both formatters in brief and full mode
