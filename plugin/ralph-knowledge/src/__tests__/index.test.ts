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
