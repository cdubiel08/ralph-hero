---
date: 2026-03-24
github_issue: 672
github_url: https://github.com/cdubiel08/ralph-hero/issues/672
status: complete
type: research
tags: [ralph-knowledge, graphology, centrality, pagerank, betweenness, mcp-server]
---

# Research: knowledge_central and knowledge_bridges Tools (Centrality)

## Prior Work

- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]

## Problem Statement

Issue #672 asks for two centrality-based MCP tools in `plugin/ralph-knowledge`:

- `knowledge_central` — ranks documents by importance using PageRank, with optional community scope filter and degree-centrality fallback for disconnected graphs
- `knowledge_bridges` — identifies connector documents using betweenness centrality (documents that sit on shortest paths between many pairs of other nodes)

Both tools depend on issue #670 (GraphBuilder module) which provides the in-memory graphology graph constructed from the `documents` and `relationships` tables. Issue #671 (community detection) is a sibling and shares the target file `graph-tools.ts`.

## Current State Analysis

### What Exists

The `plugin/ralph-knowledge` codebase has:

- `src/db.ts` — `KnowledgeDB` class with `documents`, `relationships`, and `tags` tables. The `relationships` table stores typed edges (`builds_on`, `tensions`, `superseded_by`) only. No graphology dependency present.
- `src/traverse.ts` — `Traverser` class using recursive CTEs for linear chain traversal. No graph algorithm support.
- `src/index.ts` — MCP server registering 4 tools: `knowledge_search`, `knowledge_traverse`, `knowledge_record_outcome`, `knowledge_query_outcomes`. The `createServer()` function instantiates all dependencies and returns them.
- `package.json` — No graphology dependency. Current deps: `@huggingface/transformers`, `@modelcontextprotocol/sdk`, `better-sqlite3`, `sqlite-vec`, `yaml`, `zod`.

### What Does Not Exist

