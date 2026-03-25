---
date: 2026-03-24
github_issue: 664
github_url: https://github.com/cdubiel08/ralph-hero/issues/664
status: complete
type: research
tags: [ralph-knowledge, knowledge-graph, wikilinks, sqlite, parser, graph-edges]
---

# GH-664: Capture All Wiki Links as Edges with Paragraph Context

## Prior Work

- builds_on:: [[2026-03-24-knowledge-graph-plugin-comparison]]
- builds_on:: [[2026-03-09-GH-0549-knowledge-metadata-alignment]]
- builds_on:: [[2026-03-08-knowledge-graph-design]]

## Problem Statement

The `ralph-knowledge` plugin's `relationships` table only captures edges with explicit type prefixes (`builds_on::`, `tensions::`, `post_mortem::`, `superseded_by:`). This leaves the vast majority of cross-references invisible to the graph.

A corpus audit shows approximately 948 untyped list-style wikilinks and 156 inline wikilinks scattered across `thoughts/`, compared to only 173 typed wikilinks. The typed-only approach produces a sparse graph — too sparse for graph algorithms (community detection, centrality) to produce meaningful results. The issue requests capturing all `[[wikilinks]]` as untyped edges alongside the existing typed layer, storing the enclosing paragraph as `context`, and creating stub document nodes for unresolved link targets.

## Current State Analysis

### Parser (`plugin/ralph-knowledge/src/parser.ts`)

The parser extracts relationships using two mechanisms:

1. **Body regex** (`WIKILINK_REL_RE`, line 25): `/^- (builds_on|tensions|post_mortem):: \[\[(.+?)\]\]/gm` — requires exact typed prefix format.
2. **Frontmatter** (`SUPERSEDED_BY_RE`, line 26): Handles `superseded_by:` as a YAML field.

The `ParsedDocument` interface carries `relationships: Relationship[]` where `Relationship.type` is a literal union of four types. Any `[[wikilink]]` not matching these patterns is silently discarded.

### Database (`plugin/ralph-knowledge/src/db.ts`)

The `relationships` table has a hard CHECK constraint at line 114:
```sql
type TEXT CHECK(type IN ('builds_on', 'tensions', 'superseded_by'))
```

Note: `post_mortem` is accepted by the parser but **rejected by the DB** — `INSERT OR IGNORE` silently drops it. This is a pre-existing bug uncovered during this research. The `knowledge_traverse` MCP tool's `z.enum` at `index.ts:71` also omits `post_mortem`.

The `addRelationship` method uses `INSERT OR IGNORE`, so the DB constraint violation is swallowed without error. Post-mortem relationships parsed from documents are silently lost.

For untyped wiki link storage, two design options exist:
1. **Same table** — add `'untyped'` to the CHECK constraint (or drop the constraint). Simple, all relationship queries hit one table.
2. **Separate table** — avoids changing the CHECK constraint semantics. More complex joins.

### Reindex (`plugin/ralph-knowledge/src/reindex.ts`)

The reindex pipeline at lines 69-71 iterates `parsed.relationships` and calls `db.addRelationship()`. Adding untyped edge extraction to the parser naturally flows into the same loop — no reindex changes needed beyond passing through the new relationship type.

### Corpus Audit

- **Typed wikilinks**: 173 across the corpus (14% of all wikilinks)
- **Untyped list wikilinks** (`- [[doc]]`): 948
- **Untyped inline wikilinks** (mid-sentence): 156
- **Total untyped**: ~1,104 (86% of all wikilinks)

Adding untyped edges would increase graph density by 6x. This is necessary for graph algorithms to produce meaningful results.

### Paragraph Context Capture

The obra/knowledge-graph approach: for each `[[wikilink]]`, find the enclosing paragraph and store it as the edge's `context` field. A "paragraph" in markdown is a block of consecutive non-empty lines.

Our current `relationships` table has no `context` column. Adding it requires a schema migration.

### Stub Nodes

