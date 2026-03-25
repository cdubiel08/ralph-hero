---
date: 2026-03-24
github_issue: 673
github_url: https://github.com/cdubiel08/ralph-hero/issues/673
status: complete
type: research
tags: [graphology, knowledge-graph, path-finding, dfs, mcp-tools, ralph-knowledge]
---

# Research: knowledge_paths and knowledge_common Tools

## Prior Work

- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]

## Problem Statement

Issue #673 asks for two new MCP tools on top of a graphology-based graph:

- **`knowledge_paths`** — DFS all simple paths between two documents (up to `maxDepth`, capped at 20 paths)
- **`knowledge_common`** — set intersection of neighbors shared by two documents

Both tools depend on `GraphBuilder` from issue #670 (not yet implemented). This research characterises what the implementation needs to know before coding begins: the correct graphology API, the DFS algorithm pattern from obra's reference implementation, the graph topology limitations specific to ralph-knowledge, and the test fixture shapes required by the acceptance criteria.

## Current State Analysis

### What exists today

The ralph-knowledge plugin has:
- `KnowledgeDB` — SQLite schema with `documents`, `relationships`, and `tags` tables ([`plugin/ralph-knowledge/src/db.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/db.ts))
- `Traverser` — recursive CTE that walks typed edges linearly ([`plugin/ralph-knowledge/src/traverse.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/traverse.ts))
- `index.ts` — MCP server registering `knowledge_search`, `knowledge_traverse`, `knowledge_record_outcome`, `knowledge_query_outcomes` ([`plugin/ralph-knowledge/src/index.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts))

No `graph-builder.ts`, no `graph-tools.ts`, no graphology dependency — all of that is introduced by #670 (graph builder) and the sibling issues #671/#672 (community detection, centrality).

### Relationships schema constraint

The `relationships` table constrains `type` to `('builds_on', 'tensions', 'superseded_by')` and has no support for untyped wiki-link edges (a known limitation from the obra comparison research). This makes our graph intentionally sparse — approximately 200 documents with only explicitly declared typed relationships form edges. Paths between documents that only share untyped wiki links will not be found. This is acceptable for v1 but should be noted in the tool's documentation.

### Dependency on #670

`knowledge_paths` and `knowledge_common` both require a `Graph` object built by `GraphBuilder`. Until #670 is implemented, these tools cannot be registered. The implementation must import from `graph-builder.js` (which will be created by #670) and accept a `GraphBuilder` instance in its module factory function.

## Key Discoveries

### 1. graphology-shortest-path does NOT provide DFS all-paths

Despite the issue referencing `graphology-shortest-path` for path finding, that package only implements:
- `bidirectional()` — single shortest (BFS) path
- `singleSource()` — shortest paths from one source to all nodes
- `dijkstra.bidirectional()` / `dijkstra.singleSource()` — weighted variants
- `astar.bidirectional()` — heuristic weighted path

There is **no `allSimplePaths` or DFS enumeration function** in `graphology-shortest-path`. The issue body references it, but this is misleading. The correct approach, confirmed by obra's implementation, is a hand-written DFS with a visited set.

### 2. obra's DFS implementation pattern

From the obra/knowledge-graph source (`src/lib/graph.ts`), the reference `findAllSimplePaths` is:

```typescript
function findAllSimplePaths(
  graph: Graph,
  from: string,
  to: string,
  maxDepth: number,
): string[][]
```

- Uses a `visited: Set<string>` to prevent cycles
- DFS with backtracking: push to path + visited, recurse into neighbors, pop from both on return
- Returns when target is reached; prunes when depth is exhausted
- Calls `graph.neighbors(node)` — which on a directed graph returns only outgoing neighbors

**Critical topology note**: obra's graph treats all wiki links as undirected and calls `commonNeighbors` by unioning both in/out neighbor sets. Our `GraphBuilder` (per issue #670) will produce a **directed** graph where edges follow the relationship direction (`source_id → target_id`). For path finding to work across the sparse typed-relationship graph, the DFS should walk both outgoing (`graph.outNeighbors`) and incoming (`graph.inNeighbors`) neighbors, effectively treating the graph as undirected. Otherwise `knowledge_paths` will fail to find paths whenever the traversal direction doesn't match the edge direction.

Alternatively, the `GraphBuilder` from #670 could build an undirected graphology `Graph` — this is the simpler choice and matches obra's approach. The implementation decision belongs to #670, but #673's implementer needs to confirm the graph type before choosing the DFS neighbor method.

### 3. `knowledge_common` uses neighbor set intersection

The implementation is straightforward:
1. `new Set(graph.neighbors(docA))` — all neighbors of docA
2. `new Set(graph.neighbors(docB))` — all neighbors of docB
3. Intersection: nodes present in both sets
4. Enrich with title and type from graph node attributes

If the graph is directed, use `graph.inNeighbors(node)` unioned with `graph.outNeighbors(node)` to compute all adjacencies.

### 4. Combinatorial explosion guard

DFS over an undirected graph with even modest connectivity can produce thousands of paths. The acceptance criteria cap is **20 paths**. The DFS must implement early termination: once `results.length >= 20`, stop exploring further branches. This prevents runaway execution even if `maxDepth` is generous.

### 5. Registration pattern

The existing MCP tools are registered inline in `index.ts`. Sibling issues #671 and #672 both specify adding to `graph-tools.ts` and registering from there. Issue #673 specifies the same file: `plugin/ralph-knowledge/src/graph-tools.ts`.

The pattern used in `index.ts` is:
```typescript
server.tool("tool_name", "description", { param: z.type() }, async (args) => { ... });
```

`graph-tools.ts` should export a `registerGraphTools(server, db)` function that creates a `GraphBuilder(db)` and registers all five graph tools (communities from #671, centrality + bridges from #672, paths + common from #673). The `index.ts` then calls `registerGraphTools(server, db)`.

### 6. Test fixture requirements

**`knowledge_paths` test** (acceptance criterion: "graph with multiple routes between two nodes"):

A diamond topology is the minimal fixture:
```
A → B → D
A → C → D
```
This yields two paths: `[A, B, D]` and `[A, C, D]`. Add `A → D` for a direct edge (three paths). Verify `maxDepth=1` returns only `[A, D]`.

**`knowledge_common` test** (acceptance criterion: "diamond-shaped fixture"):
```
A → B
A → C
D → B
D → C
```
`knowledge_common(A, D)` should return `[B, C]` as shared connections.

Both tests can be combined in a single fixture (all four nodes with edges A→B, A→C, A→D, D→B, D→C, B→D) to cover all edge cases.

### 7. TypeScript integration

`graph-tools.ts` will need to import:
- `graphology` (the `Graph` type)
- `./graph-builder.js` (the `GraphBuilder` class from #670)
- `./db.js` (the `KnowledgeDB` type)
- `zod` (for parameter schemas)
- `@modelcontextprotocol/sdk/server/mcp.js` (for `McpServer`)

The return type of `knowledge_paths` is `Array<Array<{ id: string; title: string }>>` — each path is an ordered list of node objects. The return type of `knowledge_common` is `Array<{ id: string; title: string; type: string | null; connectionToA: string; connectionToB: string }>`. The `connectionToA` and `connectionToB` fields describe the edge type (e.g., "neighbor" or the relationship type if available).

## Potential Approaches

### Option A: DFS in graph-tools.ts (recommended)

Implement `findAllSimplePaths` as a module-private function in `graph-tools.ts`. The function takes a `Graph`, source, target, and maxDepth, and returns `string[][]`. Tool wraps this and enriches with titles from graph attributes.

**Pros**: Self-contained, no additional dependency, matches obra's approach, easy to test.
**Cons**: Slightly more code than using a library function.

### Option B: Use graphology-traversal for DFS iteration

`graphology-traversal` provides a `dfs(graph, callback)` function that visits all nodes in DFS order. It does not support source-to-target path extraction — it is a full-graph traversal only. Not suitable for all-paths enumeration.

**Verdict**: Not applicable.

### Option C: Depend on graphology-shortest-path allPaths

Does not exist in the package. Not applicable.

## Risks

1. **#670 not complete**: This issue is blocked until `graph-builder.ts` exists. Cannot be implemented in parallel with #670 unless a stub is used.

2. **Directed vs undirected graph topology**: If `GraphBuilder` produces a directed graph and the DFS only follows outgoing edges, paths will be missed. Must confirm with #670 implementer or document the assumption. Recommended: `GraphBuilder` builds undirected, or DFS uses `graph.neighbors()` on an undirected graph.

3. **Sparse graph yields empty results**: With only typed relationships (`builds_on`, `tensions`, `superseded_by`), most document pairs will have no connecting path. This is expected and documented, but callers may be surprised. Tool should return a helpful empty array (not an error).

4. **Max 20 paths cap**: The DFS must short-circuit when 20 paths are found. Without this, a densely connected subgraph (e.g., a document that tensions five others, each of which builds on the target) could produce combinatorial path counts.

## Recommended Next Steps

1. Confirm with #670 whether `GraphBuilder` builds a directed or undirected graphology `Graph`. If directed, document that `knowledge_paths` and `knowledge_common` will use `graph.neighbors()` treating edges as undirected (by unioning in+out neighbors).
2. Implement `graph-tools.ts` with the `registerGraphTools(server, db)` export pattern shared by all five graph tools (#671, #672, #673).
3. Implement `findAllSimplePaths` as a module-private recursive DFS function.
4. Use the diamond + direct-edge fixture for both path and common-connection tests.
5. Register `knowledge_paths` and `knowledge_common` using `z.string()` for `source`/`target`/`docA`/`docB`, `z.number().optional()` for `maxDepth`.
6. Add `registerGraphTools` call to `index.ts` after #670 is merged.

## Files Affected

### Will Modify
- `plugin/ralph-knowledge/src/graph-tools.ts` - New file: register knowledge_paths and knowledge_common MCP tools; private findAllSimplePaths DFS function
- `plugin/ralph-knowledge/src/__tests__/graph-tools.test.ts` - New file: diamond fixture tests for both tools
- `plugin/ralph-knowledge/src/index.ts` - Add registerGraphTools call after GraphBuilder is available

### Will Read (Dependencies)
- `plugin/ralph-knowledge/src/db.ts` - KnowledgeDB type and relationship schema
- `plugin/ralph-knowledge/src/graph-builder.ts` - GraphBuilder class from #670 (not yet created)
- `plugin/ralph-knowledge/package.json` - Confirm graphology packages added by #670
