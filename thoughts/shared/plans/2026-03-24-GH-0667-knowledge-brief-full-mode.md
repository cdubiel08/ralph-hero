---
date: 2026-03-24
status: draft
type: plan
github_issue: 667
github_issues: [667]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/667
primary_issue: 667
tags: [ralph-knowledge, mcp-server, search, graph-exploration, api-design]
---

# Brief/Full Mode for knowledge_search and knowledge_traverse - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-24-GH-0667-knowledge-brief-full-mode]]
- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-667 | ralph-knowledge: brief/full mode for document retrieval | XS |

## Shared Constraints

- **ESM module system**: All internal imports require `.js` extensions. The project uses `"type": "module"` with `"module": "NodeNext"`.
- **Zod parameter schemas**: Optional boolean parameters must use `z.boolean().optional()` -- not `z.boolean()` -- to preserve backward compatibility. Follow the existing `includeSuperseded` pattern.
- **No DB schema changes**: Brief mode is purely a presentation-layer concern. No new columns, indexes, or tables.
- **Backward compatibility**: Full mode (default when `brief` is omitted or `false`) must return identical output to current behavior. No breaking changes to existing callers.
- **Test isolation**: Tests use `:memory:` SQLite databases. No filesystem side effects.

## Current State Analysis

### knowledge_search

The `knowledge_search` tool in [plugin/ralph-knowledge/src/index.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts) calls `HybridSearch.search()` which returns `SearchResult[]` containing `id`, `path`, `title`, `type`, `status`, `date`, `score`, and `snippet`. The handler enriches results with `tags` (via `db.getTags()`) and optionally `outcomes_summary`. The `snippet` field is an FTS5 content excerpt -- not the full document body. Brief mode needs to suppress `snippet`.

### knowledge_traverse

The `knowledge_traverse` tool calls `Traverser.traverse()` or `Traverser.traverseIncoming()`, returning `TraverseResult[]` with `sourceId`, `targetId`, `type`, `depth`, and a `doc` object containing `{ title, status, date }`. There is no content/snippet in traverse results today. Brief mode for traverse strips `doc` down to just the title string (dropping `status` and `date`), and adds `tags` per hop target for richer graph exploration metadata.

### Key types

