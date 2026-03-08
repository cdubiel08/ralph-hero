import { describe, it, expect, beforeEach } from "vitest";
import { KnowledgeDB } from "../db.js";
import { FtsSearch } from "../search.js";
import { VectorSearch } from "../vector-search.js";
import { HybridSearch, type EmbedFn } from "../hybrid-search.js";

let db: KnowledgeDB;
let fts: FtsSearch;
let vec: VectorSearch;
let hybrid: HybridSearch;

function mockEmbedding(seed: number): Float32Array {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    v[i] = Math.sin(seed * (i + 1) * 0.1);
  }
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/** Simple hash of a string to a numeric seed for deterministic mock embeddings. */
function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 1000;
}

const mockEmbedFn: EmbedFn = async (text: string) =>
  mockEmbedding(hashSeed(text));

beforeEach(() => {
  db = new KnowledgeDB(":memory:");

  db.upsertDocument({
    id: "cache-doc",
    path: "thoughts/shared/research/cache-strategies.md",
    title: "Cache Invalidation Strategies",
    date: "2026-03-01",
    type: "research",
    status: "draft",
    githubIssue: null,
    content:
      "Analysis of cache invalidation patterns including TTL, event-driven, and write-through approaches.",
  });
  db.setTags("cache-doc", ["caching", "performance"]);

  db.upsertDocument({
    id: "auth-doc",
    path: "thoughts/shared/plans/auth-redesign.md",
    title: "Auth Redesign Plan",
    date: "2026-03-02",
    type: "plan",
    status: "approved",
    githubIssue: 42,
    content:
      "Redesign authentication to use OAuth2 with PKCE flow for improved security.",
  });
  db.setTags("auth-doc", ["auth", "security"]);

  fts = new FtsSearch(db);
  fts.rebuildIndex();

  vec = new VectorSearch(db);
  vec.createIndex();
  vec.upsertEmbedding("cache-doc", mockEmbedding(1));
  vec.upsertEmbedding("auth-doc", mockEmbedding(5));

  hybrid = new HybridSearch(db, fts, vec, mockEmbedFn);
});

describe("HybridSearch", () => {
  it("returns results combining FTS and vector scores", async () => {
    const results = await hybrid.search("cache");

    expect(results.length).toBeGreaterThanOrEqual(1);
    // cache-doc should appear since it matches "cache" in FTS and also has a vector entry
    const cacheResult = results.find((r) => r.id === "cache-doc");
    expect(cacheResult).toBeDefined();
    // RRF score should be positive
    expect(cacheResult!.score).toBeGreaterThan(0);

    // Results should be sorted descending by score
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("passes through type filter", async () => {
    const results = await hybrid.search("cache", { type: "plan" });

    // cache-doc is type=research, so it should be excluded
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain("cache-doc");
  });

  it("passes through tag filter", async () => {
    const results = await hybrid.search("cache OR auth", {
      tags: ["security"],
    });

    // Only auth-doc has the "security" tag
    expect(results.length).toBeGreaterThanOrEqual(1);
    const ids = results.map((r) => r.id);
    expect(ids).toContain("auth-doc");
    expect(ids).not.toContain("cache-doc");
  });
});
