---
date: 2026-04-30
status: complete
type: eval
tags: [ralph-knowledge, retrieval-quality, evaluation, semantic-search, cross-encoder-reranker]
github_issues: [919, 923, 925, 926, 927]
---

# Eval: ralph-knowledge knowledge_search with rerank=true vs RRF baseline

## Why this exists

Phases 1-3 of the [GH-0923 group plan](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-30-group-GH-0923-cross-encoder-reranker-knowledge-search.md) shipped a cross-encoder reranker (BGE-Reranker-v2-m3-int8) wired as an opt-in `rerank: true` parameter on `knowledge_search`. This eval (Phase 4 / GH-927) re-runs the [2026-04-29 8-query golden eval](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/evals/2026-04-29-knowledge-search-vs-ripgrep.md) with `rerank: true` to test whether parent #919's measurable acceptance criteria are met:

- **Hit@1 ≥ 50%** (mid-point between 25% baseline and 62.5% ripgrep ceiling).
- **No regression on Q5** (reranker calibration) **or Q7** (context handoff) — the two queries semantic currently wins.
- **Latency budget documented** per query (cold + warm).

## Configurations

**Method A — Semantic + rerank** (`mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search` with `rerank: true`)
- BGE-base-en-v1.5 sentence embeddings + sqlite-vec ANN (unchanged from baseline).
- SQLite FTS5 + vector fused with RRF (unchanged).
- **NEW**: Post-RRF top-50 candidate set rescored by `onnx-community/bge-reranker-v2-m3-ONNX` at `dtype=q8` via `@huggingface/transformers` (Phase 1's `Reranker` class, Phase 2's `HybridSearch` splice, Phase 3's MCP parameter).
- `lambda=1.0` (pure relevance), `limit=10`, `return_diagnostics=true` (to capture `rerank_score`).
- DB: `~/.ralph-hero/knowledge.db` (same as baseline — 1,710 docs / 12,879 chunks).

**Method B — Semantic baseline** (same `knowledge_search` with `rerank: false`, against the same DB at the same point in time).
- Re-ran on 2026-04-30 against the current corpus; numbers differ from the 2026-04-29 baseline doc because the corpus has grown by ~50 docs (this group's plan, reviews, the eval doc itself, dream-memory ingests). This eval reports the in-run baseline alongside the rerank result so the comparison is apples-to-apples.

**Method C — Lexical ripgrep ceiling** — copied from the 2026-04-29 baseline (corpus drift is small enough that ripgrep ranks haven't materially changed for these queries).

## Methodology

Same 8 queries from the [2026-04-29 baseline](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/evals/2026-04-29-knowledge-search-vs-ripgrep.md#golden-queries), unchanged. Each query ran 1 cold call + 3 warm calls with `rerank: true`, plus 1 call with `rerank: false` for the in-run baseline. Cold-start = first `rerank: true` call across the eval (model load + first batch). Warm = subsequent calls (model cached).

Reproducer: [`benchmark/eval-rerank.mjs`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/benchmark/eval-rerank.mjs) — imports the compiled `dist/` modules so the eval exercises the exact code path `knowledge_search` runs in production. Output JSON saved to `/tmp/eval-rerank-results.json` during the run.

## Results

Rank of expected doc in top-10 (lower is better, ✗ = not in top-10):

| # | Query | Type | rerank=true | rerank=false (in-run) | Lexical ceiling | Δ vs baseline |
|---|-------|------|------------:|----------------------:|----------------:|---------------|
| 1 | reindex OOM            | specific-keyword | 3 | **1** | **1** | rerank pushed wrong doc to top |
| 2 | tensor disposal        | specific-keyword | 2 | 2 | **1** | unchanged |
| 3 | chunker progress       | specific-keyword | 2 | **1** | **1** | rerank pushed wrong doc to top |
| 4 | dream-loop arch        | mixed            | ✗ | **1** | **1** | **regression: dropped out of top-10** |
| 5 | reranker calibration   | mixed            | **1** | **1** | 2 | held |
| 6 | wikilink extractor     | specific-keyword | 3 | 3 | **1** | unchanged |
| 7 | context handoff        | mixed            | **1** | **1** | 4 | held |
| 8 | landcrawler hardening  | specific-keyword | ✗ | ✗ | 2 | unchanged (both miss) |

### Aggregate metrics

| Metric | Semantic+rerank | Semantic baseline (in-run, 2026-04-30) | Semantic baseline (2026-04-29) | Lexical ceiling |
|--------|----------------:|---------------------------------------:|-------------------------------:|----------------:|
| Hit@1  | 2/8 (**25.0%**)  | 5/8 (62.5%)                            | 2/8 (25.0%)                     | 5/8 (62.5%)     |
| Hit@5  | 6/8 (75.0%)      | 7/8 (87.5%)                            | 3/8 (37.5%)                     | 8/8 (100%)      |
| Hit@10 | 6/8 (75.0%)      | 7/8 (87.5%)                            | 3/8 (37.5%)                     | 8/8 (100%)      |
| MRR    | 0.458            | **0.729**                              | 0.310                           | 0.781           |

**Note on the in-run baseline jump (25% → 62.5%)**: The 2026-04-29 baseline saw Hit@1 = 25% on `rerank: false`, but re-running today the same configuration scores 62.5%. The corpus has grown (group plans, critiques, review docs, dream-memories) and several previously-missing-from-top-10 expected docs now appear at rank 1 *without rerank* — Q1 (reindex memory profile), Q3 (chunker fix), Q4 (dream-loop architecture). The in-run baseline is the correct comparison point for this eval; the older `25%` number is preserved here for traceability but reflects a different snapshot of the corpus.

### Latency

`rerank: true` warm latency per query (median of 3 runs after the initial cold-start). Cold-start is the first `rerank: true` call's wall-clock time (model load + warmup + first batch). All numbers in milliseconds.

| # | Query | Cold-start | First call | Warm p50 | Warm p95 | rerank=false |
|---|-------|-----------:|-----------:|---------:|---------:|-------------:|
| 1 | reindex OOM           | **7091** | 7091 | 626 | 627 | 9   |
| 2 | tensor disposal       | -        | 181  | 177 | 179 | 8   |
| 3 | chunker progress      | -        | 264  | 256 | 257 | 8   |
| 4 | dream-loop arch       | -        | 505  | 476 | 483 | 9   |
| 5 | reranker calibration  | -        | 327  | 323 | 324 | 9   |
| 6 | wikilink extractor    | -        | 328  | 321 | 327 | 8   |
| 7 | context handoff       | -        | 331  | 322 | 323 | 9   |
| 8 | landcrawler hardening | -        | 755  | 732 | 733 | 10  |

**Aggregate**

- Cold-start: **7091 ms** (one-time, paid on the first `rerank: true` call after server boot). About 5.5x the [#901 bench's 1293 ms](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/benchmark/results-2026-04-27.tsv) cold-start — likely because the eval runs from a fresh Node process with no transformers.js warm cache. The bench was already half-warmed by the embedder load.
- Warm median: **404 ms** average across queries (range 177-732 ms depending on candidate-set size). The variance is dominated by the rerank topN window — queries with denser RRF candidate lists trigger more cross-encoder pairs.
- `rerank: false` baseline: **9 ms** average. Rerank adds ~45-80x of latency on warm calls.
- Per-pair cost: warm median ÷ topN ≈ 404 ms / ~50 pairs = **~8 ms/pair** on M5 Pro at q8. Slightly faster than the [#901 bench's 40 ms p50](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/benchmark/results-2026-04-27.tsv) per query (which ran a different batching shape).

## Per-query observations

**Q1 (reindex OOM)** — **REGRESSION.** The rerank=false top-1 is the expected doc (`2026-04-29-reindex-memory-profile.md` at rrf=0.0325). With rerank=true, BGE assigned that doc a logit of **-0.77** but assigned the GH-910 critique doc (`2026-04-29-GH-910-critique.md`) a logit of **+1.72**. The critique doc happens to be a high-density review of the memory-profile research — the cross-encoder reads it as "more relevant" because every paragraph engages directly with the OOM question, while the research doc opens with broader background. End result: rank moved 1 → 3.

**Q2 (tensor disposal)** — **NO CHANGE.** Rank 2 in both. Rerank scored the GH-911 critique (-0.72) above the GH-911 plan (-3.84) — same critique-vs-plan dynamic as Q1. Both methods miss the user-intended plan doc at rank 1.

**Q3 (chunker progress)** — **REGRESSION.** Same pattern as Q1: rerank=false ranks the expected GH-916 plan first (rrf=0.0328); rerank=true scores the GH-916 critique higher (+3.38 vs +1.20) and pushes the plan to rank 2. Critique docs systematically score higher than the underlying plans/research they critique.

**Q4 (dream-loop architecture)** — **MAJOR REGRESSION.** rerank=false has the expected `2026-04-26-dreaming-research-trail-and-self-containment.md` at rank 1 (rrf=0.0323). With rerank=true, that doc drops out of the top-10 entirely. The rerank window grabs the top-50 by RRF (which still contains the expected doc), but BGE assigns it a low logit because the query "dream-loop memory consolidation pipeline architecture" doesn't textually appear in the expected doc's snippet — the doc is *about* the pipeline but uses different vocabulary. Meanwhile the GH-762 chunked-embeddings plan, which has more literal "dream-loop" + "pipeline" hits, climbs to rank 1.

**Q5 (reranker calibration)** — **HELD.** Rank 1 in both. The expected `2026-04-26-softmax-and-rerank-calibration.md` got logit +0.023 (highest in the candidate set) — narrowly above the GH-0899 calibration plan (+0.020). No regression on the parent's flagship Q5.

**Q6 (wikilink extractor)** — **NO CHANGE.** Rank 3 in both. Two related-but-not-target docs (the dreaming-research-trail doc at logit +0.021 and an older `GH-0664-capture-all-wiki-links` research at -1.26) outrank the target. Rerank doesn't fix the underlying RRF issue here.

**Q7 (context handoff)** — **HELD.** Rank 1 in both. The expected `2026-04-22-context-handoff-topology.md` got logit +0.73, well above the next candidate (-3.77). Rerank reinforces the correct ranking. No regression on the parent's other watch-query Q7.

**Q8 (landcrawler hardening)** — **NO CHANGE.** Both methods miss the expected `2026-04-24-landcrawler-backend-hardening-postmortem.md` (it's not in the RRF top-50 at all on this corpus snapshot — likely a chunk-content vs query-vocabulary gap). Rerank can't recover docs that aren't in the candidate window.

## Verdict against parent #919 acceptance criteria

| Criterion | Target | Result | Met? |
|-----------|--------|--------|------|
| Hit@1     | ≥ 50%  | 25.0%  | **NO** — at the parity-with-old-baseline floor, far below the 62.5% in-run rerank=false baseline. |
| No regression on Q5 (reranker calibration) | rank stays in top-3 | rank 1 (held) | **YES** |
| No regression on Q7 (context handoff) | rank stays in top-3 | rank 1 (held) | **YES** |
| Latency budget documented per query | cold + warm captured | cold ~7s, warm 177-732ms | **YES** |

**Two of four criteria met. The Hit@1 criterion is the load-bearing one for #919's measurable acceptance, and rerank fails it.** The reason is structural, not a tuning miss: BGE-Reranker-v2-m3-int8's notion of "relevance" weights critique/review docs above the underlying plans/research they critique, and weights doc-snippet keyword density above topical relevance. On Q4 it actively pushes the expected doc out of the top-10.

### Why Hit@1 went DOWN with rerank instead of up

The 2026-04-29 baseline doc's premise was: "RRF buries FTS-first docs that don't also rank highly in vector space — a reranker should bubble them back up." This eval shows that premise was correct for the *old* corpus snapshot (Hit@1 = 25% there) but the corpus has since absorbed enough new docs that RRF alone now hits 62.5% — and the reranker's reordering of the top-50 candidate window introduces NEW errors faster than it fixes old ones.

Two specific failure modes:

1. **Critique-bias**: Critique/review docs (`*-critique.md`, `*-review.md`) consistently score higher than the underlying plans/research they review (Q1, Q2, Q3 all show this). These docs are written to engage densely with the question, so cross-encoders read them as "more relevant" even when the user wants the source doc.
2. **Snippet-vocabulary mismatch**: The reranker scores on truncated 1000-char snippets. When the expected doc's chunk doesn't contain the query's literal terms (Q4), the reranker scores it low and a doc with denser keyword overlap wins — even if the no-rerank vector half had correctly identified the topical match.

Both failure modes are visible in the rerank logits in `/tmp/eval-rerank-results.json` (e.g., Q1: critique +1.72 vs research -0.77 vs query "what causes the reindex to OOM").

## Recommendations

**Do NOT flip the default `rerank` to `true`.** Keep it opt-in. The current implementation is sound (the splice point, MCP wiring, and lazy-load are correct per the plan), but the *quality result* doesn't justify the latency cost on this corpus.

Specific options for follow-up issues:

1. **Tune the rerank window**: dropping topN from 50 to 10-20 may help by limiting the reranker's chance to re-score the already-top-1 doc against denser-snippet competitors. Worth a separate eval to confirm.
2. **Filter critique docs from the rerank candidate set**: a doc-type-aware policy ("don't let critique/review re-outrank their parent in the top-3") could close the Q1/Q3 regression without touching the model. This is a corpus-shape issue the reranker can't solve on its own.
3. **Snippet selection**: feed the reranker the chunk it scored highest in vec, not the doc's first chunk. The current splice uses `truncateForRerank(\`${r.title}\\n${r.snippet}\`)` ([hybrid-search.ts:328-330](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/hybrid-search.ts#L328-L330)) — the snippet is already chunk-aware, but the title prefix may be diluting the per-chunk signal. Worth a A/B with title-omitted vs title-prefixed.
4. **Calibrate the cross-encoder**: per [2026-04-26-softmax-and-rerank-calibration.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-softmax-and-rerank-calibration.md), softmax temperature scaling on the logit set could turn the raw scores into well-calibrated probabilities and let RRF + rerank fuse linearly instead of replace-ordering. This is the most principled fix; it's also the most work.

Track these as follow-ups; they are out of scope for #927 (which only asked for the measurement).

## Reproducing

```bash
cd ~/projects/ralph-hero/worktrees/GH-919/plugin/ralph-knowledge
npm run build
node benchmark/eval-rerank.mjs > /tmp/eval-rerank-results.json
```

Script source: [`benchmark/eval-rerank.mjs`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/benchmark/eval-rerank.mjs). It imports the compiled `HybridSearch` + `Reranker` from `dist/` and runs against `~/.ralph-hero/knowledge.db` (overridable with `RALPH_KNOWLEDGE_DB`). Output is a JSON object with per-query rank, rerank logits, latency split, and the full top-10 lists for both rerank=true and rerank=false.

## Follow-up

The 2026-04-29 baseline doc has been linked from this one (the `Δ vs baseline` column in the results table). When (if) a follow-up corpus or model change inverts the verdict above, append a fresh `## Re-run YYYY-MM-DD` section here rather than starting a new doc.

## References

- Baseline eval: [2026-04-29-knowledge-search-vs-ripgrep.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/evals/2026-04-29-knowledge-search-vs-ripgrep.md)
- Group plan: [2026-04-30-group-GH-0923-cross-encoder-reranker-knowledge-search.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-30-group-GH-0923-cross-encoder-reranker-knowledge-search.md)
- Reranker bench: [2026-04-26-GH-0901-local-cross-encoder-reranker-m5-pro.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-GH-0901-local-cross-encoder-reranker-m5-pro.md)
- Bench TSV: [results-2026-04-27.tsv](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/benchmark/results-2026-04-27.tsv)
- Calibration research (cited in Recommendation 4): [2026-04-26-softmax-and-rerank-calibration.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-softmax-and-rerank-calibration.md)
- Reproducer: [benchmark/eval-rerank.mjs](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/benchmark/eval-rerank.mjs)
- Parent #919: https://github.com/cdubiel08/ralph-hero/issues/919
- Phase 1: #923 / Phase 2: #925 / Phase 3: #926 / Phase 4 (this eval): #927
