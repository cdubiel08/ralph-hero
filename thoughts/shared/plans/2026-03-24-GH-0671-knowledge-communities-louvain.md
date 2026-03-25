---
date: 2026-03-24
status: draft
type: plan
github_issue: 671
github_issues: [671]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/671
primary_issue: 671
tags: [ralph-knowledge, graphology, louvain, community-detection, mcp-server, graph-algorithms]
---

# knowledge_communities Tool (Louvain) — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-24-GH-0671-knowledge-communities-louvain]]
- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-671 | Add knowledge_communities MCP tool (Louvain community detection) | S |

## Shared Constraints

- The `plugin/ralph-knowledge/` plugin uses `"type": "module"` with `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`. All internal imports must use `.js` extensions.
- TypeScript strict mode is enabled. No `any` types without justification.
- The MCP tool registration pattern is: `server.tool(name, description, schema, async handler)` with `return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }` on success and `{ ..., isError: true }` on error.
- All test files live in `src/__tests__/` and use vitest with in-memory SQLite (`":memory:"`).
- `GraphBuilder` (from GH-670, same parent group) must be available at `plugin/ralph-knowledge/src/graph-builder.ts` before this work begins. The plan assumes its interface: `new GraphBuilder(db).buildGraph()` returns a `graphology.Graph`.
- `graphology` and `graphology-communities-louvain` packages must be present in `package.json` dependencies. If GH-670 added only `graphology`, this task adds `graphology-communities-louvain`.
- Build command: `npm run build` (tsc) from `plugin/ralph-knowledge/`.
- Test command: `npm test` (vitest run) from `plugin/ralph-knowledge/`.
- Louvain is non-deterministic; tests must seed randomness via the `rng` option or assert community count rather than specific member assignments.

## Current State Analysis

The `plugin/ralph-knowledge/` MCP server has four tools registered in `src/index.ts` within a `createServer(dbPath)` function. There is no graph algorithm capability. The `src/` directory contains:

- `db.ts` — `KnowledgeDB` with `getDocument()`, `getTags()`, `getRelationshipsFrom()`, `getRelationshipsTo()`
- `traverse.ts` — `Traverser` for SQL-based chain walking
- No `graph-builder.ts` yet (blocked on GH-670)
- No `graphology` or `graphology-communities-louvain` in `package.json`

The `relationships` table uses typed edges (`builds_on`, `tensions`, `superseded_by`). The graph may be sparse, but Louvain handles sparse and disconnected graphs correctly — isolated nodes each become their own community.

## Desired End State

### Verification
- [ ] `knowledge_communities` MCP tool is callable and returns `{ communities: [...], modularity: number, totalDocuments: number }`
- [ ] Each community entry contains `{ communityId, members: [{ id, title, type }], size, label }`
- [ ] Optional `resolution` parameter (float, default 1.0) controls community granularity
- [ ] Empty graph returns `{ communities: [], modularity: 0, totalDocuments: 0 }`
- [ ] Tool is registered via `registerGraphTools()` called from `createServer()` in `index.ts`
- [ ] Unit tests cover: connected pairs, isolated nodes, empty DB, label generation from tags

## What We're NOT Doing

- Not implementing other graph algorithms (centrality, bridges, path-finding) — those are future sibling tools
- Not persisting community assignments to the DB — computation is on-demand per call
- Not exposing Louvain's dendrogram or per-iteration move counts in the output (too verbose for MCP consumers)
- Not adding a new npm package `graphology-types` explicitly — `graphology-communities-louvain` ships its own types
- Not implementing community filtering by type or tag in this issue — a follow-on can add query params

## Implementation Approach

The work is structured as three sequential tasks within a single phase:

1. Add the npm dependency and create `graph-tools.ts` with a stub `registerGraphTools` function (pure wiring)
2. Implement the `knowledge_communities` tool logic inside `registerGraphTools` with TDD
3. Wire `registerGraphTools` into `createServer()` in `index.ts`

The test file for the tool exercises the full stack: in-memory `KnowledgeDB` → `GraphBuilder` → `louvain()` → output shape.

---

## Phase 1: Add knowledge_communities MCP Tool (GH-671)

### Overview

Create `src/graph-tools.ts` with the `registerGraphTools(server, db)` function that registers the `knowledge_communities` MCP tool, add the npm dependency, and wire the registration into `createServer()`.

