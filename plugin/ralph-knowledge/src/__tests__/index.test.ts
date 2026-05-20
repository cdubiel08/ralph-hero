import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KnowledgeDB } from "../db.js";

/**
 * Deterministic mock embedding. Avoids the 16MB ONNX model download in tests.
 */
function mockEmbed(seed: number): Float32Array {
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

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 1000;
}

const mockEmbedFn = async (text: string) => mockEmbed(hashSeed(text));

/**
 * Helper to call a registered MCP tool by name (mirrors the pattern in
 * graph-tools.test.ts). McpServer stores handlers at `_registeredTools`.
 */
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
  if (!tool) {
    throw new Error(`Tool "${name}" not registered`);
  }
  return tool.handler(args, {}) as Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

/**
 * Ensure the v3 schema extensions (memory_tier column on documents, chunks
 * table) exist on the test DB. Phase 1 (GH-762) owns the production schema
 * migration; here we add them in test fixtures so Phase 8's features can be
 * exercised independently of Phase 1's merge order.
 */
function ensureV3Schema(db: KnowledgeDB): void {
  const rows = db.db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>;
  const hasTier = rows.some((r) => r.name === "memory_tier");
  if (!hasTier) {
    db.db.exec(
      "ALTER TABLE documents ADD COLUMN memory_tier TEXT NOT NULL DEFAULT 'doc' CHECK(memory_tier IN ('doc','raw','reflection'))",
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

describe("knowledge-index server", () => {
  it("exports createServer function", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.createServer).toBe("function");
  });

  it("registers outcome tools without error", async () => {
    const mod = await import("../index.js");
    const { server } = mod.createServer(":memory:");
    expect(server).toBeTruthy();
  });

  it("registers knowledge_memory_stats tool alongside search/traverse", async () => {
    const mod = await import("../index.js");
    const { server } = mod.createServer(":memory:");
    const registered = (server as unknown as Record<string, unknown>)
      ._registeredTools as Record<string, unknown>;
    expect(registered).toHaveProperty("knowledge_memory_stats");
    expect(registered).toHaveProperty("knowledge_search");
    expect(registered).toHaveProperty("knowledge_traverse");
  });

  it("knowledge_search tool schema accepts memory_tier + return_chunk_meta", async () => {
    const mod = await import("../index.js");
    const { server } = mod.createServer(":memory:");
    const registered = (server as unknown as Record<string, unknown>)
      ._registeredTools as Record<string, { inputSchema?: { parse: (v: unknown) => unknown } }>;
    const schema = registered.knowledge_search?.inputSchema;
    expect(schema).toBeDefined();
    // Valid inputs should pass zod validation without throwing
    expect(() =>
      schema!.parse({ query: "hello", memory_tier: "reflection", return_chunk_meta: true }),
    ).not.toThrow();
    expect(() => schema!.parse({ query: "hello", memory_tier: "any" })).not.toThrow();
    // Invalid tier value must be rejected
    expect(() => schema!.parse({ query: "hello", memory_tier: "garbage" })).toThrow();
  });

  it("knowledge_traverse schema accepts memory_tier", async () => {
    const mod = await import("../index.js");
    const { server } = mod.createServer(":memory:");
    const registered = (server as unknown as Record<string, unknown>)
      ._registeredTools as Record<string, { inputSchema?: { parse: (v: unknown) => unknown } }>;
    const schema = registered.knowledge_traverse?.inputSchema;
    expect(schema).toBeDefined();
    expect(() =>
      schema!.parse({ from: "doc-1", memory_tier: "reflection" }),
    ).not.toThrow();
    expect(() => schema!.parse({ from: "doc-1", memory_tier: "bad" })).toThrow();
  });

  it("knowledge_search schema accepts lambda in [0,1] (Phase 1, GH-902)", async () => {
    const mod = await import("../index.js");
    const { server } = mod.createServer(":memory:");
    const registered = (server as unknown as Record<string, unknown>)
      ._registeredTools as Record<string, { inputSchema?: { parse: (v: unknown) => unknown } }>;
    const schema = registered.knowledge_search?.inputSchema;
    expect(schema).toBeDefined();
    // Valid lambda values
    expect(() => schema!.parse({ query: "hello", lambda: 0.0 })).not.toThrow();
    expect(() => schema!.parse({ query: "hello", lambda: 0.7 })).not.toThrow();
    expect(() => schema!.parse({ query: "hello", lambda: 1.0 })).not.toThrow();
    // lambda omitted is OK (default = no MMR)
    expect(() => schema!.parse({ query: "hello" })).not.toThrow();
    // Out-of-range values are rejected by zod (impl clamps internally too).
    expect(() => schema!.parse({ query: "hello", lambda: -0.1 })).toThrow();
    expect(() => schema!.parse({ query: "hello", lambda: 1.5 })).toThrow();
  });

  it("knowledge_search schema accepts return_diagnostics (Phase 2, GH-899)", async () => {
    const mod = await import("../index.js");
    const { server } = mod.createServer(":memory:");
    const registered = (server as unknown as Record<string, unknown>)
      ._registeredTools as Record<string, { inputSchema?: { parse: (v: unknown) => unknown } }>;
    const schema = registered.knowledge_search?.inputSchema;
    expect(schema).toBeDefined();
    // Valid forms.
    expect(() => schema!.parse({ query: "hello", return_diagnostics: true })).not.toThrow();
    expect(() => schema!.parse({ query: "hello", return_diagnostics: false })).not.toThrow();
    // Omitted is OK (defaults to false).
    expect(() => schema!.parse({ query: "hello" })).not.toThrow();
    // Wrong type is rejected.
    expect(() => schema!.parse({ query: "hello", return_diagnostics: "yes" })).toThrow();
  });
});

describe("knowledge_search memory_tier + chunk_meta", () => {
  it("filters to reflection when memory_tier=reflection", async () => {
    const mod = await import("../index.js");
    const { server, db, fts, vec } = mod.createServer(":memory:", { embedFn: mockEmbedFn });

    ensureV3Schema(db);

    // Seed 3 docs in doc/raw/reflection tiers with distinct content
    db.upsertDocument({
      id: "s-doc",
      path: "s-doc.md",
      title: "Curated Research",
      date: "2026-03-01",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "Curated research about chunking retrieval strategies.",
    });
    db.upsertDocument({
      id: "s-raw",
      path: "s-raw.md",
      title: "Raw Memory",
      date: "2026-03-02",
      type: null,
      status: null,
      githubIssue: null,
      content: "Raw ingested note about chunking retrieval.",
    });
    db.upsertDocument({
      id: "s-reflection",
      path: "s-reflection.md",
      title: "Reflection Synthesis",
      date: "2026-03-03",
      type: null,
      status: null,
      githubIssue: null,
      content: "Reflection about chunking retrieval patterns.",
    });
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("doc", "s-doc");
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("raw", "s-raw");
    db.db
      .prepare("UPDATE documents SET memory_tier = ? WHERE id = ?")
      .run("reflection", "s-reflection");
    fts.rebuildIndex();

    // Ensure vec index exists so the query path runs — empty is fine.
    vec.createIndex();

    const result = await callTool(server, "knowledge_search", {
      query: "chunking retrieval",
      memory_tier: "reflection",
      limit: 10,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Array<{ id: string }>;
    const ids = payload.map((r) => r.id);
    expect(ids).toContain("s-reflection");
    expect(ids).not.toContain("s-doc");
    expect(ids).not.toContain("s-raw");
  });

  it("returns all tiers when memory_tier='any' (default)", async () => {
    const mod = await import("../index.js");
    const { server, db, fts, vec } = mod.createServer(":memory:", { embedFn: mockEmbedFn });

    ensureV3Schema(db);

    db.upsertDocument({
      id: "a-doc",
      path: "a-doc.md",
      title: "Doc",
      date: "2026-03-04",
      type: null,
      status: null,
      githubIssue: null,
      content: "Content about retrieval pipelines.",
    });
    db.upsertDocument({
      id: "a-raw",
      path: "a-raw.md",
      title: "Raw",
      date: "2026-03-04",
      type: null,
      status: null,
      githubIssue: null,
      content: "Raw content about retrieval pipelines.",
    });
    db.upsertDocument({
      id: "a-reflect",
      path: "a-reflect.md",
      title: "Reflect",
      date: "2026-03-04",
      type: null,
      status: null,
      githubIssue: null,
      content: "Reflection content about retrieval pipelines.",
    });
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("doc", "a-doc");
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("raw", "a-raw");
    db.db
      .prepare("UPDATE documents SET memory_tier = ? WHERE id = ?")
      .run("reflection", "a-reflect");
    fts.rebuildIndex();
    vec.createIndex();

    const result = await callTool(server, "knowledge_search", {
      query: "retrieval pipelines",
      limit: 10,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Array<{ id: string }>;
    const ids = payload.map((r) => r.id);
    expect(ids).toContain("a-doc");
    expect(ids).toContain("a-raw");
    expect(ids).toContain("a-reflect");
  });

  it("populates chunk_index when return_chunk_meta=true", async () => {
    const mod = await import("../index.js");
    const { server, db, fts, vec } = mod.createServer(":memory:", { embedFn: mockEmbedFn });
    ensureV3Schema(db);

    db.upsertDocument({
      id: "c-doc",
      path: "c-doc.md",
      title: "Chunked Doc",
      date: "2026-03-05",
      type: null,
      status: null,
      githubIssue: null,
      content: "The first portion of a long research document discussing retrieval.",
    });
    fts.rebuildIndex();

    // Seed a chunk + a chunk-level vec row
    db.db
      .prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, content, char_start, char_end, context_prefix)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "c-doc#c0",
        "c-doc",
        0,
        "The first portion of a long research document discussing retrieval.",
        0,
        68,
        "Research context.",
      );

    vec.createIndex();
    const queryEmbedding = await mockEmbedFn("retrieval research chunking");
    vec.upsertEmbedding("c-doc#c0", queryEmbedding);

    const result = await callTool(server, "knowledge_search", {
      query: "retrieval research chunking",
      limit: 5,
      return_chunk_meta: true,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>;
    const hit = payload.find((r) => r.id === "c-doc");
    expect(hit).toBeDefined();
    expect(hit!.chunk_index).toBe(0);
    expect(hit!.char_start).toBe(0);
    expect(hit!.char_end).toBe(68);
    expect(hit!.context_prefix).toBe("Research context.");
    expect(hit!.best_chunk_id).toBe("c-doc#c0");
  });

  it("knowledge_search passes lambda through to MMR (Phase 1, GH-902)", async () => {
    // Verifies that calling knowledge_search with `lambda: 0.7` triggers the
    // MMR rerank path. End-to-end test: build a fixture where MMR will
    // observably reorder results, invoke the tool, assert the order changed.
    const mod = await import("../index.js");
    const { server, db, fts, vec } = mod.createServer(":memory:", {
      embedFn: async () => {
        const v = new Float32Array(384);
        v[0] = 1.0;
        return v;
      },
    });
    ensureV3Schema(db);

    function unitAt(d: number): Float32Array {
      const v = new Float32Array(384);
      v[d] = 1.0;
      return v;
    }
    function nearDup(v: Float32Array, dim: number, eps: number): Float32Array {
      const out = new Float32Array(v);
      out[dim] += eps;
      let n = 0;
      for (let i = 0; i < out.length; i++) n += out[i] * out[i];
      n = Math.sqrt(n);
      for (let i = 0; i < out.length; i++) out[i] /= n;
      return out;
    }

    db.upsertDocument({ id: "mmr-a", path: "a.md", title: "topic anchor", date: "2026-04-01", type: "research", status: "draft", githubIssue: null, content: "topic anchor primary" });
    db.upsertDocument({ id: "mmr-b", path: "b.md", title: "topic clone", date: "2026-04-02", type: "plan", status: "draft", githubIssue: null, content: "topic clone of a sibling" });
    db.upsertDocument({ id: "mmr-c", path: "c.md", title: "topic distinct", date: "2026-04-03", type: "research", status: "draft", githubIssue: null, content: "topic distinct from a content different domain" });
    for (let i = 0; i < 10; i++) {
      db.upsertDocument({ id: `mmr-floor-${i}`, path: `f${i}.md`, title: "floor", date: `2026-04-${10 + i}`, type: "plan", status: "draft", githubIssue: null, content: "topic floor unrelated filler doc number " + i });
    }
    fts.rebuildIndex();

    vec.createIndex();
    const aVec = unitAt(0);
    vec.upsertEmbedding("mmr-a", aVec);
    vec.upsertEmbedding("mmr-b", nearDup(aVec, 1, 0.01));
    const cVec = new Float32Array(384);
    cVec[0] = 0.3;
    cVec[2] = 1.0;
    let cn = 0;
    for (let i = 0; i < cVec.length; i++) cn += cVec[i] * cVec[i];
    cn = Math.sqrt(cn);
    for (let i = 0; i < cVec.length; i++) cVec[i] /= cn;
    vec.upsertEmbedding("mmr-c", cVec);
    for (let i = 0; i < 10; i++) {
      const v = new Float32Array(384);
      for (let d = 100; d < 200; d++) v[d] = Math.sin((900 + i) * (d + 1) * 0.1);
      let n = 0;
      for (let d = 0; d < v.length; d++) n += v[d] * v[d];
      n = Math.sqrt(n);
      for (let d = 0; d < v.length; d++) v[d] /= n;
      vec.upsertEmbedding(`mmr-floor-${i}`, v);
    }

    const baseline = await callTool(server, "knowledge_search", {
      query: "topic",
      limit: 3,
    });
    const withMmr = await callTool(server, "knowledge_search", {
      query: "topic",
      limit: 3,
      lambda: 0.7,
    });

    expect(baseline.isError).not.toBe(true);
    expect(withMmr.isError).not.toBe(true);

    const baselineIds = (JSON.parse(baseline.content[0].text) as Array<{ id: string }>).map(r => r.id);
    const mmrIds = (JSON.parse(withMmr.content[0].text) as Array<{ id: string }>).map(r => r.id);

    // Both should lead with mmr-a (top relevance).
    expect(baselineIds[0]).toBe("mmr-a");
    expect(mmrIds[0]).toBe("mmr-a");
    // Baseline puts the near-duplicate (mmr-b) at slot 2.
    expect(baselineIds[1]).toBe("mmr-b");
    // MMR demotes mmr-b — slot 2 is no longer the near-duplicate.
    expect(mmrIds[1]).not.toBe("mmr-b");
  });

  it("knowledge_search return_diagnostics=true emits snake_case fts_score / vec_distance / hit_sources (Phase 2, GH-899)", async () => {
    const mod = await import("../index.js");
    const { server, db, fts, vec } = mod.createServer(":memory:", { embedFn: mockEmbedFn });
    ensureV3Schema(db);

    db.upsertDocument({
      id: "diag-doc",
      path: "diag-doc.md",
      title: "Calibration Diagnostic Doc",
      date: "2026-04-26",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "Document about calibration diagnostic surfaces for retrieval observability.",
    });
    fts.rebuildIndex();

    vec.createIndex();
    vec.upsertEmbedding("diag-doc", await mockEmbedFn("calibration diagnostic"));

    const result = await callTool(server, "knowledge_search", {
      query: "calibration diagnostic",
      limit: 5,
      return_diagnostics: true,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>;
    const hit = payload.find((r) => r.id === "diag-doc");
    expect(hit).toBeDefined();
    // Snake_case keys per MCP convention (matches chunk_index pattern).
    expect(hit!.fts_score).toBeDefined();
    expect(typeof hit!.fts_score).toBe("number");
    expect(hit!.vec_distance).toBeDefined();
    expect(typeof hit!.vec_distance).toBe("number");
    expect(hit!.hit_sources).toBeDefined();
    expect(Array.isArray(hit!.hit_sources)).toBe(true);
    // Also assert the camelCase forms are NOT leaked through.
    expect(hit!.ftsScore).toBeUndefined();
    expect(hit!.vecDistance).toBeUndefined();
    expect(hit!.hitSources).toBeUndefined();
  });

  it("knowledge_search omits diagnostic fields when return_diagnostics is false (default) (Phase 2, GH-899)", async () => {
    const mod = await import("../index.js");
    const { server, db, fts, vec } = mod.createServer(":memory:", { embedFn: mockEmbedFn });
    ensureV3Schema(db);

    db.upsertDocument({
      id: "noflag-doc",
      path: "noflag-doc.md",
      title: "Default Flag Doc",
      date: "2026-04-26",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "Document used to verify no diagnostic leakage when flag omitted.",
    });
    fts.rebuildIndex();
    vec.createIndex();
    vec.upsertEmbedding("noflag-doc", await mockEmbedFn("default flag verification"));

    const result = await callTool(server, "knowledge_search", {
      query: "default flag verification",
      limit: 5,
      // return_diagnostics omitted — defaults to false.
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>;
    const hit = payload.find((r) => r.id === "noflag-doc");
    expect(hit).toBeDefined();
    expect(hit!.fts_score).toBeUndefined();
    expect(hit!.vec_distance).toBeUndefined();
    expect(hit!.hit_sources).toBeUndefined();
    expect(hit!.ftsScore).toBeUndefined();
    expect(hit!.vecDistance).toBeUndefined();
    expect(hit!.hitSources).toBeUndefined();
  });

  it("omits chunk_index when return_chunk_meta is false (default)", async () => {
    const mod = await import("../index.js");
    const { server, db, fts, vec } = mod.createServer(":memory:", { embedFn: mockEmbedFn });
    ensureV3Schema(db);

    db.upsertDocument({
      id: "d-doc",
      path: "d-doc.md",
      title: "Chunked Doc",
      date: "2026-03-05",
      type: null,
      status: null,
      githubIssue: null,
      content: "Chunked document body about retrieval.",
    });
    fts.rebuildIndex();
    db.db
      .prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, content, char_start, char_end, context_prefix)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("d-doc#c0", "d-doc", 0, "Chunked document body about retrieval.", 0, 40, "");
    vec.createIndex();
    vec.upsertEmbedding("d-doc#c0", await mockEmbedFn("retrieval document"));

    const result = await callTool(server, "knowledge_search", {
      query: "retrieval document",
      limit: 5,
      // return_chunk_meta omitted (defaults to false)
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>;
    const hit = payload.find((r) => r.id === "d-doc");
    expect(hit).toBeDefined();
    expect(hit!.chunk_index).toBeUndefined();
    expect(hit!.best_chunk_id).toBeUndefined();
  });
});

describe("knowledge_traverse memory_tier filter", () => {
  it("drops non-reflection nodes when memory_tier=reflection", async () => {
    const mod = await import("../index.js");
    const { server, db } = mod.createServer(":memory:");

    ensureV3Schema(db);

    db.upsertDocument({
      id: "t-root",
      path: "t-root.md",
      title: "Root",
      date: null,
      type: null,
      status: null,
      githubIssue: null,
      content: "",
    });
    db.upsertDocument({
      id: "t-doc-child",
      path: "c1.md",
      title: "Doc Child",
      date: null,
      type: null,
      status: null,
      githubIssue: null,
      content: "",
    });
    db.upsertDocument({
      id: "t-reflect-child",
      path: "c2.md",
      title: "Reflect Child",
      date: null,
      type: null,
      status: null,
      githubIssue: null,
      content: "",
    });
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("doc", "t-doc-child");
    db.db
      .prepare("UPDATE documents SET memory_tier = ? WHERE id = ?")
      .run("reflection", "t-reflect-child");
    db.addRelationship("t-root", "t-doc-child", "builds_on");
    db.addRelationship("t-root", "t-reflect-child", "builds_on");

    const result = await callTool(server, "knowledge_traverse", {
      from: "t-root",
      memory_tier: "reflection",
    });
    expect(result.isError).not.toBe(true);
    const rows = JSON.parse(result.content[0].text) as Array<{ targetId: string }>;
    const targetIds = rows.map((r) => r.targetId);
    expect(targetIds).toContain("t-reflect-child");
    expect(targetIds).not.toContain("t-doc-child");
  });

  it("returns all tiers when memory_tier='any' (default)", async () => {
    const mod = await import("../index.js");
    const { server, db } = mod.createServer(":memory:");

    ensureV3Schema(db);

    db.upsertDocument({
      id: "any-root",
      path: "r.md",
      title: "R",
      date: null,
      type: null,
      status: null,
      githubIssue: null,
      content: "",
    });
    db.upsertDocument({
      id: "any-doc",
      path: "a.md",
      title: "A",
      date: null,
      type: null,
      status: null,
      githubIssue: null,
      content: "",
    });
    db.upsertDocument({
      id: "any-raw",
      path: "b.md",
      title: "B",
      date: null,
      type: null,
      status: null,
      githubIssue: null,
      content: "",
    });
    db.upsertDocument({
      id: "any-reflect",
      path: "c.md",
      title: "C",
      date: null,
      type: null,
      status: null,
      githubIssue: null,
      content: "",
    });
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("doc", "any-doc");
    db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run("raw", "any-raw");
    db.db
      .prepare("UPDATE documents SET memory_tier = ? WHERE id = ?")
      .run("reflection", "any-reflect");
    db.addRelationship("any-root", "any-doc", "builds_on");
    db.addRelationship("any-root", "any-raw", "builds_on");
    db.addRelationship("any-root", "any-reflect", "builds_on");

    const result = await callTool(server, "knowledge_traverse", {
      from: "any-root",
    });
    expect(result.isError).not.toBe(true);
    const rows = JSON.parse(result.content[0].text) as Array<{ targetId: string }>;
    const targetIds = rows.map((r) => r.targetId);
    expect(targetIds).toContain("any-doc");
    expect(targetIds).toContain("any-raw");
    expect(targetIds).toContain("any-reflect");
  });
});

describe("knowledge_search rerank parameter (GH-926)", () => {
  /**
   * Stub Reranker — implements the same `score()` surface as the real
   * `Reranker` class but returns a deterministic scoreMap supplied at
   * construction time. Lets MCP tool tests exercise the rerank wiring
   * without paying the ~580 MB ONNX model download.
   *
   * Shape match: `score(query: string, docs: RerankerInput[]) => Promise<Map<string, number>>`
   * matches `Reranker.score`. The cast to `Reranker` in the
   * `rerankerFactory` callback is safe because the production code path
   * (HybridSearch.search) only invokes `.score()` on the injected reranker.
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

  it("schema accepts rerank boolean (true/false/omitted) and rejects non-boolean", async () => {
    const mod = await import("../index.js");
    const { server } = mod.createServer(":memory:");
    const registered = (server as unknown as Record<string, unknown>)
      ._registeredTools as Record<string, { inputSchema?: { parse: (v: unknown) => unknown } }>;
    const schema = registered.knowledge_search?.inputSchema;
    expect(schema).toBeDefined();
    // Valid forms.
    expect(() => schema!.parse({ query: "x", rerank: true })).not.toThrow();
    expect(() => schema!.parse({ query: "x", rerank: false })).not.toThrow();
    // Omitted is OK (defaults to false).
    expect(() => schema!.parse({ query: "x" })).not.toThrow();
    // Wrong type is rejected.
    expect(() => schema!.parse({ query: "x", rerank: "yes" })).toThrow();
  });

  it("rerank: true + return_diagnostics: true emits snake_case rerank_score on each hit", async () => {
    const mod = await import("../index.js");
    // Stub returns a logit for every seeded doc id so they all carry
    // rerank_score after the splice runs.
    const stub = new StubReranker(
      new Map([
        ["rerank-mcp-a", 0.95],
        ["rerank-mcp-b", 0.20],
      ]),
    );
    const { server, db, fts, vec } = mod.createServer(":memory:", {
      embedFn: mockEmbedFn,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rerankerFactory: () => stub as any,
    });
    ensureV3Schema(db);

    db.upsertDocument({
      id: "rerank-mcp-a",
      path: "rerank-mcp-a.md",
      title: "Rerank A",
      date: "2026-04-30",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "Document A about cross-encoder reranking experiments.",
    });
    db.upsertDocument({
      id: "rerank-mcp-b",
      path: "rerank-mcp-b.md",
      title: "Rerank B",
      date: "2026-04-30",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "Document B about cross-encoder reranking experiments.",
    });
    fts.rebuildIndex();
    vec.createIndex();
    vec.upsertEmbedding("rerank-mcp-a", await mockEmbedFn("rerank-mcp-a"));
    vec.upsertEmbedding("rerank-mcp-b", await mockEmbedFn("rerank-mcp-b"));

    const result = await callTool(server, "knowledge_search", {
      query: "cross-encoder reranking",
      limit: 5,
      rerank: true,
      return_diagnostics: true,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>;
    expect(payload.length).toBeGreaterThan(0);
    // Every result that the stub scored must carry rerank_score in the
    // diagnostics-on payload.
    const scoredIds = new Set(["rerank-mcp-a", "rerank-mcp-b"]);
    for (const hit of payload) {
      if (scoredIds.has(hit.id as string)) {
        expect(hit.rerank_score).toBeDefined();
        expect(typeof hit.rerank_score).toBe("number");
      }
    }
    // camelCase form must NOT leak through.
    for (const hit of payload) {
      expect(hit.rerankScore).toBeUndefined();
    }
  });

  it("rerank: true + return_diagnostics: false omits rerank_score (diagnostic discipline)", async () => {
    const mod = await import("../index.js");
    const stub = new StubReranker(
      new Map([
        ["rerank-nodiag-a", 0.95],
        ["rerank-nodiag-b", 0.20],
      ]),
    );
    const { server, db, fts, vec } = mod.createServer(":memory:", {
      embedFn: mockEmbedFn,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rerankerFactory: () => stub as any,
    });
    ensureV3Schema(db);

    db.upsertDocument({
      id: "rerank-nodiag-a",
      path: "rerank-nodiag-a.md",
      title: "Nodiag A",
      date: "2026-04-30",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "Doc about reranking without diagnostics requested.",
    });
    db.upsertDocument({
      id: "rerank-nodiag-b",
      path: "rerank-nodiag-b.md",
      title: "Nodiag B",
      date: "2026-04-30",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "Another doc about reranking without diagnostics requested.",
    });
    fts.rebuildIndex();
    vec.createIndex();
    vec.upsertEmbedding("rerank-nodiag-a", await mockEmbedFn("rerank-nodiag-a"));
    vec.upsertEmbedding("rerank-nodiag-b", await mockEmbedFn("rerank-nodiag-b"));

    const result = await callTool(server, "knowledge_search", {
      query: "reranking diagnostics",
      limit: 5,
      rerank: true,
      // return_diagnostics omitted (defaults to false).
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>;
    expect(payload.length).toBeGreaterThan(0);
    for (const hit of payload) {
      expect(hit.rerank_score).toBeUndefined();
      expect(hit.rerankScore).toBeUndefined();
    }
  });

  it("rerank: false (and omitted) is byte-identical and never includes rerank_score", async () => {
    const mod = await import("../index.js");
    // Use a stub that, IF it ran, would mutate ordering — so any drift
    // signals the splice ran when it shouldn't.
    const stub = new StubReranker(
      new Map([
        ["rerank-off-a", 0.01],
        ["rerank-off-b", 0.99],
      ]),
    );
    const { server, db, fts, vec } = mod.createServer(":memory:", {
      embedFn: mockEmbedFn,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rerankerFactory: () => stub as any,
    });
    ensureV3Schema(db);

    db.upsertDocument({
      id: "rerank-off-a",
      path: "rerank-off-a.md",
      title: "Off A",
      date: "2026-04-30",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "Document A used to verify rerank-off byte-identity.",
    });
    db.upsertDocument({
      id: "rerank-off-b",
      path: "rerank-off-b.md",
      title: "Off B",
      date: "2026-04-30",
      type: "research",
      status: "draft",
      githubIssue: null,
      content: "Document B used to verify rerank-off byte-identity.",
    });
    fts.rebuildIndex();
    vec.createIndex();
    vec.upsertEmbedding("rerank-off-a", await mockEmbedFn("rerank-off-a"));
    vec.upsertEmbedding("rerank-off-b", await mockEmbedFn("rerank-off-b"));

    const omitted = await callTool(server, "knowledge_search", {
      query: "verify byte identity",
      limit: 5,
      // rerank omitted (defaults to false).
    });
    const explicitFalse = await callTool(server, "knowledge_search", {
      query: "verify byte identity",
      limit: 5,
      rerank: false,
    });
    expect(omitted.isError).not.toBe(true);
    expect(explicitFalse.isError).not.toBe(true);
    // Byte-identical — JSON text must match exactly.
    expect(explicitFalse.content[0].text).toBe(omitted.content[0].text);
    const payload = JSON.parse(omitted.content[0].text) as Array<Record<string, unknown>>;
    for (const hit of payload) {
      expect(hit.rerank_score).toBeUndefined();
      expect(hit.rerankScore).toBeUndefined();
    }
    // Even when return_diagnostics is true but rerank is false, no
    // rerank_score should leak.
    const diagOnly = await callTool(server, "knowledge_search", {
      query: "verify byte identity",
      limit: 5,
      rerank: false,
      return_diagnostics: true,
    });
    expect(diagOnly.isError).not.toBe(true);
    const diagPayload = JSON.parse(diagOnly.content[0].text) as Array<Record<string, unknown>>;
    for (const hit of diagPayload) {
      expect(hit.rerank_score).toBeUndefined();
    }
  });
});

describe("knowledge_expert", () => {
  it("is registered alongside knowledge_recall and knowledge_search", async () => {
    const mod = await import("../index.js");
    const { server } = mod.createServer(":memory:");
    const registered = (server as unknown as Record<string, unknown>)
      ._registeredTools as Record<string, unknown>;
    expect(registered).toHaveProperty("knowledge_expert");
  });

  it("returns empty bundle + warning when no docs match the domain", async () => {
    const mod = await import("../index.js");
    const { server } = mod.createServer(":memory:");
    const result = await callTool(server, "knowledge_expert", {
      domain: "nonexistent-domain",
      issue_number: 1306,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(payload.wiki).toEqual([]);
    expect(payload.reflections).toEqual([]);
    expect(payload.warning).toMatch(/No documents found/);
    expect(typeof payload.query_id).toBe("string");
    expect((payload.query_id as string)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns wiki + reflection buckets filtered by domain tag", async () => {
    const mod = await import("../index.js");
    const { server, db } = mod.createServer(":memory:");
    // Seed: one wiki doc and one reflection, both tagged 'auth'
    db.upsertDocument({
      id: "wiki-auth",
      path: "thoughts/wiki/auth.md",
      title: "Auth",
      date: "2026-04-01",
      type: null,
      status: null,
      githubIssue: null,
      content: "Authentication best practices.",
      memoryTier: "wiki",
    });
    db.upsertDocument({
      id: "refl-auth",
      path: "thoughts/dream-memories/2026/05/refl.md",
      title: "Auth reflection",
      date: "2026-05-10",
      type: null,
      status: null,
      githubIssue: null,
      content: "Reflection on auth patterns observed this week.",
      memoryTier: "reflection",
    });
    db.setTags("wiki-auth", ["auth"]);
    db.setTags("refl-auth", ["auth", "dream"]);

    const result = await callTool(server, "knowledge_expert", {
      domain: "auth",
      issue_number: 1306,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect((payload.wiki as unknown[]).length).toBe(1);
    expect((payload.reflections as unknown[]).length).toBe(1);
    expect(payload.warning).toBeNull();
  });

  it("does not return docs from other tiers in the wiki bucket", async () => {
    const mod = await import("../index.js");
    const { server, db } = mod.createServer(":memory:");
    // Seed a doc-tier and a raw-tier document both tagged 'search'
    db.upsertDocument({
      id: "doc-search",
      path: "thoughts/research/search.md",
      title: "Search doc",
      date: "2026-04-01",
      type: null,
      status: null,
      githubIssue: null,
      content: "Research notes on search.",
      memoryTier: "doc",
    });
    db.upsertDocument({
      id: "raw-search",
      path: "thoughts/dream-memories/raw.md",
      title: "Search raw",
      date: "2026-04-02",
      type: null,
      status: null,
      githubIssue: null,
      content: "Raw memory about search.",
      memoryTier: "raw",
    });
    db.setTags("doc-search", ["search"]);
    db.setTags("raw-search", ["search"]);

    const result = await callTool(server, "knowledge_expert", {
      domain: "search",
      issue_number: 1306,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    // Neither doc nor raw tier should appear in wiki or reflections
    expect((payload.wiki as unknown[]).length).toBe(0);
    expect((payload.reflections as unknown[]).length).toBe(0);
    expect(payload.warning).toMatch(/No documents found/);
  });

  it("respects recency_window_days for reflections", async () => {
    const mod = await import("../index.js");
    const { server, db } = mod.createServer(":memory:");
    // Seed an old reflection (100 days ago) — should be excluded with a 7-day window
    const oldDate = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);
    db.upsertDocument({
      id: "refl-old",
      path: "thoughts/dream-memories/old.md",
      title: "Old reflection",
      date: oldDate,
      type: null,
      status: null,
      githubIssue: null,
      content: "Old reflection about caching.",
      memoryTier: "reflection",
    });
    // Seed a recent reflection
    const recentDate = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    db.upsertDocument({
      id: "refl-recent",
      path: "thoughts/dream-memories/recent.md",
      title: "Recent reflection",
      date: recentDate,
      type: null,
      status: null,
      githubIssue: null,
      content: "Recent reflection about caching.",
      memoryTier: "reflection",
    });
    db.setTags("refl-old", ["caching"]);
    db.setTags("refl-recent", ["caching"]);

    const result = await callTool(server, "knowledge_expert", {
      domain: "caching",
      issue_number: 1306,
      recency_window_days: 7,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    const reflections = payload.reflections as Array<{ id: string }>;
    const ids = reflections.map((r) => r.id);
    expect(ids).toContain("refl-recent");
    expect(ids).not.toContain("refl-old");
  });

  it("prior_outcomes field is an array (empty when no matching outcomes)", async () => {
    const mod = await import("../index.js");
    const { server } = mod.createServer(":memory:");
    const result = await callTool(server, "knowledge_expert", {
      domain: "deployment",
      issue_number: 1306,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(Array.isArray(payload.prior_outcomes)).toBe(true);
  });

  // Phase 2 telemetry tests

  it("writes an expert_call outcome event with payload.query_id on every call", async () => {
    const mod = await import("../index.js");
    const { server, db } = mod.createServer(":memory:");
    const result = await callTool(server, "knowledge_expert", {
      domain: "auth",
      issue_number: 1306,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;

    // One expert_call event should exist for issue 1306
    const events = db.queryOutcomeEvents({ issueNumber: 1306, eventType: "expert_call" });
    expect(events).toHaveLength(1);

    // Payload must carry query_id and domain
    const evtPayload = JSON.parse(events[0].payload) as Record<string, unknown>;
    expect(evtPayload.query_id).toBe(payload.query_id);
    expect(evtPayload.domain).toBe("auth");
  });

  it("expert_call event payload includes returned_doc_ids with wiki and reflections arrays", async () => {
    const mod = await import("../index.js");
    const { server, db } = mod.createServer(":memory:");
    // Seed a wiki doc tagged 'logging'
    db.upsertDocument({
      id: "wiki-logging",
      path: "thoughts/wiki/logging.md",
      title: "Logging",
      date: "2026-04-01",
      type: null,
      status: null,
      githubIssue: null,
      content: "Logging best practices.",
      memoryTier: "wiki",
    });
    db.setTags("wiki-logging", ["logging"]);

    await callTool(server, "knowledge_expert", { domain: "logging", issue_number: 1306 });

    const events = db.queryOutcomeEvents({ issueNumber: 1306, eventType: "expert_call" });
    expect(events).toHaveLength(1);
    const evtPayload = JSON.parse(events[0].payload) as Record<string, unknown>;
    const returnedDocIds = evtPayload.returned_doc_ids as { wiki: string[]; reflections: string[] };
    expect(returnedDocIds.wiki).toContain("wiki-logging");
    expect(Array.isArray(returnedDocIds.reflections)).toBe(true);
  });

  it("knowledge_record_outcome accepts query_id and stores it in payload", async () => {
    const mod = await import("../index.js");
    const { server, db } = mod.createServer(":memory:");

    // First call knowledge_expert to get a query_id
    const expertResult = await callTool(server, "knowledge_expert", {
      domain: "auth",
      issue_number: 1306,
    });
    expect(expertResult.isError).not.toBe(true);
    const queryId = (JSON.parse(expertResult.content[0].text) as Record<string, unknown>).query_id as string;

    // Record an outcome correlated to the expert call
    const recordResult = await callTool(server, "knowledge_record_outcome", {
      event_type: "phase_completed",
      issue_number: 1306,
      query_id: queryId,
      verdict: "pass",
    });
    expect(recordResult.isError).not.toBe(true);

    // Query by query_id: both the expert_call row and the phase_completed row must return
    const correlated = db.queryOutcomeEventsByQueryId(queryId);
    expect(correlated).toHaveLength(2);

    // Verify both event types are present
    const eventTypes = correlated.map((e) => e.eventType);
    expect(eventTypes).toContain("expert_call");
    expect(eventTypes).toContain("phase_completed");
  });

  it("knowledge_record_outcome without query_id still works (backwards compatible)", async () => {
    const mod = await import("../index.js");
    const { server, db } = mod.createServer(":memory:");

    // Call without query_id — must not error
    const result = await callTool(server, "knowledge_record_outcome", {
      event_type: "research_started",
      issue_number: 9999,
      verdict: "pass",
    });
    expect(result.isError).not.toBe(true);

    // Event is stored; querying by a random query_id returns nothing
    const events = db.queryOutcomeEvents({ issueNumber: 9999 });
    expect(events).toHaveLength(1);
    const evtPayload = JSON.parse(events[0].payload) as Record<string, unknown>;
    // query_id should be absent from payload
    expect(evtPayload.query_id).toBeUndefined();
  });

  it("queryOutcomeEventsByQueryId returns only events matching the query_id", async () => {
    const mod = await import("../index.js");
    const { server, db } = mod.createServer(":memory:");

    // Call knowledge_expert twice — two different query_ids
    const r1 = await callTool(server, "knowledge_expert", { domain: "auth", issue_number: 1306 });
    const r2 = await callTool(server, "knowledge_expert", { domain: "caching", issue_number: 1306 });
    const qid1 = (JSON.parse(r1.content[0].text) as Record<string, unknown>).query_id as string;
    const qid2 = (JSON.parse(r2.content[0].text) as Record<string, unknown>).query_id as string;

    // Add a correlated outcome for qid1 only
    await callTool(server, "knowledge_record_outcome", {
      event_type: "phase_completed",
      issue_number: 1306,
      query_id: qid1,
    });

    const byQid1 = db.queryOutcomeEventsByQueryId(qid1);
    const byQid2 = db.queryOutcomeEventsByQueryId(qid2);

    // qid1: expert_call + phase_completed = 2
    expect(byQid1).toHaveLength(2);
    // qid2: only its expert_call = 1
    expect(byQid2).toHaveLength(1);
  });

  it("prior_outcomes domain filter is applied in SQL before LIMIT (not JS-side after)", async () => {
    // Regression test: a burst of M other-domain expert_call rows (more recent) must not
    // starve the target domain when prior_outcomes uses a SQL domain predicate + LIMIT.
    const mod = await import("../index.js");
    const { server, db } = mod.createServer(":memory:");

    // Seed N=3 target-domain expert_call rows
    for (let i = 0; i < 3; i++) {
      db.insertOutcomeEvent({
        eventType: "expert_call",
        issueNumber: 1306,
        sessionId: `session-target-${i}`,
        agentType: "knowledge_expert",
        payload: { domain: "auth", query_id: `qid-auth-${i}` },
      });
    }

    // Seed M=5 other-domain expert_call rows (these are more recent because inserted after)
    for (let i = 0; i < 5; i++) {
      db.insertOutcomeEvent({
        eventType: "expert_call",
        issueNumber: 1306,
        sessionId: `session-other-${i}`,
        agentType: "knowledge_expert",
        payload: { domain: "caching", query_id: `qid-caching-${i}` },
      });
    }

    // Call knowledge_expert for "auth" with limit=3.
    // Without the SQL domain predicate, the 5 "caching" rows (being more recent) would
    // consume the entire LIMIT before the JS filter runs, returning 0 "auth" rows.
    // With the fix, the SQL WHERE filters first and we get back up to 3 "auth" rows.
    const result = await callTool(server, "knowledge_expert", {
      domain: "auth",
      issue_number: 1306,
      limit: 3,
    });
    expect(result.isError).not.toBe(true);

    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    const priorOutcomes = payload.prior_outcomes as unknown[];

    // Must return the 3 seeded "auth" rows, not 0 (the pre-fix behavior)
    expect(priorOutcomes).toHaveLength(3);
    // Confirm all returned rows are for the "auth" domain
    for (const row of priorOutcomes) {
      const rowPayload = JSON.parse((row as { payload: string }).payload) as Record<string, unknown>;
      expect(rowPayload.domain).toBe("auth");
    }
  });
});
