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
