import type { KnowledgeDB } from "./db.js";

export type MemoryTier = "doc" | "raw" | "reflection" | "any";

export interface SearchOptions {
  type?: string;
  tags?: string[];
  includeSuperseded?: boolean;
  limit?: number;
  memoryTier?: MemoryTier;
  /**
   * MMR diversity / relevance trade-off (Phase 1, GH-902). Range [0, 1].
   * - `1.0` (or omitted): pure relevance — RRF order unchanged (default).
   * - `0.7`: balanced — recommended; demotes near-duplicate clusters.
   * - `0.0`: max diversity — selects only on dissimilarity to the running set.
   * Values outside [0, 1] are silently clamped.
   */
  lambda?: number;
  /**
   * Diagnostic mode (Phase 2, GH-899). When `true`, each `SearchResult` is
   * decorated with raw per-retriever scores so callers can inspect / calibrate
   * the underlying signals that fed the RRF fusion. Default `false` keeps the
   * payload byte-identical to today (Track-B observability hook).
   *
   * Populates `ftsScore`, `vecDistance`, and `hitSources` per result.
   */
  diagnosticMode?: boolean;
  /**
   * Cross-encoder rerank (Phase 2, GH-925). When `true`, the post-RRF
   * candidate set is rescored by a cross-encoder reranker (default
   * BGE-Reranker-v2-m3-int8) before MMR / `slice(limit)`. Default `false`
   * keeps the payload byte-identical to today.
   *
   * **Latency tradeoff**: cold-start incurs a 5-10s ONNX model load on the
   * first call; warm calls add ~25-45ms per (query, doc) pair on M5 Pro per
   * #901's bench. Opt-in until #927's eval re-run confirms no regression on
   * paraphrase queries (parent #919 acceptance criteria).
   *
   * **Quality**: improves Hit@1 on specific-keyword queries by surfacing FTS
   * candidates that RRF's `1/(60+rank)` averaging buries when the vector
   * half doesn't also rank them highly (per the 2026-04-29 8-query golden
   * eval baseline).
   *
   * When `rerank: true` AND `lambda < 1.0` are both set, rerank applies
   * BEFORE MMR — see the splice-point comment in
   * `HybridSearch.search()` for the ordering rationale.
   */
  rerank?: boolean;
}

export interface SearchResult {
  id: string;
  path: string;
  title: string;
  type: string | null;
  status: string | null;
  date: string | null;
  score: number;
  snippet: string;
  // Optional chunk-level metadata. Populated when chunk data is available
  // for the best-scoring chunk of this document.
  chunkIndex?: number;
  charStart?: number;
  charEnd?: number;
  contextPrefix?: string;
  bestChunkId?: string;
  // Optional per-retriever diagnostic fields (Phase 2, GH-899). Populated
  // only when `SearchOptions.diagnosticMode === true`. Default behavior leaves
  // these undefined so `JSON.stringify` produces a byte-identical payload.
  /**
   * Raw FTS5 BM25 score for this doc's best FTS hit. SQLite's FTS5 returns the
   * BM25 negative-rank value (smaller = better). Undefined when the doc had no
   * FTS contribution (vec-only hit).
   */
  ftsScore?: number;
  /**
   * Raw cosine distance from sqlite-vec for this doc's best chunk hit. Range
   * `[0, 2]` (0 = identical, 2 = anti-parallel). Undefined when the doc had no
   * vector contribution (FTS-only hit).
   */
  vecDistance?: number;
  /**
   * Subset of `["fts", "vec"]` indicating which retriever(s) contributed the
   * RRF score for this doc. Useful for calibration analysis (e.g., are
   * vec-only hits less precise than fts+vec hits?).
   */
  hitSources?: Array<"fts" | "vec">;
  /**
   * Raw cross-encoder logit produced by the reranker (Phase 2, GH-925).
   * Populated only when `SearchOptions.rerank === true` AND a `Reranker`
   * was injected into `HybridSearch`. Higher = more relevant. The RRF
   * `score` field is preserved separately so callers that sort/filter on
   * `score` see stable values regardless of `rerank` on/off (Constraint 7
   * in the GH-0923 group plan).
   *
   * `undefined` for docs that had no entry in the reranker's score map
   * (e.g., the reranker dropped them, or rerank was disabled). Such docs
   * keep their RRF position relative to the rerank window's tail.
   */
  rerankScore?: number;
}

export class FtsSearch {
  private readonly db: KnowledgeDB;

  constructor(db: KnowledgeDB) {
    this.db = db;
  }

