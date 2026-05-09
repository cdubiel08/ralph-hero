---
date: 2026-05-09
status: draft
type: plan
github_issue: 1126
github_issues: [1126]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1126
primary_issue: 1126
parent_plan: thoughts/shared/plans/2026-05-07-GH-1118-test-coverage-hardening-epic.md
tags: [ralph-knowledge, retrieval-quality, evaluation, ci, regression-guard]
---

# Expand ralph-knowledge Retrieval Eval Suite (8 → 16) - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-05-GH-0920-knowledge-search-retrieval-eval-ci-guard]]
- builds_on:: [[2026-05-07-GH-1118-test-coverage-hardening-epic]]

## Overview

Single XS issue, atomic implementation in one PR.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1126 | Expand retrieval eval suite 8 → 16 golden queries | XS |

**Why grouped**: N=1, sibling phases (1119-1125) of parent epic #1118 are already implemented or in review.

## Shared Constraints

Inherited from parent epic plan-of-plans (`2026-05-07-GH-1118-test-coverage-hardening-epic.md`):

- All work targets `plugin/ralph-knowledge/` and CI wiring already exists in `.github/workflows/ci.yml`.
- Eval runner must remain CI-safe: tmp-dir DB, `RALPH_CONTEXTUAL_RETRIEVAL=0`, `process.exitCode` (never `process.exit`) to avoid the libc++ abort during native ONNX teardown.
- `rerank: false` (default RRF-only path) — do NOT enable the cross-encoder reranker; it adds ~7s cold-start.
- Threshold is in absolute query-count units (e.g., `10/16`), NOT a percentage — matches the existing `${n}/${total}` formatting convention.
- No new corpus documents may be added under `__tests__/eval-corpus/`. New queries must map to existing corpus titles.
- CI eval job has a 10-minute `timeout-minutes`; doubling queries (~1 min → ~2 min) stays well within budget.

Feature-specific:
- New threshold = (observed Hit@5 − 1) with one-query slack, documented inline with date comment per acceptance criterion.
- Mix of `specific-keyword` and `mixed`/semantic queries; at least half must require semantic matching, not trivial title match.

## Current State Analysis

`plugin/ralph-knowledge/evals/golden-queries.json` has 8 queries (N=1..8) covering: reindex OOM, embedder tensor release, chunker forward progress, dream-loop architecture, reranker calibration, wikilink extractor, context handoff topology, landcrawler hardening.

`plugin/ralph-knowledge/scripts/eval-retrieval.ts` reindexes `__tests__/eval-corpus/` into a tmp-dir SQLite DB, runs each query through `HybridSearch.search()` with `rerank: false`, computes Hit@1, Hit@5, MRR, and exits 1 when `hit5Count < HIT5_THRESHOLD` (currently `5`). The threshold constant is at the top of the file with explanatory comment.

