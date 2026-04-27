---
date: 2026-04-26
status: draft
type: plan
github_issue: 897
github_issues: [897]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/897
primary_issue: 897
tags: [ralph-knowledge, stub-documents, sqlite, fts5, traverse, memory-stats, data-integrity]
---

# ralph-knowledge stub-leak fix (traverse, search FTS leg, memory_stats) — Implementation Plan

## Prior Work

- builds_on:: [[2026-04-26-ralph-knowledge-wikilink-extractor]]
- builds_on:: [[2026-03-24-GH-0664-capture-all-wiki-links-as-edges]]
- builds_on:: [[2026-03-25-GH-0682-ralph-knowledge-three-bug-fix]]
- builds_on:: [[2026-03-26-ralph-knowledge-architecture-for-engine-parity]]

## Overview

Single S issue. Three MCP tools (`knowledge_traverse`, `knowledge_search` FTS leg, `knowledge_memory_stats`) bypass the `is_stub` filter that `GraphBuilder.buildGraph()` applies — they query SQLite directly and return stub documents that were materialized as foreign-key targets for unresolved wikilink references. Fix is mechanical: add `is_stub = 0 OR is_stub IS NULL` predicates at each bypass site, then add regression tests.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-897 | Stub-filter the three direct-SQLite bypass sites + regression tests | S |

## Shared Constraints

