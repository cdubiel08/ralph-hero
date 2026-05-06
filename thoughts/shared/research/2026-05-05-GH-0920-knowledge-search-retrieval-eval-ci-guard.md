---
date: 2026-05-05
github_issue: 920
github_url: https://github.com/cdubiel08/ralph-hero/issues/920
status: complete
type: research
tags: [ralph-knowledge, retrieval-quality, evaluation, ci, regression-guard]
---

# Research: knowledge_search Retrieval Eval as CI Regression Guard (GH-920)

## Prior Work

- builds_on:: [[2026-04-29-knowledge-search-vs-ripgrep]] (eval — primary evidence; established the 8-query golden set and Hit@5 = 37.5% baseline on the pre-reranker config)
- builds_on:: [[2026-04-30-knowledge-search-with-rerank]] (eval — post-reranker re-run; Hit@5 = 87.5% with fusion+drop-title, Hit@1 = 50% at rerank=true; RRF-only Hit@5 = 87.5% at rerank=false)
- builds_on:: [[2026-04-26-GH-0901-local-cross-encoder-reranker-m5-pro]] (research — reranker latency: cold ~7s, warm ~40ms/pair)
- builds_on:: [[2026-04-26-softmax-and-rerank-calibration]] (research — score calibration background, cited in hybrid-search.ts fusion logic)

## Problem Statement

The 8-query golden-query eval in `thoughts/shared/evals/2026-04-29-knowledge-search-vs-ripgrep.md` established a retrieval-quality baseline: Hit@1 = 25%, Hit@5 = 37.5%, MRR = 0.310 on the pre-reranker config. The post-reranker re-run (2026-04-30) shows the current config (RRF + fusion reranker, `rerank: false` default) achieves Hit@5 = 87.5% on a live corpus of ~1,710 docs.

Without a CI regression guard, changes to the chunker, embedder, RRF weights, reranker fusion alpha, or corpus processing could silently regress these numbers. Issue #920 asks for an eval runner script at `plugin/ralph-knowledge/scripts/eval-retrieval.ts`, a pinned eval corpus, golden-query JSON, and CI wiring.

## Current State Analysis

### What already exists

**`benchmark/eval-rerank.mjs`** (`plugin/ralph-knowledge/benchmark/eval-rerank.mjs`):
- Contains the exact 8 golden queries with `expectedSubstrings` for each
- Imports compiled `dist/` modules: `KnowledgeDB`, `FtsSearch`, `VectorSearch`, `HybridSearch`, `embed`, `Reranker`
- Runs against the live `~/.ralph-hero/knowledge.db` (not a pinned corpus)
- Measures Hit@1, Hit@5, Hit@10, MRR plus per-query latency (cold vs warm)
- Outputs structured JSON to stdout — not CI-safe (no `--assert` mode, no threshold enforcement, no corpus pinning)
- Was written for the one-shot GH-927 eval measurement; it is NOT a CI guard

**`benchmark/reindex-heap-bench.ts`** (`plugin/ralph-knowledge/benchmark/reindex-heap-bench.ts`):
- The model to follow for the retrieval eval (GH-913 CI guard pattern)
- Uses `--assert` flag to convert threshold breach into `process.exitCode = 1`
- Uses `process.exitCode` not `process.exit()` so native ONNX teardown completes cleanly
- Runs against a synthetic deterministic corpus (50 docs, seeded RNG) so corpus drift cannot move the score
- Wired in CI as `npm run bench:heap -- --assert` inside `build-and-test-knowledge` job

**CI job (`build-and-test-knowledge` in `.github/workflows/ci.yml`)**:
- Runs `npm ci` → `npm run build` → `npm test` → `npm run bench:heap -- --assert`
- No path filter currently (runs on all PRs touching anything)
- No retrieval eval step
- No PR comment posting (the "perf-bench comments" mentioned in the issue do not exist in the current CI)

**`package.json` scripts**:
- `bench:heap` maps to `tsx benchmark/reindex-heap-bench.ts`
- No `bench:retrieval` or `eval:retrieval` script exists yet
- `tsx` is already a devDependency — usable immediately for `.ts` scripts

**Source modules** (`src/`):
- `HybridSearch` accepts an injected `reranker?: Reranker` and mocks cleanly in tests (stub injection instead of real ONNX model)
- `KnowledgeDB`, `FtsSearch`, `VectorSearch` all usable from `dist/` without mocking
- `hybrid-search.ts` contains the `RERANK_FUSION_ALPHA = 0.5` fusion constant and the full rerank splice

### What does not exist yet

