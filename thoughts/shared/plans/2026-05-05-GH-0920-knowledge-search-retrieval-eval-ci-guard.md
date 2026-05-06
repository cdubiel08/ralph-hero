---
date: 2026-05-05
status: draft
type: plan
github_issue: 920
github_issues: [920]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/920
primary_issue: 920
tags: [ralph-knowledge, retrieval-quality, evaluation, ci, regression-guard]
---

# knowledge_search Retrieval Eval as CI Regression Guard - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-05-GH-0920-knowledge-search-retrieval-eval-ci-guard]] (research — primary research document)
- builds_on:: [[2026-04-29-knowledge-search-vs-ripgrep]] (eval — established Hit@5 = 37.5% baseline)
- builds_on:: [[2026-04-30-knowledge-search-with-rerank]] (eval — Hit@5 = 87.5% post-reranker baseline)

## Overview

1 atomic issue split across 4 phases for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-920 | Extract golden-queries.json + assemble pinned eval-corpus | S (part 1) |
| 2 | GH-920 | Implement scripts/eval-retrieval.ts runner | S (part 2) |
| 3 | GH-920 | Wire eval into CI (npm script + workflow step + model cache) | S (part 3) |
| 4 | GH-920 | Update benchmark/eval-rerank.mjs to consume shared JSON | S (part 4) |

This is a single S issue (`#920`) decomposed into four sequential phases that all land in one PR. The 4-phase split mirrors the `--assert` / corpus / runner / CI ordering recommended by the research document and follows the GH-913 heap-bench precedent.

## Shared Constraints

These constraints apply to ALL phases:

1. **Use `process.exitCode = 1`, NEVER `process.exit(1)`** — Hard `process.exit()` causes a libc++ abort during native ONNX teardown that returns 134 (SIGABRT) instead of 1. Match the heap-bench pattern in `benchmark/reindex-heap-bench.ts`.
2. **`rerank: false` is the only CI-supported path** — The BGE-Reranker-v2-m3 model is ~580 MB with a ~7s cold-start. The CI guard tests the default RRF-only retrieval path; do not add the reranker to the eval invocation.
3. **Initial threshold: `HIT5_THRESHOLD = 5/8 (62.5%)`** — Conservative relative to the current 87.5% baseline. The threshold MUST NOT exceed 62.5% on first commit even though the actual run will exceed it. Comment `// Raise to 6/8 (75%) once stable` near the constant so future maintainers see the deferred bump intent.
4. **Pinned corpus must be static fixtures, NOT symlinks or live references** — Copy the 11 corpus files (9 primary targets + 2 distractors) to `plugin/ralph-knowledge/__tests__/eval-corpus/` as committed `.md` content. Edits to live `thoughts/shared/` documents must NOT affect the eval.
5. **Reindex into a tmp-dir SQLite DB; NEVER write to the user's `~/.ralph-hero/knowledge.db`** — Use `mkdtempSync(join(tmpdir(), "eval-retrieval-db-"))` for the DB path, mirroring the heap-bench fixture handling.
6. **Set `RALPH_CONTEXTUAL_RETRIEVAL=0`** before calling `reindex()` to disable the LLM context call (the local llm endpoint is unreachable in CI).
7. **Substring-based hit matching** — The 8 golden queries each have an `expectedSubstrings` array. A result is a hit when ANY substring matches the result's path or id (mirrors the existing `findRank()` logic in `benchmark/eval-rerank.mjs`).
8. **`scripts/` (not `benchmark/`) signals CI intent** — `benchmark/` is for human-run one-shot quality probes; `scripts/` is for CI-enforced quality gates. The new runner MUST live at `plugin/ralph-knowledge/scripts/eval-retrieval.ts`.
9. **No PR-comment posting in this plan** — The issue's "PR comment with before/after Hit@1" requirement is deferred per research finding #5; the core eval guard does not need it. Stretch follow-up tracked separately.

## Current State Analysis

Per the research document:

