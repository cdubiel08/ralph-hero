import type { KnowledgeDB } from "./db.js";
import type { FtsSearch, SearchOptions, SearchResult } from "./search.js";
import type { VectorSearch } from "./vector-search.js";

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
    const { type, tags, includeSuperseded = false, limit = 20, memoryTier } = options;

    // Run FTS and vector search (FTS already applies memoryTier filter in SQL
    // when the schema supports it).
    const ftsResults = this.fts.search(query, {
      includeSuperseded: true,
      limit: limit * 2,
      memoryTier,
    });

    const queryEmbedding = await this.embedFn(query);
    const vecResults = this.vec.search(queryEmbedding, limit * 2);

    // Build RRF score map, keyed by document_id. When vec ids are chunk ids
    // like `{doc}#c{n}`, we collapse to the parent doc for scoring but
    // remember the best-scoring chunk id per doc for later meta enrichment.
    const scores = new Map<string, number>();
    const bestChunkByDoc = new Map<string, { chunkId: string; rank: number }>();

    for (let i = 0; i < ftsResults.length; i++) {
      const id = ftsResults[i].id;
      const rrfScore = 1 / (HybridSearch.RRF_K + i + 1);
      scores.set(id, (scores.get(id) ?? 0) + rrfScore);
    }

    for (let i = 0; i < vecResults.length; i++) {
      const vecId = vecResults[i].id;
      const docId = this.docIdFromVecId(vecId);
      const rrfScore = 1 / (HybridSearch.RRF_K + i + 1);
      scores.set(docId, (scores.get(docId) ?? 0) + rrfScore);
      if (vecId !== docId) {
        const existing = bestChunkByDoc.get(docId);
        if (!existing || i < existing.rank) {
          bestChunkByDoc.set(docId, { chunkId: vecId, rank: i });
        }
      }
    }

    // Build a lookup of FTS results by id for quick access
    const ftsById = new Map<string, SearchResult>();
    for (const r of ftsResults) {
      ftsById.set(r.id, r);
    }

    // Assemble combined results
    const combined: SearchResult[] = [];

    for (const [id, rrfScore] of scores) {
      const ftsHit = ftsById.get(id);
      if (ftsHit) {
        combined.push({ ...ftsHit, score: rrfScore });
      } else {
        // Vector-only result: fetch document metadata from db
        const doc = this.db.getDocument(id);
        // Skip stub documents — they have no real content or path
        if (!doc || doc.isStub) continue;
        combined.push({
          id: doc.id,
          path: doc.path as string,
          title: doc.title,
          type: doc.type,
          status: doc.status,
          date: doc.date,
          score: rrfScore,
          snippet: "",
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

    return filtered.slice(0, limit);
  }
}
