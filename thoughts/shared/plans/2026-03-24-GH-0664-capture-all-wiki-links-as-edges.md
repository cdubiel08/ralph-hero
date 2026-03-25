---
date: 2026-03-24
status: draft
type: plan
github_issue: 664
github_issues: [664]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/664
primary_issue: 664
tags: [ralph-knowledge, knowledge-graph, wikilinks, sqlite, parser, graph-edges]
---

# Capture All Wiki Links as Edges with Paragraph Context - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-24-GH-0664-capture-all-wiki-links-as-edges]]
- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]
- builds_on:: [[2026-03-08-knowledge-graph-design]]

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-664 | Capture all wiki links as edges with paragraph context | S |

## Shared Constraints

- **ESM imports**: All internal imports require `.js` extensions (`import { foo } from "./bar.js"`).
- **SQLite schema**: The `createSchema()` method uses `CREATE TABLE IF NOT EXISTS` with `CREATE INDEX IF NOT EXISTS`. Schema changes must be additive (new columns, extended CHECK constraints). The `clearAll()` method does a full wipe of `documents`, `tags`, and `relationships` on every reindex, so migration of existing data is not required -- only the schema DDL matters.
- **INSERT OR IGNORE**: The `addRelationship()` method uses `INSERT OR IGNORE`, which silently drops constraint violations. The extended CHECK constraint must include all valid type values.
- **Type safety**: TypeScript strict mode is the primary quality gate. All new interfaces and type unions must be exhaustive.
- **Test isolation**: All DB tests use `:memory:` SQLite databases via `new KnowledgeDB(":memory:")`.
- **Backward compatibility**: Existing typed relationships (`builds_on`, `tensions`, `superseded_by`) must continue to work identically. The `post_mortem` type parsed by the parser but rejected by the DB CHECK constraint is a pre-existing bug to fix in this PR.

## Current State Analysis

The `ralph-knowledge` plugin's `relationships` table captures only typed edges with explicit prefixes (`builds_on::`, `tensions::`, `superseded_by:`). The parser regex (`WIKILINK_REL_RE`) matches only these prefixed patterns. A corpus audit reveals approximately 1,104 untyped wikilinks (86% of all cross-references) that are invisible to the graph. The typed-only approach produces a sparse graph inadequate for graph algorithms.