Available corpus files in `plugin/ralph-knowledge/__tests__/eval-corpus/` (11 docs total):
- `2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop.md`
- `2026-04-22-context-handoff-topology.md` (already query #7)
- `2026-04-24-landcrawler-backend-hardening-postmortem.md` (already query #8)
- `2026-04-26-dreaming-research-trail-and-self-containment.md` (already query #4)
- `2026-04-26-GH-0899-rrf-calibration-observability.md`
- `2026-04-26-GH-0902-mmr-diversity-reranking-ralph-knowledge.md`
- `2026-04-26-ralph-knowledge-wikilink-extractor.md` (already query #6)
- `2026-04-26-softmax-and-rerank-calibration.md` (already query #5)
- `2026-04-29-GH-911-release-embedder-tensors.md` (already query #2)
- `2026-04-29-GH-916-chunker-no-progress-fix.md` (already query #3)
- `2026-04-29-reindex-memory-profile.md` (already query #1)

Existing queries cover 8 of 11 corpus docs. Three corpus docs are unused: `chunked-embeddings-dream-loop` (GH-0761), `RRF calibration` (GH-0899), `MMR diversity reranking` (GH-0902). The 8 new queries can re-use existing corpus docs (multiple queries per doc with different phrasing) and cover the unused three.

## Desired End State

### Verification

- [ ] `golden-queries.json` contains 16 queries numbered 1..16
- [ ] `npm run eval:retrieval -- --assert` passes from `plugin/ralph-knowledge/`
- [ ] `HIT5_THRESHOLD` set to `(observed Hit@5 − 1)` with inline date-stamped comment
- [ ] Removing one expected doc ID from a passing query locally drops Hit@5 below threshold and exits 1
- [ ] At least 8 of 16 queries have `type: "mixed"` (semantic) — not trivial title match
- [ ] CI build-and-test-knowledge job passes on main

## What We're NOT Doing

- No changes to `eval-retrieval.ts` runner architecture (just the threshold constant + comment)
- No changes to scoring algorithm (Hit@1, Hit@5, MRR formulas unchanged)
- No new corpus documents added to `__tests__/eval-corpus/`
- No removal of the existing 8 queries (renumbering is allowed but content preserved)
- No reranker changes — `rerank: false` stays the default
- Not raising the threshold to `(N − 1)/N` — slack of one query is intentional per acceptance criteria

## Implementation Approach

Single-phase atomic change. Add 8 queries to the JSON, run the eval locally to measure observed Hit@5, then set the threshold to `observed − 1`. Verify by mutating one query's expected ID and confirming exit 1.

---

## Phase 1: Expand golden-queries.json and re-tune threshold (GH-1126)

- **depends_on**: null

### Overview

Add 8 new golden queries to the JSON, measure observed Hit@5 on the expanded suite, and update the threshold constant in `eval-retrieval.ts` with a date-stamped inline comment.

### Tasks

#### Task 1.1: Add 8 new queries to golden-queries.json

- **files**: `plugin/ralph-knowledge/evals/golden-queries.json` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] JSON has 16 entries with `n: 1..16`, monotonically increasing
  - [ ] Each new entry has `query`, `expectedSubstrings` (1-3 items), `type` ("specific-keyword" or "mixed")
  - [ ] At least 4 of the 8 new queries have `type: "mixed"` (so 8+ of 16 total are semantic)
  - [ ] Every `expectedSubstrings` value matches a real basename under `plugin/ralph-knowledge/__tests__/eval-corpus/` (use the basename without `.md`)
  - [ ] Suggested topic coverage: chunked embeddings dream-loop (GH-0761), RRF calibration (GH-0899), MMR diversity (GH-0902), backend hardening postmortem, wikilink extractor (paraphrased), softmax + rerank calibration (paraphrased), embedder tensor release (paraphrased), context handoff (paraphrased)
  - [ ] JSON is valid (parseable by `JSON.parse`); trailing commas absent; 2-space indent matches existing style

#### Task 1.2: Measure observed Hit@5 locally

- **files**: `plugin/ralph-knowledge/evals/golden-queries.json` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Run `cd plugin/ralph-knowledge && npm run eval:retrieval` (no `--assert`) and capture the printed Hit@5 line
  - [ ] Record the observed `hit5Count` value (e.g., `14/16`); note any queries with `rank: -` for debugging
  - [ ] If observed Hit@5 < 12/16 (75%), revise weak queries in 1.1 (prefer paraphrases that test real semantics, not adversarial mismatches) and re-run

#### Task 1.3: Update HIT5_THRESHOLD with date-stamped comment

- **files**: `plugin/ralph-knowledge/scripts/eval-retrieval.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] `HIT5_THRESHOLD` constant updated to `observed_hit5 - 1` (e.g., observed 14/16 → threshold 13)
  - [ ] Inline comment updated: includes date `2026-05-09`, the observed Hit@5 value, and the slack rationale (`one-query slack`)
  - [ ] JSDoc block comment at top of file updated: `8` → `16` and `5/8 (62.5%)` → new ratio
  - [ ] `loadGoldenQueries` and runner code unchanged (no architectural changes)

#### Task 1.4: Mutation-test the threshold (negative test)

- **files**: none modified (transient local edit only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] Temporarily mutate one passing query's `expectedSubstrings` to a non-matching string in a local copy, run `npm run eval:retrieval -- --assert`, confirm `process.exitCode === 1` and `ASSERT FAIL` printed
  - [ ] Revert the mutation; confirm `npm run eval:retrieval -- --assert` prints `PASS` and exit code is 0
  - [ ] No file under version control is left mutated after this task

### Phase Success Criteria

#### Automated Verification:

- [ ] `cd plugin/ralph-knowledge && npm run build` — no errors
- [ ] `cd plugin/ralph-knowledge && npm run eval:retrieval -- --assert` — exits 0 with `PASS` log line
- [ ] `cd plugin/ralph-knowledge && npm test` — all tests passing (no test files touched, but coverage thresholds from Phase 2 still met)

#### Manual Verification:

- [ ] Threshold comment in `eval-retrieval.ts` reads naturally and includes the 2026-05-09 date
- [ ] Per-query log lines show plausible top-rank results across both keyword and mixed queries

**Creates for next phase**: N/A (final phase of parent epic #1118)

---

## Integration Testing

- [ ] CI `build-and-test-knowledge` job passes on the PR (eval step runs in <2 min)
- [ ] Epic parent #1118 advances to In Review/Done once all sibling phases (1121, 1122, 1123, 1125) merge

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1126
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1118
- Research: thoughts/shared/research/2026-05-05-GH-0920-knowledge-search-retrieval-eval-ci-guard.md
- Runner: `plugin/ralph-knowledge/scripts/eval-retrieval.ts`
- Golden queries: `plugin/ralph-knowledge/evals/golden-queries.json`
- Corpus: `plugin/ralph-knowledge/__tests__/eval-corpus/`
- CI wiring: `.github/workflows/ci.yml` (build-and-test-knowledge job, ~line 108-110)
