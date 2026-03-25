---
date: 2026-03-24
status: draft
type: plan
github_issue: 673
github_issues: [673]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/673
primary_issue: 673
tags: [graphology, knowledge-graph, path-finding, dfs, mcp-tools, ralph-knowledge]
---

# knowledge_paths and knowledge_common Tools - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-24-GH-0673-knowledge-paths-and-common-tools]]
- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]

## Overview

1 issue implementing two connection-discovery MCP tools in the ralph-knowledge plugin.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-673 | knowledge_paths and knowledge_common tools | S |

## Shared Constraints

- **ESM module system**: All internal imports require `.js` extensions (e.g., `import { foo } from "./graph-builder.js"`). The plugin uses `"type": "module"` with TypeScript `"module": "NodeNext"`.
- **Tool registration pattern**: `graph-tools.ts` must export `registerGraphTools(server: McpServer, db: KnowledgeDB)`. All five graph tools from issues #671, #672, and #673 share this single module and single export. Index.ts calls it once.
- **Dependency on #670**: `graph-builder.ts` and the `GraphBuilder` class must exist before this issue can be built. The implementation imports `GraphBuilder` from `./graph-builder.js`. If `graph-builder.ts` does not exist yet, this issue is blocked.
- **Graph topology assumption**: The `GraphBuilder` from #670 is assumed to produce an **undirected** graphology `Graph` (matching obra's approach). If it produces a directed graph, the DFS must union `graph.inNeighbors(n)` and `graph.outNeighbors(n)` instead of calling `graph.neighbors(n)`. This must be confirmed with the #670 implementation before writing the DFS.
- **No new npm dependencies**: `graphology` is added by #670 to `package.json`. This issue adds no additional packages.
- **Max 20 paths hard cap**: The DFS early-terminates when `results.length >= 20`. This prevents combinatorial explosion and is not configurable by callers.
- **Error handling pattern**: Tool handlers wrap logic in `try/catch` and return `{ content: [{ type: "text", text: "Error: ..." }], isError: true }` on failure. Match the pattern in `index.ts`.
- **In-memory SQLite for tests**: Use `new KnowledgeDB(":memory:")` as the test fixture database, matching the pattern in `traverse.test.ts`.

## Current State Analysis

The ralph-knowledge plugin (`plugin/ralph-knowledge/`) provides:
- `KnowledgeDB` with typed relationship edges (`builds_on`, `tensions`, `superseded_by`) stored in the `relationships` table
- `Traverser` for linear CTE-based edge walking
- `index.ts` registering four tools: `knowledge_search`, `knowledge_traverse`, `knowledge_record_outcome`, `knowledge_query_outcomes`
- No graphology dependency, no `graph-builder.ts`, no `graph-tools.ts`

The sibling issues #671 (community detection) and #672 (centrality/bridges) also target `graph-tools.ts`. All three issues assume that `GraphBuilder` from #670 produces a graphology `Graph` populated from the `relationships` table.

The `relationships` table constrains `type` to `('builds_on', 'tensions', 'superseded_by')`. The graph is intentionally sparse — only explicitly declared typed relationships form edges. Paths between documents that share only untyped wiki links will not be found.

## Desired End State

### Verification
- [x] `knowledge_paths` returns all simple paths between two connected documents, capped at 20
- [x] `knowledge_paths` returns empty array when no path exists
- [x] `knowledge_paths` respects `maxDepth` parameter (default: 5)
- [x] `knowledge_common` returns shared neighbors of two documents with full metadata
- [x] `knowledge_common` returns empty array when no shared connections exist
- [x] Tests pass with diamond-topology fixture covering both tools
- [x] `registerGraphTools` is called from `index.ts` and both tools are live in the MCP server

## What We're NOT Doing

