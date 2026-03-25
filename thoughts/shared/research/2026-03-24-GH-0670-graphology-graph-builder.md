---
date: 2026-03-24
github_issue: 670
github_url: https://github.com/cdubiel08/ralph-hero/issues/670
status: complete
type: research
tags: [graphology, ralph-knowledge, graph-builder, typescript, sqlite, testing]
---

# Research: ralph-knowledge graphology dependency and GraphBuilder module

## Prior Work

- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]

## Problem Statement

Issue #670 asks us to add `graphology` as a dependency to the ralph-knowledge plugin and implement a `GraphBuilder` module that constructs an in-memory graphology `Graph` object on-demand from the `documents` and `relationships` tables in the SQLite database. This is the foundational layer that sibling issues (#671, #672, #673) will consume to run community detection, centrality, and path-finding algorithms.

The key questions to answer:
1. Which graphology packages are needed and what TypeScript types do they ship?
2. How do `documents` and `relationships` tables map to graphology nodes and edges?
3. What metadata shape should nodes and edges carry?
4. How should the module be structured to match existing plugin conventions?
5. What test fixture design covers the acceptance criteria?

## Current State Analysis

### Existing Database Schema

The `documents` table stores: `id TEXT PRIMARY KEY, path, title, date, type, status, github_issue, content`. The `relationships` table stores: `source_id, target_id, type CHECK(type IN ('builds_on', 'tensions', 'superseded_by'))`.

The `KnowledgeDB` class exposes:
- `getRelationshipsFrom(sourceId)` — outgoing relationships from one node
- `getRelationshipsTo(targetId)` — incoming relationships to one node

Critically, there is no method to fetch ALL documents or ALL relationships at once for bulk graph construction. The `GraphBuilder` will need to query the underlying `db.db` (better-sqlite3 instance) directly, as the `Traverser` class already does (`this.db.db.prepare(...)`).

### Existing Traverser Pattern

`plugin/ralph-knowledge/src/traverse.ts` constructs a `Traverser` class that takes a `KnowledgeDB` instance. It uses recursive CTEs over the SQLite `relationships` table. This is the closest analogue to what `GraphBuilder` will do — same constructor injection pattern, same data source, different output format (graphology `Graph` object rather than `TraverseResult[]`).

### Issue Scope Clarification

Issue #670 is explicitly scoped to:
- Adding npm dependencies (graphology + algorithm packages)
- `GraphBuilder` class with `buildGraph()` method
- TypeScript type exports for downstream consumers

