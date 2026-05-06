---
date: 2026-04-26
github_issue: 899
github_url: https://github.com/cdubiel08/ralph-hero/issues/899
status: complete
type: research
tags: [calibration, rrf, hybrid-search, observability, retrieval, ralph-knowledge]
---

# Research: RRF Score Calibration & Observability (GH-899)

## Prior Work

- builds_on:: [[2026-04-26-softmax-and-rerank-calibration]]
- builds_on:: [[2026-04-03-knowledge-implementation-comparison-obra-vs-ralph]]
- builds_on:: [[2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop]]

## Problem Statement

`knowledge_search` returns RRF scores in the range `[0.010, 0.033]` with no interpretable threshold between relevant and incidental hits. The issue asks whether post-hoc calibration (Platt scaling, isotonic regression, beta calibration) can produce more meaningful scores — either applied to the fused RRF output or to per-retriever scores before fusion. This research answers: (a) what raw inputs are available at each stage, (b) whether those inputs are sufficient for post-hoc calibration, and (c) what observability hooks currently exist.

## Current Implementation Analysis

### RRF Fusion (`hybrid-search.ts`)

The core fusion loop is at `plugin/ralph-knowledge/src/hybrid-search.ts:115-133`.

The RRF constant is `K = 60` (line 35). For each document, the fused score is:

```
RRF(d) = Σ  1 / (K + rank_r(d))
         r
```

With `limit * 2 = 40` candidates per retriever, the actual score range is:

| Configuration | Score |
|---|---|
| Rank 0 in both retrievers | 0.032787 (1/61 + 1/61) |
| Rank 0 in one retriever only | 0.016393 (1/61) |
| Rank 39 in one retriever only | 0.010000 (1/100) |
| Rank 39 in both retrievers | 0.020000 |

The full observed range is `[0.010, 0.033]` — a compressed band of width ~0.023. This is exactly the compression described in the issue: `Σ 1/(k+rank)` discards score magnitude by design.

### FTS5 Score (`search.ts`)

`FtsSearch.search()` returns SQLite FTS5's built-in `rank` column as `score` (line 163). FTS5 `rank` is a **negative BM25 score** — more negative means higher relevance. The query uses `ORDER BY rank ASC` (line 169) so the most-negative value is the best match. This BM25 score is a real-valued, unbounded-negative number. Its magnitude varies per query and corpus.

Critically: `ftsResults[i].score` (the BM25 value) is **never used in RRF**. Only the ordinal rank `i` enters the RRF formula at line 121: `1 / (HybridSearch.RRF_K + i + 1)`. The BM25 score is discarded after ordering.

### Vector Search Score (`vector-search.ts`)

`VectorSearch.search()` returns `distance` (cosine distance from sqlite-vec) per result (line 6, returned at line 88). The index uses `distance_metric=cosine` (line 36). sqlite-vec returns distances in `[0, 2]` for cosine (0 = identical, 2 = opposite). After L2-normalization (embedder uses `normalize: true` at line 27 of `embedder.ts`), practical distances sit in `[0, 1]`.

The cosine distance is stored in `VectorResult.distance`. In `hybrid-search.ts`, the vector results are processed at line 104-113: the loop uses only ordinal position `i` (as `bucket.bestRank`) — the distance value is never used in RRF. Distances are not passed forward.

### Score Availability Summary

| Signal | Where available | Passed to RRF | Exposed to caller |
|---|---|---|---|
| FTS5 BM25 `rank` | `ftsResults[i].score` | No — only rank index | No |
| Cosine `distance` | `vecResults[i].distance` | No — only rank index | No |
| Bucketed vec rank | `bucket.bestRank` | Yes (as ordinal) | No |
| FTS ordinal | loop var `i` | Yes (as ordinal) | No |
| Fused RRF score | `scores` Map | — | Yes, via `SearchResult.score` |

Neither the BM25 score nor the cosine distance is currently accessible outside the `search()` method. They are local variables consumed and discarded during fusion.

