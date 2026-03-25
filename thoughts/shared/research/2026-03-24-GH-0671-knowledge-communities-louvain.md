---
date: 2026-03-24
github_issue: 671
github_url: https://github.com/cdubiel08/ralph-hero/issues/671
status: complete
type: research
tags: [ralph-knowledge, graphology, louvain, community-detection, mcp-server, graph-algorithms]
---

# Research: knowledge_communities Tool (Louvain Community Detection)

## Prior Work

- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]

## Problem Statement

The ralph-knowledge MCP server has no graph algorithm capabilities. Issue #671 requests adding the `knowledge_communities` MCP tool that runs Louvain community detection over the knowledge graph, returning clusters of related documents. This is the first algorithm tool from the graphology integration track (parent #666) and depends on `GraphBuilder` from #670.

## Current State Analysis

The ralph-knowledge plugin at `plugin/ralph-knowledge/` currently has:

- `KnowledgeDB` (`db.ts`): SQLite-backed store with `documents`, `tags`, and `relationships` tables
- `Traverser` (`traverse.ts`): Recursive CTE traversal via SQL — chain walking only, no cluster detection
- MCP server (`index.ts`): Four registered tools: `knowledge_search`, `knowledge_traverse`, `knowledge_record_outcome`, `knowledge_query_outcomes`
- No graphology dependency in `package.json`
- No `GraphBuilder` class yet (blocked on #670 but within same parent group)

The `relationships` table uses typed edges (`builds_on`, `tensions`, `superseded_by`). The graph is sparse due to typed-only capture; however, Louvain community detection is meaningful even on sparse graphs — it groups isolated components into their own communities, which itself is useful signal.

## Key Discoveries

### 1. Graphology Louvain API

The `graphology-communities-louvain` package provides three call styles:

```typescript
import louvain from 'graphology-communities-louvain';

// Returns { [nodeId: string]: number } — community index per node
const partition = louvain(graph);

// Directly assigns community as node attribute
louvain.assign(graph, { resolution: 1.0 });

// Returns partition + modularity + dendrogram + move counts
const detailed = louvain.detailed(graph, { resolution: 1.0 });
```

The `resolution` parameter (default `1.0`) controls community granularity — higher values yield more, smaller communities. This matches the acceptance criterion for configurable resolution.

Key notes from the docs:
- Works on both undirected and directed graphs
- Works with multigraphs (single edge class)
- Community labels are integers 0..n
- Handles disconnected graphs — each disconnected component is its own community

### 2. GraphBuilder Interface (Issue #670)

Issue #670 defines the expected contract:
- `GraphBuilder` class takes a `KnowledgeDB` instance
- `buildGraph()` method returns a `graphology.Graph` with nodes carrying `{ title, type, date, status }` metadata and edges carrying `{ type }` metadata
- Handles disconnected components and isolated nodes

The `knowledge_communities` tool needs to instantiate `GraphBuilder` on-demand and call `buildGraph()` before running Louvain. No persistent graph state is needed.

### 3. MCP Tool Registration Pattern

All tools are registered in `index.ts` using the pattern:

```typescript
server.tool(
  "tool_name",
  "description",
  { param: z.type().describe("...") },
  async (args) => {
    try {
      // ...
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);
```

The issue scope mentions a separate `graph-tools.ts` file for registration — this is the right pattern since `index.ts` already has four tools and a `createServer` function. A `GraphTools` registration function following the same `registerXyzTools()` pattern from the hero MCP server is appropriate.

### 4. Output Shape Design

The acceptance criteria require:
- Community ID (integer from Louvain)
- Member document IDs
- Member titles
- Cluster size
- Human-readable label (most common tag or type)

The `louvain()` return is a flat `{ [nodeId]: communityIndex }` map. The tool must invert this mapping to group nodes by community, then enrich each group with document metadata. Document metadata is available via `GraphBuilder` node attributes (title, type, date, status). Tags require a separate `db.getTags(docId)` call per document.

For the human-readable label, the most common tag across members is a good heuristic. Fallback to most common `type` if tags are sparse.

### 5. Edge Case Handling

**Empty graph** (zero documents): `louvain()` on an empty graph returns `{}`. Inverting an empty map yields an empty array — natural graceful handling.

**Fully disconnected graph** (all isolated nodes): Louvain assigns each isolated node to its own community. This can produce O(n) single-member communities. The tool should include these — they represent genuinely ungrouped documents.

**Single-node graph**: Produces one community with one member.

**No typed relationships** (all nodes isolated): This is the current state of a freshly-indexed corpus before typed relationships are parsed. Louvain gracefully assigns each node its own community.

### 6. TypeScript Import for graphology-communities-louvain

The package ships with TypeScript types. Import pattern:

```typescript
import louvain from 'graphology-communities-louvain';
import type Graph from 'graphology';
```

The package requires `graphology` as a peer dependency (added by #670).

### 7. Test Pattern

Existing tests in `src/__tests__/` use vitest with in-memory SQLite (`":memory:"`). The `traverse.test.ts` pattern is directly applicable:

1. Create `KnowledgeDB(":memory:")`
2. Insert fixture documents and relationships
3. Instantiate `GraphBuilder(db)` and call `buildGraph()`
4. Run `louvain(graph)` and verify partition

For the MCP tool test, the `index.test.ts` pattern shows testing via module import and `createServer(":memory:")`.

## Potential Approaches

### Option A: Inline in index.ts

Add the `knowledge_communities` tool directly to the `createServer()` function in `index.ts`.

**Pros**: Minimal files, consistent with current structure (all tools in one file).

**Cons**: `index.ts` already has 150+ lines with four tools and supporting logic. Adding graph tools here makes it harder to navigate. The issue explicitly calls for `graph-tools.ts`.

### Option B: Separate graph-tools.ts (Recommended)

Create `src/graph-tools.ts` with a `registerGraphTools(server, db)` function, called from `createServer()`.

**Pros**: Mirrors the `registerXyzTools()` pattern from `plugin/ralph-hero/mcp-server/src/tools/`. Keeps `index.ts` focused on wiring. Easy to add sibling algorithm tools (centrality, bridges, path-finding) in the same file.

**Cons**: One more file to maintain.

This matches the acceptance criteria which explicitly name `plugin/ralph-knowledge/src/graph-tools.ts`.

### Option C: GraphTools class

Export a `GraphTools` class with methods.

**Pros**: Encapsulation.

**Cons**: Unnecessary OOP for a stateless registration function. Inconsistent with the pattern in the codebase.

**Recommended: Option B.**

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| `graphology-communities-louvain` lacks TypeScript types | Low | Package ships types; peer dep on `graphology-types` |
| Louvain non-determinism breaks tests | Medium | Use `rng` option to seed randomness in tests; or assert community count rather than specific assignments |
| Very sparse graph yields n single-node communities | Low | Expected behavior; document in tool description |
| `GraphBuilder` API changes in #670 | Low | Both issues are in same parent group; coordinate via issue comments |
| ESM import issues with graphology | Medium | graphology is ESM-native; check that package exports map is compatible with `"type": "module"` + `"module": "NodeNext"` |

### ESM Compatibility Note

The ralph-knowledge plugin uses `"type": "module"` with `"module": "NodeNext"` (TypeScript). Graphology is ESM-native. The import `import louvain from 'graphology-communities-louvain'` should work cleanly, but if the package only exports CommonJS, a dynamic `createRequire` workaround would be needed. Based on the graphology repository, it ships dual CJS/ESM builds.

## Recommended Next Steps

1. **#670 first**: Implement `GraphBuilder` with `buildGraph()` returning a graphology Graph. The communities tool depends on this interface.

2. **Add npm dependencies** (done in #670): `graphology`, `graphology-communities-louvain`, and `graphology-types`.

3. **Create `src/graph-tools.ts`** with:
   - `registerGraphTools(server: McpServer, db: KnowledgeDB): void`
   - `knowledge_communities` tool with `resolution?: number` parameter
   - On-demand `GraphBuilder(db).buildGraph()` per call
   - `louvain(graph, { resolution })` for partition
   - Invert partition map → community clusters
   - Enrich each cluster with member titles and tag-based label
   - Return `{ communities: Array<{ communityId, members, size, label }>, modularity }` from `louvain.detailed`

4. **Create `src/__tests__/graph-tools.test.ts`**:
   - Fixture: 5 documents, 2 typed relationships connecting 2+2 of them, 1 isolated
   - Verify: 3 communities returned (2 connected pairs + 1 isolated)
   - Verify: empty DB returns empty clusters array
   - Verify: label generated from common tag

5. **Call `registerGraphTools`** from `createServer()` in `index.ts`

## Files Affected

### Will Modify
- `plugin/ralph-knowledge/src/index.ts` - Call `registerGraphTools` from `createServer()`
- `plugin/ralph-knowledge/package.json` - Add `graphology-communities-louvain` dep (graphology itself added by #670)

### Will Read (Dependencies)
- `plugin/ralph-knowledge/src/db.ts` - KnowledgeDB type and getTags method
- `plugin/ralph-knowledge/src/graph-builder.ts` - GraphBuilder class (created by #670)
- `plugin/ralph-knowledge/src/__tests__/traverse.test.ts` - Test fixture pattern to follow
- `plugin/ralph-knowledge/src/__tests__/db.test.ts` - In-memory DB setup pattern