- `benchmark/eval-rerank.mjs` already encodes the 8 golden queries with `expectedSubstrings` but is one-shot, not CI-safe (no `--assert`, no threshold enforcement, no corpus pinning). It runs against the live `~/.ralph-hero/knowledge.db`.
- `benchmark/reindex-heap-bench.ts` is the model to follow for the CI guard pattern: `--assert` flag, `process.exitCode = 1`, tmp-dir DB, structured TSV output, `npm run bench:heap -- --assert` step in `build-and-test-knowledge`.
- Source modules (`HybridSearch`, `KnowledgeDB`, `FtsSearch`, `VectorSearch`, `embed`, `reindex`) are all importable from `src/` (`tsx` runs `.ts` directly without a build step).
- All 9 primary target docs and 2 distractor docs already live in `thoughts/shared/`. They need to be COPIED to `__tests__/eval-corpus/`, not referenced.
- `package.json` currently has `bench:heap` but no `eval:retrieval`. `tsx` is already a devDependency.
- `.github/workflows/ci.yml` has the `build-and-test-knowledge` job with the heap-bench step, but no retrieval eval step and no HuggingFace model cache.
- Current RRF-only baseline on a fresh corpus run: Hit@1 = 62.5%, Hit@5 = 87.5%, MRR = 0.729 (post-reranker re-run from 2026-04-30, with `rerank: false`).

## Desired End State

### Verification

- [ ] `plugin/ralph-knowledge/evals/golden-queries.json` exists with 8 queries (identical to the spec in `benchmark/eval-rerank.mjs`).
- [ ] `plugin/ralph-knowledge/__tests__/eval-corpus/` contains 11 committed `.md` files (9 targets + 2 distractors).
- [ ] `plugin/ralph-knowledge/scripts/eval-retrieval.ts` runs locally via `npm run eval:retrieval` and prints Hit@1, Hit@5, MRR for the 8 queries.
- [ ] `npm run eval:retrieval -- --assert` exits 0 when Hit@5 >= 62.5% (5/8); exits 1 otherwise.
- [ ] `.github/workflows/ci.yml` runs the eval inside `build-and-test-knowledge` with HuggingFace model cache.
- [ ] `benchmark/eval-rerank.mjs` reads queries from the shared JSON file (no behavior drift).
- [ ] `npm run build` succeeds (no TS errors introduced).
- [ ] `npm test` continues to pass (no test regressions).
- [ ] `npm run bench:heap -- --assert` continues to pass (no perf regressions).

## What We're NOT Doing

