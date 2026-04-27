import type { KnowledgeDB } from "./db.js";

export type MemoryTier = "doc" | "raw" | "reflection" | "any";

export interface SearchOptions {
  type?: string;
  tags?: string[];
  includeSuperseded?: boolean;
  limit?: number;
  memoryTier?: MemoryTier;
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