- `plugin/ralph-knowledge/scripts/` directory
- `plugin/ralph-knowledge/scripts/eval-retrieval.ts` runner script
- `plugin/ralph-knowledge/__tests__/eval-corpus/` pinned corpus directory
- `plugin/ralph-knowledge/evals/golden-queries.json` golden-query spec
- A `bench:retrieval` (or `eval:retrieval`) script in `package.json`
- CI step to run the eval on PRs touching `plugin/ralph-knowledge/src/**`
- PR comment posting for before/after metrics

### Current quality baseline (post-reranker, as of 2026-04-30 re-run)

| Metric | rerank=false (RRF only) | rerank=true (fusion) |
|--------|------------------------:|---------------------:|
| Hit@1  | 62.5% (5/8)             | 50.0% (4/8)          |
| Hit@5  | 87.5% (7/8)             | 87.5% (7/8)          |
| MRR    | 0.729                   | 0.667                |

The threshold in the issue (`Hit@5 ≥ 50%`) is conservative relative to the current 87.5% baseline. The evaluation should run against `rerank=false` (the default) to avoid the 7-second ONNX model cold-start on CI (which would make the step impractical on every PR).

## Key Discoveries

### 1. eval-rerank.mjs is the direct predecessor — reuse its query definitions

`benchmark/eval-rerank.mjs` already encodes all 8 golden queries with `expectedSubstrings` arrays. The new `scripts/eval-retrieval.ts` should import query definitions from a shared `evals/golden-queries.json` file, and `eval-rerank.mjs` should be updated to read from the same JSON. This avoids duplication and ensures the CI guard and the one-shot bench are always in sync on query definitions.

### 2. Pinned corpus: the 9 primary target docs are already in the repo

All 8 golden query target documents live in `thoughts/shared/` and are already committed to the repo. They do NOT need to be fetched from external sources. They total ~3,600 lines, well within the "small corpus" goal. The issue recommends 10-20 docs; we need the 9 primary targets plus a set of "distractor" docs (docs that are topically adjacent but should NOT rank at position 1) to make the eval meaningful.

The 9 primary target files (relative to repo root):

1. `thoughts/shared/research/2026-04-29-reindex-memory-profile.md` (Q1)
2. `thoughts/shared/plans/2026-04-29-GH-911-release-embedder-tensors.md` (Q2)
3. `thoughts/shared/plans/2026-04-29-GH-916-chunker-no-progress-fix.md` (Q3)
4. `thoughts/shared/research/2026-04-26-dreaming-research-trail-and-self-containment.md` (Q4, alt: `thoughts/shared/plans/2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop.md`)
5. `thoughts/shared/plans/2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop.md` (Q4 alternate)
6. `thoughts/shared/research/2026-04-26-softmax-and-rerank-calibration.md` (Q5)
7. `thoughts/shared/research/2026-04-26-ralph-knowledge-wikilink-extractor.md` (Q6)
8. `thoughts/shared/research/2026-04-22-context-handoff-topology.md` (Q7)
9. `thoughts/shared/research/2026-04-24-landcrawler-backend-hardening-postmortem.md` (Q8)

Distractor docs (topically adjacent, should NOT outrank the target):
- `thoughts/shared/research/2026-04-26-GH-0899-rrf-calibration-observability.md` (adjacent to Q5)
- `thoughts/shared/research/2026-04-26-GH-0902-mmr-diversity-reranking-ralph-knowledge.md` (adjacent to Q5)

A 10-12 doc corpus (9 targets + 2-3 distractors) is sufficient. The eval should be deterministic: copy these specific files to `plugin/ralph-knowledge/__tests__/eval-corpus/` and reindex that directory into a fresh `:memory:` SQLite DB for each run.

### 3. Corpus must use a fresh in-memory DB, not the live knowledge.db

The heap-bench model (using a tmp-dir corpus + tmp-dir DB) is correct here too. Importing `reindex()` directly from `src/reindex.ts` (as the heap bench does) lets the eval run against a fresh in-memory (or tmp) DB without touching the user's live database. This is how `reindex.test.ts` works as well — deterministic, no filesystem side effects.

The difference from the heap bench: the retrieval eval needs the transformer model for embedding the corpus and queries. This is the primary CI feasibility concern (see Risk 1 below).

### 4. rerank=false is the correct default for CI; rerank=true is too slow

The live corpus eval showed `rerank: false` warm latency is ~9ms/query. On the pinned 12-doc corpus, embedding + FTS + vector search will be even faster. Using `rerank: false` for the CI guard means no ONNX reranker model download (the BGE-Reranker-v2-m3 model is ~580 MB and has a ~7s cold-start). The eval should guard the RRF baseline quality, not the opt-in reranker path — that's a separate quality bar.

