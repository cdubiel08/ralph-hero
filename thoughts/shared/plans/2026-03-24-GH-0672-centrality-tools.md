---
date: 2026-03-24
status: draft
type: plan
github_issue: 672
github_issues: [672]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/672
primary_issue: 672
tags: [ralph-knowledge, graphology, centrality, pagerank, betweenness, mcp-server, graph-algorithms]
---

# knowledge_central and knowledge_bridges Tools (Centrality) - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-24-GH-0672-centrality-tools]]
- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]
- builds_on:: [[2026-03-24-GH-0670-graphology-graph-builder]]
- builds_on:: [[2026-03-24-GH-0671-knowledge-communities-louvain]]

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-672 | knowledge_central and knowledge_bridges centrality tools | S |

## Shared Constraints

- The `plugin/ralph-knowledge/` plugin uses `"type": "module"` with `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`. All internal imports must use `.js` extensions (e.g., `import { foo } from "./graph-builder.js"`).
- TypeScript strict mode is enabled. No `any` types without justification.
- The MCP tool registration pattern is: `server.tool(name, description, schema, async handler)` with `return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }` on success and `{ ..., isError: true }` on error.
- All test files live in `src/__tests__/` and use vitest with in-memory SQLite (`":memory:"`).
- `GraphBuilder` (from GH-670) must be available at [`plugin/ralph-knowledge/src/graph-builder.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/graph-builder.ts) before this work begins. The plan assumes its interface: `new GraphBuilder(db).buildGraph()` returns a `graphology.Graph` with `multi: true`, node attributes `{ title, type, date, status }`, and edge attributes `{ type }`.
- `graph-tools.ts` (from GH-671) must already exist with an exported `registerGraphTools(server: McpServer, db: KnowledgeDB): void` function that registers `knowledge_communities`. This issue extends that function by adding `knowledge_central` and `knowledge_bridges` tool registrations within the same function body.
- `graph-tools.test.ts` (from GH-671) must already exist with community detection tests. This issue extends that test file with centrality-specific test suites.
- `graphology-metrics` must be added to `package.json` dependencies. `graphology-operators` must also be added for `toUndirected()` conversion used by betweenness centrality. `graphology-communities-louvain` is already present (added by GH-671) and is reused for the optional `community` scoping parameter on `knowledge_central`.
- Build command: `npm run build` (tsc) from `plugin/ralph-knowledge/`.
- Test command: `npm test` (vitest run) from `plugin/ralph-knowledge/`.
- Use top-level named imports from `graphology-metrics` (e.g., `import { pagerank } from "graphology-metrics"`) rather than subpath imports to avoid NodeNext module resolution failures. Verify at implementation time: if the top-level barrel export does not re-export `pagerank`, use `import pagerank from "graphology-metrics/centrality/pagerank"` instead and confirm it resolves.

## Current State Analysis

The `plugin/ralph-knowledge/` MCP server currently has four tools registered in [`src/index.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts) within a `createServer(dbPath)` function. After GH-670 and GH-671 ship (both are upstream dependencies), the plugin will also have:

