import * as sqliteVec from "sqlite-vec";
import type { KnowledgeDB } from "./db.js";

export interface VectorResult {
  id: string;
  distance: number;
  /**
   * Chunk content populated via LEFT JOIN to `chunks` table when the vec id
   * matches a chunk row. When the vec id is doc-level (back-compat / legacy
   * fixtures) or no matching chunks row exists, this is `null`.
   */
  content?: string | null;
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
    // LEFT JOIN to `chunks` so chunk-level vec rows surface their content.
    // Doc-level vec ids (no matching chunks row) return content = NULL, which
    // preserves back-compat for pre-chunks callers and legacy test fixtures.
    return this.knowledgeDb.db
      .prepare(
        `
      SELECT documents_vec.id, distance, chunks.content
      FROM documents_vec
      LEFT JOIN chunks ON chunks.id = documents_vec.id
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `
      )
      .all(buf, limit) as VectorResult[];
  }

  /**
   * Fetch the raw embedding for a single id via a POINT lookup on the TEXT
   * primary key. Returns null when no row exists (no throw).
   *
   * Used by Phase 1 (GH-902) MMR diversity rerank to compute doc-doc cosine
   * similarity over the candidate set without re-running the KNN MATCH path.
   *
   * Note: sqlite-vec's vec0 virtual table may FULLSCAN on a TEXT primary-key
   * point lookup in some versions (per Phase-1 research risk #1). Correctness
   * is independent of plan choice — if profiling shows hot-path cost on large
   * candidate sets, fall back to a plain SQLite cache table keyed by id.
   */
  getEmbedding(id: string): Float32Array | null {
    this.ensureVecLoaded();
    const row = this.knowledgeDb.db
      .prepare("SELECT embedding FROM documents_vec WHERE id = ?")
      .get(id) as { embedding: Buffer } | undefined;
    if (!row) return null;
    const buf = row.embedding;
    // Slice the underlying ArrayBuffer to the embedding's byte range so the
    // returned Float32Array is independent of the SQLite row buffer.
    return new Float32Array(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    );
  }
}