- **Plugin location**: All source lives under [plugin/ralph-knowledge/src/](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/). All tests live under [plugin/ralph-knowledge/src/__tests__/](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/).
- **Build/test working directory**: `cd plugin/ralph-knowledge && npm run build && npm test`. The vitest config and TS config are local to that directory.
- **Stub-filter idiom (canonical form)**: `is_stub = 0 OR is_stub IS NULL`. This matches the existing predicate at [graph-builder.ts:33](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/graph-builder.ts#L33). The `IS NULL` clause matters because the column was added via migration ([db.ts:181](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/db.ts#L181)) with `DEFAULT 0`, but legacy rows inserted before the migration may surface as `NULL` until rewritten. Use the same wording everywhere for greppability.
- **Schema is read-only in this work**. No new columns, no new indexes, no new tables. Existing `idx_rel_target` on `(target_id, type)` already supports the traverse query path.
- **ESM imports require `.js` extensions** (project uses `"type": "module"` with NodeNext resolution). Test files import from `"../db.js"`, `"../traverse.js"`, etc.
- **In-memory test DBs**: existing patterns use `new KnowledgeDB(":memory:")`. Reuse — no temp-file fixtures needed.
- **Stub creation surface to cover in tests**: stubs are created by both untyped wikilinks AND typed relationships (`builds_on`, `tensions`, `post_mortem`, `superseded_by`). Reference: [reindex.ts:160-168](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L160-L168). Tests should explicitly seed at least one of each path so a regression in either direction trips the suite.
- **`upsertStubDocument` writes `title = id`**: see [db.ts:241](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/db.ts#L241). Tests can assert "stub leaked" by checking that no result has `title === stubId` for a known stub id.
- **Search.ts FTS approach decision**: The acceptance criteria allow approach (a) query-time filter or approach (b) rebuild-time filter. **This plan picks (a)** — the search-time JOIN already includes `documents d`, so adding the predicate is a one-line change with no migration concern. Approach (b) would require existing installs to bump schema version or manually rebuild before stubs disappear from FTS. (a) is correct on every query without operator action.

## Current State Analysis

The four direct-SQLite query sites that bypass the `GraphBuilder` filter:

1. **[traverse.ts:24-53](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/traverse.ts#L24-L53)** — `Traverser.traverse()` outgoing CTE. The recursive walk uses `relationships` only, then a `LEFT JOIN documents d ON d.id = chain.target_id` to enrich titles. No `is_stub` clause, so stub-target hops surface with `doc.title = stubId`.
2. **[traverse.ts:81-110](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/traverse.ts#L81-L110)** — `Traverser.traverseIncoming()`. Same shape, mirrored direction. Joins on `d.id = chain.source_id`. Same gap.
3. **[search.ts:155-171](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/search.ts#L155-L171)** — `FtsSearch.search()` query. Joins `documents_fts` to `documents d` and applies superseded/type/tag filters but no stub filter. Full-text matches on stub `title = id` field surface.
4. **[index.ts:196,213,224](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts#L196-L228)** — `knowledge_memory_stats` runs three `COUNT(*) FROM documents` aggregates; only the `new_since` query incidentally excludes stubs (filters `date IS NOT NULL`, and stubs have `date = NULL`). Total and by-tier inflate.

Existing regression coverage of `is_stub` is limited to:
- [reindex.test.ts scenario 8 (line ~289)](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/reindex.test.ts) — stub creation timing.
- [db.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/db.test.ts) — `upsertStubDocument` mechanics.
- [traverse.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/traverse.test.ts) — exists but has zero stub-related cases.

No existing test asserts that `GraphBuilder.buildGraph()` drops stub-target edges (research §"Test coverage gaps"); this plan adds that assertion alongside the bypass-site fixes so the entire stub-filter contract has explicit coverage.

## Desired End State

After this plan ships:
- `knowledge_traverse` (outgoing and incoming) returns no rows whose `targetId` (outgoing) or `sourceId` (incoming) is a stub document.
- `knowledge_search` returns no documents with `is_stub = 1`.
- `knowledge_memory_stats.total_documents` and `by_tier.*` exclude stubs.
- `GraphBuilder.buildGraph()` continues to drop stub-target relationships, now backed by an explicit test.
- All four bypass surfaces share a single, greppable predicate: `is_stub = 0 OR is_stub IS NULL`.

### Verification

- [ ] `knowledge_traverse` from a doc with stub-target wikilinks returns only real-document hops in both directions.
- [ ] `knowledge_search` over an FTS index containing stubs returns zero stub rows.
- [ ] `knowledge_memory_stats` totals match `SELECT COUNT(*) FROM documents WHERE is_stub = 0 OR is_stub IS NULL`.
- [ ] Typed-relationship stubs (`builds_on` to non-existent target) are filtered identically to untyped-wikilink stubs by all three tools.
- [ ] `npm test` from `plugin/ralph-knowledge/` passes.

## What We're NOT Doing

- **Parser hardening** (skip `[[…]]` inside inline code, HTML comments, block quotes). Listed as out-of-scope on the issue. Track separately if needed.
- **Allowlist/validation** of placeholder-looking wikilink targets. Out-of-scope.
- **FTS auto-rebuild on stub-handling change**. Existing installs running pre-fix code will continue to have stubs in their `documents_fts` table; the search-time filter we add (Task 1.2) makes that benign — the stubs are filtered at query time. No migration step required. (If approach (b) were chosen, a rebuild trigger would be needed; we deliberately picked (a) to avoid that.)
- **Fixing `knowledge_subgraph` or other graph tools** — research confirmed they all route through `GraphBuilder.buildGraph()` and are clean.
- **Fixing the vector leg of `knowledge_search`** — confirmed clean (`upsertStubDocument` never embeds; `hybrid-search.ts:161` has a defense-in-depth guard).
- **Schema migrations** — no column adds, no index adds.
- **Refactoring the stub-filter into a helper function** — three lines in three files, all with slightly different SQL contexts (CTE alias `d`, direct table query, plain count). A helper would obscure more than it saves.

## Implementation Approach

A single phase containing:
- One source change per bypass site (3 files, 4 query locations).
- Four test additions covering each fix surface plus the missing graph-layer assertion.

The tests are written to exercise the production code paths (FTS rebuild, traverse CTE recursion) rather than asserting filter syntax in isolation, so any regression that re-introduces a bypass — including via a future refactor — trips the suite.

---

## Phase 1: Stub-filter the three direct-SQLite bypass sites + regression tests
- **depends_on**: null

### Overview

Add `is_stub = 0 OR is_stub IS NULL` predicates at the four bypass query sites in `traverse.ts`, `search.ts`, and `index.ts`, then add regression tests covering each fix plus the previously-missing graph-layer stub-drop assertion.

### Tasks

#### Task 1.1: Add stub filter to `Traverser.traverse()` and `Traverser.traverseIncoming()`
- **files**: `plugin/ralph-knowledge/src/traverse.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] In `traverse.ts:28-53` (outgoing CTE), add `WHERE d.is_stub = 0 OR d.is_stub IS NULL` to the outer `SELECT ... FROM chain LEFT JOIN documents d ...`. Because the current join is a `LEFT JOIN`, the predicate must NOT filter rows where `d.id IS NULL` (which would happen if a relationship target row was deleted but the relationship persisted). Use exactly: `WHERE d.id IS NULL OR d.is_stub = 0 OR d.is_stub IS NULL`.
  - [ ] In `traverse.ts:85-110` (incoming CTE), apply the same predicate to the join on `d.id = chain.source_id`: `WHERE d.id IS NULL OR d.is_stub = 0 OR d.is_stub IS NULL`.
  - [ ] No change to the recursive CTE body itself — the filter only constrains the outer SELECT so chains can still recurse through (then drop) any path. **Decision rationale**: filtering inside the CTE would prune mid-chain, hiding real targets reachable via a stub hop. Filtering only the final projection drops stub *results* without breaking transitive reach. (For this codebase, where stubs are never sources of edges that would extend a chain, both choices are equivalent in practice — outer-filter is simpler.)
  - [ ] All existing tests in `__tests__/traverse.test.ts` continue to pass (no fixture currently uses stubs, so behavior is identical).

#### Task 1.2: Add stub filter to `FtsSearch.search()` query
- **files**: `plugin/ralph-knowledge/src/search.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] In `search.ts:123-153`, add a new condition to the `conditions` array (alongside the superseded/type/tag predicates): `conditions.push("(d.is_stub = 0 OR d.is_stub IS NULL)");`. Place it immediately after the `documents_fts MATCH @query` push so it always applies and runs early in the WHERE evaluation.
  - [ ] No parameter binding required — the literal `0` is fine and avoids noise.
  - [ ] Do NOT modify `rebuildIndex()`. Approach (b) was rejected per Shared Constraints — stubs may remain in `documents_fts` on existing installs, and the query-time filter handles them.
  - [ ] All existing tests in `__tests__/search.test.ts` pass unchanged.

#### Task 1.3: Add stub filter to `knowledge_memory_stats` count queries
- **files**: `plugin/ralph-knowledge/src/index.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] At `index.ts:196`, change `SELECT COUNT(*) AS c FROM documents` to `SELECT COUNT(*) AS c FROM documents WHERE is_stub = 0 OR is_stub IS NULL`.
  - [ ] At `index.ts:213-216`, change the by-tier query to add `WHERE (is_stub = 0 OR is_stub IS NULL)` before `GROUP BY memory_tier`.
  - [ ] At `index.ts:224-229`, change the new-since by-tier query to add `AND (is_stub = 0 OR is_stub IS NULL)` to the existing WHERE clause (before `GROUP BY memory_tier`).
  - [ ] At `index.ts:240-243` (the v2-schema fallback `new_since` query for `byTier.doc`), add `AND (is_stub = 0 OR is_stub IS NULL)` to the existing WHERE. Even though stubs have `date = NULL` and the existing `date IS NOT NULL` filter already excludes them, add the explicit predicate for consistency and to harden against any future stub that gets a non-null date.
  - [ ] At `index.ts:262-268` (the `last_reflection_at` query): add `AND (is_stub = 0 OR is_stub IS NULL)` for the same defense-in-depth reason; reflection stubs cannot exist today but the predicate is cheap.
  - [ ] When `hasTier` is false and `totalDocuments` is assigned to `byTier.doc` at `index.ts:238`, this still uses the now-stub-filtered total — correct behavior, no change needed.
  - [ ] `chunks_per_doc_p50/p90` query at `index.ts:250-254` operates on `chunks` table (not `documents`); chunks are only created for real documents per [reindex.ts:230](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L230) (research §"Vector index is clean" and the same logic applies to chunks). No change needed.

#### Task 1.4: Regression test — `knowledge_traverse` excludes stub hops (outgoing + incoming)
- **files**: `plugin/ralph-knowledge/src/__tests__/traverse.test.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Add a `describe("stub filtering", () => {...})` block to the existing test file.
  - [ ] Test setup: insert a real doc `real-a`, then call `db.upsertStubDocument("stub-untyped-target")` and `db.upsertStubDocument("stub-typed-target")`, then `db.addRelationship("real-a", "stub-untyped-target", "untyped", "context")` and `db.addRelationship("real-a", "stub-typed-target", "builds_on")`.
  - [ ] Assert `traverser.traverse("real-a", { depth: 1 })` returns zero results (both stub targets filtered).
  - [ ] Assert `traverser.traverseIncoming("stub-untyped-target")` returns zero results (the inbound edge from `real-a` is technically present, but the stub itself has no outbound chain — verify no spurious empty-target rows leak).
  - [ ] Mirror test for incoming: insert `real-b` and `db.addRelationship("stub-untyped-target", "real-b", "untyped")` (yes, stubs CAN appear as source_id in `relationships` because the FK constraint accepts them — the row only needs the stub doc to exist). Then `traverser.traverseIncoming("real-b", { depth: 1 })` must return zero results (the only incoming edge is from a stub).
  - [ ] Assert that the existing fixture in the file (real-only chain `doc-c -> doc-b -> doc-a`) still returns exactly the same results as before — non-regression check.

#### Task 1.5: Regression test — `FtsSearch.search()` excludes stub documents
- **files**: `plugin/ralph-knowledge/src/__tests__/search.test.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] Add a `describe("stub filtering", () => {...})` block.
  - [ ] Setup: in a fresh `beforeEach` (or new `describe` with own setup), insert one real doc with content `"unique-marker payload"`, then `db.upsertStubDocument("unique-marker-stub-id")`. Call `fts.rebuildIndex()` after both inserts so the stub gets indexed (this is the unfortunate state present on installs that bumped schema version after stubs existed).
  - [ ] Assert `fts.search("unique-marker")` returns exactly the real doc — the stub (whose `title = "unique-marker-stub-id"` matches) must be filtered out.
  - [ ] Assert `fts.search("unique-marker-stub-id")` returns zero results — confirms the stub is invisible even when its title is queried directly.
  - [ ] Verify the existing tests in `__tests__/search.test.ts` continue to pass.

#### Task 1.6: Regression test — `knowledge_memory_stats` totals and by-tier exclude stubs
- **files**: `plugin/ralph-knowledge/src/__tests__/memory-stats.test.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] Add a `describe("stub filtering", () => {...})` block using the existing `callStats` helper and `seedDoc` pattern.
  - [ ] Setup: seed two real docs (one `doc` tier, one `reflection` tier), then create three stubs via `db.upsertStubDocument("stub-1")`, `db.upsertStubDocument("stub-2")`, `db.upsertStubDocument("stub-3")`.
  - [ ] Assert `payload.total_documents === 2` (not 5).
  - [ ] Assert `payload.by_tier.doc === 1`, `payload.by_tier.reflection === 1`, `payload.by_tier.raw === 0`. Stubs default to `memory_tier = 'doc'` per the migration default, so without the filter they would inflate `by_tier.doc` to 4.
  - [ ] Assert `payload.new_since.*` are unaffected (stubs have `date = NULL` and were already excluded; this is a non-regression check).

#### Task 1.7: Regression test — `GraphBuilder.buildGraph()` drops stub-target edges
- **files**: `plugin/ralph-knowledge/src/__tests__/graph-builder.test.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Add a test case asserting the previously-undocumented behavior at [graph-builder.ts:62-65](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/graph-builder.ts#L62-L65).
  - [ ] Setup: insert real doc `real-x`, call `db.upsertStubDocument("stub-y")`, then `db.addRelationship("real-x", "stub-y", "untyped")` and `db.addRelationship("real-x", "stub-y", "builds_on")` (typed) to verify both relationship types drop together.
  - [ ] Build graph: `const g = new GraphBuilder(db).buildGraph()`.
  - [ ] Assert `g.hasNode("stub-y") === false`.
  - [ ] Assert `g.outDegree("real-x") === 0` — both stub-target edges dropped.
  - [ ] Assert `g.order === 1` (only `real-x`) and `g.size === 0`.

### Phase Success Criteria

#### Automated Verification:
- [ ] `cd plugin/ralph-knowledge && npm run build` — no TypeScript errors
- [ ] `cd plugin/ralph-knowledge && npm test` — all suites pass, including the four new test blocks
- [ ] `grep -rn "is_stub = 0 OR is_stub IS NULL" plugin/ralph-knowledge/src/` returns at least 7 hits (1 graph-builder existing, 2 traverse, 1 search, 5 index.ts memory-stats; counts approximate — confirms the canonical idiom is used everywhere)

#### Manual Verification:
- [ ] After patch, run the indexer against the live `~/.ralph-hero/knowledge.db` and call `knowledge_memory_stats` — `total_documents` should drop by the count of stubs (visible via `sqlite3 ~/.ralph-hero/knowledge.db "SELECT COUNT(*) FROM documents WHERE is_stub = 1"`).
- [ ] Call `knowledge_traverse` from a research doc known to contain placeholder wikilinks (e.g., the seed dream-loop doc that triggered the original investigation) — phantom targets should no longer appear in output.

**Creates for next phase**: N/A (last phase).

---

## Integration Testing

- [ ] Build the plugin and reload the MCP server in Claude Code; confirm `knowledge_search`, `knowledge_traverse`, and `knowledge_memory_stats` all return the expected post-fix shapes.
- [ ] Optional: re-run the original failing query (`knowledge_traverse` from the dream-loop seed doc) and verify zero phantom targets in the response.

## References

- Research: [thoughts/shared/research/2026-04-26-ralph-knowledge-wikilink-extractor.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-ralph-knowledge-wikilink-extractor.md) (includes the follow-up audit table that confirmed all four bypass sites)
- Issue: https://github.com/cdubiel08/ralph-hero/issues/897
- Source files:
  - [plugin/ralph-knowledge/src/traverse.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/traverse.ts)
  - [plugin/ralph-knowledge/src/search.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/search.ts)
  - [plugin/ralph-knowledge/src/index.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts)
  - [plugin/ralph-knowledge/src/graph-builder.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/graph-builder.ts) (reference predicate)
- Test files (all modified):
  - [plugin/ralph-knowledge/src/__tests__/traverse.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/traverse.test.ts)
  - [plugin/ralph-knowledge/src/__tests__/search.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/search.test.ts)
  - [plugin/ralph-knowledge/src/__tests__/memory-stats.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/memory-stats.test.ts)
  - [plugin/ralph-knowledge/src/__tests__/graph-builder.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/graph-builder.test.ts)
- Related: #664 (capture-all-wiki-links-as-edges), #679 (exclude stubs from GraphBuilder), #682 (three-bug-fix Phase 3 stub-creation timing)