- Expanding the eval beyond 8 queries (issue's explicit non-goal — start with what we have).
- Comparing against alternative retrievers (ripgrep, BM25-only) — that's a one-shot benchmark, not a CI guard.
- Automating golden-query generation — they remain hand-curated.
- Adding the cross-encoder reranker to the CI eval path — too slow (~7s cold-start).
- Posting PR comments with before/after metrics — deferred to a follow-up issue per research.
- Adding a path filter to skip the eval on docs-only PRs — research recommends running on every PR until CI cost is shown to be a problem.
- Splitting GH-920 into sub-issues via `/ralph-split` — this is an `S` standalone issue; phases live in one PR.

## Implementation Approach

**Phase 1** assembles the data fixtures (golden-queries.json + eval-corpus directory). No runner code yet — pure data wiring. **Phase 2** writes the TypeScript runner that reads the JSON, reindexes the pinned corpus into a tmp DB, runs the queries via `HybridSearch`, computes metrics, and exits non-zero on threshold breach. **Phase 3** wires it into CI: adds the `eval:retrieval` npm script, the workflow step, and the HuggingFace model cache action. **Phase 4** updates the legacy `eval-rerank.mjs` to read the shared JSON so the two stay in sync going forward.

Phases are strictly sequential — Phase 2 needs the JSON from Phase 1 and the corpus from Phase 1; Phase 3 needs the runner from Phase 2; Phase 4 is independent of Phase 3 but should ride in the same PR.

---

## Phase 1: Assemble golden-queries.json + pinned eval-corpus

- **depends_on**: null

### Overview

Create the shared query specification file and copy the 11 corpus markdown documents (9 primary targets + 2 distractors) into the test fixtures directory. No executable code in this phase.

### Tasks

#### Task 1.1: Create `evals/golden-queries.json` with 8 query definitions

- **files**: `plugin/ralph-knowledge/evals/golden-queries.json` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-knowledge/evals/golden-queries.json`.
  - [ ] JSON shape: `{ "queries": [ { "n": 1, "query": "...", "expectedSubstrings": ["..."], "type": "specific-keyword" }, ... ] }` matching the 8 query objects currently inlined in `benchmark/eval-rerank.mjs` lines 32-84.
  - [ ] All 8 queries (n=1 through n=8) preserved with identical `query`, `expectedSubstrings`, and `type` values.
  - [ ] File parses as valid JSON via `JSON.parse(readFileSync(...))`.
  - [ ] `q4` includes BOTH expected substrings: `["2026-04-26-dreaming-research-trail-and-self-containment", "2026-04-16-GH-0761"]`.

#### Task 1.2: Create `__tests__/eval-corpus/` directory and copy primary target docs

- **files**:
  - `plugin/ralph-knowledge/__tests__/eval-corpus/2026-04-29-reindex-memory-profile.md` (create — copy of `thoughts/shared/research/2026-04-29-reindex-memory-profile.md`)
  - `plugin/ralph-knowledge/__tests__/eval-corpus/2026-04-29-GH-911-release-embedder-tensors.md` (create — copy of `thoughts/shared/plans/2026-04-29-GH-911-release-embedder-tensors.md`)
  - `plugin/ralph-knowledge/__tests__/eval-corpus/2026-04-29-GH-916-chunker-no-progress-fix.md` (create — copy of `thoughts/shared/plans/2026-04-29-GH-916-chunker-no-progress-fix.md`)
  - `plugin/ralph-knowledge/__tests__/eval-corpus/2026-04-26-dreaming-research-trail-and-self-containment.md` (create — copy of `thoughts/shared/research/2026-04-26-dreaming-research-trail-and-self-containment.md`)
  - `plugin/ralph-knowledge/__tests__/eval-corpus/2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop.md` (create — copy of `thoughts/shared/plans/2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop.md`)
  - `plugin/ralph-knowledge/__tests__/eval-corpus/2026-04-26-softmax-and-rerank-calibration.md` (create — copy of `thoughts/shared/research/2026-04-26-softmax-and-rerank-calibration.md`)
  - `plugin/ralph-knowledge/__tests__/eval-corpus/2026-04-26-ralph-knowledge-wikilink-extractor.md` (create — copy of `thoughts/shared/research/2026-04-26-ralph-knowledge-wikilink-extractor.md`)
  - `plugin/ralph-knowledge/__tests__/eval-corpus/2026-04-22-context-handoff-topology.md` (create — copy of `thoughts/shared/research/2026-04-22-context-handoff-topology.md`)
  - `plugin/ralph-knowledge/__tests__/eval-corpus/2026-04-24-landcrawler-backend-hardening-postmortem.md` (create — copy of `thoughts/shared/research/2026-04-24-landcrawler-backend-hardening-postmortem.md`)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Directory `plugin/ralph-knowledge/__tests__/eval-corpus/` exists.
  - [ ] All 9 primary-target `.md` files exist with byte-identical content to their `thoughts/shared/` source counterparts (use `cp`, not symlink).
  - [ ] No frontmatter modifications (the parser needs `date`, `type`, `status`).
  - [ ] Filenames preserve the YYYY-MM-DD-... convention so `basename(path, ".md")` produces the document `id` the `expectedSubstrings` match against.

#### Task 1.3: Add 2 distractor docs to make the eval meaningful

- **files**:
  - `plugin/ralph-knowledge/__tests__/eval-corpus/2026-04-26-GH-0899-rrf-calibration-observability.md` (create — copy of `thoughts/shared/research/2026-04-26-GH-0899-rrf-calibration-observability.md`)
  - `plugin/ralph-knowledge/__tests__/eval-corpus/2026-04-26-GH-0902-mmr-diversity-reranking-ralph-knowledge.md` (create — copy of `thoughts/shared/research/2026-04-26-GH-0902-mmr-diversity-reranking-ralph-knowledge.md`)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] Both distractor files exist in `__tests__/eval-corpus/` with byte-identical content to their `thoughts/shared/research/` source counterparts.
  - [ ] These topically adjacent docs are NOT in any query's `expectedSubstrings` (they exist to make Q5's `softmax-and-rerank-calibration` win against semantically similar competition, not to match it).

#### Task 1.4: Verify tsconfig and vitest do not pick up corpus files as code or tests

- **files**: `plugin/ralph-knowledge/tsconfig.json` (read), `plugin/ralph-knowledge/vitest.config.ts` or default config (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] `tsconfig.json`'s `include` is `["src"]` and `exclude` includes `src/__tests__` — confirms `plugin/ralph-knowledge/__tests__/` (note the path) is outside the build output and there is no risk of confusion. Note: the existing test directory is `src/__tests__/` (inside `src/`); the new corpus directory is `__tests__/eval-corpus/` (top-level under `plugin/ralph-knowledge/`), distinct from the unit-test directory.
  - [ ] Vitest does NOT treat `.md` files as test specs — verified by running `npm test` after Task 1.3 lands. No new test failures, no new test files picked up. (Vitest's default `include` is `**/*.{test,spec}.{js,ts,...}` so `.md` is naturally ignored.)

### Phase Success Criteria

#### Automated Verification:

- [x] `node -e "require('fs').readFileSync('plugin/ralph-knowledge/evals/golden-queries.json'); console.log('ok')"` — file is readable.
- [x] `node -e "const j=JSON.parse(require('fs').readFileSync('plugin/ralph-knowledge/evals/golden-queries.json','utf8')); if(j.queries.length!==8) throw new Error('expected 8 queries, got '+j.queries.length); console.log('ok')"` — has 8 queries.
- [x] `ls plugin/ralph-knowledge/__tests__/eval-corpus/*.md | wc -l` returns `11`.
- [x] `npm test` (in `plugin/ralph-knowledge/`) — all existing tests still pass.
- [x] `npm run build` (in `plugin/ralph-knowledge/`) — TS compiles cleanly.

#### Manual Verification:

- [x] Spot-check three corpus files for non-empty content matching the source originals.

**Creates for next phase**: `evals/golden-queries.json` (consumed by `scripts/eval-retrieval.ts` in Phase 2, and by `benchmark/eval-rerank.mjs` in Phase 4); `__tests__/eval-corpus/` directory (reindexed by Phase 2's runner).

---

## Phase 2: Implement scripts/eval-retrieval.ts runner

- **depends_on**: [phase-1]

### Overview

Write the CI-runnable eval script that reads the golden-queries JSON, reindexes the pinned corpus into an in-memory or tmp-dir SQLite DB, runs each query through `HybridSearch.search(query, { limit: 10, rerank: false })`, computes Hit@1 / Hit@5 / MRR, prints a structured summary, and exits non-zero under `--assert` when Hit@5 falls below the threshold.

### Tasks

#### Task 2.1: Create `scripts/` directory and add `eval-retrieval.ts` skeleton

- **files**: `plugin/ralph-knowledge/scripts/eval-retrieval.ts` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Directory `plugin/ralph-knowledge/scripts/` exists.
  - [ ] File `plugin/ralph-knowledge/scripts/eval-retrieval.ts` exists with the standard `import` block from `src/reindex.ts`, `src/db.js`, `src/search.js`, `src/vector-search.js`, `src/hybrid-search.js`, `src/embedder.js` (use `.js` extensions per the codebase's NodeNext ESM pattern — `tsx` resolves `.js` imports to the corresponding `.ts` source files).
  - [ ] Top-level header comment cites GH-920 and references the heap-bench's `--assert` pattern as the model.
  - [ ] File imports `mkdtempSync`, `tmpdir`, `join`, `dirname`, `fileURLToPath`, and `readFileSync` from node builtins.

#### Task 2.2: Implement `loadGoldenQueries()` helper

- **files**: `plugin/ralph-knowledge/scripts/eval-retrieval.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] Function `loadGoldenQueries(jsonPath: string): GoldenQuery[]` reads and parses `evals/golden-queries.json`.
  - [ ] Returns 8 typed query objects: `{ n: number, query: string, expectedSubstrings: string[], type: string }`.
  - [ ] Path resolution uses `fileURLToPath(import.meta.url)` + `dirname()` + `join("..", "evals", "golden-queries.json")` so the script works whether invoked from repo root or `plugin/ralph-knowledge/`.
  - [ ] Throws a descriptive Error (with the resolved path) when the JSON file is missing or malformed.

#### Task 2.3: Implement `findRank()` substring-match helper

- **files**: `plugin/ralph-knowledge/scripts/eval-retrieval.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] `findRank(results: SearchResult[], expectedSubstrings: string[]): number | null` — same semantics as `eval-rerank.mjs` lines 86-95.
  - [ ] Returns 1-indexed rank of the first result whose `path` or `id` contains any expected substring.
  - [ ] Returns `null` when no result matches.
  - [ ] Empty-results edge case: returns `null` when `results.length === 0`.

#### Task 2.4: Implement `runEval()` core: reindex + search + metrics

- **files**: `plugin/ralph-knowledge/scripts/eval-retrieval.ts` (modify), `plugin/ralph-knowledge/src/reindex.ts` (read), `plugin/ralph-knowledge/src/hybrid-search.ts` (read), `plugin/ralph-knowledge/src/db.ts` (read), `plugin/ralph-knowledge/src/search.ts` (read), `plugin/ralph-knowledge/src/vector-search.ts` (read), `plugin/ralph-knowledge/src/embedder.ts` (read)
- **tdd**: false
- **complexity**: high
- **depends_on**: [2.2, 2.3]
- **acceptance**:
  - [ ] Sets `process.env.RALPH_CONTEXTUAL_RETRIEVAL = "0"` BEFORE calling `reindex()` (matches heap-bench line 214).
  - [ ] Resolves the corpus directory via `join(dirname(fileURLToPath(import.meta.url)), "..", "__tests__", "eval-corpus")`.
  - [ ] Creates a tmp DB via `mkdtempSync(join(tmpdir(), "eval-retrieval-db-"))` + `bench.db`.
  - [ ] Calls `await reindex([corpusDir], dbPath, false)` (third arg `generate=false`).
  - [ ] Constructs `KnowledgeDB`, `FtsSearch`, `VectorSearch`, then `HybridSearch` (NO reranker — pass `undefined` as the 5th constructor arg).
  - [ ] For each query: calls `await hybrid.search(q.query, { limit: 10, rerank: false })`, captures rank via `findRank()`, accumulates per-query result.
  - [ ] Computes `hit@1` (count of ranks 1-1), `hit@5` (count of ranks 1-5), `MRR = sum(1/rank if rank else 0) / N`.
  - [ ] Returns `{ perQuery: PerQueryResult[], hit1: string, hit5: string, mrr: number }` where the hit values are formatted as `${count}/${total}` strings (matches eval-rerank.mjs convention).
  - [ ] Closes the `KnowledgeDB` instance after the eval.

#### Task 2.5: Implement `main()` with `--assert` flag and exit logic

- **files**: `plugin/ralph-knowledge/scripts/eval-retrieval.ts` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [2.4]
- **acceptance**:
  - [ ] Parses `process.argv.slice(2)` and detects `--assert` flag (`args.includes("--assert")`).
  - [ ] Defines `const HIT5_THRESHOLD = 5; // 5/8 = 62.5% — raise to 6/8 (75%) once stable` near the top of the file.
  - [ ] Calls `runEval()`, prints structured summary (per-query rank table + aggregate Hit@1, Hit@5, MRR) via `console.log`.
  - [ ] When `assertMode && hit5Count < HIT5_THRESHOLD`: prints `eval-retrieval: ASSERT FAIL — Hit@5 ${hit5Count}/8 below threshold ${HIT5_THRESHOLD}/8`, then sets `process.exitCode = 1` (NOT `process.exit(1)` — see Shared Constraint #1).
  - [ ] When `assertMode && hit5Count >= HIT5_THRESHOLD`: prints `eval-retrieval: PASS — Hit@5 ${hit5Count}/8 >= threshold ${HIT5_THRESHOLD}/8`, exits 0.
  - [ ] Bottom-of-file invocation guard: `const invokedDirectly = process.argv[1]?.endsWith("eval-retrieval.ts");` then `if (invokedDirectly) main().catch(...)` — same pattern as `reindex-heap-bench.ts` lines 363-369.
  - [ ] On unexpected error inside `main()`: catches, prints `eval-retrieval: fatal error`, calls `process.exit(1)` (acceptable because no native ONNX teardown is in flight at the catch site).

#### Task 2.6: Manual smoke test of the runner

- **files**: (none — execution-only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.5]
- **acceptance**:
  - [ ] `cd plugin/ralph-knowledge && npx tsx scripts/eval-retrieval.ts` runs to completion in <120s on the M5 Pro dev machine.
  - [ ] Output includes a per-query rank table and an aggregate line showing Hit@5 >= 5/8.
  - [ ] `cd plugin/ralph-knowledge && npx tsx scripts/eval-retrieval.ts --assert; echo "exit=$?"` reports `exit=0`.
  - [ ] No stderr panic about missing `chunks` table or malformed reindex DB.

### Phase Success Criteria

#### Automated Verification:

- [ ] `npm run build` (in `plugin/ralph-knowledge/`) — TS compiles cleanly even though `scripts/` is outside `src/` (tsx runs uncompiled, so this just confirms no accidental `src/` regressions).
- [ ] `npm test` — existing tests still pass.
- [ ] `npx tsx scripts/eval-retrieval.ts --assert` exits 0 (manual run).

#### Manual Verification:

- [ ] Inspect output for the 8 query results; confirm the rank numbers look plausible against the corpus content (e.g., Q1 should rank `2026-04-29-reindex-memory-profile.md` high).

**Creates for next phase**: A working `scripts/eval-retrieval.ts` runner that Phase 3 wires into `package.json` and CI.

---

## Phase 3: Wire eval into CI (npm script + workflow step + model cache)

- **depends_on**: [phase-2]

### Overview

Add the `eval:retrieval` npm script, the GitHub Actions step, and the HuggingFace model cache action to make the eval run on every PR touching the knowledge plugin.

### Tasks

#### Task 3.1: Add `eval:retrieval` script to `package.json`

- **files**: `plugin/ralph-knowledge/package.json` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `package.json` `scripts` block adds `"eval:retrieval": "tsx scripts/eval-retrieval.ts"` immediately after the `bench:heap` line.
  - [ ] No other script ordering changes.
  - [ ] `npm run eval:retrieval` (locally) invokes the runner without `--assert` and exits 0.
  - [ ] `npm run eval:retrieval -- --assert` (locally) invokes the runner WITH `--assert` and exits 0 on the current corpus.

#### Task 3.2: Add HuggingFace model cache step to CI workflow

- **files**: `.github/workflows/ci.yml` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Inside `build-and-test-knowledge`, immediately AFTER the `actions/setup-node` step and BEFORE `npm ci`, add an `actions/cache@v4` step keyed on `${{ runner.os }}-hf-${{ hashFiles('plugin/ralph-knowledge/package-lock.json') }}` with `path: ~/.cache/huggingface/hub` and a `restore-keys: ${{ runner.os }}-hf-` fallback.
  - [ ] The cache action's `name:` is `Cache HuggingFace models (GH-920)`.
  - [ ] Does NOT remove the existing `actions/cache` for npm — they coexist (the npm cache is provided by `setup-node`'s `cache: npm` shorthand; the HF cache is a separate action).
  - [ ] `actionlint` (already run in `lint-workflows` job) does not flag the new step.

#### Task 3.3: Add retrieval eval step to `build-and-test-knowledge` job

- **files**: `.github/workflows/ci.yml` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.1, 3.2]
- **acceptance**:
  - [ ] New step `Retrieval eval (GH-920)` appears AFTER `Heap regression bench (GH-913)` in `build-and-test-knowledge`.
  - [ ] Step runs `npm run eval:retrieval -- --assert` with `timeout-minutes: 10`.
  - [ ] No path filter — runs on all PRs that the workflow already triggers on (per Risk 3 mitigation in research).
  - [ ] `actionlint` passes on the modified workflow.

#### Task 3.4: Run the modified CI locally via `act` if available, otherwise rely on PR-triggered run

- **files**: (none — execution-only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.3]
- **acceptance**:
  - [ ] If `act` is installed locally, run `act -j build-and-test-knowledge` and confirm the new step executes and exits 0.
  - [ ] If `act` is NOT installed: this acceptance criterion is satisfied by the PR's actual CI run on GitHub.

### Phase Success Criteria

#### Automated Verification:

- [ ] `npm run eval:retrieval -- --assert` (in `plugin/ralph-knowledge/`) — exits 0 with `Hit@5 >= 5/8`.
- [ ] `actionlint` passes against `.github/workflows/ci.yml` (run via the `lint-workflows` CI job).
- [ ] PR CI run shows the `Retrieval eval (GH-920)` step succeeded across all three Node matrix versions (18, 20, 22).

#### Manual Verification:

- [ ] First CI run after PR open: confirm the HuggingFace cache miss happens (~90 MB download) and subsequent runs hit the cache (no download).

**Creates for next phase**: `package.json` script + workflow step that Phase 4's `eval-rerank.mjs` update can also adopt the shared JSON without behavior drift.

---

## Phase 4: Update benchmark/eval-rerank.mjs to consume shared JSON

- **depends_on**: [phase-1]

### Overview

Replace the inlined `QUERIES` array in `benchmark/eval-rerank.mjs` with a `readFileSync` of `evals/golden-queries.json` so the one-shot bench and the CI guard share a single source of truth for golden-query definitions.

### Tasks

#### Task 4.1: Replace inlined QUERIES with JSON load

- **files**: `plugin/ralph-knowledge/benchmark/eval-rerank.mjs` (modify), `plugin/ralph-knowledge/evals/golden-queries.json` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Replace lines 27-84 (the `QUERIES` constant and its docstring) with a load from `../evals/golden-queries.json` using `readFileSync` + `JSON.parse` + path-resolved via `fileURLToPath(import.meta.url)`.
  - [ ] Variable name remains `QUERIES` so the rest of the script (line 124's `for (const q of QUERIES)` etc.) does not need changes.
  - [ ] The `expectedSubstrings`, `query`, `n`, `type` fields are preserved 1:1 from the JSON.
  - [ ] The script's existing behavior (Hit@1 / Hit@5 / MRR computation, latency capture, JSON stdout output) is byte-equivalent to the pre-change behavior when the same DB is supplied.

#### Task 4.2: Manual smoke test against the live DB

- **files**: (none — execution-only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] `node benchmark/eval-rerank.mjs > /tmp/eval-rerank-after.json 2>&1` (in `plugin/ralph-knowledge/`) completes successfully against the local `~/.ralph-hero/knowledge.db`.
  - [ ] Diffing the aggregate block of `/tmp/eval-rerank-after.json` against a pre-change run shows identical Hit@1, Hit@5, MRR (latency may vary; queries themselves must not).
  - [ ] No stderr panic about a missing `golden-queries.json` file path resolution.

### Phase Success Criteria

#### Automated Verification:

- [ ] `node benchmark/eval-rerank.mjs > /tmp/out.json` completes (exit 0).
- [ ] `jq '.aggregate.noRerank.hitAt5' /tmp/out.json` returns the expected `"7/8"` value (matches the post-reranker baseline doc).

#### Manual Verification:

- [ ] Confirm `eval-rerank.mjs` no longer contains the inlined query objects (`grep -c 'expectedSubstrings' benchmark/eval-rerank.mjs` returns 0 — the only occurrence post-change is the JSON load).

**Creates for next phase**: (none — Phase 4 is the last phase)

---

## Integration Testing

- [ ] Run the full local verification matrix in order:
  1. `cd plugin/ralph-knowledge && npm run build` — passes.
  2. `npm test` — all 20 existing test files pass.
  3. `npm run bench:heap -- --assert` — passes (no regression introduced by the corpus directory addition).
  4. `npm run eval:retrieval -- --assert` — passes with `Hit@5 >= 5/8`.
  5. `node benchmark/eval-rerank.mjs > /tmp/eval-rerank.json` — completes, aggregates match pre-change baselines.
- [ ] Open the PR; observe CI:
  1. `build-and-test-knowledge` job runs the new `Retrieval eval (GH-920)` step on all three Node versions.
  2. `lint-workflows` (actionlint) passes.
  3. First run shows HF model download (~10s); cached runs show <1s cache restore.
- [ ] After merge, run `git pull && npm run eval:retrieval` from a fresh clone to confirm the corpus + golden-queries.json shipped as committed artifacts (not gitignored).

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/920
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-05-05-GH-0920-knowledge-search-retrieval-eval-ci-guard.md
- Heap-bench precedent (GH-913): `plugin/ralph-knowledge/benchmark/reindex-heap-bench.ts`
- Sibling eval predecessor: `plugin/ralph-knowledge/benchmark/eval-rerank.mjs`
- Eval methodology: `thoughts/shared/evals/2026-04-29-knowledge-search-vs-ripgrep.md`
- Post-reranker re-run: `thoughts/shared/evals/2026-04-30-knowledge-search-with-rerank.md`
