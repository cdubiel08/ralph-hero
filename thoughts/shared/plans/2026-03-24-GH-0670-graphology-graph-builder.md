---
date: 2026-03-24
status: draft
type: plan
github_issue: 670
github_issues: [670]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/670
primary_issue: 670
tags: [graphology, ralph-knowledge, graph-builder, typescript, sqlite, testing]
---

# ralph-knowledge: graphology dependency and GraphBuilder module - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-24-GH-0670-graphology-graph-builder]]
- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-670 | ralph-knowledge: add graphology dependency and graph builder module | S |

## Shared Constraints

- **ESM imports**: All internal imports must use `.js` extensions (project uses `"module": "NodeNext"`)
- **TypeScript strict mode**: The only code quality gate; no linter configured
- **Constructor injection pattern**: New modules follow the `Traverser` pattern -- class takes `KnowledgeDB` in constructor, exposes methods that access `db.db.prepare(...)` directly for bulk queries
- **Test pattern**: Use `KnowledgeDB(":memory:")` in `beforeEach`, upsert fixture documents, add relationships via `db.addRelationship()`
- **Build/test commands**: `npm run build` (tsc) and `npm test` (vitest run) from `plugin/ralph-knowledge/`
- **Multi-graph requirement**: graphology `Graph` must be constructed with `{ multi: true }` to support parallel edges between the same document pair (e.g., both `builds_on` and `tensions`)
- **Edge type as string**: Use `string` (not a union literal) for edge type to remain forward-compatible with untyped wiki-link edges from future #664
- **No index.ts changes**: GraphBuilder is a library module -- sibling issues (#671, #672, #673) handle MCP tool registration

## Current State Analysis

The ralph-knowledge plugin has a SQLite-backed `KnowledgeDB` class ([plugin/ralph-knowledge/src/db.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/db.ts)) with `documents` and `relationships` tables. The `Traverser` class ([plugin/ralph-knowledge/src/traverse.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/traverse.ts)) provides recursive CTE-based chain walking for individual document lineages but cannot perform graph-wide operations like community detection, centrality ranking, or path finding.

The parent issue #666 decomposes into four children: this issue (#670) provides the foundational graph construction, while #671 (communities), #672 (centrality), and #673 (paths) consume the `GraphBuilder` output to implement MCP tools. All algorithm packages should be added to `package.json` in this issue to avoid multiple dependency bumps.

The `KnowledgeDB` class exposes per-document relationship queries (`getRelationshipsFrom`, `getRelationshipsTo`) but no bulk-fetch methods. The `Traverser` already accesses `db.db.prepare(...)` directly for its recursive CTEs -- `GraphBuilder` will follow the same pattern for its two full-table queries.

## Desired End State

### Verification
- [x] `graphology` and algorithm packages installed and importable
- [x] `GraphBuilder` class constructs a typed `Graph<NodeAttributes, EdgeAttributes>` from all documents and relationships
- [x] Exported types (`NodeAttributes`, `EdgeAttributes`, `KnowledgeGraph`) available for sibling issues to import
- [x] Tests pass for graph construction, metadata correctness, empty database, and multi-edge scenarios

## What We're NOT Doing

- MCP tool registration (handled by #671, #672, #673)
- Algorithm implementation (Louvain, PageRank, path finding -- handled by siblings)
- Untyped wiki-link edge capture (#664)
- Caching or lazy graph construction (unnecessary at ~200 doc corpus size)
- Changes to `index.ts` or any existing MCP tool handlers

## Implementation Approach

The implementation follows a strict bottom-up sequence: install dependencies first, then create the type definitions and class implementation, then write tests. The `GraphBuilder` class mirrors the `Traverser` pattern exactly -- constructor injection of `KnowledgeDB`, synchronous methods that query `db.db.prepare()` directly, and typed return values.

---

## Phase 1: graphology dependency and GraphBuilder module (GH-670)

### Overview

Add graphology and its algorithm packages to ralph-knowledge, then implement a `GraphBuilder` class that constructs a typed in-memory graph from the SQLite database's documents and relationships tables. Export TypeScript types for downstream consumption by sibling tool modules.

### Tasks

#### Task 1.1: Add graphology dependencies to package.json

- **files**: `plugin/ralph-knowledge/package.json` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] `graphology` added to `dependencies`
  - [x] `graphology-communities-louvain` added to `dependencies`
  - [x] `graphology-metrics` added to `dependencies`
  - [x] `graphology-shortest-path` added to `dependencies`
  - [x] `graphology-simple-path` added to `dependencies`
  - [x] `graphology-traversal` added to `dependencies`
  - [x] `graphology-components` added to `dependencies`
  - [x] `graphology-types` added to `dependencies` (peer dependency for TypeScript declarations)
  - [x] `npm install` succeeds without errors in `plugin/ralph-knowledge/`
  - [x] `npm run build` succeeds (no TypeScript errors from new packages)

#### Task 1.2: Create GraphBuilder class with type exports

- **files**: `plugin/ralph-knowledge/src/graph-builder.ts` (create), `plugin/ralph-knowledge/src/db.ts` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [x] File exports `NodeAttributes` interface with fields: `title: string`, `type: string | null`, `date: string | null`, `status: string | null`
  - [x] File exports `EdgeAttributes` interface with field: `type: string`
  - [x] File exports `KnowledgeGraph` type alias as `Graph<NodeAttributes, EdgeAttributes>`
  - [x] `GraphBuilder` class constructor takes a single `KnowledgeDB` parameter stored as `private readonly db`
  - [x] `buildGraph()` method returns `KnowledgeGraph`
  - [x] `buildGraph()` creates the graph with `new Graph({ multi: true, type: "directed" })` to support parallel edges
  - [x] All documents loaded via `SELECT id, title, date, type, status FROM documents` using `this.db.db.prepare()`
  - [x] Each document added as a node with key = document `id` and attributes `{ title, type, date, status }`
  - [x] All relationships loaded via `SELECT source_id, target_id, type FROM relationships` using `this.db.db.prepare()`
  - [x] Each relationship added as a directed edge from `source_id` to `target_id` with attribute `{ type }`
  - [x] Edges where `source_id` or `target_id` do not exist as nodes are skipped (defensive -- the FK constraint should prevent this, but `target_id` in the relationships table has no FK)
  - [x] Import uses `import Graph from "graphology"` and `import { KnowledgeDB } from "./db.js"`
  - [x] All types are exported at module level for downstream import

#### Task 1.3: Write comprehensive tests for GraphBuilder

- **files**: `plugin/ralph-knowledge/src/__tests__/graph-builder.test.ts` (create), `plugin/ralph-knowledge/src/graph-builder.ts` (read), `plugin/ralph-knowledge/src/db.ts` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [x] Uses `beforeEach` with `KnowledgeDB(":memory:")` following the pattern in [traverse.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/traverse.test.ts)
  - [x] Fixture contains 5+ documents: `doc-a` (research, approved), `doc-b` (plan, draft), `doc-c` (plan, draft), `doc-d` (idea, draft), `doc-e` (research, complete)
  - [x] Fixture contains all 3 relationship types: `doc-b builds_on doc-a`, `doc-c builds_on doc-b`, `doc-d tensions doc-a`, `doc-e superseded_by doc-c`
  - [x] Test: graph has correct node count (5 nodes)
  - [x] Test: graph has correct edge count (4 edges)
  - [x] Test: node attributes match -- `graph.getNodeAttributes("doc-a")` returns `{ title: "Foundation Research", type: "research", date: "2026-02-01", status: "approved" }`
  - [x] Test: edge type attribute is correct -- iterate edges from `doc-b` and verify one has `type: "builds_on"`
  - [x] Test: parallel edges between same pair work -- add a second relationship between `doc-d` and `doc-a` (e.g., `doc-d builds_on doc-a` alongside existing `doc-d tensions doc-a`), verify 2 edges exist between them
  - [x] Test: empty database produces graph with 0 nodes and 0 edges
  - [x] Test: isolated node (document with no relationships) is included in graph -- add `doc-orphan`, verify `graph.hasNode("doc-orphan")` is true and `graph.degree("doc-orphan")` is 0
  - [x] Test: graph is directed -- `graph.type` equals `"directed"`
  - [x] Test: dangling edge target (relationship referencing non-existent target_id) is skipped without error
  - [x] All tests pass with `npx vitest run src/__tests__/graph-builder.test.ts`

### Phase Success Criteria

#### Automated Verification:
- [x] `npm run build` in `plugin/ralph-knowledge/` -- no TypeScript errors
- [x] `npm test` in `plugin/ralph-knowledge/` -- all tests passing (existing + new)

#### Manual Verification:
- [ ] `GraphBuilder` class can be imported from `graph-builder.js` in a Node REPL
- [ ] `KnowledgeGraph`, `NodeAttributes`, and `EdgeAttributes` types are available in `dist/graph-builder.d.ts`

**Creates for sibling issues**: `GraphBuilder` class, `KnowledgeGraph` type alias, `NodeAttributes` and `EdgeAttributes` interfaces -- all importable from `./graph-builder.js` by #671, #672, #673 tool modules.

---

## Integration Testing

- [x] `npm run build && npm test` in `plugin/ralph-knowledge/` passes with zero failures
- [x] New `graph-builder.test.ts` covers node construction, edge construction, metadata, empty DB, isolated nodes, parallel edges, directed graph type, and dangling edge defense
- [x] Existing test files (`db.test.ts`, `traverse.test.ts`, `search.test.ts`, `vector-search.test.ts`, `hybrid-search.test.ts`) remain passing (no regressions)

## References

- Research: [thoughts/shared/research/2026-03-24-GH-0670-graphology-graph-builder.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-24-GH-0670-graphology-graph-builder.md)
- Comparison research: [thoughts/shared/research/2026-03-24-knowledge-graph-plugin-comparison.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-24-knowledge-graph-plugin-comparison.md)
- Parent issue: [#666](https://github.com/cdubiel08/ralph-hero/issues/666) -- ralph-knowledge: add graphology graph algorithms
- Sibling issues: [#671](https://github.com/cdubiel08/ralph-hero/issues/671) (communities), [#672](https://github.com/cdubiel08/ralph-hero/issues/672) (centrality), [#673](https://github.com/cdubiel08/ralph-hero/issues/673) (paths)
- Database schema: [plugin/ralph-knowledge/src/db.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/db.ts)
- Traverser pattern: [plugin/ralph-knowledge/src/traverse.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/traverse.ts)
- Traverse tests: [plugin/ralph-knowledge/src/__tests__/traverse.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/traverse.test.ts)
- graphology docs: [graphology.github.io](https://graphology.github.io/)