- [`SearchResult`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/search.ts#L10-L19) -- has `snippet: string`
- [`TraverseResult`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/traverse.ts#L8-L14) -- has `doc: { title, status, date } | null`
- [`KnowledgeDB.getTags()`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/db.ts#L167-L169) -- returns `string[]` for a document ID

## Desired End State

### Verification
- [ ] `knowledge_search(query, brief=true)` returns results with `id`, `title`, `type`, `date`, `tags`, `score` -- no `snippet`, no `path`, no `status`, no `outcomes_summary`
- [ ] `knowledge_search(query)` and `knowledge_search(query, brief=false)` return identical output to current behavior
- [ ] `knowledge_traverse(from, brief=true)` returns results with `sourceId`, `targetId`, `type`, `depth`, and `doc` containing only `{ title }` plus `tags` array per hop target
- [ ] `knowledge_traverse(from)` and `knowledge_traverse(from, brief=false)` return identical output to current behavior
- [ ] All existing tests pass unchanged
- [ ] New tests cover both modes for both tools

## What We're NOT Doing

- Not adding brief mode to `knowledge_record_outcome` or `knowledge_query_outcomes` (not relevant for graph exploration)
- Not modifying the underlying `HybridSearch`, `FtsSearch`, or `Traverser` modules -- brief mode is handled at the tool handler/formatter layer
- Not changing `SearchResult` or `TraverseResult` TypeScript interfaces -- using optional fields and post-processing
- Not optimizing FTS5 to skip `snippet()` SQL function in brief mode (negligible perf gain at current corpus size)

## Implementation Approach

The plan follows Approach B from the research document: extract formatter helpers into a dedicated `format.ts` module. This keeps `index.ts` thin and makes the formatting logic fully unit-testable without going through the MCP transport layer.

1. **Task 1.1** creates the `format.ts` module with two pure functions: `formatSearchResults` and `formatTraverseResults`. Each takes the enriched results and a `brief` flag, returning the appropriately shaped output.
2. **Task 1.2** writes comprehensive tests for both formatters before the formatters are integrated into `index.ts`.
3. **Task 1.3** wires the formatters into the tool handlers in `index.ts`, adding the `brief` Zod parameter to both tool schemas.

---

## Phase 1: Brief/Full Mode for Document Retrieval (GH-667)

### Overview

Add a `brief` parameter to `knowledge_search` and `knowledge_traverse` tool handlers. Brief mode returns lightweight metadata for cheap graph exploration; full mode (default) preserves current behavior unchanged.

### Tasks

#### Task 1.1: Create format.ts with brief/full formatting helpers

- **files**: `plugin/ralph-knowledge/src/format.ts` (create), `plugin/ralph-knowledge/src/search.ts` (read), `plugin/ralph-knowledge/src/traverse.ts` (read), `plugin/ralph-knowledge/src/db.ts` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [x] File `plugin/ralph-knowledge/src/format.ts` exists and exports `formatSearchResults` and `formatTraverseResults`
  - [x] `formatSearchResults` signature: `(results: EnrichedSearchResult[], brief: boolean) => object[]` where `EnrichedSearchResult` extends `SearchResult` with `tags: string[]` and optional `outcomes_summary`
  - [x] When `brief=true`, `formatSearchResults` returns objects with only: `id`, `title`, `type`, `date`, `tags`, `score` -- no `snippet`, `path`, `status`, or `outcomes_summary`
  - [x] When `brief=false`, `formatSearchResults` returns the full enriched result objects unchanged (passthrough)
  - [x] `formatTraverseResults` signature: `(results: TraverseResult[], getTagsFn: (id: string) => string[], brief: boolean) => object[]`
  - [x] When `brief=true`, `formatTraverseResults` returns objects with `sourceId`, `targetId`, `type`, `depth`, `doc: { title } | null`, and `tags: string[]` (tags of the target document)
  - [x] When `brief=false`, `formatTraverseResults` returns the original `TraverseResult` objects unchanged (passthrough, no tags added)
  - [x] Uses `.js` extension in all imports (ESM requirement)
  - [x] All types are properly imported from their source modules

#### Task 1.2: Add format.test.ts with comprehensive brief/full coverage

- **files**: `plugin/ralph-knowledge/src/__tests__/format.test.ts` (create), `plugin/ralph-knowledge/src/format.ts` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [x] File `plugin/ralph-knowledge/src/__tests__/format.test.ts` exists
  - [x] Test: `formatSearchResults` with `brief=true` omits `snippet`, `path`, `status`, `outcomes_summary` fields
  - [x] Test: `formatSearchResults` with `brief=false` preserves all fields including `snippet` and `outcomes_summary`
  - [x] Test: `formatSearchResults` with `brief=true` retains `id`, `title`, `type`, `date`, `tags`, `score`
  - [x] Test: `formatTraverseResults` with `brief=true` strips `doc` to `{ title }` only and adds `tags` array
  - [x] Test: `formatTraverseResults` with `brief=false` returns original results unchanged (no tags added)
  - [x] Test: `formatTraverseResults` handles `doc: null` case in both modes
  - [x] Test: `formatSearchResults` with empty results array returns empty array in both modes
  - [x] All tests pass via `npm test` from `plugin/ralph-knowledge/`

#### Task 1.3: Wire brief parameter into index.ts tool handlers

- **files**: `plugin/ralph-knowledge/src/index.ts` (modify), `plugin/ralph-knowledge/src/format.ts` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [x] `knowledge_search` Zod schema includes `brief: z.boolean().optional().describe("Return minimal metadata only (default: false)")`
  - [x] `knowledge_traverse` Zod schema includes `brief: z.boolean().optional().describe("Return minimal metadata only (default: false)")`
  - [x] `knowledge_search` handler calls `formatSearchResults(enriched, args.brief ?? false)` before serializing
  - [x] `knowledge_traverse` handler calls `formatTraverseResults(results, (id) => db.getTags(id), args.brief ?? false)` before serializing
  - [x] Import statement: `import { formatSearchResults, formatTraverseResults } from "./format.js";`
  - [x] Existing behavior unchanged when `brief` is omitted (defaults to `false`)
  - [x] `npm run build` from `plugin/ralph-knowledge/` completes with no errors
  - [x] `npm test` from `plugin/ralph-knowledge/` -- all tests pass (existing + new)

### Phase Success Criteria

#### Automated Verification:
- [x] `npm run build` (from `plugin/ralph-knowledge/`) -- no TypeScript errors
- [x] `npm test` (from `plugin/ralph-knowledge/`) -- all tests passing including new format tests

#### Manual Verification:
- [ ] Calling `knowledge_search` with `brief: true` returns results without snippet fields
- [ ] Calling `knowledge_search` without `brief` returns results with snippet fields (unchanged)
- [ ] Calling `knowledge_traverse` with `brief: true` returns results with tags and minimal doc objects
- [ ] Calling `knowledge_traverse` without `brief` returns results identical to current output

---

## Integration Testing

- [x] Build succeeds: `npm run build` from `plugin/ralph-knowledge/`
- [x] Full test suite passes: `npm test` from `plugin/ralph-knowledge/`
- [x] Existing `index.test.ts` still passes (createServer with `:memory:` works)
- [x] Existing `search.test.ts`, `traverse.test.ts`, `hybrid-search.test.ts` pass unchanged

## References

- Research: [thoughts/shared/research/2026-03-24-GH-0667-knowledge-brief-full-mode.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-24-GH-0667-knowledge-brief-full-mode.md)
- Comparison: [thoughts/shared/research/2026-03-24-knowledge-graph-plugin-comparison.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-24-knowledge-graph-plugin-comparison.md)
- Issue: [GH-667](https://github.com/cdubiel08/ralph-hero/issues/667)
- Parent epic: [GH-663](https://github.com/cdubiel08/ralph-hero/issues/663)
