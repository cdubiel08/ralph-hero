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

/**
 * Ensure the v3 schema extensions (memory_tier column, chunks table) exist.
 * Phase 1 (GH-762) owns the production migration; tests add them so Phase 8
 * features can be exercised independently of Phase 1's merge order.
 */
function ensureV3Schema(targetDb: KnowledgeDB): void {
  const rows = targetDb.db
    .prepare("PRAGMA table_info(documents)")
    .all() as Array<{ name: string }>;
  if (!rows.some((r) => r.name === "memory_tier")) {
    targetDb.db.exec(
      "ALTER TABLE documents ADD COLUMN memory_tier TEXT NOT NULL DEFAULT 'doc' CHECK(memory_tier IN ('doc','raw','reflection'))",
    );
  }
  targetDb.db.exec(
    `CREATE TABLE IF NOT EXISTS chunks (
       id TEXT PRIMARY KEY,
       document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
       chunk_index INTEGER NOT NULL,
       content TEXT NOT NULL,
       char_start INTEGER NOT NULL,
       char_end INTEGER NOT NULL,
       context_prefix TEXT NOT NULL DEFAULT '',
       UNIQUE(document_id, chunk_index)
     )`,
  );
}

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

describe("HybridSearch memory_tier filter", () => {
  it("filters to reflection when memoryTier='reflection'", async () => {
    // Rebuild fixture with memory_tier column populated
    ensureV3Schema(db);
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("doc", "cache-doc");
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("reflection", "auth-doc");
    // FTS must be rebuilt to pick up the new column for its JOIN
    fts.rebuildIndex();

    const results = await hybrid.search("cache OR auth", { memoryTier: "reflection" });
    const ids = results.map((r) => r.id);
    expect(ids).toContain("auth-doc");
    expect(ids).not.toContain("cache-doc");
  });

  it("returns all tiers when memoryTier='any' (default)", async () => {
    ensureV3Schema(db);
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("raw", "cache-doc");
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("reflection", "auth-doc");
    fts.rebuildIndex();

    const results = await hybrid.search("cache OR auth", { memoryTier: "any" });
    const ids = results.map((r) => r.id);
    expect(ids).toContain("cache-doc");
    expect(ids).toContain("auth-doc");
  });

  it("passes silently on v2 DB where memory_tier column is absent", async () => {
    // Do NOT call ensureV3Schema — simulate v2 schema.
    const results = await hybrid.search("cache", { memoryTier: "reflection" });
    // Schema has no tier info; filter treats all docs as 'doc', so reflection
    // filter drops everything on a v2 DB — no error thrown.
    expect(Array.isArray(results)).toBe(true);
  });
});

describe("HybridSearch chunk metadata enrichment", () => {
  it("populates bestChunkId + chunk meta when vec returns chunk ids", async () => {
    ensureV3Schema(db);

    // Seed a chunk row for cache-doc and mirror its id in the vec table
    db.db
      .prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, content, char_start, char_end, context_prefix)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "cache-doc#c0",
        "cache-doc",
        0,
        "Analysis of cache invalidation patterns...",
        0,
        40,
        "Research: cache-invalidation context.",
      );
    // Replace the doc-level vec entry with a chunk-level one.
    vec.deleteEmbedding("cache-doc");
    vec.upsertEmbedding("cache-doc#c0", mockEmbedding(1));

    const results = await hybrid.search("cache");
    const hit = results.find((r) => r.id === "cache-doc");
    expect(hit).toBeDefined();
    expect(hit!.bestChunkId).toBe("cache-doc#c0");
    expect(hit!.chunkIndex).toBe(0);
    expect(hit!.charStart).toBe(0);
    expect(hit!.charEnd).toBe(40);
    expect(hit!.contextPrefix).toBe("Research: cache-invalidation context.");
  });

  it("does not populate chunk meta when vec returns doc-level ids", async () => {
    // Fixture as-is: vec stores doc ids, not chunk ids.
    const results = await hybrid.search("cache");
    const hit = results.find((r) => r.id === "cache-doc");
    expect(hit).toBeDefined();
    expect(hit!.bestChunkId).toBeUndefined();
    expect(hit!.chunkIndex).toBeUndefined();
  });
});