### Tasks

#### Task 1.1: Add graphology-communities-louvain npm dependency
- **files**: `plugin/ralph-knowledge/package.json` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `"graphology-communities-louvain": "^1.0.0"` (or latest stable) is present in `dependencies` of `plugin/ralph-knowledge/package.json`
  - [ ] If `graphology` is not already present (added by GH-670), add it as well
  - [ ] `npm install` from `plugin/ralph-knowledge/` completes without error
  - [ ] `npm run build` passes after the dependency is added (no compile-time import errors yet — the import is added in Task 1.2)

#### Task 1.2: Implement registerGraphTools with knowledge_communities tool
- **files**: `plugin/ralph-knowledge/src/graph-tools.ts` (create), `plugin/ralph-knowledge/src/__tests__/graph-tools.test.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `src/graph-tools.ts` exports `registerGraphTools(server: McpServer, db: KnowledgeDB): void`
  - [ ] The `knowledge_communities` tool accepts optional `resolution: number` (default 1.0, range 0.1–5.0 validated by Zod `.min(0.1).max(5.0)`)
  - [ ] On call, the tool instantiates `new GraphBuilder(db).buildGraph()`, then calls `louvain.detailed(graph, { resolution, rng: () => 0.5 })` to get `{ partition, modularity }`
  - [ ] Partition map `{ [nodeId: string]: number }` is inverted to group nodes by community index
  - [ ] Each community entry shape: `{ communityId: number, members: Array<{ id: string, title: string | null, type: string | null }>, size: number, label: string }`
  - [ ] Label is computed as: most common tag across members (via `db.getTags(id)` per member); falls back to most common `type` if all members have no tags; falls back to `"unknown"` if type is also null
  - [ ] Return value shape: `{ communities: Community[], modularity: number, totalDocuments: number }`
  - [ ] Empty graph (zero documents): returns `{ communities: [], modularity: 0, totalDocuments: 0 }` without error
  - [ ] Error path: returns `{ content: [{ type: "text", text: "Error: ..." }], isError: true }`
  - [ ] Test: 5 docs inserted (2 connected by `builds_on`, 2 connected by `tensions`, 1 isolated) → exactly 3 communities returned
  - [ ] Test: empty DB → communities array is empty, modularity is 0
  - [ ] Test: label is the most common tag of members in a community
  - [ ] Test: `resolution: 2.0` is accepted without error (behavior may vary but must not throw)
  - [ ] `npm run build` passes (no TypeScript errors in the new file)
  - [ ] `npm test` passes (all graph-tools tests green)

#### Task 1.3: Wire registerGraphTools into createServer
- **files**: `plugin/ralph-knowledge/src/index.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] `import { registerGraphTools } from "./graph-tools.js"` is added to `src/index.ts`
  - [ ] `registerGraphTools(server, db)` is called inside `createServer()` after the existing four tool registrations
  - [ ] `createServer()` return value is unchanged (still `{ server, db, fts, vec, hybrid, traverser }`)
  - [ ] `npm run build` passes with no errors
  - [ ] `npm test` passes — all existing tests remain green plus the new graph-tools tests

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` from `plugin/ralph-knowledge/` — no TypeScript errors
- [ ] `npm test` from `plugin/ralph-knowledge/` — all tests passing (including graph-tools.test.ts)

#### Manual Verification:
- [ ] Call `knowledge_communities` via MCP client with an indexed knowledge base and confirm communities array is non-empty and each entry has `communityId`, `members`, `size`, `label`
- [ ] Call with `resolution: 2.0` and confirm different (likely more) communities returned vs default

---

## Integration Testing

- [ ] Start the MCP server against a real knowledge DB that has at least 10 indexed documents with typed relationships
- [ ] Call `knowledge_communities` with no args — verify response includes multiple communities and a non-zero modularity value
- [ ] Call `knowledge_communities` with `resolution: 0.5` and `resolution: 2.0` — verify the number of communities differs in the expected direction (lower resolution = fewer communities)
- [ ] Verify `knowledge_search` and `knowledge_traverse` still work correctly after the addition of `registerGraphTools`

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-24-GH-0671-knowledge-communities-louvain.md
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/666
- GraphBuilder dependency: https://github.com/cdubiel08/ralph-hero/issues/670
- graphology-communities-louvain: https://graphology.github.io/standard-library/communities-louvain.html