### 5. The issue's PR comment requirement has no existing pattern to follow

The `ci.yml` currently has no PR-comment-posting steps for any job. The "similar to perf-bench comments" wording in the issue refers to a pattern that doesn't exist yet in this repo. This requirement adds significant CI complexity (needs `pull-requests: write` permission, `actions/github-script` or `gh` CLI step, storing baseline for comparison). It should be treated as a stretch goal, not a blocker for the core eval guard.

### 6. Threshold calibration: Hit@5 ≥ 50% is too conservative for the current corpus

The current RRF-only baseline is 87.5% Hit@5 on a fresh corpus run. The issue's proposed threshold of ≥50% was written against the old 37.5% baseline before the reranker landed. With a pinned 12-doc corpus the expected Hit@5 should be at least 75% (6/8 queries) if the corpus is correctly assembled. The conservative 50% guard from the issue is still a safe lower bound to START with, but the implementation document should set the initial threshold at 62.5% (5/8) and note that it should be raised to 75% once the eval runs stably in CI.

## Potential Approaches

### Approach A: TypeScript script in `scripts/` (issue-recommended)

**Structure:**
- `plugin/ralph-knowledge/scripts/eval-retrieval.ts` — eval runner
- `plugin/ralph-knowledge/evals/golden-queries.json` — query definitions shared with `eval-rerank.mjs`
- `plugin/ralph-knowledge/__tests__/eval-corpus/` — 10-12 committed markdown files
- `package.json` script: `"eval:retrieval": "tsx scripts/eval-retrieval.ts"`
- CI: new step `npm run eval:retrieval -- --assert` with `timeout-minutes: 10`

**Pros:**
- Follows the heap-bench pattern exactly
- `tsx` already available as devDependency
- `scripts/` outside `benchmark/` signals "CI-intended" vs "one-shot bench"
- TypeScript gives type safety for the query/result structures
- Runs after `npm test` in the same `build-and-test-knowledge` job

**Cons:**
- Still requires the transformer model download for embedding (see Risk 1)
- Needs the `--assert` flag path wired carefully (same `process.exitCode` pattern)
- Corpus maintenance: pinned docs may drift from active thoughts/ as they're edited

### Approach B: Extend `benchmark/eval-rerank.mjs` with `--assert` and corpus pinning

**Structure:**
- Modify `eval-rerank.mjs` to accept `--corpus <dir>` and `--assert` flags
- Commit the 10-12 target docs to `benchmark/eval-corpus/`
- Add `package.json` script for the CI invocation

**Pros:**
- Reuses existing 8-query logic with minimal new code
- The `.mjs` extension means no TypeScript compilation step

**Cons:**
- `eval-rerank.mjs` runs `rerank: true` by default — wrong for CI (too slow)
- Mixing the one-shot bench semantics with the CI guard semantics in one file creates confusion
- The issue specifically calls for `scripts/eval-retrieval.ts`, not a `benchmark/` extension

**Recommendation: Approach A.** The issue explicitly names the file and directory. The `scripts/` vs `benchmark/` distinction matters for maintenance: `benchmark/` is "run manually to understand quality", `scripts/` is "run by CI to enforce quality".

### Approach C: Vitest integration test

Use the existing vitest machinery (`src/__tests__/`) and treat the eval as a slow integration test behind a flag.

**Pros:** Natural fit with `npm test`; no separate script or npm script needed
**Cons:** Vitest tests are expected to be fast and use mocked embedders; loading the real transformer model in a vitest test violates the existing test pattern (all `embedder.ts` usages are mocked via `vi.mock()`). Not recommended.

## Risk Analysis

### Risk 1: Transformer model download on CI (HIGH impact)

The BGE-base-en-v1.5 embedding model (~90 MB) must be downloaded on every fresh CI runner unless it is cached. The `@huggingface/transformers` library caches models to `~/.cache/huggingface/hub/` by default. Without cache action, every CI run downloads ~90 MB.

**Mitigation:** Add `actions/cache` for `~/.cache/huggingface/hub/` in the `build-and-test-knowledge` job (same cache key pattern as `npm ci` cache). This is a standard pattern for model-dependent CI jobs. If the model is cached, the eval cold-start drops from ~7s (from the reranker bench numbers, scaled down for the smaller embedding model) to under 1s.

**Alternative mitigation:** Mock the embedder in the CI eval and use pre-computed embeddings stored alongside the corpus. This eliminates the model dependency entirely but requires regenerating the stored embeddings whenever the embedder changes — defeating the regression guard's purpose.

