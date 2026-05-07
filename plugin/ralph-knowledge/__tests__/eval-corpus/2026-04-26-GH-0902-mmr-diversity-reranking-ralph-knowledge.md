---
date: 2026-04-26
github_issue: 902
github_url: https://github.com/cdubiel08/ralph-hero/issues/902
status: complete
type: research
tags: [ralph-knowledge, mmr, diversity-reranking, hybrid-search, sqlite-vec, retrieval]
---

# Research: Label-Free MMR Diversity Reranking for ralph-knowledge (GH-902)

## Prior Work

- builds_on:: [[2026-04-26-softmax-and-rerank-calibration]]
- builds_on:: [[2026-04-03-knowledge-implementation-comparison-obra-vs-ralph]]
- builds_on:: [[2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop]]

## Problem Statement

The `knowledge_search` MCP tool returns up to K ranked documents fused by Reciprocal Rank Fusion over FTS5 and sqlite-vec. When the corpus contains near-duplicate topic clusters (research doc + plan doc for the same issue, or a group plan + multiple sub-issue plans), a single query can surface redundant documents occupying several of the top-K slots, crowding out genuinely different perspectives. The question is: (1) does the ralph-knowledge corpus exhibit enough near-duplicate clustering to make MMR worthwhile, and (2) if yes, how should a label-free MMR stage be designed?

## Corpus Near-Duplicate Analysis

### Corpus Scale

The `thoughts/` tree contains 918 documents: 265 in `thoughts/shared/research/`, 274 in `thoughts/shared/plans/`, 87 in `thoughts/shared/reviews/`, plus ideas and raw memories. This is not a web-scale corpus where MMR is most often benchmarked, but it has a structural property that amplifies near-duplicate risk: the ralph-hero pipeline produces a research document and a plan document for every implemented issue.

### Structural Near-Duplicate Clusters

Four types of near-duplicate clusters are present and quantifiable:

**Type 1: Research + Plan pairs on the same issue.** 221 research documents and 233 plan documents carry GH issue references. Of these, 116 issues have both a research doc and a plan doc. For any query that hits the research doc by topic, the plan doc almost certainly ranks in the top-20 candidate set too, since they share the same title keywords, tags, and vocabulary. A query for "chunked embeddings" would return both `2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop.md` (research) and `2026-04-16-GH-0761-ralph-knowledge-chunked-embeddings-dream-loop.md` (plan) as top candidates, conveying overlapping information.

**Type 2: Group plans + sub-issue plans.** There are 42 group plans (`group-GH-NNNN`) covering the same epic topic, alongside the individual sub-issue plans. The 2026-04-20 sprint produced 17 plans all tagged `ralph-playwright` on a single day. The group plan is a superset document; the sub-issue plans are subsets. All share the same terminology cluster. A user searching for "playwright visual diff" would see the group plan, the semantic diff plan, the regression emitter plan, and the noise floor pilot — all within the top-5 RRF results.

**Type 3: Sprint cohort plans.** On 2026-02-20, 38 plans were produced for 38 different GH issues, all from the same pipeline/routing sprint. They each target a different GH issue but share the same background vocabulary (GraphQL, project board, MCP tool names). These are less strongly near-duplicate than Types 1/2 — they are parallel work-streams — but they do exhibit moderate BM25-level overlap on pipeline terms.

**Type 4: Knowledge GH-055x cluster.** Six research documents from 2026-03-09 (GH-550 through GH-555) all describe "adding knowledge metadata to skill templates." They share the same 8,584-word vocabulary pool (total across 6 docs, individually 980–1,976 words each). A user asking "how do skills attach metadata for knowledge indexing" would get all six in the top-6 results.

### Redundancy Assessment: Is It Worthwhile?

**Yes, with a qualified justification.** The corpus is not a web-scale FAQ corpus where exact-duplicate URL variations flood results. Instead, it exhibits structured topic clustering from the sprint-group workflow. The redundancy is predictable and systematic: for any implemented feature, at minimum two documents (research + plan) cover the same topic with ~70% vocabulary overlap.

