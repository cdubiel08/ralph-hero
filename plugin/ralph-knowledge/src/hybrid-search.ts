import type { KnowledgeDB } from "./db.js";
import type { FtsSearch, SearchOptions, SearchResult } from "./search.js";
import type { VectorResult, VectorSearch } from "./vector-search.js";

export type EmbedFn = (text: string) => Promise<Float32Array>;

interface ChunkRow {
  id: string;
  document_id: string;
  chunk_index: number;
  char_start: number;
  char_end: number;
  context_prefix: string;
  content: string;
}

/**
 * Maximum snippet length (in characters) when the snippet is sourced from a
 * chunk's content. Keeps the MCP payload compact while still representative.
 */
const SNIPPET_MAX_CHARS = 300;

/**
 * Per-document bucket tracking the best-ranked chunk for a given doc_id in
 * the vector result list. The "rank" is the index of the first occurrence of
 * the document in the distance-sorted vector results (smaller = better).
 */
interface DocBucket {
  bestRank: number;
  bestChunkId: string;
  bestContent: string;
}

export class HybridSearch {
  private static readonly RRF_K = 60;

  constructor(
    private readonly db: KnowledgeDB,
    private readonly fts: FtsSearch,
    private readonly vec: VectorSearch,
    private readonly embedFn: EmbedFn,
  ) {}