Key gaps:
1. The DB CHECK constraint at [db.ts:114](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/db.ts#L114) omits `post_mortem` -- parsed edges of this type are silently dropped by `INSERT OR IGNORE`.
2. No `context` column exists on `relationships` for storing enclosing paragraph text.
3. No stub document mechanism exists for unresolved wikilink targets.
4. The `knowledge_traverse` tool's `z.enum` at [index.ts:71](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts#L71) omits both `post_mortem` and `untyped`.

## Desired End State

### Verification
- [x] All `[[wikilinks]]` in document bodies are captured as `untyped` edges in the `relationships` table
- [x] Each untyped edge stores the enclosing paragraph as `context`
- [x] Typed wikilinks are not double-counted (no duplicate `untyped` edge for a wikilink already captured as `builds_on`/`tensions`/etc.)
- [x] Stub documents are created for wikilink targets that do not resolve to indexed files
- [x] The `post_mortem` type is accepted by the DB CHECK constraint (bug fix)
- [x] The `knowledge_traverse` MCP tool accepts `"untyped"` and `"post_mortem"` as type filters
- [x] Existing typed relationships continue to function identically
- [x] All tests pass: `npm test` from `plugin/ralph-knowledge/`

## What We're NOT Doing

- Incremental indexing (separate issue GH-665)
- Graph algorithm tools like community detection or centrality (GH-671, GH-672)
- Brief/full response mode for search results (GH-667)
- Schema migration for persistent DBs between versions (full rebuild via `clearAll()` handles this)
- Weighting untyped edges differently from typed edges in traversal
- Extracting wikilinks from frontmatter fields other than `superseded_by`

## Implementation Approach

The plan follows a bottom-up layering: first extend the parser to extract untyped wikilinks with paragraph context (Task 1.1), then extend the DB schema to accept them (Task 1.2), then wire the reindex pipeline to insert untyped edges and create stub documents (Task 1.3), then update the MCP tool to expose the new edge type (Task 1.4), and finally add comprehensive tests (Task 1.5). Each task builds on the previous one's types and interfaces.

---

## Phase 1: Capture All Wiki Links as Edges (GH-664)

### Overview

Extend the ralph-knowledge parser to extract all `[[wikilinks]]` as untyped edges with paragraph context, update the DB schema to store them, create stub documents for unresolved targets, and update the MCP traverse tool to filter by the new type.

### Tasks

#### Task 1.1: Add untyped wikilink extraction to parser

- **files**: `plugin/ralph-knowledge/src/parser.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] New `UntypedEdge` interface exported: `{ sourceId: string; targetId: string; context: string }`
  - [ ] New `extractUntypedWikilinks(id: string, body: string, typedTargets: Set<string>): UntypedEdge[]` function exported
  - [ ] The function splits `body` into paragraph blocks by splitting on `\n\n` (consecutive blank-line boundaries)
  - [ ] For each paragraph, strips fenced code blocks (`` ```...``` ``) before scanning for `[[...]]`
  - [ ] Uses regex `/\[\[([^\]]+)\]\]/g` to find all wikilinks within each paragraph
  - [ ] Skips any wikilink whose target is in the `typedTargets` set (avoids double-counting typed edges)
  - [ ] Returns `{ sourceId: id, targetId: <wikilink-target>, context: <enclosing-paragraph-text> }` for each match
  - [ ] `ParsedDocument` interface extended with `untypedEdges: UntypedEdge[]`
  - [ ] `parseDocument()` calls `extractUntypedWikilinks()` after typed relationship extraction, passing typed targets as the exclusion set
  - [ ] Handles edge cases: multiple wikilinks in same paragraph produce one edge per unique target (deduplicated within paragraph), wikilinks inside inline backticks are NOT stripped (only fenced code blocks)

#### Task 1.2: Extend DB schema for untyped edges, context, and stubs

- **files**: `plugin/ralph-knowledge/src/db.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `relationships` table CHECK constraint updated to: `type TEXT CHECK(type IN ('builds_on', 'tensions', 'superseded_by', 'post_mortem', 'untyped'))`
  - [ ] `relationships` table has new nullable column: `context TEXT` added after `type`
  - [ ] `documents` table has new column: `is_stub INTEGER DEFAULT 0`
  - [ ] `DocumentRow` interface extended with `isStub: number` field (SQLite integer boolean)
  - [ ] `RelationshipRow` interface extended with `context: string | null` field
  - [ ] `addRelationship()` method signature updated to accept optional `context?: string` parameter
  - [ ] The `addRelationship` INSERT statement updated to include `context` column
  - [ ] New `upsertStubDocument(id: string): void` method that inserts a document with `path = NULL`, `title = id`, `is_stub = 1`, content empty string, all other nullable fields NULL. Uses `INSERT OR IGNORE` to avoid overwriting real documents
  - [ ] `upsertDocument()` continues to work for real documents (sets `is_stub = 0` implicitly via the existing INSERT/ON CONFLICT pattern)
  - [ ] `clearAll()` continues to delete all documents (including stubs) and relationships

#### Task 1.3: Wire reindex pipeline for untyped edges and stub creation

- **files**: `plugin/ralph-knowledge/src/reindex.ts` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [ ] After the existing typed relationship loop (lines 69-71), a new loop iterates `parsed.untypedEdges` and calls `db.addRelationship(edge.sourceId, edge.targetId, "untyped", edge.context)` for each
  - [ ] After all documents are indexed, collects all unique `targetId` values from both typed relationships and untyped edges across all parsed documents
  - [ ] Diffs collected target IDs against all known document IDs (the set of `parsed.id` values from the indexing pass)
  - [ ] For each unresolved target ID, calls `db.upsertStubDocument(targetId)` to create a stub node
  - [ ] Log line added: `console.log(\`  Created ${stubCount} stub documents for unresolved links\`);`

#### Task 1.4: Update knowledge_traverse MCP tool for new edge types

