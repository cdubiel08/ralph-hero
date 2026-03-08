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
});
