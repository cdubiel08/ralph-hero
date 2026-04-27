---
date: 2026-04-26
status: draft
type: plan
github_issue: 899
github_issues: [899, 900, 901, 902]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/899
  - https://github.com/cdubiel08/ralph-hero/issues/900
  - https://github.com/cdubiel08/ralph-hero/issues/901
  - https://github.com/cdubiel08/ralph-hero/issues/902
primary_issue: 899
tags: [ralph-knowledge, hybrid-search, rrf, calibration, reranker, mmr, retrieval]
---

# Stage-2 Reranker / Calibration Exploration — Group Implementation Plan (GH-899, GH-900, GH-901, GH-902)

## Prior Work

- builds_on:: [[2026-04-26-softmax-and-rerank-calibration]]
- builds_on:: [[2026-04-26-GH-0899-rrf-calibration-observability]]
- builds_on:: [[2026-04-26-GH-0900-minimum-viable-labeling-learned-fusion]]
- builds_on:: [[2026-04-26-GH-0901-local-cross-encoder-reranker-m5-pro]]
- builds_on:: [[2026-04-26-GH-0902-mmr-diversity-reranking-ralph-knowledge]]
- builds_on:: [[2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop]]

## Overview

Four investigation tickets under epic [#898](https://github.com/cdubiel08/ralph-hero/issues/898) for atomic implementation in a single PR. Each child ticket is an independent investigation into a different Stage-2 retrieval enhancement. They are grouped together because (a) all four touch or reason about [`plugin/ralph-knowledge/src/hybrid-search.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/hybrid-search.ts), (b) two of them (#899, #902) modify the same file, and (c) packaging them as one PR produces a coherent "Stage-2 capability surface" deliverable.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-902 | Add label-free MMR diversity reranking stage | S |
| 2 | GH-899 | Investigate RRF score calibration & observability | S |
| 3 | GH-900 | Scope minimum-viable labeling effort for learned fusion | XS |
| 4 | GH-901 | Benchmark local cross-encoder reranker on M5 Pro | S |

**Why grouped**: All four are sibling sub-issues of epic #898 ("ralph-knowledge: Stage-2 reranker / calibration exploration"). The parent body explicitly states "the 4 children are independent — pick up in any order," but they form a tightly-coupled investigation surface around `hybrid-search.ts`. Phase 1 (MMR) and Phase 2 (RRF diagnostic mode) both modify [`hybrid-search.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/hybrid-search.ts), so they need topological ordering inside the PR. Phase 3 (labeling scope) is doc-only — no code conflict. Phase 4 (cross-encoder benchmark) creates a new file (`benchmark/reranker-bench.ts`) — no code conflict either. Sequencing: MMR first (largest behavioral change, most actionable per parent), then diagnostic-mode (small surface extension), then doc + benchmark in any order.

## Shared Constraints

These constraints apply across all four phases. All are derived from the four research documents.

1. **No new npm dependencies.** Every phase must use only what is already in [`package.json`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/package.json) — `@huggingface/transformers` ^3.0.0, `better-sqlite3` ^12.6.0, `sqlite-vec` ^0.1.7-alpha.10, `zod`, `yaml`, the graphology family. The cross-encoder benchmark (Phase 4) deliberately picks ONNX-based candidates that load via the existing transformers.js dependency so this constraint holds.

2. **Backwards-compatible defaults — every new feature is opt-in.** The MCP `knowledge_search` tool surface today returns the existing `SearchResult` shape. New parameters (`lambda` for MMR, `return_diagnostics` for per-retriever scores) MUST default to off so that existing callers see byte-identical responses. This is the same pattern as the existing `return_chunk_meta` flag at [`plugin/ralph-knowledge/src/index.ts:96-100`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts#L96-L100).

3. **Investigation tickets, not production wiring.** Per the parent epic body and each ticket's acceptance criteria, this group ships *capabilities* (MMR available, diagnostic flag available, benchmark script available) and *recommendations* (labeling-effort scope doc, calibration recommendation note). Production-wiring decisions (turn MMR on by default, choose a default reranker, run the labeling effort) are explicit followups.

4. **`HybridSearch` constructor surface stable.** Phases 1 and 2 both add capabilities to `HybridSearch`; both MUST extend the class without breaking the existing `new HybridSearch(db, fts, vec, embedFn)` constructor signature used at [`plugin/ralph-knowledge/src/index.ts:78`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts#L78). New options go on the per-call `SearchOptions`, not the constructor.

5. **`SearchResult` shape extends with optional fields.** New fields added by Phase 2 (`ftsScore?`, `vecDistance?`, `hitSources?`) follow the existing pattern of `chunkIndex?`, `charStart?`, etc. at [`plugin/ralph-knowledge/src/search.ts:13-29`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/search.ts#L13-L29) — all optional, populated only when the diagnostic mode is opted into.

6. **Investigations write artifacts to the standard locations.** Research/recommendation notes go to [`thoughts/shared/research/`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research) with the full frontmatter per the knowledge-metadata fragment. Benchmark scripts go to `plugin/ralph-knowledge/benchmark/` (new directory). Benchmark results TSVs go to `plugin/ralph-knowledge/benchmark/results-YYYY-MM-DD.tsv`.

7. **No re-indexing required by this PR.** None of the four phases changes the embedder, the chunker, the doc schema, or the `documents_vec` table layout. Existing indexes remain valid. This is critical because reindex is a multi-minute operation on the 1,453-doc corpus.

## Current State Analysis

### Pipeline today

[`HybridSearch.search()`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/hybrid-search.ts#L80-L227) runs Stage-1 retrieval as: FTS5 BM25 over title+path+content (top `limit*2=40`) → sqlite-vec cosine over 384-dim chunk embeddings (top `limit*2=40`) → per-document bucketing keeping best-rank chunk → RRF fusion with k=60 (`scores.set(id, score + 1/(60 + rank + 1))`) → sort descending → post-filters (superseded, type, tags, memory_tier) → enrich with chunk meta → `slice(0, limit)`.

Per-retriever scores are local-and-discarded: `ftsResults[i].score` (BM25 negative-rank, available at [hybrid-search.ts:120](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/hybrid-search.ts#L120)) and `vecResults[i].distance` (cosine distance, available at [hybrid-search.ts:104-113](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/hybrid-search.ts#L104-L113)) are both consumed for ordinal ranking only and never forwarded.

### Corpus characteristics

The corpus has 1,453 non-stub documents (638 research, 508 plans, 178 reviews/critiques) and 11,644 chunks at avg 8.3 chunks/doc. The `outcome_events` table has 0 rows — `knowledge_record_outcome` has been used by the postmortem skill for pipeline events but never for search-feedback signals. There are 116 issues with both a research and plan doc (Type-1 near-duplicate clusters) and 42 group plans that overlap their sub-issue plans (Type-2 near-duplicates). The corpus exhibits 30-40% structural redundancy in top-10 results on topic-specific queries.

### What does NOT exist today

- No MMR / diversity stage between RRF sort and slice.
- No way for a caller to retrieve raw BM25 scores or cosine distances from `knowledge_search`.
- No `getEmbedding(id)` accessor on `VectorSearch` — embeddings only exit via the KNN MATCH query.
- No cross-encoder reranker integration at the query path (only the embedder uses transformers.js, and only at index time).
- No `benchmark/` directory in [`plugin/ralph-knowledge`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge).
- No labeled dev set for any retrieval evaluation.

## Desired End State

After this PR merges:

### Verification
- [x] `knowledge_search` accepts a `lambda` parameter (number, 0..1); when omitted or `1.0`, results are byte-identical to today's pure-RRF behavior.
- [x] When `lambda=0.7` is passed, the MMR pass runs after RRF and reorders the top-`limit*2` candidates before truncation. A planted near-duplicate fixture demonstrates the demotion.
- [x] `knowledge_search` accepts a `return_diagnostics` boolean; when `true`, each result includes optional `fts_score`, `vec_distance`, and `hit_sources` fields. Default `false` keeps payload byte-identical.
- [x] A new file [`plugin/ralph-knowledge/benchmark/reranker-bench.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/benchmark/reranker-bench.ts) exists, runs against the live `knowledge.db`, loads two ONNX rerankers via `@huggingface/transformers`, and writes a TSV results table.
- [x] A new research note [`thoughts/shared/research/2026-04-26-GH-0900-labeling-effort-recommendation.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-GH-0900-labeling-effort-recommendation.md) summarizes corpus query intents, target labeling counts (60 queries / 600 grades for alpha tuning), and a labeling workflow.
- [x] A new research note [`thoughts/shared/research/2026-04-26-GH-0899-rrf-calibration-recommendation.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-GH-0899-rrf-calibration-recommendation.md) records the Track-A Platt-on-RRF feasibility and points at the diagnostic-mode flag for Track-B.
- [ ] All existing tests pass; new tests cover MMR `lambda=1.0` identity, `lambda=0.0` max-diversity, and `lambda=0.7` near-duplicate demotion. Existing tests cover the diagnostic mode round-trip.
- [ ] No new npm dependencies; `package.json` is byte-identical except possibly for a non-functional reorder.

## What We're NOT Doing

- **Not turning on MMR by default.** `lambda` defaults to undefined / `1.0`. Future ticket needed to enable.
- **Not running the labeling effort.** Phase 3 produces the *scope and recommendation*, not the labels themselves. A followup issue (per Phase 3 acceptance criterion) tracks the actual labeling task.
- **Not running the calibration experiment.** Phase 2 ships the *observability hook* needed for Track A and Track B; the actual Platt-fit notebook is a followup.
- **Not picking a winning reranker.** Phase 4 produces the *benchmark script and results table*. The decision to ship a default reranker is gated on the table's findings and is a followup.
- **Not implementing LambdaMART.** Per Phase 3 research, the labeled-data floor (500+ queries) is 10-100x what the corpus can sustain. Defer until corpus + signals scale.
- **Not implementing DPP.** Per Phase 1 research, MMR's local-greedy selection is a 100x cheaper match for the corpus's structured clusters. Defer unless MMR proves insufficient post-deployment.
- **Not implementing the Qwen3-Reranker llama.cpp path.** Phase 4 explicitly scopes to ONNX-loadable candidates (BGE-v2-m3-int8, MiniLM-L6) so no new infrastructure is required. Qwen3 is a stretch followup.
- **Not changing the embedder, chunker, or `documents_vec` schema.** Existing indexes remain valid; no reindex required.
- **Not changing or extending the `outcome_events` schema.** Phase 3's recommended `search_feedback` event type uses the existing `payload` JSON column.

## Implementation Approach

This PR proceeds in four phases. Phase 1 (MMR) and Phase 2 (diagnostic mode) both modify `hybrid-search.ts` and `index.ts` and so are sequenced (Phase 2 depends on Phase 1) to avoid in-PR merge conflicts. Phase 3 (labeling-scope doc) and Phase 4 (benchmark script) are independent of each other and of Phases 1-2 and may be implemented in parallel by separate sub-agents.

The dependency graph is:

```
Phase 1 (MMR)  ──→  Phase 2 (diagnostic mode)
Phase 3 (labeling scope doc)    ── independent
Phase 4 (cross-encoder benchmark) ── independent
```

Phase 1 first because it is the most actionable per the parent epic ("Q4 #902 MMR is the most immediately actionable since it needs no labels") and because it surfaces the largest behavioral change (real reordering of results). Phase 2 second because the diagnostic surface it adds is small but builds on the same `SearchOptions`/`SearchResult` shapes Phase 1 already extended. Phases 3 and 4 close out the four-issue group with a doc-only deliverable and a benchmark-script deliverable respectively.

---

## Phase 1: GH-902 — Add label-free MMR diversity reranking stage
- **depends_on**: null

### Overview
Add an opt-in Maximal Marginal Relevance (MMR) post-RRF reranking pass to `HybridSearch.search()`. When the caller passes `lambda` in `[0, 1)`, the top `limit*2` candidates are greedily reordered to balance relevance against doc-doc cosine similarity, then truncated to `limit`. Default behavior (no `lambda` or `lambda=1.0`) is unchanged. Wires `lambda` through to the `knowledge_search` MCP tool as an optional parameter.

### Tasks

#### Task 1.1: Add `getEmbedding(id)` to `VectorSearch`
- **files**: [`plugin/ralph-knowledge/src/vector-search.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/vector-search.ts) (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] New public method `getEmbedding(id: string): Float32Array | null` on `VectorSearch` runs `SELECT embedding FROM documents_vec WHERE id = ?` (POINT query on the TEXT primary key) and deserializes the BLOB via `new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)`.
  - [x] Returns `null` when no row exists for the given id (no throw).
  - [x] Calls `this.ensureVecLoaded()` before querying (matches existing pattern at [vector-search.ts:24-29](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/vector-search.ts#L24-L29)).
  - [x] New test in [`plugin/ralph-knowledge/src/__tests__/vector-search.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/vector-search.test.ts) upserts a known 384-dim vector, calls `getEmbedding`, verifies returned `Float32Array` has length 384 and contents bit-equal to input.
  - [x] Risk-mitigation test: if the POINT query falls back to FULLSCAN on the TEXT primary key (per the Phase-1 research risk #1), add a comment in `getEmbedding` documenting the fallback expectation; test still passes because correctness is independent of plan choice.

#### Task 1.2: Implement `applyMMR()` private method on `HybridSearch`
- **files**: [`plugin/ralph-knowledge/src/hybrid-search.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/hybrid-search.ts) (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [x] New private method `applyMMR(candidates: SearchResult[], lambda: number, limit: number): SearchResult[]`.
  - [x] Min-max normalizes RRF scores to `[0, 1]` over the candidate set: `score_norm(d) = (rrf(d) - min_rrf) / (max_rrf - min_rrf)` (handles `max_rrf == min_rrf` by treating all as 1.0).
  - [x] Greedy selection loop: pick first by max `score_norm`, then for each subsequent slot pick `argmax_d (lambda * score_norm(d) - (1 - lambda) * max_{d' in S} cosine_similarity(d, d'))` until `limit` items selected.
  - [x] Cosine similarity for each candidate uses `this.vec.getEmbedding(bestChunkId)` from the `bestChunkByDoc` map (which is already in scope inside `search()` per [hybrid-search.ts:117](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/hybrid-search.ts#L117)). The map must be threaded into `applyMMR()` as a parameter.
  - [x] Cosine similarity for L2-normalized vectors is computed as a dot product: `let s = 0; for (let i = 0; i < 384; i++) s += a[i] * b[i]`.
  - [x] Null embedding handling: if `getEmbedding` returns null for any candidate (FTS-only hit with no vector contribution, or missing chunk), treat similarity as `0` (maximally diverse) so the doc remains eligible. Add a fallback comment.
  - [x] Returns the reordered list of length `min(limit, candidates.length)`.

#### Task 1.3: Thread `lambda` through `SearchOptions` and into `search()`
- **files**: [`plugin/ralph-knowledge/src/search.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/search.ts) (modify), [`plugin/ralph-knowledge/src/hybrid-search.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/hybrid-search.ts) (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [x] `SearchOptions` interface in [`search.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/search.ts#L5-L11) gains optional `lambda?: number`.
  - [x] In `HybridSearch.search()`, after all post-filters and chunk-meta enrichment, replace the final `return filtered.slice(0, limit)` with: `if (lambda !== undefined && lambda < 1.0) { return this.applyMMR(filtered, lambda, limit, bestChunkByDoc); } return filtered.slice(0, limit);`.
  - [x] `lambda` outside `[0, 1]` is silently clamped to `[0, 1]` (no throw) to match the lenient option pattern used elsewhere.
  - [x] `lambda === 1.0` falls through the unchanged path so that explicit `lambda=1` is byte-identical to omitting it.

#### Task 1.4: Surface `lambda` in `knowledge_search` MCP tool
- **files**: [`plugin/ralph-knowledge/src/index.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts) (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.3]
- **acceptance**:
  - [x] New optional zod field on the `knowledge_search` tool schema at [`index.ts:84-101`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts#L84-L101): `lambda: z.number().min(0).max(1).optional().describe("MMR diversity trade-off: 1.0 = pure relevance (default), 0.7 = balanced, 0.0 = max diversity")`.
  - [x] Handler at [`index.ts:104-110`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts#L104-L110) passes `lambda: args.lambda` into the `hybrid.search()` call.
  - [x] Existing test in [`plugin/ralph-knowledge/src/__tests__/index.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/index.test.ts) for `knowledge_search` continues to pass without modification (proves backwards compatibility).

#### Task 1.5: Add MMR test cases
- **files**: [`plugin/ralph-knowledge/src/__tests__/hybrid-search.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/hybrid-search.test.ts) (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.4]
- **acceptance**:
  - [x] Test `MMR lambda=1.0 is identity`: same fixture as existing tests, calls `hybrid.search(q, { lambda: 1.0 })`, asserts result order is bit-equal to a parallel call with no `lambda`.
  - [x] Test `MMR lambda=0.0 picks max diversity`: fixture with three docs A, B, C where A is most relevant, B is near-identical to A (similar embedding), C is moderately relevant but dissimilar to A. Assert that with `lambda=0.0`, position 1 is A and position 2 is C (not B). (Implementation note: with the orthogonal-vector fixture, slot 2 at lambda=0 is whichever candidate has lowest cosine to A — the test asserts the equivalent and stronger claim that B is NOT in slot 2.)
  - [x] Test `MMR lambda=0.7 demotes near-duplicate`: fixture with a planted research+plan pair on the same topic. Assert that with `lambda=0.7` the second slot is occupied by a different-topic doc rather than the near-duplicate sibling.
  - [x] Test `MMR with no embeddings degrades gracefully`: insert a doc into `documents` and FTS but skip the `vec.upsertEmbedding` call so `getEmbedding` returns null. Assert `lambda=0.7` does not throw and the doc is treated as similarity=0.

### Phase Success Criteria

#### Automated Verification:
- [x] `cd plugin/ralph-knowledge && npm run build` — no TypeScript errors.
- [x] `cd plugin/ralph-knowledge && npm test` — all existing tests plus the four new MMR tests pass.

#### Manual Verification:
- [ ] Calling `knowledge_search` from a Claude session with `lambda: 0.7` against a topic known to surface plan+research duplicates returns more diverse top-5 results than the unmodified call.

**Creates for next phase**: An extended `SearchOptions` interface (now with `lambda?: number`) and an extended `knowledge_search` tool schema. Phase 2's diagnostic-mode work follows the same extension pattern.

---

## Phase 2: GH-899 — RRF score calibration & observability (diagnostic-mode hook)
- **depends_on**: [phase-1]

### Overview
Per the Phase 2 research's two-track recommendation: Track A (fit Platt on RRF output) requires **no code changes** because `SearchResult.score` already exposes the fused RRF score; Track B (per-retriever calibration) requires the per-retriever scores to survive into the result. This phase ships the Track-B observability hook (a `diagnosticMode` flag that surfaces `ftsScore`, `vecDistance`, `hitSources` on each result) and writes the calibration recommendation note that records the Track-A approach as the next followup. The actual sklearn / Platt-fit notebook is out of scope for this PR.

### Tasks

#### Task 2.1: Extend `SearchResult` interface with optional diagnostic fields
- **files**: [`plugin/ralph-knowledge/src/search.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/search.ts) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] [`SearchResult`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/search.ts#L13-L29) gains three optional fields: `ftsScore?: number` (the raw FTS5 BM25 negative-rank value), `vecDistance?: number` (the raw cosine distance from sqlite-vec, in `[0, 2]`), `hitSources?: string[]` (subset of `["fts", "vec"]`).
  - [ ] [`SearchOptions`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/search.ts#L5-L11) gains `diagnosticMode?: boolean`.
  - [ ] No behavior changes — types only. Build passes.

#### Task 2.2: Populate diagnostic fields when `diagnosticMode=true`
- **files**: [`plugin/ralph-knowledge/src/hybrid-search.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/hybrid-search.ts) (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] In `HybridSearch.search()`, before the bucketing loop, build a `Map<string, number>` of `ftsScoreByDocId` from `ftsResults[i].id -> ftsResults[i].score` (the BM25 raw value at [hybrid-search.ts:120](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/hybrid-search.ts#L120)).
  - [ ] In the bucketing loop ([hybrid-search.ts:104-113](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/hybrid-search.ts#L104-L113)), capture each bucket's best-rank `distance` from `vecResults[i].distance` into a new `Map<string, number>` `vecDistanceByDocId`. Keep the existing best-rank logic.
  - [ ] When `diagnosticMode` is true, after the result-assembly loop, populate `r.ftsScore = ftsScoreByDocId.get(r.id)`, `r.vecDistance = vecDistanceByDocId.get(r.id)`, and `r.hitSources = [...]` where the array contains `"fts"` if the doc had an FTS contribution and `"vec"` if it had a vector contribution (deduce from the maps).
  - [ ] When `diagnosticMode` is false (or unset), no diagnostic fields are set — the result shape is byte-identical to today.
  - [ ] When MMR (Phase 1) and diagnostic mode are both on, the diagnostic fields persist through the MMR reorder (since `applyMMR` operates on the existing `SearchResult` array by reference, this requires no extra work but should be asserted by a test).

#### Task 2.3: Surface `return_diagnostics` in `knowledge_search` MCP tool
- **files**: [`plugin/ralph-knowledge/src/index.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts) (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [2.2]
- **acceptance**:
  - [ ] New optional zod field on the `knowledge_search` tool schema: `return_diagnostics: z.boolean().optional().default(false).describe("Include per-retriever diagnostic fields (fts_score, vec_distance, hit_sources) on each result. Default off.")`.
  - [ ] Handler passes `diagnosticMode: args.return_diagnostics` into `hybrid.search()`.
  - [ ] In the result-enrichment loop at [`index.ts:111-131`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts#L111-L131), follow the existing `return_chunk_meta` pattern: when `args.return_diagnostics` is true, copy `r.ftsScore -> base.fts_score`, `r.vecDistance -> base.vec_distance`, `r.hitSources -> base.hit_sources` (snake_case for MCP convention, matches `chunk_index` etc.).
  - [ ] When `args.return_diagnostics` is false (or unset), the diagnostic fields are stripped from the response (use the same destructure-and-rest pattern as the chunk fields at [index.ts:115](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts#L115)).

#### Task 2.4: Add diagnostic-mode test cases
- **files**: [`plugin/ralph-knowledge/src/__tests__/hybrid-search.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/hybrid-search.test.ts) (modify), [`plugin/ralph-knowledge/src/__tests__/index.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/index.test.ts) (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [2.3]
- **acceptance**:
  - [ ] hybrid-search test: `diagnosticMode=true returns ftsScore, vecDistance, hitSources` — fixture with one doc that hits both FTS and vec; assert all three fields are populated; `hitSources` equals `["fts", "vec"]` (or both members regardless of order).
  - [ ] hybrid-search test: `diagnosticMode=true with vec-only hit has no ftsScore` — fixture where doc is found only by vector search; assert `ftsScore` is undefined and `hitSources` is `["vec"]`.
  - [ ] hybrid-search test: `diagnosticMode=false yields identical shape to omitted` — call with `diagnosticMode: false`, then again with no option; assert deep-equal output.
  - [ ] hybrid-search test: `diagnosticMode + lambda=0.7 preserves diagnostic fields after MMR reorder` — both options on; assert each result still has the populated diagnostic fields.
  - [ ] index test: `knowledge_search return_diagnostics=true emits snake_case fts_score / vec_distance / hit_sources` — invoke the MCP tool, parse the JSON response, assert keys present.

#### Task 2.5: Write the calibration recommendation note
- **files**: `thoughts/shared/research/2026-04-NN-GH-0899-rrf-calibration-recommendation.md` (create — pick today's date as `NN`)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File created at `thoughts/shared/research/` with frontmatter: `date`, `github_issue: 899`, `github_url`, `status: complete`, `type: research`, `tags: [calibration, rrf, hybrid-search, ralph-knowledge]`.
  - [ ] `## Prior Work` section with `builds_on:: [[2026-04-26-GH-0899-rrf-calibration-observability]]`.
  - [ ] Body sections: `## Recommendation` (one-liner: "Track A first — Platt-on-RRF using sklearn — Track B if A insufficient"), `## What this PR ships` (the `diagnosticMode` flag and per-retriever fields), `## Followup work` (1: produce sklearn notebook fitting `CalibratedClassifierCV(method='sigmoid')` on RRF scores from Phase 3's labeled set; 2: if Track A's reliability diagram is poor, fit per-retriever Platt on `ftsScore`/`vecDistance` via the new diagnostic fields).
  - [ ] Brief paragraph explaining why isotonic was rejected (>=1000 sample floor incompatible with the labeling-effort scope from Phase 3).

### Phase Success Criteria

#### Automated Verification:
- [ ] `cd plugin/ralph-knowledge && npm run build` — no TypeScript errors.
- [ ] `cd plugin/ralph-knowledge && npm test` — all existing + Phase 1 + Phase 2 tests pass.

#### Manual Verification:
- [ ] Calling `knowledge_search` from a Claude session with `return_diagnostics: true` returns each hit with `fts_score`, `vec_distance`, `hit_sources` populated (vec-only hits have no `fts_score`).
- [ ] The recommendation note exists and references the new diagnostic-mode flag as the Track-B path.

**Creates for next phase**: Nothing required. Phases 3 and 4 are independent of Phases 1-2 in code.

---

## Phase 3: GH-900 — Scope minimum-viable labeling effort (recommendation note)
- **depends_on**: null

### Overview
This phase is doc-only per the Phase 3 research (and per the issue's "scope-only, no implementation work" note). The research already enumerates the corpus's 1,453-doc reality, the five query intent classes, the math behind 50-100 queries for alpha tuning vs 500+ for LambdaMART, and the recommended self-annotation workflow. This phase distills that into a short recommendation note in the research tree and files the followup labeling issue.

### Tasks

#### Task 3.1: Write the labeling-effort recommendation note
- **files**: `thoughts/shared/research/2026-04-NN-GH-0900-labeling-effort-recommendation.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] File created at `thoughts/shared/research/` with frontmatter: `date`, `github_issue: 900`, `github_url`, `status: complete`, `type: research`, `tags: [learning-to-rank, labeling, ralph-knowledge, hybrid-search, calibration]`.
  - [x] `## Prior Work` section with `builds_on:: [[2026-04-26-GH-0900-minimum-viable-labeling-learned-fusion]]`.
  - [x] `## Recommendation` section: pursue convex-combination-with-tuned-alpha as MVP; defer LambdaMART; corpus is 1,453 docs (not the 75 estimated in the issue).
  - [x] `## Target labeling counts`: 60 queries × 10 results = 600 grades for alpha tuning; 500+ queries × 10 grades = 5,000+ grades for LambdaMART (deferred).
  - [x] `## Workflow`: 4-phase outline (query sampling 30 min, annotation 2-3 hrs, alpha tuning 1 hr, decide on LambdaMART) with the 5 query-intent classes from the research.
  - [x] `## Storage`: use existing `knowledge_record_outcome` MCP tool with `event_type: "search_feedback"` and payload `{ query, doc_id, grade, intent_type }`. No schema change required.
  - [x] `## Followup` paragraph naming the new GH issue created in Task 3.2.

#### Task 3.2: File the labeling-task followup issue
- **files**: (no files — GitHub-only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.1]
- **acceptance**:
  - [x] New issue created in `cdubiel08/ralph-hero` with title `ralph-knowledge: collect 60-query labeled dev set for alpha tuning`.
  - [x] Body summarizes the MVP labeling workflow from the recommendation note, links the recommendation note URL, links the parent epic #898, and references its sibling Phase 3 of this plan.
  - [x] Issue is labeled `enhancement`, estimate `S`, priority `P3`, parent `#898`.
  - [x] The issue number is appended to Task 3.1's recommendation-note `## Followup` paragraph (use Edit tool after issue is created).

### Phase Success Criteria

#### Automated Verification:
- [x] `git status` shows the new note in `thoughts/shared/research/`.
- [x] `gh issue view <new-number>` shows the followup issue exists with the right parent and labels.

#### Manual Verification:
- [x] The recommendation note's `## Workflow` section is internally consistent — counts match (60 queries × 10 grades = 600 pairs) and the 4 phases sum to ~3.5-4 hours total.

**Creates for next phase**: Nothing. Phase 4 is independent.

---

## Phase 4: GH-901 — Benchmark local cross-encoder reranker on M5 Pro
- **depends_on**: null

### Overview
Create a new standalone benchmark script at `plugin/ralph-knowledge/benchmark/reranker-bench.ts` that loads two ONNX cross-encoder rerankers via the existing `@huggingface/transformers` v3 dependency, runs them on top-20 RRF candidates from 30-50 sample queries, and writes a TSV results table covering cold-start load, per-pair latency p50/p95, batch latency, memory delta, and top-3 agreement vs RRF-only. Per the research, the script does NOT wire the reranker into `hybrid-search.ts` — that is a downstream decision gated on the table.

### Tasks

#### Task 4.1: Create the `benchmark/` directory scaffolding
- **files**: `plugin/ralph-knowledge/benchmark/.gitkeep` (create), `plugin/ralph-knowledge/benchmark/README.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] New directory `plugin/ralph-knowledge/benchmark/` exists.
  - [x] Brief README.md explains the directory's purpose: standalone benchmark scripts that import from `../src/` but are not part of the published npm package or test suite.
  - [x] README.md notes the script must be run with `npx tsx benchmark/reranker-bench.ts` (no new build target required) or `node --import tsx benchmark/reranker-bench.ts`.

#### Task 4.2: Write the benchmark script
- **files**: [`plugin/ralph-knowledge/benchmark/reranker-bench.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/benchmark/reranker-bench.ts) (create)
- **tdd**: false
- **complexity**: high
- **depends_on**: [4.1]
- **acceptance**:
  - [x] Script is a standalone `.ts` file with a top-level `main()` function and a `if (import.meta.url === ...)` runner block.
  - [x] Resolves the knowledge DB path from `RALPH_KNOWLEDGE_DB` env var (same pattern as [`index.ts:372`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts#L372)) with sensible default.
  - [x] Builds a `KnowledgeDB`, `FtsSearch`, `VectorSearch`, `HybridSearch` (using `embed` from `embedder.ts`) — same wiring as `createServer()`.
  - [x] Draws 30-50 sample queries: hard-coded list covering all 5 intent classes from the Phase 3 research (12 prior-work topic queries, 8 plan-by-issue lookups, 8 claim evidence, 8 epic context, 8 hero orientation = 44 total).
  - [x] For each query, runs `hybrid.search(q, { limit: 20 })` and captures the top-20 results (this is the candidate set for reranking).
  - [x] Loads two rerankers via the existing `@huggingface/transformers` library: (a) `onnx-community/bge-reranker-v2-m3-ONNX` with int8 quantization (`dtype: "q8"`), (b) `Xenova/ms-marco-MiniLM-L-6-v2`. Each model is loaded once outside the per-query loop. Cold-start (first inference) latency is captured separately. *Implementation deviation*: uses the lower-level `AutoTokenizer` + `AutoModelForSequenceClassification` direct path instead of `pipeline('text-classification', ...)` — the high-level pipeline silently coerces `{text, text_pair}` objects to strings and returns a constant `score=1` for every cross-encoder pair, while the direct path returns the actual logits. Same npm dependency, no new package.
  - [x] For each (query, reranker) pair: time the rerank pass over the 20 candidates (one batch call); store wall-clock ms; capture `process.memoryUsage().rss` delta before/after model load.
  - [x] Computes top-3 agreement as: `|set(rrf_top_3) ∩ set(reranker_top_3)| / 3`, averaged across queries.
  - [x] Writes a TSV file at `plugin/ralph-knowledge/benchmark/results-YYYY-MM-DD.tsv` with columns: `model`, `cold_start_ms`, `latency_p50_ms`, `latency_p95_ms`, `batch_top20_p50_ms`, `memory_rss_delta_mb`, `top3_agreement_avg`, `notes`.
  - [x] Console output prints a human-readable summary table at end of run.
  - [x] Script handles missing models gracefully: catches the transformers.js download error, prints a "model X failed to load: <reason>" line, continues with other models. Exits with non-zero code only if all models fail.
  - [x] Script does NOT modify `hybrid-search.ts` or any production source file. It is purely additive.

#### Task 4.3: Document the benchmark in the parent ralph-knowledge README
- **files**: [`plugin/ralph-knowledge/README.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/README.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.2]
- **acceptance**:
  - [x] New section in README under "Development" or "Benchmarks" (whichever heading exists or is closest): brief paragraph describing the reranker benchmark, the two models compared, and the command to run it (`npx tsx benchmark/reranker-bench.ts`).
  - [x] Links to `benchmark/README.md` and to the most recent results TSV (filename TBD by run date).

#### Task 4.4: Run the benchmark and commit results
- **files**: `plugin/ralph-knowledge/benchmark/results-YYYY-MM-DD.tsv` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [4.2]
- **acceptance**:
  - [x] Run `npx tsx plugin/ralph-knowledge/benchmark/reranker-bench.ts` from the repo root with `RALPH_KNOWLEDGE_DB` pointing at the live `knowledge.db`.
  - [x] Resulting TSV has at least one row per loaded reranker (BGE-v2-m3-int8 and MiniLM-L6) — if a model fails to load on this hardware, that row records `notes: "model load failed"` and zeros for the other columns.
  - [x] Commit the TSV alongside the script.
  - [x] If both rerankers ship a measurable top-3 agreement signal (>0.4 avg), open a followup issue `ralph-knowledge: production-wire cross-encoder reranker (gated on benchmark results)` with the TSV findings linked. *(Both models exceeded the 0.4 threshold — BGE 0.402, MiniLM 0.424 — so a followup issue is filed below as part of the PR open.)*

### Phase Success Criteria

#### Automated Verification:
- [x] `cd plugin/ralph-knowledge && npm run build` — no TypeScript errors (the benchmark script type-checks against the same tsconfig).
- [x] `cd plugin/ralph-knowledge && npm test` — all tests still pass; benchmark is not part of the test suite.
- [x] `ls plugin/ralph-knowledge/benchmark/results-*.tsv` shows at least one results file.

#### Manual Verification:
- [ ] Open the TSV in a spreadsheet — columns line up, latencies are within an order of magnitude of the Phase 4 research estimates (BGE p50 25-45ms/pair, MiniLM 12ms/pair).

**Creates for next phase**: Nothing — final phase.

---

## Integration Testing
- [ ] After all four phases, manually invoke `knowledge_search` from a fresh Claude session with: (a) no new options (default behavior), (b) `lambda: 0.7` only, (c) `return_diagnostics: true` only, (d) both `lambda: 0.7` and `return_diagnostics: true`. Verify (a) is byte-identical to pre-PR responses, (b) reorders results, (c) adds diagnostic fields, (d) does both correctly.
- [ ] Verify no existing tests in any `__tests__/*.test.ts` file regressed.
- [ ] Verify the two new research notes (Phase 2.5, Phase 3.1) and the benchmark TSV (Phase 4.4) are committed.

## References

- Parent epic: [GH-898 ralph-knowledge: Stage-2 reranker / calibration exploration](https://github.com/cdubiel08/ralph-hero/issues/898)
- Sibling research (parent survey): [thoughts/shared/research/2026-04-26-softmax-and-rerank-calibration.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-softmax-and-rerank-calibration.md)
- Per-issue research:
  - [GH-899 RRF calibration & observability](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-GH-0899-rrf-calibration-observability.md)
  - [GH-900 Minimum-viable labeling for learned fusion](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-GH-0900-minimum-viable-labeling-learned-fusion.md)
  - [GH-901 Local cross-encoder reranker on M5 Pro](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-GH-0901-local-cross-encoder-reranker-m5-pro.md)
  - [GH-902 Label-free MMR diversity reranking](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-26-GH-0902-mmr-diversity-reranking-ralph-knowledge.md)
- Related issues: [GH-899](https://github.com/cdubiel08/ralph-hero/issues/899), [GH-900](https://github.com/cdubiel08/ralph-hero/issues/900), [GH-901](https://github.com/cdubiel08/ralph-hero/issues/901), [GH-902](https://github.com/cdubiel08/ralph-hero/issues/902)
- Source files in scope:
  - [plugin/ralph-knowledge/src/hybrid-search.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/hybrid-search.ts)
  - [plugin/ralph-knowledge/src/vector-search.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/vector-search.ts)
  - [plugin/ralph-knowledge/src/search.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/search.ts)
  - [plugin/ralph-knowledge/src/index.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/index.ts)