## Calibration Feasibility Analysis

### Question 1: Do post-hoc methods work on RRF output?

**Platt scaling** fits a sigmoid `f(s) = 1 / (1 + exp(A*s + B))` on labeled (score, binary_label) pairs. It is strictly monotonic, so it preserves rank order while rescaling to `[0, 1]`.

Applying Platt to RRF output is **mathematically valid but practically constrained**:

1. The input range `[0.010, 0.033]` is narrow. A sigmoid fit over this range is numerically well-conditioned (no overflow risk, bounded derivative). The sigmoid can still provide a meaningful rescaling to a wider `[0, 1]` band.
2. The sigmoid functional form may or may not match the true score-to-relevance relationship for RRF outputs. RRF has a hyperbolic-sum shape, not inherently sigmoidal. Platt will fit the sigmoid to whatever shape exists in the labeled sample — if the true shape is sufficiently S-curved within the observed range, fit quality will be good.
3. Small labeled samples are viable for Platt. The parent survey document notes `<500 labels` as the appropriate range. With a ~75-doc corpus and ~30-50 representative queries, 100-150 labeled query-doc pairs are feasible.

**Isotonic regression** requires `>= 1000 samples` to avoid overfitting (per the parent survey). With a 75-doc corpus and realistic query diversity, reaching 1000 labeled pairs would require 13+ labels per document per query, which is not feasible. Isotonic regression on RRF output is **not viable at this corpus scale**.

**Beta calibration** extends Platt to handle scores clustered near boundaries (0 or 1). RRF scores are clustered near 0 (range `[0.010, 0.033]`), which is exactly the use case beta calibration addresses. It is viable on small samples. However, the implementation surface is higher than Platt, and the marginal benefit over Platt for this score distribution is unclear without empirical testing.

**Temperature scaling** does not apply to RRF scores. Temperature scaling is defined for softmax logits and produces `exp(logit/T) / Σ exp(logit_j/T)`. RRF scores are not logits; there is no natural denominator to sum over for a single query result list. The parent survey correctly excludes temperature scaling for non-softmax signals.

### Question 2: Are calibration methods better applied to per-retriever scores before fusion?

Yes, in principle — but **the current code makes this impossible without modification**.

The BM25 score (`ftsResults[i].score`) and cosine distance (`vecResults[i].distance`) are both discarded before the caller can observe them. To apply calibration upstream, the code would need to:

1. Expose raw BM25 scores (already present in `ftsResults` as `SearchResult.score` at the point of line 88)
2. Expose raw cosine distances (present in `vecResults[i].distance` at line 95)
3. Apply calibration transforms to each signal separately before or instead of rank-based RRF

Calibrating per-retriever scores before fusion has a theoretical advantage: each retriever's score distribution can be calibrated on its own training signal. BM25 scores for short documents cluster near 0 (a case beta calibration handles well); cosine distances from a normalized embedding model have a narrower, more Gaussian-like distribution. Calibrating each separately before a convex combination (`α * calibrated_dense + (1-α) * calibrated_sparse`) would require labeled data for tuning `α` as well, moving toward the "learned fusion" category.

### Question 3: How much of the observability problem is corpus-size artifact?

RRF score compression is **intrinsic to RRF, not a corpus-size artifact**. The formula `Σ 1/(60 + rank)` produces the same `[0.010, 0.033]` band regardless of corpus size, as long as the pool sizes are fixed. A corpus of 750 documents would produce identical score ranges.

The corpus-size effect is on **calibration feasibility**, not on score interpretation: with only ~75 documents, even the best-case labeled dataset at 30-50 queries is approximately 100-200 query-doc pairs — sufficient for Platt but not isotonic.

## Observability Hooks (Current State)

### What exists