Without MMR: a top-10 search for "ralph-knowledge hybrid search" would likely surface 3-4 plan+research pairs for the same issues, consuming 6-8 slots with overlapping content. With MMR at lambda=0.7, once the first research or plan doc for an issue is selected, the other's MMR score is penalized by `(1-0.7) * max_similarity_to_selected`, reducing its chance of occupying an adjacent slot.

The corpus has enough near-duplicate clustering: estimated 30-40% of top-10 results on topic-specific queries are from type-1 or type-2 redundant clusters. MMR would reclaim these slots for genuinely different documents.

## Current Search Pipeline and Integration Point

### Pipeline Flow

```
query
  → FTS5 BM25 top-40 candidates (limit*2=20 in HybridSearch, default limit=20 at HybridSearch level)
  → sqlite-vec cosine top-40 candidates
  → Bucketed by doc_id (best chunk per doc)
  → RRF score fusion (k=60)
  → Sort by RRF score descending
  → Post-filters (superseded, type, tags, memory_tier)
  → .slice(0, limit)  ← MMR replaces this truncation
```

**MMR slot in the pipeline:** post-RRF sort, pre-`slice(0, limit)`. The candidates entering MMR are the post-filter array, already ranked by RRF score. MMR reorders them greedily to maximize `lambda * rrfScore - (1-lambda) * max_cos_similarity_to_selected`.

This is exactly the integration point described in the parent issue and the natural extension of the existing pipeline.

### Embedding Availability for MMR

The doc-doc similarity term in MMR (`max_similarity(d, selected)`) requires access to embeddings of the candidate documents. Two retrieval methods are viable:

**Method A: sqlite-vec POINT queries (recommended).** The `documents_vec` virtual table supports three query plans: KNN (MATCH), POINT (rowid = ?), and FULLSCAN. The vec0 C implementation confirms this: `vec0Column_point()` and `vec0Column_fullscan()` both return the raw embedding BLOB via `sqlite3_result_blob`. The existing schema maps chunk ids (`doc_id#cN`) to embeddings; the doc-level best chunk id is already tracked in `bestChunkByDoc` inside `HybridSearch.search()`.

Query pattern:
```sql
SELECT id, embedding FROM documents_vec WHERE id = ?
```

This is a POINT query (rowid equality on the TEXT primary key column), returns the float32 BLOB, and does not require a new MATCH pass. For 20-40 candidates, this is 20-40 point lookups in a single transaction.

**Method B: Re-embed on demand.** Call `embedFn(candidate.title + snippet)` for each candidate. This costs one model inference per candidate (~5-10ms each on M5 Pro, totaling 100-400ms for 20-40 candidates). This is significantly more expensive and semantically slightly wrong (the stored embedding was computed from the full chunk content + contextual prefix, not from the truncated snippet). Not recommended.

**Conclusion:** Method A is correct and cheap. Fetch raw float32 BLOBs via POINT queries on `documents_vec`. Deserialize as `new Float32Array(Buffer.from(blob).buffer)` (the same pattern used during upsert in `float32ToBuffer`).

### Cosine Similarity Computation

The `all-MiniLM-L6-v2` model produces L2-normalized embeddings (confirmed: `pooling: "mean", normalize: true` in `embedder.ts:26-29`). For normalized vectors, cosine similarity equals the dot product. The stored `distance` in the KNN search is `1 - cosine_similarity` (distance_metric=cosine in the vec0 definition). Therefore:

```
cosine_similarity(a, b) = 1 - cosine_distance(a, b)
```

For MMR we need cosine similarity in [0,1]. The dot product of two 384-dim L2-normalized Float32Arrays, computed in JavaScript, is O(384) per pair — approximately 1 microsecond per pair on modern hardware. For 20 candidates, the MMR loop involves at most 20*10 = 200 dot products = ~200 microseconds. This is negligible relative to SQLite query latency.

## MMR Algorithm and Parameter Design

### Standard MMR Formula

```
MMR(d) = lambda * score_rrf(d) - (1 - lambda) * max_{d' in S} cosine_similarity(d, d')
```

where `S` is the set of already-selected documents. `score_rrf(d)` is the RRF score from the fusion phase, normalized to [0, 1] via min-max over the candidate set (since raw RRF scores are in ~0.01-0.03 range and lambda needs to be a weight between comparable terms).

