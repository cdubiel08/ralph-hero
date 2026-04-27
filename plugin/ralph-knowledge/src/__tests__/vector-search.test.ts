import { describe, it, expect, beforeEach } from "vitest";
import { KnowledgeDB } from "../db.js";
import { VectorSearch } from "../vector-search.js";

let db: KnowledgeDB;
let vecSearch: VectorSearch;

function mockEmbedding(seed: number): Float32Array {
  const vec = new Float32Array(384);
  // Place energy in different dimensions per seed to ensure distinct directions
  for (let i = 0; i < 384; i++) {
    vec[i] = Math.sin(seed * (i + 1) * 0.1);
  }
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

beforeEach(() => {
  db = new KnowledgeDB(":memory:");
  vecSearch = new VectorSearch(db);
  vecSearch.createIndex();
  db.upsertDocument({
    id: "doc-1",
    path: "p1",
    title: "Cache Strategy",
    date: "2026-03-08",
    type: "research",
    status: "draft",
    githubIssue: 100,
    content: "caching",
  });
  db.upsertDocument({
    id: "doc-2",
    path: "p2",
    title: "Auth Tokens",
    date: "2026-03-07",
    type: "plan",
    status: "draft",
    githubIssue: 200,
    content: "auth",
  });
  vecSearch.upsertEmbedding("doc-1", mockEmbedding(1));
  vecSearch.upsertEmbedding("doc-2", mockEmbedding(5));
});

describe("VectorSearch", () => {
  it("finds nearest document by vector similarity", () => {
    const results = vecSearch.search(mockEmbedding(1), 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe("doc-1");
  });

  it("returns distance scores", () => {
    const results = vecSearch.search(mockEmbedding(1), 5);
    expect(typeof results[0].distance).toBe("number");
    expect(results[0].distance).toBeLessThan(results[1].distance);
  });

  it("respects limit", () => {
    const results = vecSearch.search(mockEmbedding(1), 1);
    expect(results).toHaveLength(1);
  });

  it("returns content = null when vec id has no matching chunks row (back-compat)", () => {
    // doc-1 has no chunks row; vec id is doc-level. LEFT JOIN should yield null.
    const results = vecSearch.search(mockEmbedding(1), 5);
    const hit = results.find((r) => r.id === "doc-1");
    expect(hit).toBeDefined();
    expect(hit!.content).toBeNull();
  });

  it("returns content populated when vec id matches a chunks row", () => {
    // Insert a chunk-level vec row + matching chunks row for doc-1
    db.db
      .prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, content, char_start, char_end)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run("doc-1#c0", "doc-1", 0, "This is the first chunk content.", 0, 32);
    vecSearch.upsertEmbedding("doc-1#c0", mockEmbedding(1));
    // Remove the doc-level vec row so chunk-level wins
    vecSearch.deleteEmbedding("doc-1");

    const results = vecSearch.search(mockEmbedding(1), 5);
    const hit = results.find((r) => r.id === "doc-1#c0");
    expect(hit).toBeDefined();
    expect(hit!.content).toBe("This is the first chunk content.");
  });
});

describe("VectorSearch.getEmbedding (POINT query)", () => {
  // Phase 1 (GH-902): MMR diversity rerank needs to fetch raw embeddings for
  // candidate docs to compute doc-doc cosine similarity. POINT lookup on the
  // TEXT primary key — sqlite-vec may FULLSCAN, but correctness is invariant.
  it("returns the exact 384-dim Float32Array that was upserted", () => {
    const input = mockEmbedding(7);
    vecSearch.upsertEmbedding("doc-1", input);

    const result = vecSearch.getEmbedding("doc-1");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(384);
    // Bit-equal contents — every dimension must match the input
    for (let i = 0; i < 384; i++) {
      expect(result![i]).toBeCloseTo(input[i], 6);
    }
  });

  it("returns null for unknown id (no throw)", () => {
    const result = vecSearch.getEmbedding("does-not-exist");
    expect(result).toBeNull();
  });

  it("returns the chunk-level embedding when the id is a chunk id", () => {
    const chunkEmbedding = mockEmbedding(13);
    db.db
      .prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, content, char_start, char_end)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("doc-1#c0", "doc-1", 0, "Chunk content", 0, 13);
    vecSearch.upsertEmbedding("doc-1#c0", chunkEmbedding);

    const result = vecSearch.getEmbedding("doc-1#c0");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(384);
    for (let i = 0; i < 384; i++) {
      expect(result![i]).toBeCloseTo(chunkEmbedding[i], 6);
    }
  });
});