1. `knowledge_record_outcome` and `knowledge_query_outcomes` tools in `index.ts` (lines 289-365) provide a structured outcome event store. These are designed for pipeline events (issue phases, verdicts), not query-level retrieval diagnostics.
2. `SearchResult.score` is surfaced through the MCP tool as a numeric field, so callers can observe the fused RRF score.
3. `SearchResult.bestChunkId`, `chunkIndex`, `charStart`, `charEnd` are returned when `return_chunk_meta=true`.
4. No per-retriever scores (BM25 or cosine distance) are returned in any code path.
5. No query latency, retriever hit count, or per-retriever result count is logged anywhere in the retrieval path.

### What is missing

- FTS5 BM25 score per result (currently discarded at `hybrid-search.ts:119-122`)
- Cosine distance per result (currently discarded at `hybrid-search.ts:104-113`)
- Whether a result came from FTS-only, vector-only, or both retrievers ("hit source" metadata)
- Retriever hit counts (how many FTS results vs. vector results contributed)
- A diagnostic mode that returns the above in extended result fields

## Recommendation for Planning

The issue is scoped to investigation. The plan should be structured around two distinct tracks:

### Track A: RRF-output calibration experiment (viable immediately)

Platt scaling on RRF output can be attempted without any code changes to the retrieval path. The experiment requires:

1. A query sampling harness that calls `knowledge_search` on 30-50 queries and captures the returned `score` field.
2. A hand-labeling step on ~100-150 query-doc pairs (binary: relevant/not relevant).
3. A Python notebook under `plugin/ralph-knowledge/` fitting `sklearn.calibration.CalibratedClassifierCV` (with `method="sigmoid"` for Platt) on the RRF scores and producing a reliability diagram.
4. Assessment: if calibrated probabilities are meaningfully better-separated than raw RRF scores (lower Brier score, tighter reliability diagram), the parameters `(A, B)` can be hardcoded or stored in config.

This track does not require changes to `hybrid-search.ts`, `search.ts`, or `vector-search.ts`.

### Track B: Per-retriever score observability (requires code change)

To enable calibration upstream of RRF (or to decide definitively between the two approaches), `hybrid-search.ts` should expose per-retriever scores in the `SearchResult` interface as optional diagnostic fields:

- `ftsScore?: number` — the raw FTS5 BM25 rank value
- `vecDistance?: number` — the raw cosine distance
- `hitSources?: string[]` — `["fts", "vec"]` or subset thereof

These would be populated only when a new `diagnosticMode?: boolean` option is passed to `HybridSearch.search()`, avoiding payload bloat in production callers. The MCP tool can surface them under `return_diagnostics` alongside the existing `return_chunk_meta` flag.

### Sequencing

Track A should run first because it has no implementation cost and will produce empirical data about whether Platt on RRF output is useful. Track B is only necessary if Track A results show that RRF-output calibration is insufficient and per-retriever calibration is warranted.

The followup issue referenced in #899 (#900 — labeling effort scope) should be planned before or in parallel with Track A, since both depend on the same labeled dataset.

## Files Affected

### Will Modify
- `plugin/ralph-knowledge/src/hybrid-search.ts` — add optional `diagnosticMode` flag; surface `ftsScore`, `vecDistance`, `hitSources` as optional fields (Track B)
- `plugin/ralph-knowledge/src/search.ts` — no change required for Track A; potentially expose `score` (BM25 rank) in return type for Track B diagnostic path (already present in `SearchResult.score`, just needs to survive into hybrid result)
- `plugin/ralph-knowledge/src/index.ts` — add `return_diagnostics` boolean param to `knowledge_search` tool (Track B)

### Will Read (Dependencies)
- `plugin/ralph-knowledge/src/vector-search.ts` — `VectorResult.distance` field is the cosine distance source; no changes needed
- `plugin/ralph-knowledge/src/format.ts` — `BriefSearchResult` will need new optional fields if brief mode is also to surface diagnostics
- `plugin/ralph-knowledge/src/__tests__/hybrid-search.test.ts` — reference for test patterns when adding diagnostic field tests