  /**
   * Remove a document's FTS entries. Must be called BEFORE the document
   * row is deleted/updated in the documents table, because FTS5
   * content= tables read old values from the content table during delete.
   */
  deleteFtsEntry(docId: string): void {
    const row = this.db.db.prepare(
      `SELECT rowid, title, path, content FROM documents WHERE id = ?`
    ).get(docId) as { rowid: number; title: string; path: string; content: string } | undefined;
    if (!row) return;
    this.db.db.prepare(
      `INSERT INTO documents_fts(documents_fts, rowid, title, path, content) VALUES('delete', ?, ?, ?, ?)`
    ).run(row.rowid, row.title, row.path, row.content);
  }

  /**
   * Insert/update a document's FTS entries. Must be called AFTER the
   * document row is inserted/updated in the documents table.
   */
  upsertFtsEntry(docId: string): void {
    const row = this.db.db.prepare(
      `SELECT rowid, title, path, content FROM documents WHERE id = ?`
    ).get(docId) as { rowid: number; title: string; path: string; content: string } | undefined;
    if (!row) return;
    this.db.db.prepare(
      `INSERT INTO documents_fts(rowid, title, path, content) VALUES(?, ?, ?, ?)`
    ).run(row.rowid, row.title, row.path, row.content);
  }

  /**
   * Ensure the FTS virtual table exists (idempotent).
   * Called before per-document operations to handle first-run scenarios
   * where rebuildIndex() hasn't been called yet.
   */
  ensureTable(): void {
    // Check if the table already exists to avoid re-creating it
    const exists = this.db.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='documents_fts'`
    ).get();
    if (exists) return;
    this.db.db.exec(`
      CREATE VIRTUAL TABLE documents_fts USING fts5(
        title,
        path,
        content,
        content='documents',
        content_rowid='rowid'
      )
    `);
  }

  rebuildIndex(): void {
    this.db.db.exec(`DROP TABLE IF EXISTS documents_fts`);
    this.db.db.exec(`
      CREATE VIRTUAL TABLE documents_fts USING fts5(
        title,
        path,
        content,
        content='documents',
        content_rowid='rowid'
      )
    `);
    this.db.db.exec(`
      INSERT INTO documents_fts(rowid, title, path, content)
      SELECT rowid, title, path, content FROM documents
    `);
  }

  private escapeFts5Query(raw: string): string {
    const tokens = raw.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return '""';
    return tokens.map(t => '"' + t.replace(/"/g, '""') + '"').join(" ");
  }

  /**
   * Returns true when the `documents.memory_tier` column exists (schema v3+).
   * On v2 schemas this is false and the memoryTier filter is silently ignored.
   */
  private memoryTierColumnExists(): boolean {
    const rows = this.db.db
      .prepare("PRAGMA table_info(documents)")
      .all() as Array<{ name: string }>;
    return rows.some((r) => r.name === "memory_tier");
  }

  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const { type, tags, includeSuperseded = false, limit = 20, memoryTier } = options;

    const conditions: string[] = ["documents_fts MATCH @query"];
    conditions.push("(d.is_stub = 0 OR d.is_stub IS NULL)");
    const params: Record<string, unknown> = { query: this.escapeFts5Query(query), limit };

    if (!includeSuperseded) {
      conditions.push("d.status IS NOT 'superseded'");
    }

    if (type) {
      conditions.push("d.type = @type");
      params.type = type;
    }

    if (memoryTier && memoryTier !== "any" && this.memoryTierColumnExists()) {
      conditions.push("d.memory_tier = @memoryTier");
      params.memoryTier = memoryTier;
    }

    let joinClause = "";
    if (tags && tags.length > 0) {
      joinClause = "JOIN tags t ON t.doc_id = d.id";
      const tagPlaceholders = tags.map((_, i) => `@tag${i}`);
      conditions.push(`t.tag IN (${tagPlaceholders.join(", ")})`);
      tags.forEach((tag, i) => {
        params[`tag${i}`] = tag;
      });
    }

    const whereClause = conditions.join(" AND ");

    const sql = `
      SELECT
        d.id,
        d.path,
        d.title,
        d.type,
        d.status,
        d.date,
        rank AS score,
        snippet(documents_fts, 2, '<b>', '</b>', '...', 32) AS snippet
      FROM documents_fts
      JOIN documents d ON d.rowid = documents_fts.rowid
      ${joinClause}
      WHERE ${whereClause}
      ORDER BY rank ASC
      LIMIT @limit
    `;

    return this.db.db.prepare(sql).all(params) as SearchResult[];
  }
}