  /**
   * Returns true when the `chunks` table exists (schema v3+). When absent we
   * behave as if all vector ids are doc ids (pre-chunking behavior).
   */
  private chunksTableExists(): boolean {
    const row = this.db.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks'",
      )
      .get();
    return row !== undefined;
  }

  /**
   * Given a vector-search id, return the `document_id` portion. Chunk ids
   * follow the pattern `{doc_id}#c{index}` per Shared Constraint #6 of the
   * GH-0761 plan. Legacy non-chunk ids pass through unchanged.
   */
  private docIdFromVecId(vecId: string): string {
    const marker = vecId.lastIndexOf("#c");
    if (marker === -1) return vecId;
    const suffix = vecId.slice(marker + 2);
    if (suffix.length === 0 || !/^\d+$/.test(suffix)) return vecId;
    return vecId.slice(0, marker);
  }

  private fetchChunk(chunkId: string): ChunkRow | undefined {
    if (!this.chunksTableExists()) return undefined;
    return this.db.db
      .prepare(
        `SELECT id, document_id, chunk_index, char_start, char_end, context_prefix, content
         FROM chunks WHERE id = ?`,
      )
      .get(chunkId) as ChunkRow | undefined;
  }

  async search(
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const {
      type,
      tags,
      includeSuperseded = false,
      limit = 20,
      memoryTier,
      lambda,
      diagnosticMode = false,
    } = options;

    // Run FTS and vector search (FTS already applies memoryTier filter in SQL
    // when the schema supports it).
    const ftsResults = this.fts.search(query, {
      includeSuperseded: true,
      limit: limit * 2,
      memoryTier,
    });

    const queryEmbedding = await this.embedFn(query);
    const vecResults: VectorResult[] = this.vec.search(
      queryEmbedding,
      limit * 2,
    );

    // Phase 2 (GH-899) diagnostic-mode hook: capture raw per-retriever scores
    // before they are reduced to ordinal ranks for RRF. These maps stay empty
    // when `diagnosticMode === false`, so the fast path pays no extra cost.
    const ftsScoreByDocId = diagnosticMode
      ? new Map<string, number>()
      : null;
    const vecDistanceByDocId = diagnosticMode
      ? new Map<string, number>()
      : null;
    if (diagnosticMode && ftsScoreByDocId) {
      for (const ftsRow of ftsResults) {
        // BM25 score is already a single value per doc — first hit wins (FTS
        // returns at most one row per doc).
        if (!ftsScoreByDocId.has(ftsRow.id)) {
          ftsScoreByDocId.set(ftsRow.id, ftsRow.score);
        }
      }
    }

    // Bucket vector results by doc_id, keeping the best-ranked chunk per doc.
    // vecResults is already sorted by distance ascending, so the first
    // occurrence of a given doc_id has the smallest rank (best match).
    const buckets = new Map<string, DocBucket>();
    for (let i = 0; i < vecResults.length; i++) {
      const hit = vecResults[i];
      const docId = this.docIdFromVecId(hit.id);
      if (buckets.has(docId)) continue; // Already have best rank for this doc
      buckets.set(docId, {
        bestRank: i,
        bestChunkId: hit.id,
        bestContent: hit.content ?? "",
      });
      // Phase 2 diagnostic capture: record this doc's best (smallest) cosine
      // distance from the vec retriever. Using `bestRank` semantics — same
      // best-row choice as the bucketing above.
      if (diagnosticMode && vecDistanceByDocId) {
        vecDistanceByDocId.set(docId, hit.distance);
      }
    }

    // Build RRF score map (keyed by doc_id for both FTS and vector buckets)
    const scores = new Map<string, number>();
    const bestChunkByDoc = new Map<string, { chunkId: string; rank: number }>();

    for (let i = 0; i < ftsResults.length; i++) {
      const id = ftsResults[i].id;
      const rrfScore = 1 / (HybridSearch.RRF_K + i + 1);
      scores.set(id, (scores.get(id) ?? 0) + rrfScore);
    }

    for (const [docId, bucket] of buckets) {
      const rrfScore = 1 / (HybridSearch.RRF_K + bucket.bestRank + 1);
      scores.set(docId, (scores.get(docId) ?? 0) + rrfScore);
      // Track best chunk for later enrichment
      const existing = bestChunkByDoc.get(docId);
      if (!existing || bucket.bestRank < existing.rank) {
        bestChunkByDoc.set(docId, { chunkId: bucket.bestChunkId, rank: bucket.bestRank });
      }
    }

    // Build a lookup of FTS results by id for quick access
    const ftsById = new Map<string, SearchResult>();
    for (const r of ftsResults) {
      ftsById.set(r.id, r);
    }

    // Assemble combined results. For vector-hit docs, replace the snippet
    // with the winning chunk's content (truncated). FTS-only hits keep the
    // FTS snippet.
    const combined: SearchResult[] = [];

    for (const [id, rrfScore] of scores) {
      const ftsHit = ftsById.get(id);
      const bucket = buckets.get(id);
      if (ftsHit) {
        // FTS hit (possibly also a vector hit): prefer the chunk snippet when
        // the vector side contributed real chunk content.
        const snippet =
          bucket && bucket.bestContent
            ? bucket.bestContent.slice(0, SNIPPET_MAX_CHARS)
            : ftsHit.snippet;
        combined.push({ ...ftsHit, score: rrfScore, snippet });
      } else {
        // Vector-only result: fetch document metadata from db
        const doc = this.db.getDocument(id);
        // Skip stub documents — they have no real content or path
        if (!doc || doc.isStub) continue;
        const snippet = bucket
          ? bucket.bestContent.slice(0, SNIPPET_MAX_CHARS)
          : "";
        combined.push({
          id: doc.id,
          path: doc.path as string,
          title: doc.title,
          type: doc.type,
          status: doc.status,
          date: doc.date,
          score: rrfScore,
          snippet,
        });
      }
    }

    // Sort by RRF score descending
    combined.sort((a, b) => b.score - a.score);

    // Post-filter: superseded
    let filtered = combined;
    if (!includeSuperseded) {
      filtered = filtered.filter((r) => r.status !== "superseded");
    }

    // Post-filter: type
    if (type) {
      filtered = filtered.filter((r) => r.type === type);
    }

    // Post-filter: tags
    if (tags && tags.length > 0) {
      const tagSet = new Set(tags);
      filtered = filtered.filter((r) => {
        const docTags = this.db.getTags(r.id);
        return docTags.some((t) => tagSet.has(t));
      });
    }

    // Post-filter: memory_tier for vector-only hits that bypassed the FTS
    // SQL filter. Also covers the case where the FTS stage returned 0 rows
    // but vec returned chunks from a doc in another tier.
    if (memoryTier && memoryTier !== "any") {
      filtered = filtered.filter((r) => {
        const tier = this.db.getMemoryTier(r.id);
        // When column absent (v2 schema) treat as "doc"
        return (tier ?? "doc") === memoryTier;
      });
    }

    // Enrich with chunk meta when chunk data is available (best-scoring
    // chunk per doc).
    for (const r of filtered) {
      const best = bestChunkByDoc.get(r.id);
      if (!best) continue;
      const chunk = this.fetchChunk(best.chunkId);
      if (!chunk) continue;
      r.bestChunkId = chunk.id;
      r.chunkIndex = chunk.chunk_index;
      r.charStart = chunk.char_start;
      r.charEnd = chunk.char_end;
      r.contextPrefix = chunk.context_prefix;
    }

    // Phase 2 (GH-899) diagnostic-mode population: stamp each result with raw
    // per-retriever scores BEFORE the optional MMR reorder, so MMR's reorder
    // (which works on the same SearchResult references) preserves them.
    if (diagnosticMode && ftsScoreByDocId && vecDistanceByDocId) {
      for (const r of filtered) {
        const fts = ftsScoreByDocId.get(r.id);
        const vec = vecDistanceByDocId.get(r.id);
        const sources: Array<"fts" | "vec"> = [];
        if (fts !== undefined) {
          r.ftsScore = fts;
          sources.push("fts");
        }
        if (vec !== undefined) {
          r.vecDistance = vec;
          sources.push("vec");
        }
        r.hitSources = sources;
      }
    }

    // MMR diversity rerank (Phase 1, GH-902). Opt-in via `lambda` < 1.0.
    // When omitted or `lambda === 1.0`, the pure-RRF order is preserved
    // byte-identically. Values outside [0, 1] are silently clamped.
    if (lambda !== undefined) {
      const clamped = Math.max(0, Math.min(1, lambda));
      if (clamped < 1.0) {
        return this.applyMMR(filtered, clamped, limit, bestChunkByDoc);
      }
    }

    return filtered.slice(0, limit);
  }

  /**
   * Maximal Marginal Relevance (MMR) reranker — Phase 1, GH-902.
   *
   * Greedy iterative selection over the post-RRF candidate set. For each slot
   * we pick the candidate maximizing:
   *   `lambda * score_norm(d) - (1 - lambda) * max_{d' in S} cosine(d, d')`
   *
   * `score_norm` is the min-max normalization of the RRF score over the
   * candidate set — required because raw RRF scores are tightly compressed
   * (~0.01-0.03) which would let the diversity term dominate.
   *
   * Cosine similarity uses doc-doc dot product over L2-normalized 384-dim
   * embeddings (see `VectorSearch.getEmbedding`). Candidates with no
   * embedding (FTS-only hits or missing chunk) are treated as similarity=0
   * so they remain eligible — preserves backwards compat for legacy fixtures
   * with no vector contribution.
   */
  private applyMMR(
    candidates: SearchResult[],
    lambda: number,
    limit: number,
    bestChunkByDoc: Map<string, { chunkId: string; rank: number }>,
  ): SearchResult[] {
    if (candidates.length === 0) return candidates;

    // Min-max normalize RRF scores to [0, 1] over the candidate set so the
    // relevance and diversity terms are on the same scale.
    let minScore = Infinity;
    let maxScore = -Infinity;
    for (const c of candidates) {
      if (c.score < minScore) minScore = c.score;
      if (c.score > maxScore) maxScore = c.score;
    }
    const range = maxScore - minScore;
    const scoreNorm = new Map<string, number>();
    for (const c of candidates) {
      // When all scores are equal (range = 0) treat as full relevance for all
      // so the choice falls through to the diversity term.
      scoreNorm.set(c.id, range > 0 ? (c.score - minScore) / range : 1.0);
    }

    // Pre-fetch embeddings for the candidate's best chunk. Doc-level vec ids
    // (legacy back-compat) and FTS-only hits where the doc has no chunk
    // contribution may have no embedding — those map to null.
    const embeddings = new Map<string, Float32Array | null>();
    for (const c of candidates) {
      const best = bestChunkByDoc.get(c.id);
      // Try the chunk-level id first (covers chunked docs); fall back to the
      // doc id (covers pre-chunks fixtures with doc-level vec rows).
      const tryId = best?.chunkId ?? c.id;
      let emb = this.vec.getEmbedding(tryId);
      if (emb === null && tryId !== c.id) {
        emb = this.vec.getEmbedding(c.id);
      }
      embeddings.set(c.id, emb);
    }

    const targetCount = Math.min(limit, candidates.length);
    const selected: SearchResult[] = [];
    const remaining = new Set(candidates.map((c) => c.id));
    const candidateById = new Map(candidates.map((c) => [c.id, c] as const));

    // Track the running max similarity from each remaining candidate to the
    // already-selected set. Starts at 0 because nothing is selected yet.
    const maxSimToSelected = new Map<string, number>();
    for (const c of candidates) maxSimToSelected.set(c.id, 0);

    while (selected.length < targetCount && remaining.size > 0) {
      let bestId: string | null = null;
      let bestMmrScore = -Infinity;

      for (const id of remaining) {
        const rel = scoreNorm.get(id) ?? 0;
        const sim = maxSimToSelected.get(id) ?? 0;
        const mmrScore = lambda * rel - (1 - lambda) * sim;
        if (mmrScore > bestMmrScore) {
          bestMmrScore = mmrScore;
          bestId = id;
        }
      }

      if (bestId === null) break; // Defensive — shouldn't happen with non-empty remaining.

      const pick = candidateById.get(bestId)!;
      selected.push(pick);
      remaining.delete(bestId);

      // Update max-similarity-to-selected for all remaining candidates using
      // the newly added doc. Cosine similarity of L2-normalized 384-dim
      // vectors is just the dot product. Null embeddings -> sim = 0.
      const pickEmb = embeddings.get(bestId);
      if (pickEmb) {
        for (const id of remaining) {
          const otherEmb = embeddings.get(id);
          if (!otherEmb) continue; // Treat null as similarity=0 (max diverse)
          const sim = HybridSearch.cosineSim(pickEmb, otherEmb);
          const prev = maxSimToSelected.get(id) ?? 0;
          if (sim > prev) maxSimToSelected.set(id, sim);
        }
      }
    }

    return selected;
  }

  /**
   * Cosine similarity for two L2-normalized 384-dim vectors. With unit-length
   * inputs, cosine similarity reduces to a dot product — no division needed.
   * If lengths mismatch we return 0 (defensive — should never happen for
   * matching schema vectors).
   */
  private static cosineSim(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }
}