- **files**: `plugin/ralph-knowledge/src/index.ts` (modify), `plugin/ralph-knowledge/src/traverse.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] `knowledge_traverse` tool's `type` parameter `z.enum` updated to: `["builds_on", "tensions", "superseded_by", "post_mortem", "untyped"]`
  - [ ] Tool description updated to mention untyped edges: `"Walk typed and untyped relationship edges from a document."`
  - [ ] `TraverseResult` interface in `traverse.ts` extended with `context: string | null` field
  - [ ] Traverser SQL queries updated to `SELECT` the `context` column from `relationships` and include it in results
  - [ ] Traverser `traverse()` and `traverseIncoming()` map functions updated to pass `context` through to `TraverseResult`

#### Task 1.5: Add comprehensive tests

- **files**: `plugin/ralph-knowledge/src/__tests__/parser.test.ts` (modify), `plugin/ralph-knowledge/src/__tests__/db.test.ts` (modify), `plugin/ralph-knowledge/src/__tests__/traverse.test.ts` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1, 1.2, 1.3, 1.4]
- **acceptance**:
  - [ ] **Parser tests** (`parser.test.ts`):
    - [ ] `extractUntypedWikilinks` extracts `[[target]]` from a simple paragraph and returns correct `context`
    - [ ] Multiple wikilinks in one paragraph each produce an edge with the same `context`
    - [ ] Wikilinks inside fenced code blocks (triple backtick) are skipped
    - [ ] Typed wikilinks (`- builds_on:: [[target]]`) are excluded when their target is in the `typedTargets` set
    - [ ] Duplicate targets within the same paragraph are deduplicated
    - [ ] `parseDocument()` populates `untypedEdges` array with correct sourceId, targetId, and context
    - [ ] `parseDocument()` with no untyped wikilinks returns empty `untypedEdges` array
  - [ ] **DB tests** (`db.test.ts`):
    - [ ] `addRelationship` with `type: "untyped"` succeeds (not rejected by CHECK)
    - [ ] `addRelationship` with `type: "post_mortem"` succeeds (bug fix verified)
    - [ ] `addRelationship` with `context` parameter stores and retrieves context correctly
    - [ ] `addRelationship` without `context` parameter stores NULL context
    - [ ] `upsertStubDocument` creates a document with `is_stub = 1`, `path = NULL`, `title = id`
    - [ ] `upsertStubDocument` does not overwrite an existing real document (INSERT OR IGNORE)
    - [ ] `clearAll` removes stub documents along with regular documents
  - [ ] **Traverse tests** (`traverse.test.ts`):
    - [ ] Traversing with `type: "untyped"` returns only untyped edges
    - [ ] Untyped edge results include `context` field
    - [ ] Traversing with no type filter returns both typed and untyped edges
    - [ ] Stub documents appear as `doc` in traverse results (title matches the stub ID)

### Phase Success Criteria

#### Automated Verification:
- [x] `npm run build` (from `plugin/ralph-knowledge/`) -- no TypeScript errors
- [x] `npm test` (from `plugin/ralph-knowledge/`) -- all tests passing

#### Manual Verification:
- [ ] Run `npm run reindex` against the actual `thoughts/` corpus and verify log output shows stub document creation
- [ ] Query `knowledge_traverse` from a document with known untyped wikilinks and verify edges appear with paragraph context

## Integration Testing

- [ ] Full reindex of `thoughts/` corpus completes without errors
- [ ] Existing typed relationships are preserved (count matches pre-change)
- [ ] Untyped edges are created (~1,100 expected based on corpus audit)
- [ ] Stub documents exist for wikilink targets not present in the corpus
- [ ] `knowledge_traverse` with `type: "untyped"` returns results with non-null `context`
- [ ] `knowledge_traverse` without type filter returns both typed and untyped edges
- [ ] `knowledge_search` continues to work without regression

## References

- Research: [GH-664 Research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-24-GH-0664-capture-all-wiki-links-as-edges.md)
- Related: [Knowledge Graph Plugin Comparison](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-24-knowledge-graph-plugin-comparison.md)
- Issue: https://github.com/cdubiel08/ralph-hero/issues/664