It is explicitly NOT responsible for:
- MCP tool registration (sibling issues)
- Algorithm implementation (sibling issues)
- Untyped edge capture from wiki links (#664)

The `relationships` table currently only contains typed edges (`builds_on`, `tensions`, `superseded_by`). The graph built by this module will reflect that sparse edge set until #664 adds untyped wiki link edges.

## Key Discoveries

### 1. graphology TypeScript Support

graphology ships TypeScript declarations via a peer dependency `graphology-types`. As of the current release, the main `graphology` package installs the types automatically — no separate `npm install graphology-types` is needed with npm v7+. The `tsconfig.json` uses `"skipLibCheck": true` so type declaration file issues won't block builds.

The main `Graph` class is the default export:
```typescript
import Graph from "graphology";
const graph = new Graph({ multi: true }); // multi allows parallel edges
```

For our use case, `multi: true` is needed because two documents can have multiple typed relationships (e.g., doc-A `builds_on` doc-B AND doc-A `tensions` doc-B). The edge `type` attribute distinguishes them.

### 2. Required Packages

Only the core `graphology` package is needed for issue #670 (graph construction). The algorithm packages (`graphology-communities-louvain`, `graphology-metrics`, `graphology-shortest-path`, `graphology-simple-path`, `graphology-traversal`) should be added now as declared in the issue to avoid multiple package.json bumps, even though they are consumed by sibling issues.

npm package names:
- `graphology` — core Graph object and TypeScript types
- `graphology-communities-louvain` — Louvain algorithm (#671)
- `graphology-metrics` — PageRank, betweenness centrality (#672)
- `graphology-shortest-path` — Dijkstra / path traversal (#673)
- `graphology-simple-path` — DFS all simple paths (#673)

The `graphology-traversal` package provides BFS/DFS iteration helpers and would be useful for #673 as well. The `graphology-components` package provides connected-components detection (useful for the disconnected-graph graceful handling requirement).

### 3. Node Metadata Shape

The acceptance criteria specifies nodes carry: `{ title, type, date, status }`. These map directly from `DocumentRow`:
```typescript
interface NodeAttributes {
  title: string;
  type: string | null;
  date: string | null;
  status: string | null;
}
```

Node keys should be document `id` (the filename-without-extension string), since that is the stable identifier used throughout the plugin (search results, traversal, MCP tool parameters).

### 4. Edge Metadata Shape

The acceptance criteria specifies edges carry: `{ type }` where type is one of `builds_on`, `tensions`, `superseded_by`, or a future untyped value. The `RelationshipRow` type already defines this as `type: string`.

```typescript
interface EdgeAttributes {
  type: string;
}
```

Edge keys do not need to be stable — graphology auto-generates them for `addEdge()`. We should use `addEdgeWithKey()` only if downstream code needs stable edge references, which is unlikely.

### 5. SQL Queries Needed

Two queries are needed for `buildGraph()`:

**All documents** (for nodes):
```sql
SELECT id, title, date, type, status FROM documents
```

**All relationships** (for edges):
```sql
SELECT source_id, target_id, type FROM relationships
```

Both are simple full-table scans. With ~200 documents and a sparse relationship set (typically <200 typed edges), these complete in microseconds.

### 6. Disconnected Components

graphology handles disconnected graphs natively — isolated nodes (documents with no relationships) are valid graph members. `addNode()` on a node with no edges simply produces an isolated node. The acceptance criterion is satisfied automatically: `buildGraph()` adds all documents as nodes regardless of whether they appear in any relationship.

### 7. TypeScript Generics

graphology supports typed graphs via generics: `Graph<NodeAttributes, EdgeAttributes>`. This is the idiomatic TypeScript pattern:
```typescript
import Graph from "graphology";
export type KnowledgeGraph = Graph<NodeAttributes, EdgeAttributes>;
```

Exporting the type alias lets sibling issues import and use `KnowledgeGraph` without re-specifying the generics.

### 8. Module Naming Convention

The module should be `graph-builder.ts` (matching the issue specification and the hyphenated naming convention in the plugin: `file-scanner.ts`, `hybrid-search.ts`, `vector-search.ts`). The class should be `GraphBuilder`.

### 9. ESM Import Requirements

The project uses `"module": "NodeNext"` — all internal imports need `.js` extensions:
```typescript
import { KnowledgeDB } from "./db.js";
```

For graphology, since it ships as a regular npm package (not a local module), no `.js` extension is needed:
```typescript
import Graph from "graphology";
```

### 10. Test Fixture Design

The traverse test (`traverse.test.ts`) already establishes the pattern: create `KnowledgeDB(":memory:")` in `beforeEach`, upsert 3 documents, add relationships. The `graph-builder.test.ts` should follow this exactly.

Acceptance criteria requires 5+ nodes and mixed edge types. A good fixture:
- 5 documents (doc-a through doc-e)
- `doc-b builds_on doc-a`
- `doc-c builds_on doc-b`
- `doc-d tensions doc-a`
- `doc-e superseded_by doc-c`
- doc-e is also isolated from the builds_on chain (connected only via superseded_by)

This gives:
- A chain (doc-a → doc-b → doc-c)
- A tensions edge across the chain (doc-d → doc-a)
- A superseded_by edge (doc-e → doc-c)
- All three edge types represented
- No isolated nodes in this fixture (but the empty-DB test covers that path)

## Potential Approaches

### Option A: GraphBuilder as a class with `buildGraph()` (Recommended)

```typescript
export class GraphBuilder {
  constructor(private readonly db: KnowledgeDB) {}
  buildGraph(): KnowledgeGraph { ... }
}
```

Pros: Consistent with `Traverser` and `FtsSearch` — same constructor injection, same single-responsibility class. Easy to instantiate in `index.ts` alongside existing modules.

Cons: `buildGraph()` is synchronous (no async needed for SQLite), but this is actually a pro — keeps the implementation simple.

### Option B: Standalone function

```typescript
export function buildKnowledgeGraph(db: KnowledgeDB): KnowledgeGraph { ... }
```

Pros: Simpler, no class boilerplate.

Cons: Inconsistent with every other module in the plugin. Makes future extension (e.g., `buildSubgraph(nodeId, depth)`) harder to add without breaking the public API.

Option A is recommended for consistency.

### Option C: Lazy/cached graph construction

Cache the `Graph` object in `GraphBuilder` and rebuild only when the database version changes.

Pros: Avoids redundant construction on repeated calls.

Cons: Over-engineering for issue #670 scope. With ~200 documents and full-table SQL scans, `buildGraph()` completes in <1ms. Cache invalidation adds complexity. Defer to a future issue if needed.

## Risks

1. **graphology package size**: The full `graphology-library` umbrella package is large. We should install only the specific algorithm packages needed. No risk for issue #670 (only `graphology` core is consumed here), but the issue asks us to add algorithm packages now.

2. **graphology `multi: true` requirement**: If we create the graph without `{ multi: true }`, adding a second relationship between the same pair of nodes (e.g., both `builds_on` and `tensions`) will throw. The test fixture with mixed edges between the same pair will catch this if we forget.

3. **Schema constraint on `relationships.type`**: The `CHECK(type IN ('builds_on', 'tensions', 'superseded_by'))` constraint means all edges from the current database are typed. When issue #664 adds untyped wiki-link edges, it will need to either relax this constraint or use a separate table. GraphBuilder's edge metadata type should be `string` (not a union literal type) to accommodate future untyped edges from #664 without a breaking type change.

4. **No bulk-document query method on KnowledgeDB**: `KnowledgeDB` exposes `getDocument(id)` (single lookup) but no `getAllDocuments()`. The `GraphBuilder` must access `db.db.prepare(...)` directly — same pattern as `Traverser` already uses. This is fine but worth noting as a code smell to address in a future DB cleanup issue.

## Recommended Next Steps

1. Add to `package.json` dependencies: `graphology`, `graphology-communities-louvain`, `graphology-metrics`, `graphology-shortest-path`, `graphology-simple-path`, `graphology-traversal`, `graphology-components`
2. Create `plugin/ralph-knowledge/src/graph-builder.ts` with `GraphBuilder` class, `NodeAttributes`, `EdgeAttributes`, and `KnowledgeGraph` type exports
3. Create `plugin/ralph-knowledge/src/__tests__/graph-builder.test.ts` with 5-node fixture and tests for: node count, edge count, node metadata, edge type attribute, empty database, disconnected nodes
4. Run `npm run build` and `npm test` in `plugin/ralph-knowledge/` to verify
5. No changes needed to `index.ts` for issue #670 — `GraphBuilder` is a library module, not an MCP tool

## Files Affected

### Will Modify
- `plugin/ralph-knowledge/package.json` - Add graphology and algorithm package dependencies

### Will Read (Dependencies)
- `plugin/ralph-knowledge/src/db.ts` - KnowledgeDB class and DocumentRow/RelationshipRow types
- `plugin/ralph-knowledge/src/traverse.ts` - Structural pattern for constructor injection and direct db.db SQL access
- `plugin/ralph-knowledge/src/__tests__/traverse.test.ts` - Test fixture pattern (beforeEach + :memory: db)
- `plugin/ralph-knowledge/tsconfig.json` - Module resolution settings (NodeNext, .js imports)

### Will Create
- `plugin/ralph-knowledge/src/graph-builder.ts` - GraphBuilder class and exported types
- `plugin/ralph-knowledge/src/__tests__/graph-builder.test.ts` - Test suite for graph construction