- [`src/graph-builder.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/graph-builder.ts) -- `GraphBuilder` class that produces a graphology `Graph` from the database
- [`src/graph-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/graph-tools.ts) -- `registerGraphTools(server, db)` function registering `knowledge_communities`
- [`src/__tests__/graph-tools.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/graph-tools.test.ts) -- test suite for community detection

The `relationships` table uses typed edges (`builds_on`, `tensions`, `superseded_by`). The graph is sparse -- many documents will be isolated nodes with degree 0. This directly motivates the degree-centrality fallback for PageRank (isolated nodes get uniform PageRank scores, which is unhelpful) and the undirected conversion for betweenness centrality (bridge detection should be direction-agnostic).

## Desired End State

### Verification
- [x] `knowledge_central` MCP tool is callable and returns `{ results: [...], graphSize: { nodes, edges } }`
- [x] Each result entry contains `{ id, title, score, type, date }`
- [x] Optional `community` parameter scopes PageRank to a single Louvain community
- [x] Optional `limit` parameter controls result count (default: 10)
- [x] Isolated nodes (degree 0) get degree-centrality fallback score of 0, ranking below connected nodes
- [x] `knowledge_bridges` MCP tool is callable and returns `{ results: [...], graphSize: { nodes, edges } }`
- [x] Each bridge result entry contains `{ id, title, score, type }`
- [x] Betweenness centrality runs on an undirected conversion of the graph
- [x] Optional `limit` parameter controls result count (default: 10)
- [x] Tests verify PageRank ranking with star-topology fixture (hub ranks highest)
- [x] Tests verify betweenness with barbell-graph fixture (bridge node scores highest)
- [x] Tests verify empty graph returns empty results without error
- [x] Tests verify community-scoped PageRank filters to community members only

## What We're NOT Doing

- Not implementing community detection (already done by sibling GH-671)
- Not implementing path-finding or common connections (sibling GH-673)
- Not persisting centrality scores to the database -- computation is on-demand per call
- Not densifying the graph with untyped wiki links (out of scope; depends on GH-664)
- Not exposing PageRank tuning parameters (alpha, maxIterations, tolerance) to MCP callers -- use sensible defaults
- Not creating a new `graph-tools.ts` file -- extending the existing one from GH-671
- Not modifying `index.ts` -- the `registerGraphTools()` import and call are already wired by GH-671

## Implementation Approach

The work extends the existing `graph-tools.ts` module with two new tools registered inside the already-exported `registerGraphTools()` function. The three tasks are sequential:

1. Add npm dependencies (`graphology-metrics`, `graphology-operators`) needed for centrality algorithms
2. Implement both tools with TDD -- star-topology fixture for PageRank, barbell fixture for betweenness, empty-graph and community-scope edge cases
3. No `index.ts` wiring needed since `registerGraphTools()` is already called by GH-671

The `knowledge_central` tool's optional `community` parameter requires running Louvain inline (using the `graphology-communities-louvain` package already present from GH-671) to partition the graph, then extracting a subgraph of only the specified community's nodes before running PageRank on it.

---

## Phase 1: Add knowledge_central and knowledge_bridges MCP Tools (GH-672)

### Overview

Extend the existing `graph-tools.ts` with two centrality-based MCP tools and add comprehensive tests using star-topology and barbell-graph fixtures.

### Tasks

#### Task 1.1: Add graphology-metrics and graphology-operators npm dependencies
- **files**: [`plugin/ralph-knowledge/package.json`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/package.json) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `"graphology-metrics"` is present in `dependencies` of `plugin/ralph-knowledge/package.json` (use latest stable, e.g., `"^2.4.0"`)
  - [ ] `"graphology-operators"` is present in `dependencies` (e.g., `"^1.6.0"`)
  - [ ] `npm install` from `plugin/ralph-knowledge/` completes without error
  - [ ] `npm run build` passes (no compile errors from new deps)

#### Task 1.2: Implement knowledge_central tool with TDD
- **files**: [`plugin/ralph-knowledge/src/graph-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/graph-tools.ts) (modify), [`plugin/ralph-knowledge/src/__tests__/graph-tools.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/graph-tools.test.ts) (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `knowledge_central` tool is registered inside the existing `registerGraphTools()` function in `graph-tools.ts`
  - [ ] Tool accepts optional `community: z.number().optional().describe("Community ID to scope ranking (from knowledge_communities)")`
  - [ ] Tool accepts optional `limit: z.number().optional().describe("Max results (default: 10)")` with default 10
  - [ ] On call, builds graph via `new GraphBuilder(db).buildGraph()`, then runs `pagerank(graph)` from `graphology-metrics`
  - [ ] After PageRank, detects isolated nodes via `graph.degree(node) === 0` and sets their score to 0.0 (degree-centrality fallback per obra's approach -- isolated nodes rank last since they have no connections)
  - [ ] Results are sorted by score descending and sliced to `limit`
  - [ ] Each result entry shape: `{ id: string, title: string | null, score: number, type: string | null, date: string | null }`
  - [ ] Return value shape: `{ results: Result[], graphSize: { nodes: number, edges: number } }`
  - [ ] When `community` parameter is provided: runs Louvain via `louvain(graph)` to get partition `{ [nodeId]: communityNumber }`, filters graph to nodes where `partition[nodeId] === community`, creates a subgraph with `graph.copy()` + `graph.dropNode()` for non-members, then runs PageRank on the subgraph
  - [ ] When `community` parameter references a non-existent community ID, returns empty results (no error)
  - [ ] Empty graph returns `{ results: [], graphSize: { nodes: 0, edges: 0 } }` without error
  - [ ] Error path: returns `{ content: [{ type: "text", text: "Error: ..." }], isError: true }`
  - [ ] **Test: star topology** -- 4 docs: doc-hub, doc-a, doc-b, doc-c. All 3 leaf docs have `builds_on` edges pointing to doc-hub. Expected: doc-hub has the highest PageRank score among the 4 nodes
  - [ ] **Test: empty graph** -- no documents inserted. Expected: results array is empty, graphSize.nodes is 0
  - [ ] **Test: isolated nodes rank last** -- 3 docs: doc-connected-a, doc-connected-b (with `builds_on` edge between them), doc-isolated (no edges). Expected: doc-isolated has score 0.0, both connected docs have score > 0
  - [ ] **Test: community-scoped PageRank** -- 6 docs forming 2 clear clusters (3 nodes each, connected within cluster). Call with `community: 0`. Expected: results contain only nodes from community 0 (3 or fewer results)
  - [ ] `npm run build` passes
  - [ ] `npm test` passes

#### Task 1.3: Implement knowledge_bridges tool with TDD
- **files**: [`plugin/ralph-knowledge/src/graph-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/graph-tools.ts) (modify), [`plugin/ralph-knowledge/src/__tests__/graph-tools.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/graph-tools.test.ts) (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] `knowledge_bridges` tool is registered inside the existing `registerGraphTools()` function in `graph-tools.ts`
  - [ ] Tool accepts optional `limit: z.number().optional().describe("Max results (default: 10)")` with default 10
  - [ ] On call, builds graph via `new GraphBuilder(db).buildGraph()`, converts to undirected via `toUndirected(graph)` from `graphology-operators`, then runs `betweennessCentrality(undirectedGraph, { normalized: true })` from `graphology-metrics`
  - [ ] Uses undirected graph for betweenness because bridge documents connect topical clusters regardless of edge direction
  - [ ] Results are sorted by score descending and sliced to `limit`
  - [ ] Each result entry shape: `{ id: string, title: string | null, score: number, type: string | null }`
  - [ ] Return value shape: `{ results: Result[], graphSize: { nodes: number, edges: number } }` (graphSize reflects original directed graph, not the undirected conversion)
  - [ ] Nodes with score 0 are excluded from results (they are not bridges)
  - [ ] Empty graph returns `{ results: [], graphSize: { nodes: 0, edges: 0 } }` without error
  - [ ] Error path: returns `{ content: [{ type: "text", text: "Error: ..." }], isError: true }`
  - [ ] **Test: barbell graph** -- 5 docs: cluster 1 (doc-a, doc-b connected), cluster 2 (doc-c, doc-d connected), bridge (doc-bridge connected to both doc-b and doc-c via `builds_on` edges). Expected: doc-bridge has the highest betweenness score
  - [ ] **Test: empty graph** -- no documents inserted. Expected: results array is empty
  - [ ] **Test: fully disconnected graph** -- 3 isolated docs with no edges. Expected: results array is empty (all scores are 0, excluded)
  - [ ] **Test: linear chain** -- 4 docs in a chain: a -> b -> c -> d. Expected: b and c have higher betweenness than a and d (inner nodes sit on more shortest paths)
  - [ ] `npm run build` passes
  - [ ] `npm test` passes

### Phase Success Criteria

#### Automated Verification:
- [x] `npm run build` from `plugin/ralph-knowledge/` -- no TypeScript errors
- [x] `npm test` from `plugin/ralph-knowledge/` -- all tests passing (including new centrality tests in graph-tools.test.ts)

#### Manual Verification:
- [ ] Call `knowledge_central` via MCP client with an indexed knowledge base and confirm results array is non-empty with scores sorted descending
- [ ] Call `knowledge_central` with `community: 0` and confirm results are scoped to a single community
- [ ] Call `knowledge_bridges` and confirm bridge documents (if any) appear with non-zero betweenness scores
- [ ] Verify isolated documents in the knowledge base have score 0 in `knowledge_central` results

---

## Integration Testing

- [ ] Start the MCP server against a real knowledge DB with at least 10 indexed documents and typed relationships
- [ ] Call `knowledge_central` with no args -- verify response includes ranked documents and graphSize metadata
- [ ] Call `knowledge_central` with `limit: 3` -- verify exactly 3 results returned
- [ ] Call `knowledge_bridges` -- verify response includes bridge documents (or empty results if graph is too sparse)
- [ ] Verify `knowledge_search`, `knowledge_traverse`, and `knowledge_communities` still work correctly after adding the two new tools
- [ ] Verify both tools handle the empty-database edge case without crashing the MCP server

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-24-GH-0672-centrality-tools.md
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/666
- GraphBuilder dependency: https://github.com/cdubiel08/ralph-hero/issues/670
- Community detection sibling: https://github.com/cdubiel08/ralph-hero/issues/671
- graphology-metrics docs: https://graphology.github.io/standard-library/metrics
- PageRank: https://graphology.github.io/standard-library/metrics#pagerank
- Betweenness centrality: https://graphology.github.io/standard-library/metrics#betweenness-centrality
- obra's degree centrality fallback: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-24-knowledge-graph-plugin-comparison.md
