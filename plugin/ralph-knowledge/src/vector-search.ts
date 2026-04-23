import * as sqliteVec from "sqlite-vec";
import type { KnowledgeDB } from "./db.js";

export interface VectorResult {
  id: string;
  distance: number;
}

function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export class VectorSearch {
  private vecLoaded = false;

  constructor(private knowledgeDb: KnowledgeDB) {}

  private ensureVecLoaded(): void {
    if (!this.vecLoaded) {
      sqliteVec.load(this.knowledgeDb.db);
      this.vecLoaded = true;
    }
  }

  createIndex(): void {
    this.ensureVecLoaded();
    this.knowledgeDb.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[384] distance_metric=cosine
      )
    `);
  }

  dropIndex(): void {
    this.knowledgeDb.db.exec("DROP TABLE IF EXISTS documents_vec");
  }

  upsertEmbedding(id: string, embedding: Float32Array): void {
    this.ensureVecLoaded();
    const buf = float32ToBuffer(embedding);
    this.knowledgeDb.db
      .prepare("DELETE FROM documents_vec WHERE id = ?")
      .run(id);
    this.knowledgeDb.db
      .prepare("INSERT INTO documents_vec (id, embedding) VALUES (?, ?)")
      .run(id, buf);
  }

  deleteEmbedding(id: string): void {
    this.ensureVecLoaded();
    this.knowledgeDb.db
      .prepare("DELETE FROM documents_vec WHERE id = ?")
      .run(id);
  }

  /**
   * Delete all chunk-level vec rows for a document. Chunk ids follow the
   * pattern `${docId}#c${index}` so we match via a SQLite GLOB.
   *
   * This is used by reindex to drop stale chunks when a source markdown file
   * has been deleted or modified. Complements `ON DELETE CASCADE` on the
   * `chunks` table (which deletes chunk rows but not their vec counterparts,
   * because the vec0 virtual table does not participate in FK cascades).
   */
  deleteChunkVecsByDoc(docId: string): void {
    this.ensureVecLoaded();
    this.knowledgeDb.db
      .prepare("DELETE FROM documents_vec WHERE id GLOB ?")
      .run(`${docId}#c*`);
  }

  search(queryEmbedding: Float32Array, limit: number = 10): VectorResult[] {
    this.ensureVecLoaded();
    const buf = float32ToBuffer(queryEmbedding);
    return this.knowledgeDb.db
      .prepare(
        `
      SELECT id, distance
      FROM documents_vec
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `
      )
      .all(buf, limit) as VectorResult[];
  }
}
