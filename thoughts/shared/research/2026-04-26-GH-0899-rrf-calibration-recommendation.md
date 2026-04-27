---
date: 2026-04-26
github_issue: 899
github_url: https://github.com/cdubiel08/ralph-hero/issues/899
status: complete
type: research
tags: [calibration, rrf, hybrid-search, ralph-knowledge]
---

# RRF Score Calibration & Observability — Recommendation Note (GH-899)

## Prior Work

- builds_on:: [[2026-04-26-GH-0899-rrf-calibration-observability]]
- builds_on:: [[2026-04-26-softmax-and-rerank-calibration]]

## Recommendation

**Track A first — fit Platt scaling on RRF output using sklearn — then Track B
(per-retriever calibration via the new `diagnosticMode` flag) only if Track A's
reliability diagram or Brier score shows it is insufficient.**

The investigation in `2026-04-26-GH-0899-rrf-calibration-observability.md`
established that the RRF output is numerically well-conditioned for a sigmoid
fit despite its compressed `[0.010, 0.033]` range — the compression is
concentrated, not pathological. Platt scaling is appropriate at the
~100-150-pair labeling floor that is reachable without full LambdaMART
investment (see [GH-900 labeling-effort recommendation](./2026-04-26-GH-0900-labeling-effort-recommendation.md)
once filed). Track A is also a notebook-only experiment — no production code
change required to evaluate it — so the cheap path runs first.

## What this PR ships

This PR (Phase 2 of the [GH-899/900/901/902 group plan](../plans/2026-04-26-group-GH-0899-stage2-reranker-calibration-exploration.md))
ships the **observability hook** that Track B requires:

- New `diagnosticMode?: boolean` field on `SearchOptions` in
  `plugin/ralph-knowledge/src/search.ts`.
- New optional fields on `SearchResult`: `ftsScore?: number` (raw FTS5 BM25
  negative-rank), `vecDistance?: number` (raw cosine distance from sqlite-vec
  in `[0, 2]`), `hitSources?: Array<"fts" | "vec">` (which retriever(s)
  contributed).
- New `return_diagnostics` flag on the `knowledge_search` MCP tool, surfacing
  the same fields as snake_case `fts_score`, `vec_distance`, `hit_sources` in
  the tool response (matches the existing `return_chunk_meta` convention).
- Default behavior is byte-identical to today — `diagnosticMode` defaults to
  `false` and the diagnostic fields are stripped from the response.
- The fields persist through the Phase 1 MMR reorder (verified by the
  cross-phase coupling test `diagnosticMode + lambda=0.7 preserves diagnostic
  fields after MMR reorder`).

This is the *observability surface* — it does not perform any calibration.
The actual sklearn / Platt-fit notebook is a followup (see below).

## Followup work

1. **Track A — sklearn notebook fitting `CalibratedClassifierCV(method='sigmoid')`
   on RRF scores from the labeled dev set.** Inputs: query, doc_id, RRF score,
   relevance grade. Output: a reliability diagram and Brier score.
   - Depends on the labeled dev set produced by [GH-900](https://github.com/cdubiel08/ralph-hero/issues/900)'s
     followup labeling task.
   - If reliability is poor (calibration curve far from the 45-degree line)
     or Brier score is high, Track B becomes the next step.

2. **Track B — per-retriever Platt fit on `ftsScore` / `vecDistance` via the
   new diagnostic fields.** The same notebook framework as Track A but applied
   independently to each retriever's raw output, then fused via a learned
   weighted average instead of RRF.
   - Activated only if Track A under-delivers.
   - Implementation cost is low because the per-retriever scores are already
     accessible via `return_diagnostics: true` — the calibration logic lives
     entirely in the notebook, not in `hybrid-search.ts`.

3. **Production wiring decision.** Whether to surface the calibrated
   probability in the MCP response (a new `calibrated_probability` field) is
   gated on Track A or Track B succeeding. Defer until at least one track has
   a reliability diagram on file.

## Why isotonic regression was rejected

Isotonic regression has a stricter sample-size floor than Platt scaling — a
common rule of thumb is **>=1000 sample pairs** before the monotonic step
function stops over-fitting. The labeling-effort scope from
[GH-900](https://github.com/cdubiel08/ralph-hero/issues/900) targets 600
grades for alpha tuning; this is sufficient for Platt's two-parameter sigmoid
but well below isotonic's floor.

If the corpus and the labeled dev set both grow by an order of magnitude
post-deployment (e.g., once `outcome_events` accumulates real `search_feedback`
traces from production usage), revisit isotonic as an alternative to Platt.
For now, Platt is the right size for the corpus.