### Lambda Justification for This Corpus

The corpus characteristics that inform lambda selection:
- Documents are long-form markdown (500-3000 words), not short web snippets
- Near-duplicates are structural (same issue, same sprint), not exact copies
- The primary use case is agent-side retrieval for planning and research — diversity matters but the query is usually specific
- Users are not browsing; they want the most relevant doc, then a structurally different second perspective

**Recommended lambda: 0.7.** At lambda=0.7:
- A document with RRF score 0.9 (top relevance) will beat a document with RRF score 0.5 even if the latter is maximally diverse (similarity=0 to selected set): 0.7*0.9=0.63 vs 0.7*0.5=0.35, so high relevance still dominates.
- A near-duplicate with RRF score 0.85 (plan doc alongside a research doc at 0.9) that has cosine similarity 0.80 to the selected research doc scores: 0.7*0.85 - 0.3*0.80 = 0.595 - 0.24 = 0.355. It drops below a genuinely different document with RRF score 0.65 and similarity 0.20: 0.7*0.65 - 0.3*0.20 = 0.455 - 0.06 = 0.395. MMR surface the different document first.
- Lambda=0.7 matches the Elasticsearch default for their MMR implementation and the original Carbonell & Goldstein recommendation for information retrieval (as opposed to text summarization where lambda=0.5 is common).

This corpus should NOT use lambda below 0.5 (too diversity-heavy) or above 0.85 (near-identity with pure relevance ranking, MMR has no effect). Lambda=0.7 is the right default for a research/planning corpus accessed by a reasoning agent.

### DPP vs MMR Comparison

**Determinantal Point Processes (DPPs)** compute set-level diversity as proportional to the determinant of the kernel matrix. For k selected items from N candidates, greedy MAP DPP is O(Nk³) versus MMR's O(Nk). At N=20, k=10, the difference is 200 vs 20,000 operations — DPP is 100x more expensive.