- `src/graph-builder.ts` — Created by issue #670. This is the required upstream.
- `src/graph-tools.ts` — Must be created by this issue (shared with sibling #671).
- `src/__tests__/graph-tools.test.ts` — Must be created.
- graphology packages in `package.json`.

### Dependency Relationship

Issue #670 must deliver before #672 can ship, but research can proceed since the GraphBuilder API surface is specified in the #670 acceptance criteria:

```typescript
class GraphBuilder {
  constructor(db: KnowledgeDB)
  buildGraph(): Graph  // returns graphology.Graph with nodes (documents) and edges (relationships)
}
// Node attributes: { title, type, date, status }
// Edge attributes: { type } — 'builds_on' | 'tensions' | 'superseded_by' | untyped
```

## Key Discoveries

### graphology Package Landscape

graphology v0.26.0 bundles its own TypeScript types at `dist/graphology.d.ts` and requires `graphology-types` as a peer dependency. No `@types/graphology` package exists on npm — types are first-party.

Relevant packages for this issue:

| Package | Version | Purpose |
|---------|---------|---------|
| `graphology` | 0.26.0 | Core graph data structure |
| `graphology-types` | 0.24.8 | TypeScript declarations (peer dep) |
| `graphology-metrics` | 2.4.0 | PageRank + betweenness centrality |

Issue #670 is responsible for adding `graphology` to `package.json`. Issue #672 needs `graphology-metrics` added. The exact package set for both issues:

```json
"graphology": "^0.26.0",
"graphology-types": "^0.24.8",
"graphology-metrics": "^2.4.0"
```

### PageRank API (knowledge_central)

Import path: `graphology-metrics/centrality/pagerank`

```typescript
import pagerank from 'graphology-metrics/centrality/pagerank';

const scores: Record<string, number> = pagerank(graph, {
  alpha: 0.85,         // damping factor (default)
  maxIterations: 100,  // convergence iterations (default)
  tolerance: 1e-6,     // convergence threshold (default)
});
// scores: { [nodeId]: number }
```

**Critical: Disconnected graph fallback.** PageRank on a graph with isolated nodes (no edges) returns uniform scores — all nodes rank equally. obra's approach uses degree centrality as fallback for isolated components. In our corpus, a document with no `builds_on`/`tensions`/`superseded_by` links is isolated. Since our graph is sparse (typed relationships only), many documents will be isolated. The fallback strategy:

1. Run PageRank on the full graph.
2. For any isolated node (degree === 0), substitute its score with a degree-centrality score: `degree / (totalNodes - 1)`. For truly isolated nodes this is 0, but it correctly distinguishes them from connected nodes.
3. Alternative: construct a denser graph by including untyped wiki links from issue #664 (out of scope for this issue). For now, accept the sparse-graph limitation.

The issue acceptance criteria says "falls back to degree centrality for isolated components (per obra's approach)." Implementation: after calling `pagerank()`, detect nodes with `graph.degree(node) === 0` and compute `inDegree / totalNodes` as their score.

### Betweenness Centrality API (knowledge_bridges)

Import path: `graphology-metrics/centrality/betweenness`

```typescript
import betweennessCentrality from 'graphology-metrics/centrality/betweenness';

const scores: Record<string, number> = betweennessCentrality(graph, {
  normalized: true,    // normalize by (n-1)(n-2) for directed graphs
});
// scores: { [nodeId]: number }
```

**Note on directed vs. undirected:** Our graph (from the GraphBuilder) is directed — `builds_on` edges go from newer doc to older doc. Betweenness centrality on a directed graph finds nodes on directed shortest paths. For detecting bridge documents that connect clusters, an undirected view may be more useful (e.g., doc A builds_on doc B creates an undirected relationship). The implementation should convert to undirected OR use graphology's `toUndirected()` utility for betweenness. This needs a decision.

**Recommended approach:** Use undirected betweenness. Rationale: "bridge" documents in our context connect topical clusters regardless of edge direction — a bridge between "caching research" and "auth research" is a bridge whether the link points left or right.

```typescript
import { toUndirected } from 'graphology-operators';
const undirected = toUndirected(graph);
const scores = betweennessCentrality(undirected, { normalized: true });
```

This requires `graphology-operators` as an additional dependency.

### Module Registration Pattern

`src/index.ts` uses a `createServer(dbPath)` function that instantiates all dependencies. The cleanest pattern for adding graph tools:

```typescript
// In index.ts createServer():
import { registerGraphTools } from './graph-tools.js';
// ...
registerGraphTools(server, db);
```

The `registerGraphTools` function in `graph-tools.ts` accepts `server: McpServer` and `db: KnowledgeDB`, constructs a `GraphBuilder` internally, and registers the MCP tools. This mirrors the pattern used by `registerXyzTools()` in ralph-hero's MCP server (`plugin/ralph-hero/mcp-server/src/tools/`).

**Shared file with sibling #671:** Both `knowledge_communities` (#671) and `knowledge_central`/`knowledge_bridges` (#672) write to `graph-tools.ts`. If implemented sequentially, whichever comes second must extend rather than replace. If parallel, they should coordinate on the `registerGraphTools` function signature to avoid merges. Recommended: define a single exported `registerGraphTools(server, db)` that registers all graph tools (communities + central + bridges), keeping the registration entry point unified.

### TypeScript Import Considerations

The project uses `"module": "NodeNext"` with `.js` extension imports. graphology-metrics subpath imports (`graphology-metrics/centrality/pagerank`) must be verified for NodeNext compatibility. If they fail, the fallback is:

```typescript
import { pagerank, betweennessCentrality } from 'graphology-metrics';
```

The graphology-metrics package provides both named exports from the top-level index and subpath imports. Top-level imports are safer with NodeNext.

### Test Fixture Design

**Star topology for knowledge_central:**

```
     doc-hub
    /   |   \
doc-a doc-b doc-c  (all point TO hub: doc-a builds_on doc-hub, etc.)
```

Or: hub points to 3 leaves. In PageRank, nodes that receive many incoming links rank highest. So for `builds_on` edges (A builds on B = edge A→B), B is the hub that should rank highest if many docs build on it.

```typescript
// Star: doc-hub is pointed to by 3 docs
db.addRelationship("doc-a", "doc-hub", "builds_on");
db.addRelationship("doc-b", "doc-hub", "builds_on");
db.addRelationship("doc-c", "doc-hub", "builds_on");
// Expected: doc-hub has highest PageRank score
```

**Barbell graph for knowledge_bridges:**

```
doc-a -- doc-b -- doc-bridge -- doc-c -- doc-d
```

Two clusters connected by a single bridge node:

```typescript
// Cluster 1: doc-a ↔ doc-b
db.addRelationship("doc-a", "doc-b", "builds_on");
// Bridge: doc-b ↔ doc-bridge ↔ doc-c
db.addRelationship("doc-b", "doc-bridge", "builds_on");
db.addRelationship("doc-bridge", "doc-c", "builds_on");
// Cluster 2: doc-c ↔ doc-d
db.addRelationship("doc-c", "doc-d", "builds_on");
// Expected: doc-bridge has highest betweenness score
```

### Community Scoping for knowledge_central

The issue requires an optional `community` parameter to scope PageRank to a single community. This implies communities must be pre-computed (by issue #671's `knowledge_communities` tool) and cached, OR computed on-demand here. Since #671 is a sibling (not a dependency), and the acceptance criteria says "optional," the simplest approach: if `community` is provided, filter graph to only nodes in that community before running PageRank.

This requires access to community detection results. Two options:
1. Run Louvain in-line when `community` param is provided (adds `graphology-communities-louvain` dependency to this issue's scope).
2. Scope `community` param for post-672 implementation when communities are available.

**Recommendation:** Add `graphology-communities-louvain` as a dependency and compute communities on-demand when the `community` parameter is supplied. This keeps #672 self-contained and avoids inter-tool state coupling.

## Potential Approaches

### Approach A: Standalone graph-tools.ts (Recommended)

Create `src/graph-tools.ts` with `registerGraphTools(server, db)` that:
1. Instantiates `GraphBuilder` from `./graph-builder.js`
2. Registers `knowledge_central` and `knowledge_bridges`

Pros: Clean separation, easy to test, matches existing patterns.
Cons: If #671 creates `graph-tools.ts` first, this issue must extend it.

### Approach B: Inline in index.ts

Add graph tools directly to `createServer()` in `index.ts`.

Pros: No new files.
Cons: `index.ts` grows unmanageably large. Makes testing harder. Does not match ralph-hero's architecture of separate tool registration modules.

### Approach C: graph-central.ts + graph-bridges.ts

Separate files per tool concept.

Pros: Maximum isolation.
Cons: Over-engineered for 2 related tools. Forces two separate imports in `index.ts`.

**Decision: Approach A.** Single `graph-tools.ts` that both #671 and #672 contribute to, with a unified `registerGraphTools()` entry point.

## Risks

1. **#670 not done when #672 starts implementation.** The `GraphBuilder` module is a hard compile-time dependency. Implementation is blocked until #670 ships. Research is unblocked.

2. **graphology-metrics subpath imports fail under NodeNext.** If `graphology-metrics/centrality/pagerank` isn't exposed in the package's exports map, NodeNext module resolution will fail. Mitigation: use top-level named exports `import { pagerank } from 'graphology-metrics'` and verify the package exports map before implementation.

3. **Sparse graph yields poor PageRank results.** With only typed relationships, most documents are isolated. PageRank will produce uniform-ish results until the graph is densified (issue #664: untyped wiki links). Mitigation: the degree-centrality fallback helps, and the tool should document this limitation.

4. **Sibling #671 file conflict.** If #671 and #672 are implemented in parallel, both write to `graph-tools.ts`. The plan should sequence them: #671 creates the file, #672 extends it. The dependency edge in GitHub should be: #672 blockedBy #671.

5. **Undirected betweenness requires graphology-operators.** Adding `graphology-operators` extends the dependency footprint. Alternative: use directed betweenness and accept it finds fewer bridges on a sparse directed graph.

## Recommended Next Steps

1. Confirm implementation order: #671 should run first (creates `graph-tools.ts`), #672 extends it. Add `blockedBy #671` to #672.
2. When implementing: use top-level `import { pagerank, betweennessCentrality } from 'graphology-metrics'` to avoid NodeNext subpath issues.
3. For betweenness: convert to undirected using `toUndirected` from `graphology-operators` (add to dependencies).
4. For `community` param: compute communities inline using `graphology-communities-louvain` only when param is present (lazy evaluation).
5. Test fixtures: star topology (hub-and-spoke) for PageRank, barbell (two clusters + bridge) for betweenness.

## Files Affected

### Will Modify
- `plugin/ralph-knowledge/src/graph-tools.ts` — New file or extend from #671; registers `knowledge_central` and `knowledge_bridges` MCP tools
- `plugin/ralph-knowledge/src/__tests__/graph-tools.test.ts` — New test file or extend from #671; star and barbell fixtures
- `plugin/ralph-knowledge/src/index.ts` — Import and call `registerGraphTools(server, db)` (already done by #671 if sequenced)
- `plugin/ralph-knowledge/package.json` — Add `graphology-metrics`, `graphology-operators`, `graphology-communities-louvain` (graphology + graphology-types added by #670)

### Will Read (Dependencies)
- `plugin/ralph-knowledge/src/graph-builder.ts` — Upstream from #670; provides `GraphBuilder` class and graphology `Graph` instance
- `plugin/ralph-knowledge/src/db.ts` — `KnowledgeDB` type passed to `registerGraphTools`
- `plugin/ralph-knowledge/src/index.ts` — Understand how tools are registered and `createServer()` wires dependencies
- `plugin/ralph-knowledge/tsconfig.json` — NodeNext module resolution rules for import paths
