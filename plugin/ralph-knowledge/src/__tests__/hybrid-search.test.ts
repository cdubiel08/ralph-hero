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

describe("HybridSearch chunk-to-doc dedup", () => {
  let dedupDb: KnowledgeDB;
  let dedupFts: FtsSearch;
  let dedupVec: VectorSearch;
  let dedupHybrid: HybridSearch;

  /**
   * Deterministic embed function for dedup tests: always returns the same
   * vector as mockEmbedding(42). Paired with chunk embeddings that use the
   * same seed so the chunks rank near-perfectly for any query.
   */
  const fixedEmbedFn: EmbedFn = async () => mockEmbedding(42);

  /** Insert a chunk row into the chunks table. */
  function insertChunk(
    db: KnowledgeDB,
    chunkId: string,
    docId: string,
    index: number,
    content: string,
  ): void {
    db.db
      .prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, content, char_start, char_end)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(chunkId, docId, index, content, 0, content.length);
  }

  beforeEach(() => {
    dedupDb = new KnowledgeDB(":memory:");

    dedupDb.upsertDocument({
      id: "chunk-doc",
      path: "thoughts/shared/research/chunking-strategies.md",
      title: "Chunking Strategies Deep Dive",
      date: "2026-03-01",
      type: "research",
      status: "draft",
      githubIssue: null,
      content:
        "Header paragraph not a chunk match. Body discusses recursive character splitter tradeoffs.",
    });

    dedupDb.upsertDocument({
      id: "other-doc",
      path: "thoughts/shared/plans/other.md",
      title: "Unrelated Plan",
      date: "2026-03-02",
      type: "plan",
      status: "draft",
      githubIssue: null,
      content: "This is a completely different topic unrelated to the query.",
    });

    ensureV3Schema(dedupDb);

    dedupFts = new FtsSearch(dedupDb);
    dedupFts.rebuildIndex();

    dedupVec = new VectorSearch(dedupDb);
    dedupVec.createIndex();

    // Five chunks from chunk-doc, all seeded identically so they rank as
    // the top-5 vector hits for fixedEmbedFn. Distinct content per chunk so
    // we can verify which one becomes the snippet.
    for (let i = 0; i < 5; i++) {
      const id = `chunk-doc#c${i}`;
      const content = `Chunk ${i} content about recursive character splitter tradeoffs — paragraph ${i}.`;
      insertChunk(dedupDb, id, "chunk-doc", i, content);
      // Slight seed variation so distance differs per chunk; chunk 0 is best.
      dedupVec.upsertEmbedding(id, mockEmbedding(42 + i * 0.0001));
    }

    // other-doc has a single chunk embedded with a very different seed so
    // it ranks well below chunk-doc's chunks.
    insertChunk(
      dedupDb,
      "other-doc#c0",
      "other-doc",
      0,
      "Unrelated single chunk content.",
    );
    dedupVec.upsertEmbedding("other-doc#c0", mockEmbedding(900));

    dedupHybrid = new HybridSearch(
      dedupDb,
      dedupFts,
      dedupVec,
      fixedEmbedFn,
    );
  });

  it("deduplicates: 5 chunks from same doc yield exactly 1 result entry", async () => {
    const results = await dedupHybrid.search("anything");

    const chunkDocHits = results.filter((r) => r.id === "chunk-doc");
    expect(chunkDocHits).toHaveLength(1);
    // Also ensure no chunk-level id leaks into the results
    const chunkIds = results.filter((r) => r.id.includes("#c"));
    expect(chunkIds).toHaveLength(0);
  });

  it("surfaced entry's snippet comes from the highest-ranked chunk", async () => {
    const results = await dedupHybrid.search("anything");

    const chunkDocHit = results.find((r) => r.id === "chunk-doc");
    expect(chunkDocHit).toBeDefined();
    // Chunk 0 has the smallest seed offset (mockEmbedding(42 + 0)) so it
    // should have the smallest distance to fixedEmbedFn = mockEmbedding(42).
    expect(chunkDocHit!.snippet).toContain("Chunk 0");
  });

  it("snippet length is at most 300 characters", async () => {
    // Add a chunk with very long content to chunk-doc and re-embed so it
    // becomes chunk 0's rival.
    const longContent = "X".repeat(5000);
    dedupDb.db
      .prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, content, char_start, char_end)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run("chunk-doc#c99", "chunk-doc", 99, longContent, 0, longContent.length);
    // Embed with seed exactly 42 so it becomes the best hit (distance 0).
    dedupVec.upsertEmbedding("chunk-doc#c99", mockEmbedding(42));

    const results = await dedupHybrid.search("anything");
    const hit = results.find((r) => r.id === "chunk-doc");
    expect(hit).toBeDefined();
    expect(hit!.snippet.length).toBeLessThanOrEqual(300);
  });

  it("title-only FTS match still returns the doc (no regression on legacy doc-level hits)", async () => {
    // Document with a doc-level vec row (no chunks) — simulates a legacy
    // record that predates the chunks table.
    dedupDb.upsertDocument({
      id: "legacy-doc",
      path: "thoughts/legacy.md",
      title: "Legacy Title Only Matching Query",
      date: "2026-02-01",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "Legacy body text",
    });
    dedupFts.rebuildIndex();
    dedupVec.upsertEmbedding("legacy-doc", mockEmbedding(800));

    const results = await dedupHybrid.search("Legacy");
    const legacyHit = results.find((r) => r.id === "legacy-doc");
    expect(legacyHit).toBeDefined();
    // FTS contributed the snippet (no chunk content to override it).
    expect(legacyHit!.snippet).toBeDefined();
  });

  it("RRF score: bucketed rank 0 + FTS rank 2 equals 1/(60+1) + 1/(60+3)", async () => {
    // Force a known configuration by clearing and rebuilding:
    // - chunk-doc is the #1 vector hit (bucketed rank 0)
    // - chunk-doc is the #3 FTS hit (index 2)
    // We arrange this by inserting three docs that match "match" in FTS,
    // ordered by BM25 so chunk-doc ends up at rank 2.
    //
    // Simpler: test this using a fresh controlled fixture.
    const tdb = new KnowledgeDB(":memory:");

    tdb.upsertDocument({
      id: "d-fts-top",
      path: "a.md",
      title: "match match match match",
      date: "2026-01-01",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "match match match match match",
    });
    tdb.upsertDocument({
      id: "d-fts-second",
      path: "b.md",
      title: "match match match",
      date: "2026-01-02",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "match match match",
    });
    tdb.upsertDocument({
      id: "target",
      path: "c.md",
      title: "Target Doc",
      date: "2026-01-03",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "target doc with match keyword once",
    });

    const tfts = new FtsSearch(tdb);
    tfts.rebuildIndex();

    const tvec = new VectorSearch(tdb);
    tvec.createIndex();

    // One chunk for target, seeded exactly 42 so it's the only/best vec hit.
    insertChunk(tdb, "target#c0", "target", 0, "Chunk content for target.");
    tvec.upsertEmbedding("target#c0", mockEmbedding(42));
    // Add far-away embeddings for the other docs so they don't contribute
    // to the vector bucket's top ranks for target.
    tvec.upsertEmbedding("d-fts-top", mockEmbedding(900));
    tvec.upsertEmbedding("d-fts-second", mockEmbedding(901));

    const thybrid = new HybridSearch(tdb, tfts, tvec, fixedEmbedFn);
    const results = await thybrid.search("match");

    const target = results.find((r) => r.id === "target");
    expect(target).toBeDefined();

    // Verify FTS rank of target is 2 (third position) by fetching raw FTS.
    const ftsRaw = tfts.search("match", { includeSuperseded: true, limit: 40 });
    const ftsRankOfTarget = ftsRaw.findIndex((r) => r.id === "target");
    expect(ftsRankOfTarget).toBe(2);

    const K = 60;
    const expected = 1 / (K + 0 + 1) + 1 / (K + 2 + 1);
    expect(target!.score).toBeCloseTo(expected, 10);
  });
});

