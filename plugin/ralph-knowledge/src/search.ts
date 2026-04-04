import type { KnowledgeDB } from "./db.js";

export interface SearchOptions {
  type?: string;
  tags?: string[];
  includeSuperseded?: boolean;
  limit?: number;
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

  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const { type, tags, includeSuperseded = false, limit = 20 } = options;

    const conditions: string[] = ["documents_fts MATCH @query"];
    const params: Record<string, unknown> = { query, limit };

    if (!includeSuperseded) {
      conditions.push("d.status IS NOT 'superseded'");
    }

    if (type) {
      conditions.push("d.type = @type");
      params.type = type;
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
