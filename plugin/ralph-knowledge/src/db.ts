import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface DocumentRow {
  id: string;
  path: string;
  title: string;
  date: string | null;
  type: string | null;
  status: string | null;
  githubIssue: number | null;
  content: string;
}

export interface RelationshipRow {
  sourceId: string;
  targetId: string;
  type: string;
}

export class KnowledgeDB {
  readonly db: DatabaseType;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        title TEXT,
        date TEXT,
        type TEXT,
        status TEXT,
        github_issue INTEGER,
        content TEXT
      );
      CREATE TABLE IF NOT EXISTS tags (
        doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
        tag TEXT,
        PRIMARY KEY (doc_id, tag)
      );
      CREATE TABLE IF NOT EXISTS relationships (
        source_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
        target_id TEXT,
        type TEXT CHECK(type IN ('builds_on', 'tensions', 'superseded_by')),
        PRIMARY KEY (source_id, target_id, type)
      );
      CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_id, type);
      CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
    `);
  }

  upsertDocument(doc: DocumentRow): void {
    this.db.prepare(`
      INSERT INTO documents (id, path, title, date, type, status, github_issue, content)
      VALUES (@id, @path, @title, @date, @type, @status, @githubIssue, @content)
      ON CONFLICT(id) DO UPDATE SET
        path = @path, title = @title, date = @date, type = @type,
        status = @status, github_issue = @githubIssue, content = @content
    `).run(doc);
  }

  getDocument(id: string): DocumentRow | undefined {
    return this.db.prepare(
      `SELECT id, path, title, date, type, status, github_issue AS githubIssue, content FROM documents WHERE id = ?`
    ).get(id) as DocumentRow | undefined;
  }

  setTags(docId: string, tags: string[]): void {
    this.db.prepare("DELETE FROM tags WHERE doc_id = ?").run(docId);
    const insert = this.db.prepare("INSERT INTO tags (doc_id, tag) VALUES (?, ?)");
    for (const tag of tags) insert.run(docId, tag);
  }

  getTags(docId: string): string[] {
    return (this.db.prepare("SELECT tag FROM tags WHERE doc_id = ? ORDER BY tag").all(docId) as Array<{ tag: string }>).map(r => r.tag);
  }

  addRelationship(sourceId: string, targetId: string, type: string): void {
    this.db.prepare("INSERT OR IGNORE INTO relationships (source_id, target_id, type) VALUES (?, ?, ?)").run(sourceId, targetId, type);
  }

  getRelationshipsFrom(sourceId: string): RelationshipRow[] {
    return this.db.prepare("SELECT source_id AS sourceId, target_id AS targetId, type FROM relationships WHERE source_id = ?").all(sourceId) as RelationshipRow[];
  }

  getRelationshipsTo(targetId: string): RelationshipRow[] {
    return this.db.prepare("SELECT source_id AS sourceId, target_id AS targetId, type FROM relationships WHERE target_id = ?").all(targetId) as RelationshipRow[];
  }

  clearAll(): void {
    this.db.exec("DELETE FROM relationships; DELETE FROM tags; DELETE FROM documents;");
  }

  close(): void {
    this.db.close();
  }
}
