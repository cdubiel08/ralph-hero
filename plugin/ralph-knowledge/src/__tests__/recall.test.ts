import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KnowledgeDB } from "../db.js";

/**
 * Phase 2 (GH-1204) tests for the `knowledge_recall` MCP tool.
 *
 * Verifies the role-to-tier policy fans out one hybrid.search call per tier,
 * merges and re-ranks results, dedups by id, and surfaces the same payload
 * shape as `knowledge_search`. Uses stubs to avoid the ONNX model download
 * (mirrors `index.test.ts`).
 */

function mockEmbedding(seed: number): Float32Array {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) v[i] = Math.sin(seed * (i + 1) * 0.1);
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 1000;
}

const mockEmbedFn = async (text: string) => mockEmbedding(hashSeed(text));

async function callTool(
  toolServer: McpServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const registeredTools = (toolServer as unknown as Record<string, unknown>)
    ._registeredTools as Record<
    string,
    { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
  >;
  const tool = registeredTools?.[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool.handler(args, {}) as Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

/**
 * Ensure v3 schema (memory_tier column + chunks table) on the test DB. Mirrors
 * the helper in index.test.ts.
 */
function ensureV3Schema(db: KnowledgeDB): void {
  const rows = db.db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>;
  if (!rows.some((r) => r.name === "memory_tier")) {
    db.db.exec(
      "ALTER TABLE documents ADD COLUMN memory_tier TEXT NOT NULL DEFAULT 'doc' CHECK(memory_tier IN ('doc','raw','reflection','wiki'))",
    );
  }
  db.db.exec(
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
  db.db.exec(
    "CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id)",
  );
}

/**
 * Stub Reranker — matches the public surface of `Reranker.score()` but returns
 * a fixed score map. The recall tool sets `rerank: true` internally, so wiring
 * a stub avoids the ~580 MB ONNX model download (same pattern as `index.test.ts`).
 */
class StubReranker {
  constructor(public readonly scoreMap: Map<string, number>) {}
  async score(
    _query: string,
    docs: Array<{ id: string; text: string }>,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const d of docs) {
      if (this.scoreMap.has(d.id)) out.set(d.id, this.scoreMap.get(d.id)!);
    }
    return out;
  }
}

describe("knowledge_recall tool registration", () => {
  it("registers knowledge_recall alongside knowledge_search", async () => {
    const mod = await import("../index.js");
    const { server } = mod.createServer(":memory:");
    const registered = (server as unknown as Record<string, unknown>)
      ._registeredTools as Record<string, unknown>;
    expect(registered).toHaveProperty("knowledge_recall");
    expect(registered).toHaveProperty("knowledge_search"); // sibling still exists
  });

  it("knowledge_recall schema requires query + role; accepts optional limit/type/tags", async () => {
    const mod = await import("../index.js");
    const { server } = mod.createServer(":memory:");
    const registered = (server as unknown as Record<string, unknown>)
      ._registeredTools as Record<string, { inputSchema?: { parse: (v: unknown) => unknown } }>;
    const schema = registered.knowledge_recall?.inputSchema;
    expect(schema).toBeDefined();

    // Valid minimum: query + role.
    expect(() => schema!.parse({ query: "hello", role: "researcher" })).not.toThrow();
    // All five roles accepted.
    for (const role of ["researcher", "planner", "implementer", "reviewer", "triager"]) {
      expect(() => schema!.parse({ query: "x", role })).not.toThrow();
    }
    // Invalid role rejected.
    expect(() => schema!.parse({ query: "x", role: "philosopher" })).toThrow();
    // role is required.
    expect(() => schema!.parse({ query: "x" })).toThrow();
    // Optionals accepted.
    expect(() =>
      schema!.parse({
        query: "x",
        role: "planner",
        limit: 5,
        type: "research",
        tags: ["alpha"],
        includeSuperseded: true,
        brief: true,
      }),
    ).not.toThrow();
  });
});

describe("knowledge_recall role-tier policy fan-out", () => {
  /**
   * Builds a server whose `HybridSearch` is replaced with a spy that records
   * each `search` invocation's `memoryTier`. We achieve this by hooking the
   * server's tool registration but keeping the real `createServer` — instead
   * of mocking the entire module, we seed the DB with tier-labeled docs and
   * inspect which tiers the returned results came from.
   */
  async function seedThreeTierCorpus(): Promise<{
    server: McpServer;
    db: KnowledgeDB;
  }> {
    const mod = await import("../index.js");
    const { server, db, fts, vec } = mod.createServer(":memory:", {
      embedFn: mockEmbedFn,
      // Stub reranker — recall always passes rerank=true; the stub returns
      // a fixed score map per id so we can predict ordering.
      rerankerFactory: () =>
        new StubReranker(
          new Map([
            ["doc-1", 2.0],
            ["raw-1", 3.0],
            ["reflect-1", 1.0],
            ["wiki-1", 0.5],
          ]),
        ) as unknown as import("../reranker.js").Reranker,
    });
    ensureV3Schema(db);

    // One doc per tier so we can prove which tiers a role retrieved from.
    db.upsertDocument({
      id: "doc-1",
      path: "doc-1.md",
      title: "Curated Doc",
      date: "2026-04-01",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "Curated document about retrieval orchestration policies.",
    });
    db.upsertDocument({
      id: "raw-1",
      path: "raw-1.md",
      title: "Raw Memory",
      date: "2026-04-02",
      type: null,
      status: null,
      githubIssue: null,
      content: "Raw ingest note about retrieval orchestration policies.",
    });
    db.upsertDocument({
      id: "reflect-1",
      path: "reflect-1.md",
      title: "Reflection",
      date: "2026-04-03",
      type: null,
      status: null,
      githubIssue: null,
      content: "Synthesized reflection on retrieval orchestration policies.",
    });
    db.upsertDocument({
      id: "wiki-1",
      path: "wiki-1.md",
      title: "Wiki Entry",
      date: "2026-04-04",
      type: null,
      status: null,
      githubIssue: null,
      content: "Wiki-tier curated note on retrieval orchestration policies.",
    });
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("doc", "doc-1");
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("raw", "raw-1");
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("reflection", "reflect-1");
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("wiki", "wiki-1");
    fts.rebuildIndex();

    vec.createIndex();
    const qEmb = await mockEmbedFn("retrieval orchestration policies");
    vec.upsertEmbedding("doc-1", qEmb);
    vec.upsertEmbedding("raw-1", qEmb);
    vec.upsertEmbedding("reflect-1", qEmb);
    vec.upsertEmbedding("wiki-1", qEmb);

    return { server, db };
  }

  it("role='researcher' surfaces raw + reflection + doc, never wiki", async () => {
    const { server } = await seedThreeTierCorpus();
    const result = await callTool(server, "knowledge_recall", {
      query: "retrieval orchestration policies",
      role: "researcher",
      limit: 10,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Array<{ id: string }>;
    const ids = payload.map((r) => r.id);
    expect(ids).toContain("raw-1");
    expect(ids).toContain("reflect-1");
    expect(ids).toContain("doc-1");
    expect(ids).not.toContain("wiki-1");
  });

  it("role='planner' surfaces reflection + wiki + doc, never raw", async () => {
    const { server } = await seedThreeTierCorpus();
    const result = await callTool(server, "knowledge_recall", {
      query: "retrieval orchestration policies",
      role: "planner",
      limit: 10,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Array<{ id: string }>;
    const ids = payload.map((r) => r.id);
    expect(ids).toContain("reflect-1");
    expect(ids).toContain("wiki-1");
    expect(ids).toContain("doc-1");
    expect(ids).not.toContain("raw-1");
  });

  it("role='implementer' surfaces only wiki + doc — no raw leak", async () => {
    const { server } = await seedThreeTierCorpus();
    const result = await callTool(server, "knowledge_recall", {
      query: "retrieval orchestration policies",
      role: "implementer",
      limit: 10,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Array<{ id: string }>;
    const ids = payload.map((r) => r.id);
    expect(ids).toContain("wiki-1");
    expect(ids).toContain("doc-1");
    expect(ids).not.toContain("raw-1");
    expect(ids).not.toContain("reflect-1");
  });

  it("role='reviewer' surfaces only wiki + doc — no raw or reflection leak", async () => {
    const { server } = await seedThreeTierCorpus();
    const result = await callTool(server, "knowledge_recall", {
      query: "retrieval orchestration policies",
      role: "reviewer",
      limit: 10,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Array<{ id: string }>;
    const ids = payload.map((r) => r.id);
    expect(ids).toContain("wiki-1");
    expect(ids).toContain("doc-1");
    expect(ids).not.toContain("raw-1");
    expect(ids).not.toContain("reflect-1");
  });

  it("role='triager' surfaces only doc + wiki — no raw or reflection leak", async () => {
    const { server } = await seedThreeTierCorpus();
    const result = await callTool(server, "knowledge_recall", {
      query: "retrieval orchestration policies",
      role: "triager",
      limit: 10,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Array<{ id: string }>;
    const ids = payload.map((r) => r.id);
    expect(ids).toContain("doc-1");
    expect(ids).toContain("wiki-1");
    expect(ids).not.toContain("raw-1");
    expect(ids).not.toContain("reflect-1");
  });
});

describe("knowledge_recall merge + dedup behavior", () => {
  it("dedups by id when the same doc appears in multiple tier sub-queries", async () => {
    // Seed a single reflection doc and confirm the planner role (which spans
    // reflection + wiki + doc) returns it exactly once. Even though
    // hybrid.search is called three times, the merge layer dedups.
    const mod = await import("../index.js");
    const { server, db, fts, vec } = mod.createServer(":memory:", {
      embedFn: mockEmbedFn,
      rerankerFactory: () =>
        new StubReranker(new Map([["only-reflect", 5.0]])) as unknown as import("../reranker.js").Reranker,
    });
    ensureV3Schema(db);

    db.upsertDocument({
      id: "only-reflect",
      path: "only-reflect.md",
      title: "Sole Reflection",
      date: "2026-05-01",
      type: null,
      status: null,
      githubIssue: null,
      content: "The only reflection in this fixture about idempotent merges.",
    });
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("reflection", "only-reflect");
    fts.rebuildIndex();
    vec.createIndex();
    vec.upsertEmbedding("only-reflect", await mockEmbedFn("idempotent merges"));

    const result = await callTool(server, "knowledge_recall", {
      query: "idempotent merges",
      role: "planner",
      limit: 10,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Array<{ id: string }>;
    const matches = payload.filter((r) => r.id === "only-reflect");
    expect(matches.length).toBe(1);
  });

  it("respects the `limit` parameter after merging across tiers", async () => {
    const mod = await import("../index.js");
    const { server, db, fts, vec } = mod.createServer(":memory:", {
      embedFn: mockEmbedFn,
      rerankerFactory: () =>
        new StubReranker(
          new Map([
            ["limit-doc-1", 5.0],
            ["limit-doc-2", 4.0],
            ["limit-doc-3", 3.0],
            ["limit-doc-4", 2.0],
          ]),
        ) as unknown as import("../reranker.js").Reranker,
    });
    ensureV3Schema(db);

    for (let i = 1; i <= 4; i++) {
      db.upsertDocument({
        id: `limit-doc-${i}`,
        path: `limit-doc-${i}.md`,
        title: `Curated Limit Doc ${i}`,
        date: `2026-05-0${i}`,
        type: "research",
        status: "draft",
        githubIssue: null,
        content: "Curated limit doc about consolidated reranking checkpoints.",
      });
      db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("doc", `limit-doc-${i}`);
    }
    fts.rebuildIndex();
    vec.createIndex();
    const qEmb = await mockEmbedFn("consolidated reranking checkpoints");
    for (let i = 1; i <= 4; i++) {
      vec.upsertEmbedding(`limit-doc-${i}`, qEmb);
    }

    const result = await callTool(server, "knowledge_recall", {
      query: "consolidated reranking checkpoints",
      role: "triager", // policy: [doc, wiki]
      limit: 2,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Array<{ id: string }>;
    // Exactly 2 results — even though 4 doc-tier docs match, the limit caps.
    expect(payload.length).toBe(2);
  });

  it("merges and re-ranks by rerank score descending", async () => {
    // Two doc-tier docs; the reranker gives doc-B a higher score than doc-A.
    // Confirm doc-B sorts first in the merged output.
    const mod = await import("../index.js");
    const { server, db, fts, vec } = mod.createServer(":memory:", {
      embedFn: mockEmbedFn,
      rerankerFactory: () =>
        new StubReranker(
          new Map([
            ["rank-a", 1.0],
            ["rank-b", 10.0],
          ]),
        ) as unknown as import("../reranker.js").Reranker,
    });
    ensureV3Schema(db);

    db.upsertDocument({
      id: "rank-a",
      path: "rank-a.md",
      title: "Lower Rank",
      date: "2026-05-10",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "Lower-rank doc about merge ordering during cross-tier recall.",
    });
    db.upsertDocument({
      id: "rank-b",
      path: "rank-b.md",
      title: "Higher Rank",
      date: "2026-05-11",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "Higher-rank doc about merge ordering during cross-tier recall.",
    });
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("doc", "rank-a");
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("doc", "rank-b");
    fts.rebuildIndex();
    vec.createIndex();
    const qEmb = await mockEmbedFn("merge ordering cross tier");
    vec.upsertEmbedding("rank-a", qEmb);
    vec.upsertEmbedding("rank-b", qEmb);

    const result = await callTool(server, "knowledge_recall", {
      query: "merge ordering cross tier",
      role: "implementer", // policy: [wiki, doc]
      limit: 10,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Array<{ id: string }>;
    // The fusion blend can re-order against the raw rerank logit, but the
    // higher-logit doc should still appear before the lower-logit doc.
    const idxA = payload.findIndex((r) => r.id === "rank-a");
    const idxB = payload.findIndex((r) => r.id === "rank-b");
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeLessThan(idxA);
  });
});

describe("knowledge_recall payload shape parity with knowledge_search", () => {
  it("returns the same per-hit shape as knowledge_search (id, path, title, type, status, date, score, snippet, tags)", async () => {
    const mod = await import("../index.js");
    const { server, db, fts, vec } = mod.createServer(":memory:", {
      embedFn: mockEmbedFn,
      rerankerFactory: () =>
        new StubReranker(new Map([["parity-doc", 4.0]])) as unknown as import("../reranker.js").Reranker,
    });
    ensureV3Schema(db);

    db.upsertDocument({
      id: "parity-doc",
      path: "parity-doc.md",
      title: "Parity Probe",
      date: "2026-05-12",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "Parity probe content about payload shape comparison.",
    });
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("doc", "parity-doc");
    db.setTags("parity-doc", ["parity", "probe"]);
    fts.rebuildIndex();
    vec.createIndex();
    vec.upsertEmbedding("parity-doc", await mockEmbedFn("payload shape comparison"));

    const recall = await callTool(server, "knowledge_recall", {
      query: "payload shape comparison",
      role: "triager",
      limit: 5,
    });
    expect(recall.isError).not.toBe(true);
    const payload = JSON.parse(recall.content[0].text) as Array<Record<string, unknown>>;
    const hit = payload.find((r) => r.id === "parity-doc");
    expect(hit).toBeDefined();
    expect(typeof hit!.path).toBe("string");
    expect(typeof hit!.title).toBe("string");
    expect(hit!.type).toBe("research");
    expect(hit!.status).toBe("draft");
    expect(hit!.date).toBe("2026-05-12");
    expect(typeof hit!.score).toBe("number");
    expect(typeof hit!.snippet).toBe("string");
    expect(Array.isArray(hit!.tags)).toBe(true);
    expect(hit!.tags).toEqual(expect.arrayContaining(["parity", "probe"]));
    // Recall intentionally hides chunk/diag/rerank diagnostic fields — power
    // users who want those call knowledge_search directly.
    expect(hit!.chunk_index).toBeUndefined();
    expect(hit!.fts_score).toBeUndefined();
    expect(hit!.rerank_score).toBeUndefined();
  });
});

describe("knowledge_recall degraded-but-not-failed behavior", () => {
  it("continues across tiers when a single tier sub-query throws", async () => {
    // Construct a server, then monkey-patch the hybrid search the registered
    // tool will reach via the McpServer registry. We replace `hybrid.search`
    // to throw on the first tier and return one hit on subsequent calls.
    const mod = await import("../index.js");
    const created = mod.createServer(":memory:", {
      embedFn: mockEmbedFn,
      // Stub reranker — without it, hybrid.search lazy-loads the real ONNX
      // model on the second tier call, blowing the 5s test budget.
      rerankerFactory: () =>
        new StubReranker(
          new Map([["degraded-doc", 1.0]]),
        ) as unknown as import("../reranker.js").Reranker,
    });
    const { server, db, fts, vec } = created;
    ensureV3Schema(db);

    db.upsertDocument({
      id: "degraded-doc",
      path: "degraded-doc.md",
      title: "Degraded Doc",
      date: "2026-05-12",
      type: null,
      status: null,
      githubIssue: null,
      content: "Degraded path doc — survives a partial tier failure.",
    });
    // Tier matches the SECOND tier in the triager policy (wiki), so when the
    // first tier (doc) sub-query throws, the second tier still returns the doc.
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("wiki", "degraded-doc");
    fts.rebuildIndex();
    vec.createIndex();
    vec.upsertEmbedding("degraded-doc", await mockEmbedFn("survives partial tier failure"));

    // Monkey-patch the hybrid instance to fail on the first call only.
    let callCount = 0;
    const realSearch = created.hybrid.search.bind(created.hybrid);
    created.hybrid.search = (async (q: string, opts: unknown) => {
      callCount++;
      if (callCount === 1) throw new Error("synthetic tier-1 failure");
      return realSearch(q, opts as Parameters<typeof realSearch>[1]);
    }) as typeof created.hybrid.search;

    const result = await callTool(server, "knowledge_recall", {
      query: "survives partial tier failure",
      role: "triager", // policy = [doc, wiki] -> 2 tiers; doc throws, wiki survives.
      limit: 5,
    });
    // The first tier sub-query throws; the second one returns the doc.
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Array<{ id: string }>;
    expect(payload.some((r) => r.id === "degraded-doc")).toBe(true);
    // Both tiers were attempted.
    expect(callCount).toBe(2);
  });
});
