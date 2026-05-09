import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KnowledgeDB } from "../db.js";

/**
 * Helper: call the MCP `knowledge_memory_stats` tool directly via the
 * server's private `_registeredTools` map. Mirrors graph-tools.test.ts.
 */
async function callStats(
  server: McpServer,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const registered = (server as unknown as Record<string, unknown>)
    ._registeredTools as Record<
    string,
    { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
  >;
  const tool = registered.knowledge_memory_stats;
  if (!tool) throw new Error("knowledge_memory_stats not registered");
  const result = (await tool.handler(args, {})) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  if (result.isError) {
    throw new Error(`tool error: ${result.content[0]?.text}`);
  }
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

/**
 * Ensure the v3 schema extensions (memory_tier column on documents, chunks
 * table) exist on the test DB. Phase 1 (GH-762) owns the production schema
 * migration; test fixtures add them so Phase 8 features can be exercised
 * independently of Phase 1 merge order.
 */
function ensureV3Schema(db: KnowledgeDB): void {
  const rows = db.db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>;
  if (!rows.some((r) => r.name === "memory_tier")) {
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
}

function seedDoc(
  db: KnowledgeDB,
  id: string,
  tier: "doc" | "raw" | "reflection",
  date: string | null,
): void {
  db.upsertDocument({
    id,
    path: `${id}.md`,
    title: id,
    date,
    type: null,
    status: null,
    githubIssue: null,
    content: "",
  });
  db.db.prepare("UPDATE documents SET memory_tier = ? WHERE id = ?").run(tier, id);
}

function seedChunks(db: KnowledgeDB, docId: string, count: number): void {
  const stmt = db.db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, content, char_start, char_end, context_prefix)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < count; i++) {
    stmt.run(`${docId}#c${i}`, docId, i, `chunk ${i}`, i * 100, (i + 1) * 100, "");
  }
}

describe("knowledge_memory_stats", () => {
  it("returns tier counts matching the fixture", async () => {
    const mod = await import("../index.js");
    const { server, db } = mod.createServer(":memory:");
    ensureV3Schema(db);

    // 2 doc, 3 raw, 1 reflection
    seedDoc(db, "d1", "doc", "2026-04-01");
    seedDoc(db, "d2", "doc", "2026-04-02");
    seedDoc(db, "r1", "raw", "2026-04-03");
    seedDoc(db, "r2", "raw", "2026-04-03");
    seedDoc(db, "r3", "raw", "2026-04-04");
    seedDoc(db, "f1", "reflection", "2026-04-05");

    const out = await callStats(server, { since: "1970-01-01T00:00:00Z" });
    expect(out.total_documents).toBe(6);
    expect(out.by_tier).toEqual({ doc: 2, raw: 3, reflection: 1, wiki: 0 });
    expect(out.new_since).toEqual({ doc: 2, raw: 3, reflection: 1, wiki: 0 });
  });

  it("computes chunks_per_doc_p50 and _p90 correctly on [1,2,3,4,5]", async () => {
    const mod = await import("../index.js");
    const { server, db } = mod.createServer(":memory:");
    ensureV3Schema(db);

    // Seed 5 docs each with 1,2,3,4,5 chunks respectively
    const counts = [1, 2, 3, 4, 5];
    for (let i = 0; i < counts.length; i++) {
      const id = `chunked-${i}`;
      seedDoc(db, id, "doc", "2026-04-10");
      seedChunks(db, id, counts[i]);
    }

    const out = await callStats(server, { since: "1970-01-01T00:00:00Z" });
    // sorted counts: [1,2,3,4,5]. floor(5*0.5)=2 -> 3; floor(5*0.9)=4 -> 5.
    expect(out.chunks_per_doc_p50).toBe(3);
    expect(out.chunks_per_doc_p90).toBe(5);
  });

  it("returns last_reflection_at as null when no reflection docs exist", async () => {
    const mod = await import("../index.js");
    const { server, db } = mod.createServer(":memory:");
    ensureV3Schema(db);

    seedDoc(db, "only-doc", "doc", "2026-04-01");

    const out = await callStats(server, { since: "1970-01-01T00:00:00Z" });
    expect(out.last_reflection_at).toBeNull();
  });

  it("returns ISO timestamp of most recent reflection when present", async () => {
    const mod = await import("../index.js");
    const { server, db } = mod.createServer(":memory:");
    ensureV3Schema(db);

    seedDoc(db, "r-older", "reflection", "2026-03-01");
    seedDoc(db, "r-newer", "reflection", "2026-04-10");

    const out = await callStats(server, { since: "1970-01-01T00:00:00Z" });
    expect(out.last_reflection_at).toBe("2026-04-10");
  });

  it("counts new_since correctly when filtering by timestamp", async () => {
    const mod = await import("../index.js");
    const { server, db } = mod.createServer(":memory:");
    ensureV3Schema(db);

    seedDoc(db, "old-doc", "doc", "2026-01-01");
    seedDoc(db, "new-doc", "doc", "2026-05-01");
    seedDoc(db, "old-raw", "raw", "2026-01-15");
    seedDoc(db, "new-raw", "raw", "2026-05-02");

    const out = await callStats(server, { since: "2026-04-01T00:00:00Z" });
    expect(out.total_documents).toBe(4);
    expect(out.by_tier).toEqual({ doc: 2, raw: 2, reflection: 0, wiki: 0 });
    expect(out.new_since).toEqual({ doc: 1, raw: 1, reflection: 0, wiki: 0 });
  });

  it("defaults `since` to ~24h ago when not provided", async () => {
    const mod = await import("../index.js");
    const { server, db } = mod.createServer(":memory:");
    ensureV3Schema(db);
    seedDoc(db, "d1", "doc", "2026-04-01");

    const out = await callStats(server);
    const since = out.since as string;
    expect(since).toBeTruthy();
    const sinceMs = Date.parse(since);
    const nowMs = Date.now();
    // Allow a wide window to accommodate slow test startup; the spec is 24h.
    const ageMs = nowMs - sinceMs;
    expect(ageMs).toBeGreaterThanOrEqual(23.5 * 3600 * 1000);
    expect(ageMs).toBeLessThanOrEqual(24.5 * 3600 * 1000);
  });

  it("reports all documents as tier 'doc' on a v2 schema (column absent)", async () => {
    const mod = await import("../index.js");
    const { server, db } = mod.createServer(":memory:");
    // Intentionally do NOT call ensureV3Schema — simulate v2 DB.

    db.upsertDocument({
      id: "legacy-doc",
      path: "l.md",
      title: "Legacy",
      date: "2026-04-01",
      type: null,
      status: null,
      githubIssue: null,
      content: "",
    });

    const out = await callStats(server, { since: "1970-01-01T00:00:00Z" });
    expect(out.total_documents).toBe(1);
    expect(out.by_tier).toEqual({ doc: 1, raw: 0, reflection: 0, wiki: 0 });
    expect(out.chunks_per_doc_p50).toBe(0);
    expect(out.chunks_per_doc_p90).toBe(0);
    expect(out.last_reflection_at).toBeNull();
  });

  describe("stub filtering (GH-897)", () => {
    it("excludes stubs from total_documents and by_tier on v3 schema", async () => {
      const mod = await import("../index.js");
      const { server, db } = mod.createServer(":memory:");
      ensureV3Schema(db);

      // Two real docs across two tiers.
      seedDoc(db, "real-doc", "doc", "2026-04-10");
      seedDoc(db, "real-reflection", "reflection", "2026-04-11");

      // Three stubs (default memory_tier = 'doc' per migration).
      db.upsertStubDocument("stub-1");
      db.upsertStubDocument("stub-2");
      db.upsertStubDocument("stub-3");

      const out = await callStats(server, { since: "1970-01-01T00:00:00Z" });
      expect(out.total_documents).toBe(2);
      expect(out.by_tier).toEqual({ doc: 1, raw: 0, reflection: 1, wiki: 0 });
      // new_since unaffected — stubs have date = NULL and never count regardless.
      expect(out.new_since).toEqual({ doc: 1, raw: 0, reflection: 1, wiki: 0 });
    });

    it("excludes stubs from total on a v2 schema (column absent)", async () => {
      const mod = await import("../index.js");
      const { server, db } = mod.createServer(":memory:");
      // Do NOT call ensureV3Schema; v2 path uses the standalone total query and
      // assigns it to byTier.doc.

      db.upsertDocument({
        id: "legacy-real",
        path: "l.md",
        title: "Legacy",
        date: "2026-04-01",
        type: null,
        status: null,
        githubIssue: null,
        content: "",
      });
      db.upsertStubDocument("legacy-stub");

      const out = await callStats(server, { since: "1970-01-01T00:00:00Z" });
      expect(out.total_documents).toBe(1);
      expect(out.by_tier).toEqual({ doc: 1, raw: 0, reflection: 0, wiki: 0 });
    });

    it("typed-relationship stubs are filtered identically to untyped wikilink stubs", async () => {
      const mod = await import("../index.js");
      const { server, db } = mod.createServer(":memory:");
      ensureV3Schema(db);

      seedDoc(db, "real-source", "doc", "2026-04-10");
      // Stub created via typed relationship target.
      db.upsertStubDocument("typed-stub-target");
      db.addRelationship("real-source", "typed-stub-target", "builds_on");

      const out = await callStats(server, { since: "1970-01-01T00:00:00Z" });
      expect(out.total_documents).toBe(1);
      expect(out.by_tier).toEqual({ doc: 1, raw: 0, reflection: 0, wiki: 0 });
    });

    it("last_reflection_at ignores stubs even if a stub somehow had a date and reflection tier", async () => {
      const mod = await import("../index.js");
      const { server, db } = mod.createServer(":memory:");
      ensureV3Schema(db);

      seedDoc(db, "real-reflection-old", "reflection", "2026-03-01");
      // Force a stub into the reflection tier with a future date — defense-in-depth check.
      db.upsertStubDocument("future-reflection-stub");
      db.db
        .prepare("UPDATE documents SET memory_tier = 'reflection', date = '2099-01-01' WHERE id = ?")
        .run("future-reflection-stub");

      const out = await callStats(server, { since: "1970-01-01T00:00:00Z" });
      // Without the filter, the stub's "2099-01-01" would surface as last_reflection_at.
      expect(out.last_reflection_at).toBe("2026-03-01");
    });
  });
});