- Implementing `knowledge_communities` (sibling #671)
- Implementing `knowledge_centrality` or `knowledge_bridges` (sibling #672)
- Adding `graphology` to `package.json` — that belongs to #670
- Implementing `GraphBuilder` — that belongs to #670
- Supporting configurable path caps above 20
- Tracking edge types along paths (v1 returns node IDs and titles only)

## Implementation Approach

The work is contained in two files: `graph-tools.ts` (new) and `graph-tools.test.ts` (new). A third file, `index.ts`, gets a one-line addition. The DFS function is a module-private helper; the tool handlers delegate to it and enrich results with titles from graph node attributes. Tests use the same in-memory SQLite pattern as `traverse.test.ts` and drive the tools through `GraphBuilder` directly rather than through the MCP server.

---

## Phase 1: Atomic Issue GH-673 — knowledge_paths and knowledge_common tools

### Overview

Create `graph-tools.ts` with a module-private DFS function and two registered MCP tools (`knowledge_paths`, `knowledge_common`). Add diamond-topology tests. Wire into `index.ts`.

### Tasks

#### Task 1.1: Implement findAllSimplePaths DFS helper
- **files**: `plugin/ralph-knowledge/src/graph-tools.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Module exports only `registerGraphTools` — `findAllSimplePaths` is not exported
  - [ ] `findAllSimplePaths(graph, source, target, maxDepth)` returns `string[][]`
  - [ ] Uses a `visited: Set<string>` for cycle prevention with backtracking (push on entry, delete on return)
  - [ ] Calls `graph.neighbors(node)` for undirected traversal (if GraphBuilder produces directed graph, use union of `graph.inNeighbors` + `graph.outNeighbors` instead — confirm with #670)
  - [ ] Returns as soon as target is reached and pushes completed path to results
  - [ ] Prunes recursion when current depth equals maxDepth without reaching target
  - [ ] Early-terminates entire DFS when `results.length >= 20`
  - [ ] Returns `[]` when source equals target (no self-paths)
  - [ ] Returns `[]` when source or target is not in the graph

#### Task 1.2: Implement knowledge_paths MCP tool registration
- **files**: `plugin/ralph-knowledge/src/graph-tools.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Tool name: `"knowledge_paths"`
  - [ ] Parameters: `source: z.string()`, `target: z.string()`, `maxDepth: z.number().optional()` (default: 5)
  - [ ] Creates a `GraphBuilder(db)` instance on each invocation and calls `.build()` to get the graph
  - [ ] Calls `findAllSimplePaths(graph, source, target, maxDepth)` to get raw paths (arrays of node IDs)
  - [ ] Enriches each path: maps each node ID to `{ id: string; title: string }` using `graph.getNodeAttribute(id, "title")` or falls back to the raw ID string if no title attribute
  - [ ] Returns `Array<Array<{ id: string; title: string }>>` serialised as JSON in the content text field
  - [ ] Returns `[]` (empty array, not an error) when no paths exist
  - [ ] Wraps logic in try/catch returning `isError: true` on exception

#### Task 1.3: Implement knowledge_common MCP tool registration
- **files**: `plugin/ralph-knowledge/src/graph-tools.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Tool name: `"knowledge_common"`
  - [ ] Parameters: `docA: z.string()`, `docB: z.string()`
  - [ ] Creates a `GraphBuilder(db)` instance on each invocation and calls `.build()` to get the graph
  - [ ] Computes neighbors of `docA`: `new Set(graph.neighbors(docA))` (or union of in+out for directed)
  - [ ] Computes neighbors of `docB`: `new Set(graph.neighbors(docB))`
  - [ ] Intersection: node IDs present in both sets
  - [ ] Enriches each shared node: `{ id: string; title: string; type: string | null; connectionToA: string; connectionToB: string }` where `connectionToA`/`connectionToB` are the relationship type of the edge connecting the shared node to docA/docB respectively, or `"neighbor"` if the type is unavailable
  - [ ] Returns the enriched array serialised as JSON
  - [ ] Returns `[]` when intersection is empty
  - [ ] Wraps logic in try/catch returning `isError: true` on exception

#### Task 1.4: Write diamond-topology test fixture and tests
- **files**: `plugin/ralph-knowledge/src/__tests__/graph-tools.test.ts` (create), `plugin/ralph-knowledge/src/graph-tools.ts` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.2, 1.3]
- **acceptance**:
  - [ ] Uses `new KnowledgeDB(":memory:")` as the test database — no disk I/O
  - [ ] Inserts documents: `doc-a` (title "Doc A"), `doc-b` (title "Doc B"), `doc-c` (title "Doc C"), `doc-d` (title "Doc D")
  - [ ] Inserts edges: `doc-a builds_on doc-b`, `doc-a builds_on doc-c`, `doc-a builds_on doc-d`, `doc-d builds_on doc-b`, `doc-d builds_on doc-c` (diamond: A→B, A→C, A→D direct, D→B, D→C forms diamond)
  - [ ] `knowledge_paths` test: finds paths from `doc-a` to `doc-b` — expects at least two paths: `[doc-a, doc-b]` and `[doc-a, doc-d, doc-b]`
  - [ ] `knowledge_paths` test: `maxDepth=1` returns only direct path `[doc-a, doc-b]`, not the two-hop path through doc-d
  - [ ] `knowledge_paths` test: source and target with no connection returns `[]`
  - [ ] `knowledge_common` test: `knowledge_common(doc-a, doc-d)` returns `[doc-b, doc-c]` as shared connections
  - [ ] `knowledge_common` test: two disconnected docs return `[]`
  - [ ] All tests use `describe`/`it`/`expect` from vitest with `beforeEach` fixture setup

#### Task 1.5: Wire registerGraphTools into index.ts
- **files**: `plugin/ralph-knowledge/src/index.ts` (modify), `plugin/ralph-knowledge/src/graph-tools.ts` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2, 1.3]
- **acceptance**:
  - [ ] `import { registerGraphTools } from "./graph-tools.js"` added to `index.ts`
  - [ ] `registerGraphTools(server, db)` called inside `createServer()` after the existing tool registrations
  - [ ] No existing tools or exports removed or changed
  - [ ] `npm run build` succeeds with no TypeScript errors

### Phase Success Criteria

#### Automated Verification:
- [x] `npm run build` — no TypeScript errors (run from `plugin/ralph-knowledge/`)
- [x] `npx vitest run src/__tests__/graph-tools.test.ts` — all tests passing (run from `plugin/ralph-knowledge/`)

#### Manual Verification:
- [ ] `knowledge_paths` and `knowledge_common` appear in the MCP server tool list when started locally
- [ ] `knowledge_paths` called with two unrelated document IDs returns `[]` without error

**Creates for next phase**: N/A — this is the only phase.

---

## Integration Testing
- [x] Full `npm test` passes (all existing tests continue to pass) after `registerGraphTools` is wired in
- [x] `knowledge_traverse` and `knowledge_search` tools remain unaffected (no regressions)

## References
- Research: [thoughts/shared/research/2026-03-24-GH-0673-knowledge-paths-and-common-tools.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-24-GH-0673-knowledge-paths-and-common-tools.md)
- Parent issue: [#666](https://github.com/cdubiel08/ralph-hero/issues/666)
- Depends on: [#670](https://github.com/cdubiel08/ralph-hero/issues/670) (GraphBuilder)
- Sibling: [#671](https://github.com/cdubiel08/ralph-hero/issues/671) (community detection), [#672](https://github.com/cdubiel08/ralph-hero/issues/672) (centrality/bridges)
- obra DFS reference: [obra/knowledge-graph](https://github.com/obra/knowledge-graph)
- graphology neighbors API: [graphology.github.io/iteration#neighbors](https://graphology.github.io/iteration#neighbors)