### Risk 2: Corpus doc drift (MEDIUM impact)

The pinned corpus docs live in the thoughts/ tree which is actively edited. If Q1's target doc (`2026-04-29-reindex-memory-profile.md`) is significantly rewritten, its embeddings change and the eval may flip from pass to fail for reasons unrelated to code changes.

**Mitigation:** Commit copies to `plugin/ralph-knowledge/__tests__/eval-corpus/` as static fixtures (not symlinks or references to the live thoughts/ tree). The eval always reindexes from the committed copies, making it reproducible regardless of subsequent edits to the live versions.

### Risk 3: Path filter causing eval skip on important changes (LOW impact)

The issue proposes skipping the eval on docs-only PRs to save CI compute. Path filters in GitHub Actions can be tricky — a PR touching both `plugin/ralph-knowledge/src/hybrid-search.ts` AND a docs file must still trigger the eval.

**Mitigation:** Use the existing CI pattern (no path filter, run on all PRs). The retrieval eval is expected to run in under 60s on the pinned 12-doc corpus with cached model, so CI cost is acceptable. Re-evaluate the path filter if CI becomes a bottleneck.

## Recommended Next Steps

1. **Create `evals/golden-queries.json`** — extract the 8 query definitions from `benchmark/eval-rerank.mjs` into a shared JSON spec with `query`, `expectedSubstrings`, `type` fields. Update `eval-rerank.mjs` to read from this file.

2. **Assemble `__tests__/eval-corpus/`** — copy the 9 primary target docs + 2-3 distractors into `plugin/ralph-knowledge/__tests__/eval-corpus/`. These must be committed as static fixtures (not live references).

3. **Write `scripts/eval-retrieval.ts`** — following the `reindex-heap-bench.ts` structure:
   - Reads `evals/golden-queries.json`
   - Calls `reindex([evalCorpusDir], tmpDbPath, false)` (no contextual retrieval; disables the LLM context call)
   - Runs each query via `HybridSearch.search(query, { limit: 10, rerank: false })`
   - Computes Hit@1, Hit@5, MRR
   - Exits `process.exitCode = 1` when `--assert` and `Hit@5 < threshold`
   - Initial threshold: `HIT5_THRESHOLD = 5/8 = 62.5%` (conservative; raise to 75% once stable)

4. **Add `package.json` script** — `"eval:retrieval": "tsx scripts/eval-retrieval.ts"`

5. **Add CI step to `build-and-test-knowledge`** — after `npm run bench:heap`:
   ```yaml
   - name: Retrieval eval (GH-920)
     run: npm run eval:retrieval -- --assert
     timeout-minutes: 10
   ```
   Plus `actions/cache` for HuggingFace model cache.

6. **PR comment posting** — defer to a follow-up issue; the core guard doesn't need it.

## Pipeline History

No outcome events recorded for `plugin/ralph-knowledge` in the outcome ledger (empty aggregate). Prior art discovery relied on file scan (knowledge graph sparse for this component area).

## Files Affected

### Will Modify
- `plugin/ralph-knowledge/package.json` - Add `eval:retrieval` script entry
- `.github/workflows/ci.yml` - Add retrieval eval step + model cache to `build-and-test-knowledge` job
- `plugin/ralph-knowledge/benchmark/eval-rerank.mjs` - Update to read query definitions from shared JSON

### Will Read (Dependencies)
- `plugin/ralph-knowledge/src/reindex.ts` - `reindex()` function called by the eval runner
- `plugin/ralph-knowledge/src/hybrid-search.ts` - `HybridSearch.search()` exercised by the eval; `RERANK_FUSION_ALPHA` constant
- `plugin/ralph-knowledge/src/db.ts` - `KnowledgeDB` used for the tmp evaluation database
- `plugin/ralph-knowledge/src/search.ts` - `FtsSearch` dependency of `HybridSearch`
- `plugin/ralph-knowledge/src/vector-search.ts` - `VectorSearch` dependency of `HybridSearch`
- `plugin/ralph-knowledge/src/embedder.ts` - `embed` function; required for indexing the pinned corpus
- `plugin/ralph-knowledge/benchmark/reindex-heap-bench.ts` - Pattern reference for `--assert` mode, `process.exitCode`, threshold reporting

### Will Create
- `plugin/ralph-knowledge/scripts/eval-retrieval.ts` - Main eval runner script
- `plugin/ralph-knowledge/evals/golden-queries.json` - Shared query definitions (8 golden queries)
- `plugin/ralph-knowledge/__tests__/eval-corpus/` - Directory with 10-12 committed markdown fixtures