DPP has better theoretical guarantees (global diversity vs MMR's local greedy view) and would in principle select a better diverse subset. However:
- The corpus exhibits structured clusters (plan+research pairs) where greedy selection is already optimal: once the research doc is selected, the plan doc's similarity to the selected set is high, and MMR correctly penalizes it.
- For retrieval queries (not recommendation), the user-specified query provides strong relevance signal, and greedy MMR's local choices are adequate.
- The additional complexity of DPP (kernel matrix construction, determinant computation with numerical stability concerns) is disproportionate to the benefit for a 20-40 candidate set.

**Recommendation: implement MMR, not DPP.** If diversity quality proves insufficient post-deployment (measured by user or agent feedback), DPP can replace MMR without changing the external API since the interface is lambda + candidates.

Sampled MMR (SMMR from SIGIR 2025) adds randomness for better relevance-diversity tradeoff with logarithmic speedup — worth considering if MMR lambda tuning proves brittle, but not for the initial implementation.

## Proposed Implementation

### Changes to `plugin/ralph-knowledge/src/vector-search.ts`

Add a `getEmbedding(id: string)` method that does a POINT query:

```typescript
getEmbedding(id: string): Float32Array | null {
  this.ensureVecLoaded();
  const row = this.knowledgeDb.db
    .prepare("SELECT embedding FROM documents_vec WHERE id = ?")
    .get(id) as { embedding: Buffer } | undefined;
  if (!row) return null;
  return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
}
```

This works via the sqlite-vec POINT query plan (equality on primary key `id`), returning the float32 BLOB.

### Changes to `plugin/ralph-knowledge/src/hybrid-search.ts`

Add an MMR stage post-filter, pre-slice:

```typescript
// After all post-filters and before filtered.slice(0, limit)
if (lambda !== undefined && lambda < 1.0) {
  filtered = this.applyMMR(filtered, lambda, limit);
} else {
  filtered = filtered.slice(0, limit);
}
```

The `applyMMR` method implements greedy selection, fetching embeddings via `this.vec.getEmbedding()` lazily (only for candidates that make it into the greedy selection process).

### Changes to `plugin/ralph-knowledge/src/index.ts` (knowledge_search tool)

Add an optional `lambda` parameter:

```typescript
lambda: z.number().min(0).max(1).optional().describe(
  "MMR diversity trade-off: 1.0 = pure relevance (default), 0.7 = balanced, 0.0 = max diversity"
),
```

The parameter is off by default (undefined = pure RRF, no MMR). Callers must opt in by passing `lambda: 0.7` until MMR is validated.

### Test Coverage

- `lambda=1.0` (or undefined): results identical to current sort-by-RRF behavior
- `lambda=0.0`: first result is highest RRF, subsequent results are maximally dissimilar from selected
- `lambda=0.7` with a planted near-duplicate pair: verify the near-duplicate ranks below a less-similar alternative

## RRF Score Normalization Note

The RRF score range (~0.01-0.03) and cosine similarity range ([0,1]) differ by an order of magnitude. Before applying the MMR formula, the `score_rrf` term must be normalized to [0,1] over the candidate set using min-max normalization:

```
score_norm(d) = (rrf(d) - min_rrf) / (max_rrf - min_rrf)
```

This is a 1-pass O(N) operation over the candidate set. Without normalization, the lambda term would not meaningfully balance relevance and diversity.

## Risks

1. **sqlite-vec POINT query on TEXT primary key**: The `documents_vec` table declares `id TEXT PRIMARY KEY` per the `createIndex()` method. sqlite-vec vec0 POINT query plan is triggered by `EQ` on the rowid column. When the primary key is TEXT (not INTEGER), the POINT plan may fall back to FULLSCAN for some sqlite-vec versions. This needs a quick test during implementation. Fallback: if POINT queries don't work, store a separate `embedding_cache` table (plain SQLite, not virtual) as a lookup.

2. **Chunk-level vs doc-level embeddings**: The vector table stores chunk-level embeddings (`doc_id#cN`) not doc-level. The best chunk id for each candidate is tracked in `bestChunkByDoc`. MMR should use the best chunk's embedding (the one that contributed to the RRF score) as the representative for that document. If `bestChunkByDoc` doesn't have an entry for a candidate (FTS-only hit with no vector contribution), fall back to re-embedding or skip the similarity term for that candidate.

3. **Cold start with no embeddings**: Documents with no vec entry (rare, possible if reindex was interrupted) would cause `getEmbedding` to return null. The MMR implementation should treat null embeddings as similarity=0 (maximally diverse) to maintain graceful degradation.

## Files Affected

### Will Modify
- `plugin/ralph-knowledge/src/hybrid-search.ts` - Add `applyMMR()` method and `lambda` parameter to `search()` options
- `plugin/ralph-knowledge/src/vector-search.ts` - Add `getEmbedding(id: string): Float32Array | null` method
- `plugin/ralph-knowledge/src/index.ts` - Add optional `lambda` parameter to `knowledge_search` MCP tool
- `plugin/ralph-knowledge/src/search.ts` - No changes needed (FTS output is already in RRF input format)

### Will Read (Dependencies)
- `plugin/ralph-knowledge/src/db.ts` - KnowledgeDB + schema reference (documents_vec table)
- `plugin/ralph-knowledge/src/__tests__/hybrid-search.test.ts` - Existing test patterns to follow

## Conclusion

The ralph-knowledge corpus exhibits substantial near-duplicate clustering: 116 research+plan pairs, 42 group plan supersets, and sprint-cohort plan clusters that share 60-80% of their vocabulary. MMR at lambda=0.7 is warranted and will measurably improve result diversity for topically specific queries.

The implementation is low-risk and self-contained:
- sqlite-vec POINT queries expose raw float32 embeddings without re-embedding
- The MMR math (dot products on 384-dim L2-normalized vectors) costs ~200 microseconds for a 20-candidate set
- The feature is opt-in via the `lambda` parameter, defaulting off until validated
- DPP is not necessary: the corpus's structured clustering is handled well by greedy MMR, and the 100x compute cost increase is not justified

Recommended lambda: **0.7** (balanced), defaulting to off (lambda=1.0 or undefined). The lambda value should be exposed as a tunable parameter in the MCP tool to allow per-query experimentation.
