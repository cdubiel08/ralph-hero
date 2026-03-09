import type { KnowledgeDB } from "./db.js";
import type { FtsSearch, SearchOptions, SearchResult } from "./search.js";
import type { VectorSearch } from "./vector-search.js";

export type EmbedFn = (text: string) => Promise<Float32Array>;

export class HybridSearch {
  private static readonly RRF_K = 60;

  constructor(
    private readonly db: KnowledgeDB,
    private readonly fts: FtsSearch,
    private readonly vec: VectorSearch,
    private readonly embedFn: EmbedFn,
  ) {}

  async search(
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const { type, tags, includeSuperseded = false, limit = 20 } = options;

    // Run FTS and vector search
    const ftsResults = this.fts.search(query, {
      includeSuperseded: true,
      limit: limit * 2,
    });

    const queryEmbedding = await this.embedFn(query);
    const vecResults = this.vec.search(queryEmbedding, limit * 2);

    // Build RRF score map
    const scores = new Map<string, number>();

    for (let i = 0; i < ftsResults.length; i++) {
      const id = ftsResults[i].id;
      const rrfScore = 1 / (HybridSearch.RRF_K + i + 1);
      scores.set(id, (scores.get(id) ?? 0) + rrfScore);
    }

    for (let i = 0; i < vecResults.length; i++) {
      const id = vecResults[i].id;
      const rrfScore = 1 / (HybridSearch.RRF_K + i + 1);
      scores.set(id, (scores.get(id) ?? 0) + rrfScore);
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
        if (!doc) continue;
        combined.push({
          id: doc.id,
          path: doc.path,
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

    return filtered.slice(0, limit);
  }
}
