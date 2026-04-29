---
date: 2026-04-29
status: draft
type: plan
github_issue: 906
github_issues: [906]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/906
primary_issue: 906
tags: [ralph-knowledge, memory-tier, dream-loop, parser, schema-v3]
---

# GH-906: Parser memory_tier Write Path - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-26-dreaming-research-trail-and-self-containment]]
- builds_on:: [[2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop]]
- builds_on:: [[2026-04-19-group-GH-762-ralph-knowledge-chunked-embeddings-dream-loop]]
- tensions:: None identified.

## Overview

Single-issue plan for atomic implementation in one PR:

| Phase | Issue  | Title                                                                              | Estimate |
|-------|--------|------------------------------------------------------------------------------------|----------|
| 1     | GH-906 | Parser drops memory_tier frontmatter, all docs land as 'doc'                       | S        |

## Shared Constraints

These constraints apply across every task in this plan. They are derived from the research doc, the existing schema v3 migration code, and the project's general TypeScript/SQLite conventions.

- **Three allowed `memory_tier` values**: `'doc'`, `'raw'`, `'reflection'`. Enforced at the SQL layer via the existing `CHECK(memory_tier IN ('doc','raw','reflection'))` constraint added in schema v3 (`db.ts:191`).
- **Default value when absent**: `'doc'`. The column already defaults to `'doc'` at the SQL level, so omitting `memory_tier` from the parsed object MUST yield `'doc'` in the DB row. Both `parser.ts` and `db.ts` must respect this default.
- **Parser keeps a single source of truth for frontmatter keys**: extend the existing key-extraction block in `parseDocument()` rather than introducing a separate function. Match the style of `date`, `type`, `status`, `github_issue`, `tags`, and `superseded_by`.
- **Forward compatibility for v2 DBs**: `db.ts:upsertDocument()` must continue to work on databases that have not yet run the v3 migration (the column is added by an `ALTER TABLE` in `createSchema()`, but external callers may pass a `dbPath` that points at a fresh `:memory:` instance — in which case the migration runs synchronously before `upsertDocument()` is reachable, so this is automatic). Do NOT add `memoryTier` to the `DocumentRow` interface as a required field — keep it optional (`memoryTier?: string | null`) so existing callers in `reindex.ts` and the tests don't have to change shape.
- **Reindex hand-off**: `reindex.ts:135-144` constructs the upsert payload from `parsed` fields. Add `memoryTier: parsed.memoryTier` to that payload — matching the style of the other fields. Do not refactor the surrounding code; the touch is two lines.
- **Validation strictness**: Invalid `memory_tier` values in frontmatter (e.g., `memory_tier: garbage`) MUST be coerced to `'doc'` rather than crashing the indexer. Log one warning per unknown value and treat absent/invalid the same way — the parser is forgiving, the SQL CHECK is the hard guard. This is consistent with how `parser.ts` treats unknown `type` values today (it just passes them through).
- **Tests use real disk + real DB**: per the issue's third acceptance criterion, the new end-to-end test MUST write a markdown file to a temp dir, invoke `reindex()`, then assert against a `KnowledgeDB(dbPath)` instance — not against `:memory:` with hand-crafted rows. The `reindex.test.ts` file already establishes the `mkdtempSync` + `writeFileSync` + `reindex([dir], dbPath)` pattern; reuse it.
- **Verification commands** (discovered from `plugin/ralph-knowledge/package.json`):
  - Build: `npm run build` (TypeScript compile, no errors)
  - Test: `npm test` (vitest)
  - No linter or formatter configured for ralph-knowledge — TypeScript strict mode is the only quality gate.

## Current State Analysis

The schema v3 migration in `plugin/ralph-knowledge/src/db.ts:186-198` adds the `memory_tier` column with a CHECK constraint and a `'doc'` default, plus an index. `getMemoryTier()` (`db.ts:477-486`) reads it. The parser in `plugin/ralph-knowledge/src/parser.ts:91-144` parses frontmatter for `date`, `type`, `status`, `github_issue`, `github_issues`, `primary_issue`, `tags`, and `superseded_by` — but not `memory_tier`. The write path in `db.ts:223-231` lists the columns `id, path, title, date, type, status, github_issue, content, is_stub` in both INSERT and `ON CONFLICT UPDATE` — `memory_tier` is absent.

Result on this machine: 1,685 documents in `~/.ralph-hero/knowledge.db` all have `memory_tier='doc'` (column default), including 14 raw-memory files written by `ingest.py` with explicit `memory_tier: raw` in frontmatter. The `knowledge_search memory_tier=raw|reflection` retrieval path returns nothing because no row was ever written with a non-default value. Plugin tests pass because they use `:memory:` SQLite with hand-crafted `INSERT INTO documents (..., memory_tier) VALUES (..., 'raw')` statements — they verify the *filter* and the *CHECK constraint*, not the *write path through `parseDocument` → `upsertDocument`*.

