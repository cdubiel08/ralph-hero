import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KnowledgeDB } from "../db.js";

/**
 * GH-1512 tests for the `knowledge_think` MCP tool wiring: retrieve grounding
 * excerpts, synthesize a cited answer + gaps via an injected (stub) LLM
 * completion, and fail open when the model is offline. The synthesis logic
 * itself is unit-tested in think.test.ts; this verifies registration, schema,
 * retrieval→sources mapping, and the thinkComplete seam.
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
  const registered = (toolServer as unknown as Record<string, unknown>)
    ._registeredTools as Record<
    string,
    { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
  >;
  const tool = registered?.[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool.handler(args, {}) as Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

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
       chunk_index INTEGER NOT NULL, content TEXT NOT NULL,
       char_start INTEGER NOT NULL, char_end INTEGER NOT NULL,
       context_prefix TEXT NOT NULL DEFAULT '', UNIQUE(document_id, chunk_index))`,
  );
}

class StubReranker {
  constructor(public readonly scoreMap: Map<string, number>) {}
  async score(_q: string, docs: Array<{ id: string; text: string }>): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const d of docs) if (this.scoreMap.has(d.id)) out.set(d.id, this.scoreMap.get(d.id)!);
    return out;
  }
}

async function seedServer(thinkComplete: (p: string) => Promise<string>): Promise<{
  server: McpServer;
  prompts: string[];
}> {
  const prompts: string[] = [];
  const wrapped = async (p: string) => {
    prompts.push(p);
    return thinkComplete(p);
  };
  const mod = await import("../index.js");
  const { server, db, fts, vec } = mod.createServer(":memory:", {
    embedFn: mockEmbedFn,
    rerankerFactory: () =>
      new StubReranker(
        new Map([
          ["reflect-1", 3.0],
          ["raw-1", 2.0],
        ]),
      ) as unknown as import("../reranker.js").Reranker,
    thinkComplete: wrapped,
  });
  ensureV3Schema(db);
  db.upsertDocument({
    id: "reflect-1", path: "reflect-1.md", title: "Clustering rework",
    date: "2026-06-01", type: null, status: null, githubIssue: null,
    content: "Agglomerative clustering beat HDBSCAN on the sparse reflection stream.",
  });
  db.upsertDocument({
    id: "raw-1", path: "raw-1.md", title: "Session",
    date: "2026-06-02", type: null, status: null, githubIssue: null,
    content: "We chose cosine distance 0.40 for clustering.",
  });
  db.db.prepare("UPDATE documents SET memory_tier=? WHERE id=?").run("reflection", "reflect-1");
  db.db.prepare("UPDATE documents SET memory_tier=? WHERE id=?").run("raw", "raw-1");
  fts.rebuildIndex();
  vec.createIndex();
  const qEmb = await mockEmbedFn("clustering");
  vec.upsertEmbedding("reflect-1", qEmb);
  vec.upsertEmbedding("raw-1", qEmb);
  return { server, prompts };
}

describe("knowledge_think registration + schema", () => {
  it("registers the tool with a query (required) and optional role/limit", async () => {
    const mod = await import("../index.js");
    const { server } = mod.createServer(":memory:");
    const registered = (server as unknown as Record<string, unknown>)
      ._registeredTools as Record<string, { inputSchema?: { parse: (v: unknown) => unknown } }>;
    expect(registered).toHaveProperty("knowledge_think");
    const schema = registered.knowledge_think?.inputSchema;
    expect(() => schema!.parse({ query: "x" })).not.toThrow();
    expect(() => schema!.parse({ query: "x", role: "planner", limit: 5 })).not.toThrow();
    expect(() => schema!.parse({ query: "x", role: "philosopher" })).toThrow();
    expect(() => schema!.parse({})).toThrow();
  });
});

describe("knowledge_think synthesis", () => {
  it("grounds the prompt in retrieved ids and returns a cited answer + gaps", async () => {
    const { server, prompts } = await seedServer(async () =>
      '{"answer": "Agglomerative was chosen [reflect-1].", "gaps": "No N>1000 benchmark."}',
    );
    const result = await callTool(server, "knowledge_think", { query: "clustering", limit: 8 });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as {
      answer: string; gaps: string; synthesized: boolean;
      sources: Array<{ id: string; tier?: string }>;
    };
    expect(payload.synthesized).toBe(true);
    expect(payload.answer).toContain("[reflect-1]");
    expect(payload.gaps).toContain("benchmark");
    const ids = payload.sources.map((s) => s.id);
    expect(ids).toContain("reflect-1");
    // the LLM prompt was grounded in the retrieved excerpts
    expect(prompts[0]).toContain("reflect-1");
    // tier is resolved onto the sources
    expect(payload.sources.find((s) => s.id === "reflect-1")?.tier).toBe("reflection");
  });

  it("with a role, fans out across the role's tiers and still synthesizes", async () => {
    const { server } = await seedServer(async () =>
      '{"answer": "a [reflect-1]", "gaps": "none"}',
    );
    const result = await callTool(server, "knowledge_think", {
      query: "clustering",
      role: "researcher",
      limit: 8,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as {
      synthesized: boolean; sources: Array<{ id: string }>;
    };
    expect(payload.synthesized).toBe(true);
    const ids = payload.sources.map((s) => s.id);
    expect(ids).toContain("reflect-1"); // reflection tier is in researcher policy
  });

  it("fails open when the local model is offline (empty completion)", async () => {
    const { server } = await seedServer(async () => "");
    const result = await callTool(server, "knowledge_think", { query: "clustering" });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as {
      synthesized: boolean; gaps: string; sources: unknown[];
    };
    expect(payload.synthesized).toBe(false);
    expect(payload.gaps.toLowerCase()).toContain("unavailable");
    expect(payload.sources.length).toBeGreaterThan(0);
  });
});
