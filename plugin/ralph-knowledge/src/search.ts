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