The fix is two narrow edits — one in `parser.ts` (extract from frontmatter) and one in `db.ts:upsertDocument()` (include the column in INSERT and UPDATE) — plus one supporting line in `reindex.ts` to forward the parsed value, and one new end-to-end test.

## Desired End State

### Verification

- [ ] `parser.ts` extracts `memory_tier` from frontmatter alongside `date`, `type`, `status`, `github_issue`, `tags`, `superseded_by`. Validates against the three allowed values; coerces invalid/absent values to `'doc'` with a one-line warning for invalid.
- [ ] `db.ts:upsertDocument()` includes `memory_tier` in both the INSERT column list and the `ON CONFLICT(id) DO UPDATE SET ...` clause.
- [ ] `reindex.ts` forwards `parsed.memoryTier` into the upsert payload at the existing call site (line ~135).
- [ ] An end-to-end test writes `memory_tier: raw` markdown to a temp dir on disk, runs `reindex(...)`, opens the produced DB via `new KnowledgeDB(dbPath)`, and asserts `SELECT memory_tier FROM documents WHERE id = ?` returns `'raw'`. The test does not use `:memory:` and does not hand-craft `INSERT` statements.
- [ ] After re-running `npm run reindex` on the user's local corpus, `sqlite3 ~/.ralph-hero/knowledge.db "SELECT memory_tier, COUNT(*) FROM documents GROUP BY memory_tier"` reports non-zero counts for `raw` (and, once `reflect.py` runs successfully, for `reflection`). [Manual — depends on GH-907 to also be resolved before all 14 raw files survive a reindex.]
- [ ] `reflect.py` finds the raw memories in its query window after the manual reindex (currently returns "Loaded 0 raw memories"). [Manual — same dependency.]

## What We're NOT Doing

- **Not fixing the reindex OOM (GH-907)**: Issue #907 is parallel and independent. This plan touches `parser.ts`, `db.ts`, and one line of `reindex.ts` — no embedder, no chunker, no batching changes. The 14 raw memories that exist on disk today will only fully land in the DB once GH-907 is also resolved, but THIS plan's E2E test creates a single tiny file and never approaches the OOM threshold.
- **Not adding ingest-time silent-failure surfacing (GH-908)**: Issue #908 is about how `ingest.py` should react when its auto-reindex hook fails. Out of scope here.
- **Not promoting `memory_tier` to a first-class field on `DocumentRow`**: Keep it optional on the upsert input. Existing callers (test fixtures, `reindex.ts`) don't need to change shape — they get the SQL default `'doc'` for free when they don't pass it.
- **Not adding a new `getMemoryTier()` method**: One already exists at `db.ts:477-486`. We just need it to return non-`'doc'` values for some rows.
- **Not changing the CHECK constraint or migrating existing rows**: All 1,685 existing `'doc'` rows stay as `'doc'`. The next reindex (post-fix) will upsert them with whatever their current frontmatter says — almost all of which will still resolve to `'doc'` by absence/default. Only the 14 dream-memory files will flip to `'raw'`. This is correct behavior.
- **Not modifying `parser.ts` behavior for any other frontmatter key**: Surgical extension only.
- **Not introducing a setup-driven config schema for memory tiers**: The three values are hardcoded in two places (parser validation + SQL CHECK). Documented in the shared constraints. No JSON schema, no enum re-export.

## Implementation Approach

The work is a single phase because all three code touches (parser, db, reindex hand-off) plus the one new E2E test must land together to satisfy any individual acceptance criterion. Splitting them would create a half-fixed write path that's harder to reason about and would require more shim code. The phase has four tasks because each touches a distinct file and each is independently verifiable.

**Phase dependency annotations**: This is a single-phase plan with no cross-plan dependencies. All tasks within the phase have intra-phase `depends_on` annotations to express the natural fix → forward → test flow.

---

## Phase 1: Add memory_tier to the parser/db write path (GH-906)

- **depends_on**: null

### Overview

Extend the markdown frontmatter parser to extract `memory_tier`, extend the SQL upsert to write it, forward it through the indexer, and prove the round-trip with a real-disk + real-DB end-to-end test. The fix is mechanical and lives entirely inside `plugin/ralph-knowledge/src/`.

### Tasks

#### Task 1.1: Extract memory_tier from frontmatter in parser.ts