When a wikilink target (`[[2026-future-doc]]`) doesn't resolve to an existing file, obra/knowledge-graph creates a stub document with `{ _stub: true }`. Our `documents` table has no stub mechanism.

In practice, stub nodes are needed to preserve graph structure for forward references. Without stubs, a link from document A to a not-yet-created document B creates an orphaned edge (target_id references no row in `documents`). Since `target_id` in our `relationships` table has no FK constraint (`source_id` references `documents` but `target_id` does not), orphaned edges already work without breaking the DB — stubs are optional for correctness but valuable for graph traversal (they allow `LEFT JOIN documents ON d.id = chain.target_id` to surface the stub node's metadata).

## Key Design Decisions

### 1. Same Table vs Separate Table for Untyped Edges

**Recommendation: Same table.** Add `'untyped'` to the CHECK constraint. The alternative (separate table) doubles query complexity for any traversal that should cross typed and untyped edges. The typed relationship semantic is preserved — typed edges just carry more specific types. The `knowledge_traverse` MCP tool can accept `type: "untyped"` as a new valid filter value.

### 2. Paragraph Context Column

Add a nullable `context TEXT` column to `relationships`. Typed edges (parsed from the `- builds_on:: [[]]` format) have no natural paragraph context (they're already semantically tagged), so `context` will be `NULL` for typed edges. Untyped edges store the surrounding paragraph.

### 3. Stub Document Representation

Add a nullable `is_stub INTEGER` column (SQLite boolean) to `documents`. Stub documents are created during reindex with: `id = targetId`, `path = NULL`, `title = targetId`, `is_stub = 1`. This is enough for the traverser's `LEFT JOIN` to return a non-null `doc` for stub nodes.

### 4. Wikilink Extraction Regex

The new regex for all wikilinks (not just typed ones):
```
/\[\[([^\]]+)\]\]/g
```

Applied to each paragraph block of the document body. The enclosing paragraph is found by splitting on `\n\n` and searching for the paragraph containing the match position.

This regex will also match wikilinks in code blocks (`` `[[foo]]` ``) unless we strip code blocks first. Code block stripping is already handled implicitly since our corpus uses wikilinks in backtick contexts only in the knowledge-graph-comparison research document (non-standard usage). Safe to apply the regex after stripping fenced code blocks.

### 5. Avoid Double-Counting Typed Wikilinks

Typed wikilinks (`- builds_on:: [[target]]`) already produce a typed edge. The untyped extraction pass should skip any wikilink that is part of a typed relationship line to avoid creating a duplicate `untyped` edge for the same wikilink.

## Potential Approaches

### Approach A: Extend Parser + DB Schema (Recommended)

1. In `parser.ts`: Add `extractAllWikilinks(body)` function that scans for `[[...]]` not on typed prefix lines, captures enclosing paragraph.
2. Add `UntypedEdge` interface with `{ sourceId, targetId, context }`.
3. In `db.ts`: Alter schema to add `context` column to `relationships`, add `'untyped'` to CHECK, add `is_stub` to `documents`.
4. In `reindex.ts`: After processing typed relationships, also insert untyped edges. Collect all `targetId` values; diff against known document IDs; create stub documents for unresolved targets.
5. In `index.ts`: Update `knowledge_traverse` enum to include `"untyped"`.
6. Tests: New test cases in `parser.test.ts`, `db.test.ts`, `traverse.test.ts`.

**Pros**: Clean, unified relationship model. Single query for mixed traversal.
**Cons**: Schema migration required (existing DB files need `ALTER TABLE`). The `clearAll()` + full rebuild pattern means migration only matters for persistent DBs between versions.

### Approach B: Separate `untyped_edges` Table

1. New table `untyped_edges (source_id, target_id, context)` with no type constraint.
2. Parser adds separate `untypedEdges` array to `ParsedDocument`.
3. Separate MCP tool or extended traverser for untyped edges.

**Pros**: Zero risk to existing typed relationship logic.
**Cons**: Dual-table traversal complexity. Graph algorithms must JOIN both tables. Harder to filter by "all edges" for graph density.

### Approach C: Separate `wiki_links` Table (obra pattern)

Mirror obra/knowledge-graph exactly: a `wiki_links` or `edges` table separate from `relationships`.

**Pros**: Exact parity with obra's design. Future-proof for adding more edge metadata.
**Cons**: Introduces three relationship stores (typed `relationships`, untyped `wiki_links`, and `superseded_by` in frontmatter). Over-engineered for current corpus size.

**Recommendation: Approach A.** The schema migration cost is near zero because `reindex` does a full rebuild every run (no incremental state to migrate). The unified model is simpler to query. The CHECK constraint is just documentation at this point since `INSERT OR IGNORE` swallows violations anyway.

## Risks

1. **Regex false positives in code blocks**: Wikilink-like syntax in fenced code blocks or inline backticks. Mitigation: strip fenced code blocks before scanning.
2. **Paragraph boundary detection**: Splitting on `\n\n` may misidentify boundaries in documents with single-newline separators. Mitigation: use a more robust block splitter that handles both `\n\n` and `\n`.
3. **Performance**: ~1,100 additional edges to insert during reindex. At current corpus size (200 docs), negligible. The `INSERT OR IGNORE` pattern is already in place.
4. **Stub node ID collisions**: If a stub target name coincidentally matches a future document ID, the reindex will update the stub to a real document. This is correct behavior — stubs are placeholders.
5. **Post-mortem bug regression**: The existing `post_mortem` parser/DB mismatch must be fixed in the same PR to avoid confusion. If `post_mortem` is added to the CHECK constraint, it becomes a proper typed edge type. The `knowledge_traverse` MCP enum must also be updated.

## Recommended Next Steps

1. Fix the pre-existing `post_mortem` bug: add `'post_mortem'` to the DB CHECK constraint and to the `knowledge_traverse` z.enum.
2. Add `context TEXT` column to `relationships` (nullable).
3. Add `is_stub INTEGER DEFAULT 0` column to `documents`.
4. Add `'untyped'` to the relationships CHECK constraint.
5. Implement `extractAllWikilinks(body)` in `parser.ts` — returns `{ targetId, context }[]`, skipping typed-prefix lines.
6. Add `untypedEdges` field to `ParsedDocument` interface.
7. In `reindex.ts`: insert untyped edges; collect unresolved targets; create stub documents.
8. Update `knowledge_traverse` MCP tool to accept `type: "untyped"`.
9. Write tests covering: untyped edge extraction, context capture, stub creation, backward compatibility with typed rels, post_mortem fix.

## Files Affected

### Will Modify
- `plugin/ralph-knowledge/src/parser.ts` - Add `extractAllWikilinks()`, `UntypedEdge` interface, extend `ParsedDocument` with `untypedEdges`
- `plugin/ralph-knowledge/src/db.ts` - Add `context` column to relationships, `is_stub` column to documents, extend CHECK constraint to include `'untyped'` and `'post_mortem'`
- `plugin/ralph-knowledge/src/reindex.ts` - Insert untyped edges and create stub documents after typed relationship processing
- `plugin/ralph-knowledge/src/index.ts` - Update `knowledge_traverse` z.enum to include `"untyped"` and `"post_mortem"`
- `plugin/ralph-knowledge/src/__tests__/parser.test.ts` - Tests for untyped extraction, context capture
- `plugin/ralph-knowledge/src/__tests__/db.test.ts` - Tests for stub documents, context column, extended CHECK
- `plugin/ralph-knowledge/src/__tests__/traverse.test.ts` - Tests for untyped edge traversal

### Will Read (Dependencies)
- `plugin/ralph-knowledge/src/traverse.ts` - Traverser queries; context column flows through naturally via `LEFT JOIN` change
- `plugin/ralph-knowledge/src/__tests__/reindex.test.ts` - Verify no assumptions broken by stub document creation
