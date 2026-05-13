import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  memoryHash,
  rememberPath,
  renderRememberMarkdown,
} from "../index.js";

/**
 * GH-1205 tests for the `knowledge_remember` MCP tool.
 *
 * Strategy: every test injects `rememberFs` (filesystem stub), `rememberReindex`
 * (single-path index stub), `rememberNow` (clock stub) and `rememberBaseDir`
 * so the suite never touches `~/projects/thoughts/dream-memories/` and never
 * pays the ONNX model download cost. The pure helpers (`memoryHash`,
 * `rememberPath`, `renderRememberMarkdown`) are exercised directly so their
 * deterministic invariants are pinned independent of the tool wiring.
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

describe("memoryHash + rememberPath pure helpers", () => {
  it("memoryHash is deterministic for the same (source, text)", () => {
    const a = memoryHash("agent:impl", "hello world");
    const b = memoryHash("agent:impl", "hello world");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it("memoryHash differs across distinct (source, text) pairs", () => {
    expect(memoryHash("agent:impl", "x")).not.toBe(
      memoryHash("agent:research", "x"),
    );
    expect(memoryHash("agent:impl", "x")).not.toBe(
      memoryHash("agent:impl", "y"),
    );
  });

  it("rememberPath uses UTC date components and lays out agent/YYYY/MM/DD", () => {
    // 2026-05-12 UTC; local-time differences must not shift the path.
    const t = new Date("2026-05-12T03:30:00Z");
    const p = rememberPath("/dream-memories", "agent:impl", "hello", t);
    // Path must include the agent prefix segment.
    expect(p).toContain("/dream-memories/agent/2026/05/12/");
    // Filename is `${source}-${hash12}.md`.
    expect(p.endsWith(".md")).toBe(true);
    const file = p.substring(p.lastIndexOf("/") + 1);
    expect(file.startsWith("agent:impl-")).toBe(true);
    // The 12-char digest is stable.
    const digest = file.replace("agent:impl-", "").replace(".md", "");
    expect(digest).toBe(memoryHash("agent:impl", "hello"));
  });
});

describe("renderRememberMarkdown frontmatter shape", () => {
  it("emits deterministic frontmatter key order so the file is byte-stable", () => {
    const now = new Date("2026-05-12T12:00:00Z");
    const a = renderRememberMarkdown({
      text: "body",
      source: "agent:impl",
      tier: "raw",
      tags: ["alpha", "beta"],
      githubIssue: 1205,
      now,
    });
    const b = renderRememberMarkdown({
      text: "body",
      source: "agent:impl",
      tier: "raw",
      tags: ["alpha", "beta"],
      githubIssue: 1205,
      now,
    });
    expect(a).toBe(b);

    // Key order: date, memory_tier, source, github_issue, tags.
    const dateIdx = a.indexOf("date:");
    const tierIdx = a.indexOf("memory_tier:");
    const sourceIdx = a.indexOf("source:");
    const issueIdx = a.indexOf("github_issue:");
    const tagsIdx = a.indexOf("tags:");
    expect(dateIdx).toBeGreaterThanOrEqual(0);
    expect(tierIdx).toBeGreaterThan(dateIdx);
    expect(sourceIdx).toBeGreaterThan(tierIdx);
    expect(issueIdx).toBeGreaterThan(sourceIdx);
    expect(tagsIdx).toBeGreaterThan(issueIdx);
  });

  it("omits github_issue when not provided and emits empty tags list", () => {
    const now = new Date("2026-05-12T12:00:00Z");
    const rendered = renderRememberMarkdown({
      text: "body",
      source: "agent:impl",
      tier: "raw",
      now,
    });
    expect(rendered).not.toContain("github_issue:");
    expect(rendered).toContain("tags: []");
    expect(rendered).toContain("memory_tier: raw");
  });

  it("strips trailing newlines on the body and appends exactly one", () => {
    const now = new Date("2026-05-12T12:00:00Z");
    const rendered = renderRememberMarkdown({
      text: "body line\n\n\n",
      source: "agent:impl",
      tier: "raw",
      now,
    });
    // No double-trailing newline beyond the final single one.
    expect(rendered.endsWith("body line\n")).toBe(true);
    expect(rendered.endsWith("body line\n\n")).toBe(false);
  });
});

describe("knowledge_remember MCP tool", () => {
  it("is registered with createServer", async () => {
    const mod = await import("../index.js");
    const { server } = mod.createServer(":memory:");
    const registered = (server as unknown as Record<string, unknown>)
      ._registeredTools as Record<string, unknown>;
    expect(registered).toHaveProperty("knowledge_remember");
  });

  it("schema rejects tier='reflection' and tier='wiki'", async () => {
    const mod = await import("../index.js");
    const { server } = mod.createServer(":memory:");
    const registered = (server as unknown as Record<string, unknown>)
      ._registeredTools as Record<string, { inputSchema?: { parse: (v: unknown) => unknown } }>;
    const schema = registered.knowledge_remember?.inputSchema;
    expect(schema).toBeDefined();
    // Valid forms.
    expect(() =>
      schema!.parse({ text: "x", source: "agent:impl", tier: "raw" }),
    ).not.toThrow();
    expect(() =>
      schema!.parse({ text: "x", source: "agent:impl", tier: "doc" }),
    ).not.toThrow();
    // Tier omitted defaults to "raw".
    expect(() => schema!.parse({ text: "x", source: "agent:impl" })).not.toThrow();
    // The two protected tiers must be rejected so reflections/wikis stay
    // owned by the dream-loop and the manual curation pipeline respectively.
    expect(() =>
      schema!.parse({ text: "x", source: "agent:impl", tier: "reflection" }),
    ).toThrow();
    expect(() =>
      schema!.parse({ text: "x", source: "agent:impl", tier: "wiki" }),
    ).toThrow();
    // Empty text + empty source are rejected (avoid junk memories).
    expect(() => schema!.parse({ text: "", source: "agent:impl" })).toThrow();
    expect(() => schema!.parse({ text: "x", source: "" })).toThrow();
  });

  it("writes a file under <baseDir>/agent/YYYY/MM/DD/<source>-<hash>.md and calls reindex once", async () => {
    const mod = await import("../index.js");
    const writes: Array<{ path: string; body: string }> = [];
    const mkdirCalls: string[] = [];
    const reindexCalls: string[] = [];

    const { server } = mod.createServer(":memory:", {
      rememberFs: {
        mkdir: (dir: string) => mkdirCalls.push(dir),
        write: (path: string, body: string) => writes.push({ path, body }),
      },
      rememberReindex: async (path: string) => {
        reindexCalls.push(path);
        return { indexed: true };
      },
      rememberNow: () => new Date("2026-05-12T03:30:00Z"),
      rememberBaseDir: "/tmp/test-dream-memories",
    });

    const result = await callTool(server, "knowledge_remember", {
      text: "decided to keep the embedder at 4 batch size",
      source: "agent:impl",
      tags: ["embedder", "GH-1205"],
      github_issue: 1205,
    });

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as {
      path: string;
      indexed: boolean;
    };
    expect(payload.indexed).toBe(true);
    expect(payload.path).toMatch(
      /\/tmp\/test-dream-memories\/agent\/2026\/05\/12\/agent:impl-[0-9a-f]{12}\.md$/,
    );

    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(payload.path);
    // Body shape sanity: contains frontmatter + the text.
    expect(writes[0].body).toContain("memory_tier: raw");
    expect(writes[0].body).toContain("source: agent:impl");
    expect(writes[0].body).toContain("github_issue: 1205");
    expect(writes[0].body).toContain(
      "decided to keep the embedder at 4 batch size",
    );

    expect(mkdirCalls).toHaveLength(1);
    expect(mkdirCalls[0]).toBe(
      "/tmp/test-dream-memories/agent/2026/05/12",
    );

    expect(reindexCalls).toHaveLength(1);
    expect(reindexCalls[0]).toBe(payload.path);
  });

  it("returns indexed=false but still writes the file when reindex throws", async () => {
    const mod = await import("../index.js");
    const writes: Array<{ path: string; body: string }> = [];
    const { server } = mod.createServer(":memory:", {
      rememberFs: {
        mkdir: () => {},
        write: (path: string, body: string) => writes.push({ path, body }),
      },
      rememberReindex: async () => {
        throw new Error("synthetic reindex failure");
      },
      rememberNow: () => new Date("2026-05-12T00:00:00Z"),
      rememberBaseDir: "/tmp/test-dream-memories",
    });

    const result = await callTool(server, "knowledge_remember", {
      text: "abc",
      source: "agent:impl",
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as {
      path: string;
      indexed: boolean;
    };
    expect(payload.indexed).toBe(false);
    // File-write side effect happened regardless of the reindex failure so
    // the memory isn't lost — the next full reindex will pick it up.
    expect(writes).toHaveLength(1);
  });

  it("returns indexed=false when reindex resolves false (parse/embed error)", async () => {
    const mod = await import("../index.js");
    const { server } = mod.createServer(":memory:", {
      rememberFs: { mkdir: () => {}, write: () => {} },
      rememberReindex: async () => ({ indexed: false }),
      rememberNow: () => new Date("2026-05-12T00:00:00Z"),
      rememberBaseDir: "/tmp/test-dream-memories",
    });
    const result = await callTool(server, "knowledge_remember", {
      text: "abc",
      source: "agent:impl",
    });
    const payload = JSON.parse(result.content[0].text) as {
      indexed: boolean;
    };
    expect(payload.indexed).toBe(false);
  });

  it("produces byte-identical output across two identical calls (idempotence)", async () => {
    const mod = await import("../index.js");
    const writes: Array<{ path: string; body: string }> = [];
    const { server } = mod.createServer(":memory:", {
      rememberFs: {
        mkdir: () => {},
        write: (path: string, body: string) => writes.push({ path, body }),
      },
      rememberReindex: async () => ({ indexed: true }),
      rememberNow: () => new Date("2026-05-12T03:30:00Z"),
      rememberBaseDir: "/tmp/test-dream-memories",
    });

    await callTool(server, "knowledge_remember", {
      text: "the answer is 42",
      source: "agent:impl",
      tags: ["x"],
    });
    await callTool(server, "knowledge_remember", {
      text: "the answer is 42",
      source: "agent:impl",
      tags: ["x"],
    });
    expect(writes).toHaveLength(2);
    expect(writes[0].path).toBe(writes[1].path);
    expect(writes[0].body).toBe(writes[1].body);
  });
});