- **files**: [plugin/ralph-knowledge/src/parser.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/parser.ts) (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `ParsedDocument` interface gains `memoryTier: string` field (non-optional on the parsed type — the parser always resolves to one of the three allowed values).
  - [ ] `parseDocument()` reads `frontmatter.memory_tier`. When the value is one of `'doc'`, `'raw'`, `'reflection'`, the parsed object's `memoryTier` is set to that exact value. When the value is absent (`undefined`/`null`), `memoryTier` is `'doc'`. When the value is present but not one of the three allowed strings, log one warning via `console.warn` (`memory_tier '<value>' on '<id>' is not one of doc|raw|reflection — coercing to 'doc'`) and set `memoryTier` to `'doc'`.
  - [ ] An existing `ALLOWED_MEMORY_TIERS = ['doc','raw','reflection'] as const` (or equivalent `Set<string>`) is declared once at module top.
  - [ ] New unit tests in [plugin/ralph-knowledge/src/__tests__/parser.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/parser.test.ts) cover:
    - frontmatter `memory_tier: raw` → `parsedDoc.memoryTier === 'raw'`
    - frontmatter `memory_tier: reflection` → `parsedDoc.memoryTier === 'reflection'`
    - frontmatter `memory_tier: doc` → `parsedDoc.memoryTier === 'doc'`
    - frontmatter omits `memory_tier` → `parsedDoc.memoryTier === 'doc'`
    - frontmatter `memory_tier: garbage` → `parsedDoc.memoryTier === 'doc'` AND `console.warn` was called once (use `vi.spyOn(console, 'warn')`)
  - [ ] Existing parser tests continue to pass — no change to the shape of returned `ParsedDocument` for any test that does not declare `memory_tier`.

#### Task 1.2: Persist memory_tier in db.ts upsertDocument

- **files**: [plugin/ralph-knowledge/src/db.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/db.ts) (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] The `upsertDocument()` parameter type accepts an optional `memoryTier?: string | null` (extending the existing intersection type so existing test fixtures that don't pass it continue to compile). When `memoryTier` is `undefined` or `null`, the SQL relies on the column default `'doc'` for inserts and on `COALESCE(@memoryTier, memory_tier)` for updates (so re-upserting an existing `'raw'` row without a `memoryTier` argument doesn't reset it back to `'doc'`).
  - [ ] INSERT clause column list becomes `(id, path, title, date, type, status, github_issue, content, is_stub, memory_tier)` and `VALUES (..., COALESCE(@memoryTier, 'doc'))`.
  - [ ] `ON CONFLICT(id) DO UPDATE SET ...` clause includes `memory_tier = COALESCE(@memoryTier, memory_tier)`.
  - [ ] New unit tests in [plugin/ralph-knowledge/src/__tests__/db.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/db.test.ts) cover:
    - `upsertDocument({...without memoryTier...})` → `getMemoryTier(id) === 'doc'` (default holds)
    - `upsertDocument({...memoryTier: 'raw'})` → `getMemoryTier(id) === 'raw'`
    - `upsertDocument({...memoryTier: 'reflection'})` → `getMemoryTier(id) === 'reflection'`
    - Re-upsert existing `'raw'` row WITHOUT passing `memoryTier` → `getMemoryTier(id) === 'raw'` still (COALESCE preserves the prior value).
    - Re-upsert existing `'raw'` row WITH `memoryTier: 'reflection'` → `getMemoryTier(id) === 'reflection'` (explicit value wins).
  - [ ] Existing `db.test.ts` tests under "schema v3: memory_tier column" continue to pass — they assert SQL-layer behavior (CHECK constraint, default, index) which this change does not touch.

#### Task 1.3: Forward parsed.memoryTier through reindex.ts

- **files**: [plugin/ralph-knowledge/src/reindex.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [ ] At [plugin/ralph-knowledge/src/reindex.ts:135-144](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/reindex.ts#L135-L144), the `db.upsertDocument({...})` call gains one new property: `memoryTier: parsed.memoryTier`. No other changes to `reindex.ts`.
  - [ ] TypeScript compiles (`npm run build`) without errors. The `parsed.memoryTier` field is now defined on `ParsedDocument` (per Task 1.1) and accepted by `upsertDocument` (per Task 1.2).

#### Task 1.4: End-to-end test for memory_tier round-trip

- **files**: [plugin/ralph-knowledge/src/__tests__/reindex.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/reindex.test.ts) (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1, 1.2, 1.3]
- **acceptance**:
  - [ ] A new test scenario in `describe("incremental reindex", ...)` (or a new `describe("memory_tier round-trip", ...)` block — implementer's choice, but reuse the existing `dir`, `dbPath`, and embedder/LLM mocks) named approximately `"memory_tier from frontmatter is persisted to the documents table"`.
  - [ ] The test writes a single markdown file to the temp `dir` with frontmatter that explicitly declares `memory_tier: raw` (full frontmatter: `date`, `type`, `status`, AND `memory_tier`).
  - [ ] The test calls `await reindex([dir], dbPath)`.
  - [ ] After reindex, the test opens `new KnowledgeDB(dbPath)` and asserts:
    - `db.getMemoryTier(<doc-id>) === 'raw'`
    - The raw SQL `db.db.prepare("SELECT memory_tier FROM documents WHERE id = ?").get(<doc-id>)` also returns `'raw'` (belt-and-suspenders against any future change to `getMemoryTier` semantics).
  - [ ] A second test scenario covers `memory_tier: reflection` — same flow, different value, asserts `'reflection'`.
  - [ ] A third test scenario writes a file WITHOUT a `memory_tier` frontmatter key, runs reindex, and asserts `getMemoryTier(<doc-id>) === 'doc'` (default propagation through the full pipeline).
  - [ ] A fourth test scenario writes a file with `memory_tier: garbage`, runs reindex, and asserts `getMemoryTier(<doc-id>) === 'doc'` (parser-layer coercion). Verifying the warning here is optional — the unit test in Task 1.1 already covers the warning.
  - [ ] The new tests do NOT use `:memory:` and do NOT hand-craft `INSERT` statements. They go through `reindex()` end-to-end.
  - [ ] All four scenarios pass on `npm test`.

### Phase Success Criteria

#### Automated Verification:

- [ ] `npm run build` (in `plugin/ralph-knowledge/`) — no TypeScript errors
- [ ] `npm test` (in `plugin/ralph-knowledge/`) — all existing tests pass + new tests in `parser.test.ts`, `db.test.ts`, and `reindex.test.ts` pass

#### Manual Verification:

- [ ] Run `npm run reindex` on the user's local corpus (after this fix is merged + GH-907 reindex OOM is fixed). Verify `sqlite3 ~/.ralph-hero/knowledge.db "SELECT memory_tier, COUNT(*) FROM documents GROUP BY memory_tier"` reports a non-zero `raw` count.
- [ ] Run `dream-now` (or the manual `uv run reflect.py --since 24h`). Verify `reflect.py` no longer reports "Loaded 0 raw memories" — it should report the count matching the indexed raw memories. (Note: the `reflect.py` query hits `documents_vec` keyed by `documents.id`, so once the documents table has correct tiers AND the chunks table has the corresponding rows, the reflector will see them.)

**Creates for next phase**: N/A — this is a single-phase plan. The fixed write path unblocks the dream-loop end-to-end test in `2026-04-26-dreaming-research-trail-and-self-containment.md` (Bootstrap Findings, Bug 1 → resolved). GH-907 (reindex OOM) is the next blocker for end-to-end dream-loop operation, and is being planned/implemented in parallel.

---

## Integration Testing

- [ ] After PR merges, run `dream-now` end-to-end on the user's machine. Confirm the count of `memory_tier='raw'` rows in `~/.ralph-hero/knowledge.db` matches the count of files in `~/projects/thoughts/dream-memories/<latest>/`. (This step depends on GH-907 also being resolved; until then, only a fraction of raw files will land in the DB before the OOM, but that fraction MUST have correct `memory_tier='raw'` after this fix.)
- [ ] Verify `knowledge_search memory_tier=raw` (via the MCP tool) returns the raw memories — proves the search.ts post-filter and the new write path agree on tier values.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/906
- Research: [thoughts/shared/research/2026-04-26-dreaming-research-trail-and-self-containment.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-dreaming-research-trail-and-self-containment.md) (Bootstrap Findings, Bug 1)
- Related issues:
  - GH-907 — reindex OOMs Node heap (P1, M, parallel)
  - GH-908 — ingest.py auto-reindex surfaces OOM as silent warning (P2, XS, blocked by 907)
- Schema v3 plan: [thoughts/shared/plans/2026-04-19-group-GH-762-ralph-knowledge-chunked-embeddings-dream-loop.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-19-group-GH-762-ralph-knowledge-chunked-embeddings-dream-loop.md)
- Schema v3 migration site: [plugin/ralph-knowledge/src/db.ts:186-198](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/db.ts#L186-L198)
- Existing memory_tier reader: [plugin/ralph-knowledge/src/db.ts:477-486](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/db.ts#L477-L486)
- Existing search-side filter: [plugin/ralph-knowledge/src/search.ts:151-180](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/search.ts#L151-L180)