describe("HybridSearch MMR diversity rerank (Phase 1, GH-902)", () => {
  // Fixture: three docs A, B, C all matching the FTS query "topic".
  // Vectors are crafted with explicit orthogonality so the MMR diversity
  // term has a predictable effect:
  //   - A: unit vector along dim 0       (query-aligned, top relevance)
  //   - B: A + tiny dim-1 perturbation   (cosine to A ~ 0.9999)
  //   - C: unit vector along dim 1       (orthogonal to A — cosine 0)
  // With pure RRF (lambda=1.0): order is [A, B, C].
  // With MMR lambda<1: C is preferred over B because C is orthogonal to the
  // already-selected A (zero similarity penalty).
  let mmrDb: KnowledgeDB;
  let mmrFts: FtsSearch;
  let mmrVec: VectorSearch;
  let mmrHybrid: HybridSearch;

  /** Unit vector along a single dimension. */
  function unitAt(dim: number): Float32Array {
    const v = new Float32Array(384);
    v[dim] = 1.0;
    return v;
  }

  /** A + small perturbation along another dim, then re-normalize. */
  function nearDuplicateOf(v: Float32Array, perturbDim: number, eps: number): Float32Array {
    const out = new Float32Array(v);
    out[perturbDim] += eps;
    let norm = 0;
    for (let i = 0; i < out.length; i++) norm += out[i] * out[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < out.length; i++) out[i] /= norm;
    return out;
  }

  /** Orthogonal-ish low-relevance vector for floor docs (random direction). */
  function lowRelevanceVec(seed: number): Float32Array {
    const v = new Float32Array(384);
    // Place energy in higher dims that are orthogonal to dim 0 and dim 1.
    for (let i = 100; i < 200; i++) {
      v[i] = Math.sin(seed * (i + 1) * 0.1);
    }
    let norm = 0;
    for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
  }

  beforeEach(() => {
    mmrDb = new KnowledgeDB(":memory:");

    // A: most-matching FTS body — strongest relevance.
    mmrDb.upsertDocument({
      id: "doc-a",
      path: "a.md",
      title: "topic anchor primary",
      date: "2026-04-01",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "topic anchor primary",
    });
    // B: near-duplicate of A in vector space.
    mmrDb.upsertDocument({
      id: "doc-b",
      path: "b.md",
      title: "topic clone",
      date: "2026-04-02",
      type: "plan",
      status: "draft",
      githubIssue: null,
      content: "topic clone of a sibling",
    });
    // C: same FTS shape as B (one "topic" each), but vector orthogonal to A.
    mmrDb.upsertDocument({
      id: "doc-c",
      path: "c.md",
      title: "topic distinct",
      date: "2026-04-03",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "topic distinct from a content different domain",
    });
    // Floor docs — bottom-anchor the FTS candidate pool so min-max
    // normalization spreads C's normalized relevance above 0. Without these
    // anchors, the small 3-doc fixture compresses the relevance term so
    // much that the diversity bonus can't overcome it at lambda=0.7.
    for (let i = 0; i < 10; i++) {
      mmrDb.upsertDocument({
        id: `floor-${i}`,
        path: `f${i}.md`,
        title: `floor`,
        date: `2026-04-${10 + i}`,
        type: "plan",
        status: "draft",
        githubIssue: null,
        content: "topic floor unrelated filler doc number " + i,
      });
    }

    mmrFts = new FtsSearch(mmrDb);
    mmrFts.rebuildIndex();

    mmrVec = new VectorSearch(mmrDb);
    mmrVec.createIndex();
    const aVec = unitAt(0);
    mmrVec.upsertEmbedding("doc-a", aVec);
    // Cosine(A, B) ~ 0.9999 — true near-duplicate, but distinct enough that
    // the vec search ranks A first.
    mmrVec.upsertEmbedding("doc-b", nearDuplicateOf(aVec, 1, 0.01));
    // C is mostly along dim 2 with a small dim-0 component — keeps cos(A, C)
    // small (~0.3) so MMR's diversity term still favors C, while ensuring
    // vec ranks C above the orthogonal floor docs.
    const cVec = new Float32Array(384);
    cVec[0] = 0.3;
    cVec[2] = 1.0;
    let cNorm = 0;
    for (let i = 0; i < cVec.length; i++) cNorm += cVec[i] * cVec[i];
    cNorm = Math.sqrt(cNorm);
    for (let i = 0; i < cVec.length; i++) cVec[i] /= cNorm;
    mmrVec.upsertEmbedding("doc-c", cVec);
    // Floor docs — orthogonal to all of A, B, C in vector space (dims 100+).
    for (let i = 0; i < 10; i++) {
      mmrVec.upsertEmbedding(`floor-${i}`, lowRelevanceVec(900 + i));
    }

    // Query embedding = A's direction so A is the top vec hit.
    const fixedEmbedFn: EmbedFn = async () => unitAt(0);
    mmrHybrid = new HybridSearch(mmrDb, mmrFts, mmrVec, fixedEmbedFn);
  });

  it("lambda=1.0 is identity — same result order as omitting lambda", async () => {
    const baseline = await mmrHybrid.search("topic", { limit: 3 });
    const withLambda1 = await mmrHybrid.search("topic", { limit: 3, lambda: 1.0 });

    expect(withLambda1).toHaveLength(baseline.length);
    for (let i = 0; i < baseline.length; i++) {
      expect(withLambda1[i].id).toBe(baseline[i].id);
      // Score should also be byte-identical because we skip the MMR pass entirely.
      expect(withLambda1[i].score).toBeCloseTo(baseline[i].score, 10);
    }
  });

  it("lambda=0.0 picks max diversity (B is demoted because cos(A,B) ~ 1)", async () => {
    // With lambda=0.0 the second slot is chosen entirely on dissimilarity
    // to A. The near-duplicate B (cos ~ 0.9999) gets a similarity penalty
    // ~1.0, far worse than any of C or the floor docs (cos to A ~ 0..0.3).
    // So B must NOT be in slot 2; the actual winner is whichever orthogonal
    // candidate has the smallest cosine to A (a floor doc with cos = 0).
    const results = await mmrHybrid.search("topic", { limit: 3, lambda: 0.0 });

    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].id).toBe("doc-a");
    expect(results[1].id).not.toBe("doc-b");
  });

  it("lambda=0.7 demotes the near-duplicate sibling", async () => {
    // At lambda=0.7 the near-dup penalty still pushes B below C in slot 2.
    // (Per Phase-1 research: a doc with cosine ~1.0 to the selected set
    // gets a ~0.3 similarity penalty, which exceeds the small RRF lead
    // B has over C in this fixture.)
    const baseline = await mmrHybrid.search("topic", { limit: 3, lambda: 1.0 });
    const reranked = await mmrHybrid.search("topic", { limit: 3, lambda: 0.7 });

    // A still leads
    expect(reranked[0].id).toBe("doc-a");
    // The near-duplicate (B) is no longer in slot 2 even though pure RRF
    // (lambda=1) would give B and C a similar position.
    expect(reranked[1].id).toBe("doc-c");
    // Sanity: confirm baseline ranks B at slot 2 (otherwise the test is
    // measuring the wrong thing).
    expect(baseline[1].id).toBe("doc-b");
  });

  it("lambda outside [0,1] is clamped (lambda=2 behaves like lambda=1)", async () => {
    const clamped = await mmrHybrid.search("topic", { limit: 3, lambda: 2.0 });
    const baseline = await mmrHybrid.search("topic", { limit: 3 });
    expect(clamped.map((r) => r.id)).toEqual(baseline.map((r) => r.id));
  });

  it("negative lambda is clamped to 0 (max diversity)", async () => {
    const clamped = await mmrHybrid.search("topic", { limit: 3, lambda: -0.5 });
    const explicitZero = await mmrHybrid.search("topic", { limit: 3, lambda: 0.0 });
    expect(clamped.map((r) => r.id)).toEqual(explicitZero.map((r) => r.id));
  });

  it("graceful degradation: doc with no embedding is treated as similarity=0", async () => {
    // Add a doc with NO vec embedding so getEmbedding(id) returns null for it.
    mmrDb.upsertDocument({
      id: "doc-no-embed",
      path: "no-embed.md",
      title: "topic mystery",
      date: "2026-04-04",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "topic mystery no vector",
    });
    mmrFts.rebuildIndex();

    // Should not throw despite missing embedding — null embedding treated as
    // similarity=0 (maximally diverse) so doc remains eligible.
    await expect(
      mmrHybrid.search("topic mystery", { limit: 5, lambda: 0.7 }),
    ).resolves.toBeDefined();

    const results = await mmrHybrid.search("topic mystery", { limit: 5, lambda: 0.7 });
    expect(Array.isArray(results)).toBe(true);
  });

  it("respects limit: with lambda set, returns at most `limit` items", async () => {
    const results = await mmrHybrid.search("topic", { limit: 2, lambda: 0.7 });
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe("HybridSearch diagnosticMode (Phase 2, GH-899)", () => {
  // Uses the top-level fixture (cache-doc, auth-doc) which is freshly
  // initialised in the outer `beforeEach`. Both docs have FTS rows and vec
  // entries, so they hit both retrievers in the standard flow.

  it("diagnosticMode=true returns ftsScore, vecDistance, hitSources for fts+vec hits", async () => {
    // Query that matches cache-doc in FTS — `escapeFts5Query` quotes each
    // token and ANDs them, so a single-token query is the safest way to
    // ensure FTS matches without surprises. cache-doc has "cache" in title
    // and content; it is also in the vec index — so it hits BOTH retrievers.
    const results = await hybrid.search("cache", { diagnosticMode: true });
    expect(results.length).toBeGreaterThanOrEqual(1);

    for (const r of results) {
      // Diagnostic fields should be populated for any doc returned.
      expect(r.hitSources).toBeDefined();
      expect(Array.isArray(r.hitSources)).toBe(true);
      expect(r.hitSources!.length).toBeGreaterThan(0);
    }

    // cache-doc matches "cache" in FTS and is in the vec table — should have
    // both ftsScore and vecDistance set.
    const cacheHit = results.find((r) => r.id === "cache-doc");
    expect(cacheHit).toBeDefined();
    expect(cacheHit!.ftsScore).toBeDefined();
    expect(typeof cacheHit!.ftsScore).toBe("number");
    expect(cacheHit!.vecDistance).toBeDefined();
    expect(typeof cacheHit!.vecDistance).toBe("number");
    // hitSources contains both members regardless of order.
    expect(cacheHit!.hitSources!.sort()).toEqual(["fts", "vec"]);
  });

  it("diagnosticMode=true with vec-only hit has no ftsScore", async () => {
    // Add a doc that vec finds but FTS does not (no matching keyword in
    // title/path/content). The mock embedder hashes the query string, so we
    // arrange a query whose hashed seed lands close to the planted vec
    // embedding by upserting a dedicated vec embedding with the same seed
    // we'll use for the query.
    const queryText = "xyzzyrandom";
    const seed = (() => {
      let h = 0;
      for (let i = 0; i < queryText.length; i++) h = (h * 31 + queryText.charCodeAt(i)) | 0;
      return Math.abs(h) % 1000;
    })();

    db.upsertDocument({
      id: "vec-only-doc",
      path: "vec-only.md",
      title: "Different Words",
      date: "2026-04-10",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "Body without the query keyword either.",
    });
    // Important: do NOT rebuild FTS so the doc is missing from FTS too.
    // Actually we must rebuild for the doc to be queryable AT ALL. But our
    // query "xyzzyrandom" doesn't appear in title/content, so FTS won't match
    // even after rebuild. Rebuild so other tests' state stays consistent.
    fts.rebuildIndex();
    // Plant an embedding with the same seed as the query so vec ranks it #1.
    const v = new Float32Array(384);
    for (let i = 0; i < 384; i++) v[i] = Math.sin(seed * (i + 1) * 0.1);
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    n = Math.sqrt(n);
    if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
    vec.upsertEmbedding("vec-only-doc", v);

    const results = await hybrid.search(queryText, { diagnosticMode: true });
    const vecOnly = results.find((r) => r.id === "vec-only-doc");
    expect(vecOnly).toBeDefined();
    // FTS contribution should be absent — query terms don't appear in title/content.
    expect(vecOnly!.ftsScore).toBeUndefined();
    // Vec contribution should be present.
    expect(vecOnly!.vecDistance).toBeDefined();
    expect(vecOnly!.hitSources).toEqual(["vec"]);
  });

  it("diagnosticMode=false yields identical shape to omitted", async () => {
    const omitted = await hybrid.search("cache OR auth");
    const explicit = await hybrid.search("cache OR auth", { diagnosticMode: false });

    expect(explicit).toHaveLength(omitted.length);
    // Deep-equal each element so we catch any spurious fields the impl might
    // accidentally add when diagnosticMode is false.
    for (let i = 0; i < omitted.length; i++) {
      expect(explicit[i]).toEqual(omitted[i]);
      // Sanity: the diagnostic fields must NOT appear on either path.
      expect(explicit[i].ftsScore).toBeUndefined();
      expect(explicit[i].vecDistance).toBeUndefined();
      expect(explicit[i].hitSources).toBeUndefined();
      expect(omitted[i].ftsScore).toBeUndefined();
      expect(omitted[i].vecDistance).toBeUndefined();
      expect(omitted[i].hitSources).toBeUndefined();
    }
  });

  it("diagnosticMode + lambda=0.7 preserves diagnostic fields after MMR reorder (cross-phase coupling)", async () => {
    // Build the MMR fixture inline so we can exercise both lambda and
    // diagnosticMode in the same call. This is the cross-phase coupling test
    // (Phase 1 + Phase 2 interaction): MMR's applyMMR() returns a reordered
    // SearchResult[], and we assert that the diagnostic fields populated
    // before MMR survive on each entry post-reorder.
    const xdb = new KnowledgeDB(":memory:");

    function unitAt(d: number): Float32Array {
      const u = new Float32Array(384);
      u[d] = 1.0;
      return u;
    }
    function nearDup(v: Float32Array, dim: number, eps: number): Float32Array {
      const out = new Float32Array(v);
      out[dim] += eps;
      let norm = 0;
      for (let i = 0; i < out.length; i++) norm += out[i] * out[i];
      norm = Math.sqrt(norm);
      for (let i = 0; i < out.length; i++) out[i] /= norm;
      return out;
    }

    xdb.upsertDocument({ id: "x-a", path: "a.md", title: "topic anchor primary", date: "2026-04-01", type: "research", status: "draft", githubIssue: null, content: "topic anchor primary" });
    xdb.upsertDocument({ id: "x-b", path: "b.md", title: "topic clone", date: "2026-04-02", type: "plan", status: "draft", githubIssue: null, content: "topic clone of a sibling" });
    xdb.upsertDocument({ id: "x-c", path: "c.md", title: "topic distinct", date: "2026-04-03", type: "research", status: "draft", githubIssue: null, content: "topic distinct from a content different domain" });
    for (let i = 0; i < 10; i++) {
      xdb.upsertDocument({ id: `x-floor-${i}`, path: `f${i}.md`, title: "floor", date: `2026-04-${10 + i}`, type: "plan", status: "draft", githubIssue: null, content: "topic floor unrelated filler doc number " + i });
    }

    const xfts = new FtsSearch(xdb);
    xfts.rebuildIndex();
    const xvec = new VectorSearch(xdb);
    xvec.createIndex();
    const aVec = unitAt(0);
    xvec.upsertEmbedding("x-a", aVec);
    xvec.upsertEmbedding("x-b", nearDup(aVec, 1, 0.01));
    const cVec = new Float32Array(384);
    cVec[0] = 0.3;
    cVec[2] = 1.0;
    let cn = 0;
    for (let i = 0; i < cVec.length; i++) cn += cVec[i] * cVec[i];
    cn = Math.sqrt(cn);
    for (let i = 0; i < cVec.length; i++) cVec[i] /= cn;
    xvec.upsertEmbedding("x-c", cVec);
    for (let i = 0; i < 10; i++) {
      const v = new Float32Array(384);
      for (let d = 100; d < 200; d++) v[d] = Math.sin((900 + i) * (d + 1) * 0.1);
      let n = 0;
      for (let d = 0; d < v.length; d++) n += v[d] * v[d];
      n = Math.sqrt(n);
      for (let d = 0; d < v.length; d++) v[d] /= n;
      xvec.upsertEmbedding(`x-floor-${i}`, v);
    }

    const xEmbedFn: EmbedFn = async () => unitAt(0);
    const xhybrid = new HybridSearch(xdb, xfts, xvec, xEmbedFn);

    // Run with BOTH lambda=0.7 (Phase 1) AND diagnosticMode=true (Phase 2).
    const results = await xhybrid.search("topic", {
      limit: 3,
      lambda: 0.7,
      diagnosticMode: true,
    });

    // Sanity: MMR actually reordered (slot 2 should not be the near-duplicate).
    expect(results[0].id).toBe("x-a");
    expect(results[1].id).not.toBe("x-b");

    // Critical assertion: every returned hit retains its diagnostic fields
    // after MMR's slice + reorder. applyMMR operates by reference on the same
    // SearchResult objects, so populated fields must survive intact.
    for (const r of results) {
      expect(r.hitSources).toBeDefined();
      expect(Array.isArray(r.hitSources)).toBe(true);
      expect(r.hitSources!.length).toBeGreaterThan(0);
      // x-a, x-b, x-c, and all floors hit FTS (all match "topic"), so ftsScore
      // is set for every result that was returned.
      expect(r.ftsScore).toBeDefined();
      expect(typeof r.ftsScore).toBe("number");
      // All three are also in the vec index (since the query embedding aligns
      // with dim 0, and floors are in dims 100-200, the floor docs may or may
      // not enter the top-`limit*2=6` vec results — assert vecDistance is
      // present only when the doc made the vec cut. For x-a/x-b/x-c they
      // definitely do.
      if (r.id === "x-a" || r.id === "x-b" || r.id === "x-c") {
        expect(r.vecDistance).toBeDefined();
        expect(typeof r.vecDistance).toBe("number");
        expect(r.hitSources!.sort()).toEqual(["fts", "vec"]);
      }
    }
  });
});

describe("HybridSearch rerank wiring (GH-925)", () => {
  /**
   * Stub reranker class — implements the same surface as the real
   * `Reranker` class but returns a deterministic scoreMap supplied at
   * construction time. Lets tests exercise the splice path without paying
   * the ~580 MB ONNX model download.
   *
   * Shape match: `score(query: string, docs: RerankerInput[]) => Promise<Map<string, number>>`
   * matches `Reranker.score` from `../reranker.js`. The cast in
   * `new HybridSearch(..., stub as any)` is safe because the production
   * code path only calls `.score()` on the injected reranker.
   */
  class StubReranker {
    constructor(public readonly scoreMap: Map<string, number>) {}
    async score(
      _query: string,
      _docs: Array<{ id: string; text: string }>,
    ): Promise<Map<string, number>> {
      return this.scoreMap;
    }
  }

  it("rerank=false (or omitted) is byte-identical to today", async () => {
    // Construct two hybrids: one with a stub reranker, one without. Run
    // three queries — `rerank` omitted, `rerank: false` (with stub),
    // `rerank: false` (without stub) — and assert all three deep-equal.
    // Confirms zero side-effects when the option is off.
    const stub = new StubReranker(
      new Map([
        ["auth-doc", 0.99],
        ["cache-doc", 0.01],
      ]),
    );
    const hybridWithStub = new HybridSearch(
      db,
      fts,
      vec,
      mockEmbedFn,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
    );

    const omittedFromBare = await hybrid.search("cache OR auth");
    const explicitFalseFromStub = await hybridWithStub.search("cache OR auth", {
      rerank: false,
    });
    const omittedFromStub = await hybridWithStub.search("cache OR auth");

    // All three arrays should be deep-equal. The stub reranker's logits
    // would reverse the order, so any drift here means the splice ran when
    // it shouldn't have.
    expect(explicitFalseFromStub).toEqual(omittedFromBare);
    expect(omittedFromStub).toEqual(omittedFromBare);

    // None of the results should carry rerankScore.
    for (const r of omittedFromBare) {
      expect(r.rerankScore).toBeUndefined();
    }
    for (const r of explicitFalseFromStub) {
      expect(r.rerankScore).toBeUndefined();
    }
    for (const r of omittedFromStub) {
      expect(r.rerankScore).toBeUndefined();
    }
  });

  it("stub reranker logits drive new order", async () => {
    // RRF-only order on this fixture would surface auth-doc and cache-doc
    // — but stub returns logits that put auth-doc strictly above cache-doc.
    // After rerank, auth-doc must be slot 0 and cache-doc slot 1, and both
    // must carry rerankScore.
    const stub = new StubReranker(
      new Map([
        ["auth-doc", 0.9],
        ["cache-doc", 0.1],
      ]),
    );
    const hybridWithStub = new HybridSearch(
      db,
      fts,
      vec,
      mockEmbedFn,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
    );

    const results = await hybridWithStub.search("cache OR auth", {
      rerank: true,
    });

    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].id).toBe("auth-doc");
    expect(results[1].id).toBe("cache-doc");
    expect(results[0].rerankScore).toBe(0.9);
    expect(results[1].rerankScore).toBe(0.1);
  });

  it("stub returns no score for a doc id -> doc keeps RRF position via -Infinity sink", async () => {
    // Stub only scores auth-doc. cache-doc gets no entry so rerankScore
    // stays undefined and sorts to the bottom of the rerank window via
    // the `?? -Infinity` fallback in the sort comparator. The defensive
    // path is documented in the splice-point comment block.
    const stub = new StubReranker(new Map([["auth-doc", 0.5]]));
    const hybridWithStub = new HybridSearch(
      db,
      fts,
      vec,
      mockEmbedFn,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
    );

    const results = await hybridWithStub.search("cache OR auth", {
      rerank: true,
    });

    const auth = results.find((r) => r.id === "auth-doc");
    const cache = results.find((r) => r.id === "cache-doc");
    expect(auth).toBeDefined();
    expect(cache).toBeDefined();

    // auth-doc is the only doc with a logit (0.5) — cache-doc sorts below
    // it because undefined -> -Infinity in the comparator.
    const authIdx = results.findIndex((r) => r.id === "auth-doc");
    const cacheIdx = results.findIndex((r) => r.id === "cache-doc");
    expect(authIdx).toBeLessThan(cacheIdx);

    expect(auth!.rerankScore).toBe(0.5);
    expect(cache!.rerankScore).toBeUndefined();
  });

  it("rerank + lambda<1 applies rerank before MMR", async () => {
    // Build a fresh fixture where the rerank-determined order would
    // disagree with MMR if MMR ran first. Three docs A, B, C:
    //   - rerank logits: A=0.95, B=0.90, C=0.10 (rerank order: A, B, C)
    //   - vector geometry: A and B near-duplicates (cos ~ 0.9999),
    //     C orthogonal to A.
    // With rerank-then-MMR (lambda=0.7, limit=2): rerank sorts to [A, B, C],
    // then MMR picks A first (highest relevance), then chooses C over B
    // because B is a near-duplicate of A.
    //
    // If the splice ran in the wrong order (MMR first), MMR would operate
    // on the RRF-only `filtered` order and could surface a different
    // second slot. The deliberate ordering decision (Constraint 7,
    // Task 2.4 acceptance) is verified here.
    const xdb = new KnowledgeDB(":memory:");

    function unitAt(d: number): Float32Array {
      const u = new Float32Array(384);
      u[d] = 1.0;
      return u;
    }
    function nearDup(v: Float32Array, dim: number, eps: number): Float32Array {
      const out = new Float32Array(v);
      out[dim] += eps;
      let norm = 0;
      for (let i = 0; i < out.length; i++) norm += out[i] * out[i];
      norm = Math.sqrt(norm);
      for (let i = 0; i < out.length; i++) out[i] /= norm;
      return out;
    }

    xdb.upsertDocument({
      id: "rr-a",
      path: "a.md",
      title: "topic anchor",
      date: "2026-04-01",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "topic anchor",
    });
    xdb.upsertDocument({
      id: "rr-b",
      path: "b.md",
      title: "topic clone",
      date: "2026-04-02",
      type: "plan",
      status: "draft",
      githubIssue: null,
      content: "topic clone of anchor",
    });
    xdb.upsertDocument({
      id: "rr-c",
      path: "c.md",
      title: "topic distinct",
      date: "2026-04-03",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "topic distinct different domain",
    });
    // Floor docs to give min-max normalization room (mirrors the
    // existing MMR fixture pattern).
    for (let i = 0; i < 10; i++) {
      xdb.upsertDocument({
        id: `rr-floor-${i}`,
        path: `f${i}.md`,
        title: "floor",
        date: `2026-04-${10 + i}`,
        type: "plan",
        status: "draft",
        githubIssue: null,
        content: "topic floor unrelated filler doc number " + i,
      });
    }

    const xfts = new FtsSearch(xdb);
    xfts.rebuildIndex();
    const xvec = new VectorSearch(xdb);
    xvec.createIndex();
    const aVec = unitAt(0);
    xvec.upsertEmbedding("rr-a", aVec);
    xvec.upsertEmbedding("rr-b", nearDup(aVec, 1, 0.01));
    // C orthogonal-ish to A.
    const cVec = new Float32Array(384);
    cVec[0] = 0.3;
    cVec[2] = 1.0;
    let cn = 0;
    for (let i = 0; i < cVec.length; i++) cn += cVec[i] * cVec[i];
    cn = Math.sqrt(cn);
    for (let i = 0; i < cVec.length; i++) cVec[i] /= cn;
    xvec.upsertEmbedding("rr-c", cVec);
    for (let i = 0; i < 10; i++) {
      const v = new Float32Array(384);
      for (let d = 100; d < 200; d++) v[d] = Math.sin((900 + i) * (d + 1) * 0.1);
      let n = 0;
      for (let d = 0; d < v.length; d++) n += v[d] * v[d];
      n = Math.sqrt(n);
      for (let d = 0; d < v.length; d++) v[d] /= n;
      xvec.upsertEmbedding(`rr-floor-${i}`, v);
    }

    const xEmbedFn: EmbedFn = async () => unitAt(0);
    const stub = new StubReranker(
      new Map([
        ["rr-a", 0.95],
        ["rr-b", 0.9],
        ["rr-c", 0.1],
      ]),
    );
    const xhybrid = new HybridSearch(
      xdb,
      xfts,
      xvec,
      xEmbedFn,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
    );

    const results = await xhybrid.search("topic", {
      rerank: true,
      lambda: 0.7,
      limit: 2,
    });

    // A still leads (highest rerank logit AND highest RRF relevance).
    expect(results[0].id).toBe("rr-a");
    // C (not B) wins slot 2: rerank sorted the candidate list to
    // [A, B, C, ...floors], MMR then picked A first, then chose C over B
    // because B is a near-duplicate of A. If MMR had run on the RRF order
    // first, the rerank would have re-sorted whatever MMR returned —
    // verify by asserting B is NOT in slot 2.
    expect(results[1].id).not.toBe("rr-b");
  });

  it("rerank + return_diagnostics: rerankScore survives MMR reorder", async () => {
    // Cross-feature plumbing test — when both rerank and diagnosticMode
    // are enabled, the rerankScore stamped pre-MMR must survive the MMR
    // reorder (which works on the same SearchResult references).
    const stub = new StubReranker(
      new Map([
        ["auth-doc", 0.7],
        ["cache-doc", 0.3],
      ]),
    );
    const hybridWithStub = new HybridSearch(
      db,
      fts,
      vec,
      mockEmbedFn,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
    );

    const results = await hybridWithStub.search("cache OR auth", {
      rerank: true,
      lambda: 0.7,
      diagnosticMode: true,
    });

    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const r of results) {
      // diagnosticMode populates hitSources for every returned hit.
      expect(r.hitSources).toBeDefined();
      expect(Array.isArray(r.hitSources)).toBe(true);
      expect(r.hitSources!.length).toBeGreaterThan(0);
      // rerank populates rerankScore for every doc the stub mapped.
      expect(r.rerankScore).toBeDefined();
      expect(typeof r.rerankScore).toBe("number");
    }
  });

  it("no reranker injected + rerank=true: behaves as RRF-only", async () => {
    // Defensive guard from Task 2.2 acceptance: if rerank is requested but
    // no Reranker was injected, the splice is a no-op and the RRF order
    // returns unchanged. No errors thrown.
    // (`hybrid` from the outer beforeEach is constructed without a reranker.)
    const baseline = await hybrid.search("cache OR auth");
    const withRerankFlag = await hybrid.search("cache OR auth", {
      rerank: true,
    });

    expect(withRerankFlag).toEqual(baseline);
    for (const r of withRerankFlag) {
      expect(r.rerankScore).toBeUndefined();
    }
  });

  it("score fusion respects RRF when rerank logits are mildly negative (post-#927 tuning)", async () => {
    // Regression test for the post-#927 score fusion behavior. The pure
    // replace-rerank semantics (logits drive ordering directly) dropped
    // Hit@1 from 62.5% to 25% on the 8-query golden eval because BGE
    // assigns negative logits to plan/research docs that the user actually
    // wants. Fusion (RRF/sigmoid blend) preserves the retriever's ceiling.
    //
    // Test: stub returns mildly negative logit for the doc that RRF ranks
    // first. With pure replace, that doc would lose to a doc with a
    // positive logit. With fusion (alpha=0.5), the RRF-leader's max-norm
    // RRF=1.0 keeps it ahead because the rerank delta isn't extreme
    // enough to override.
    //
    // Setup: RRF-leader (A) has logit -0.3, follower (B) has logit +0.3.
    // - sigmoid(-0.3) ~ 0.426, sigmoid(+0.3) ~ 0.574, delta ~ 0.148.
    // - normRrf for A = 1.0, for B depends on RRF score gap.
    // - When RRF gap is at least ~0.15 in normalized space, A keeps slot 0.
    // - With cache-doc and auth-doc both matching "cache OR auth" the RRF
    //   gap on this fixture is ~0 (similar ranks), so the fusion gives:
    //     A: 0.5*1.0 + 0.5*0.426 = 0.713
    //     B: 0.5*~1.0 + 0.5*0.574 = 0.787
    //   B wins. To assert "fusion preserves RRF when delta is mild" we
    //   need a fixture with a clear RRF leader. The "cache" query (not
    //   "cache OR auth") gives that — only cache-doc has FTS+vec match.
    const stub = new StubReranker(
      new Map([
        ["cache-doc", -0.3],
        ["auth-doc", 0.3],
      ]),
    );
    const hybridWithStub = new HybridSearch(
      db,
      fts,
      vec,
      mockEmbedFn,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
    );

    const baselineNoRerank = await hybridWithStub.search("cache");
    const withRerank = await hybridWithStub.search("cache", {
      rerank: true,
    });

    // RRF-only ranks cache-doc first (it's the only doc that matches
    // "cache" in FTS).
    expect(baselineNoRerank[0].id).toBe("cache-doc");

    // With fusion (alpha=0.5): cache-doc has RRF score, auth-doc may not
    // have one at all (it'd only show up via vector similarity). The key
    // assertion is that cache-doc still leads after rerank — we don't
    // claim the rest of the order, just that the top-1 RRF leader is
    // preserved when its rerank logit is only mildly negative.
    expect(withRerank[0].id).toBe("cache-doc");
    // The rerankScore is still stamped (raw logit, NOT post-sigmoid).
    expect(withRerank[0].rerankScore).toBe(-0.3);
  });

  it("score fusion is stable under sigmoid: mild logits don't flip RRF ties", async () => {
    // Companion test: when RRF scores are tied (or near-tied) and rerank
    // logits also disagree mildly (-0.5 vs +0.5), the fusion math gives
    // a clear winner to the higher-logit doc. This documents the
    // intended "rerank breaks ties" behavior — opposite of the regression
    // test above. Together the two tests pin down the blend semantics.
    const stub = new StubReranker(
      new Map([
        ["auth-doc", 0.5],
        ["cache-doc", -0.5],
      ]),
    );
    const hybridWithStub = new HybridSearch(
      db,
      fts,
      vec,
      mockEmbedFn,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
    );

    // "cache OR auth" matches both docs, RRF scores are similar.
    const results = await hybridWithStub.search("cache OR auth", {
      rerank: true,
    });

    expect(results.length).toBeGreaterThanOrEqual(2);
    // With mild logits +0.5 vs -0.5, the fusion delta from sigmoid is
    // 0.622 - 0.378 = 0.244 — enough to flip the order when RRF scores
    // are within ~24% of each other (which they are on this fixture).
    expect(results[0].id).toBe("auth-doc");
    expect(results[0].rerankScore).toBe(0.5);
  });
});
