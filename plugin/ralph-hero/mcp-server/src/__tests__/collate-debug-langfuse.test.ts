/**
 * Integration test: `ralph_hero__collate_debug` end-to-end with a stubbed
 * Langfuse client. Loads `langfuse-spans.fixture.json` from disk and asserts
 * that the grouped report matches the expected shape and counts.
 *
 * The Langfuse `fetch` is stubbed via `setLangfuseClientFactory` — no live
 * network, no environment variables required.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerDebugTools,
  setLangfuseClientFactory,
} from "../tools/debug-tools.js";
import type { GitHubClient } from "../github-client.js";
import {
  createLangfuseClient,
  type LangfuseClient,
  type LangfuseObservation,
  type LangfusePage,
} from "../lib/langfuse-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface HandlerResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface RegisteredTool {
  handler: (args: unknown, extra: unknown) => Promise<HandlerResult>;
}

function getTool(server: McpServer, name: string): RegisteredTool {
  const tools = (
    server as unknown as { _registeredTools: Record<string, RegisteredTool> }
  )._registeredTools;
  const tool = tools?.[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool;
}

function parsePayload(result: HandlerResult): Record<string, unknown> {
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function makeMockClient(): GitHubClient {
  return {
    config: {
      token: "tok",
      owner: "owner",
      repo: "repo",
      projectNumber: 1,
    },
  } as unknown as GitHubClient;
}

interface StubOptions {
  recordedUrls: string[];
  recordedHeaders: Array<Record<string, string>>;
  responder?: (url: string) => unknown;
}

function makeFetchStubFromFixture(
  fixture: LangfusePage<LangfuseObservation>,
  opts: StubOptions,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    opts.recordedUrls.push(url);
    const headers: Record<string, string> = {};
    const reqHeaders = init?.headers as Record<string, string> | undefined;
    if (reqHeaders) for (const [k, v] of Object.entries(reqHeaders)) headers[k] = v;
    opts.recordedHeaders.push(headers);

    if (opts.responder) {
      const v = opts.responder(url);
      if (v instanceof Response) return v;
      return new Response(JSON.stringify(v), { status: 200 });
    }
    return new Response(JSON.stringify(fixture), { status: 200 });
  }) as unknown as typeof fetch;
}

async function loadFixture(): Promise<LangfusePage<LangfuseObservation>> {
  const fixturePath = join(
    __dirname,
    "fixtures",
    "langfuse-spans.fixture.json",
  );
  const text = await readFile(fixturePath, "utf-8");
  return JSON.parse(text) as LangfusePage<LangfuseObservation>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ralph_hero__collate_debug — Langfuse path (Phase 3a)", () => {
  let server: McpServer;
  let restoreFactory: (() => void) | undefined;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    registerDebugTools(server, makeMockClient());
  });

  afterEach(() => {
    if (restoreFactory) {
      restoreFactory();
      restoreFactory = undefined;
    }
  });

  it("returns a grouped report from the fixture with dryRun=true", async () => {
    const fixture = await loadFixture();
    const recordedUrls: string[] = [];
    const recordedHeaders: Array<Record<string, string>> = [];

    let firstCall = true;
    const stubFetch = makeFetchStubFromFixture(fixture, {
      recordedUrls,
      recordedHeaders,
      responder: (_url) => {
        if (firstCall) {
          firstCall = false;
          return fixture;
        }
        // Second page returns empty so pagination stops.
        return { data: [] };
      },
    });

    restoreFactory = setLangfuseClientFactory(() => {
      return createLangfuseClient({
        publicKey: "pk-lf-local-dev",
        secretKey: "sk-lf-local-dev",
        host: "http://localhost:3100",
        fetchImpl: stubFetch,
      }) as LangfuseClient;
    });

    const tool = getTool(server, "ralph_hero__collate_debug");
    const result = await tool.handler({ dryRun: true, minOccurrences: 3 }, {});
    const payload = parsePayload(result);

    expect(payload.dryRun).toBe(true);
    // Fixture has 3 distinct signatures, all >=3 occurrences:
    //   - GetIssue "Issue #N not found" (count 4)
    //   - rate_limit "rate limit exceeded; retry after <N>s" (count 4)
    //   - network "network error connecting to <STR>" (count 2)
    //     -> filtered out by minOccurrences=3
    expect(payload.errorGroups).toBe(2);
    expect(payload.totalOccurrences).toBe(8);

    const groups = payload.groups as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(2);
    // Sorted by count desc, both have 4 occurrences — either could be first.
    for (const g of groups) {
      expect(g.count).toBe(4);
      expect(g.hash).toMatch(/^[0-9a-f]{8}$/);
      expect(typeof g.signature).toBe("string");
      expect(typeof g.exampleTraceUrl).toBe("string");
      expect((g.exampleTraceUrl as string)).toContain(
        "http://localhost:3100/project/",
      );
      const sampleSpans = g.sampleSpans as unknown[];
      expect(Array.isArray(sampleSpans)).toBe(true);
      expect(sampleSpans.length).toBeGreaterThan(0);
      expect(sampleSpans.length).toBeLessThanOrEqual(3);
    }

    // Verify the Langfuse HTTP call:
    expect(recordedUrls[0]).toContain("/api/public/observations");
    expect(recordedUrls[0]).toContain("type=SPAN");
    expect(recordedUrls[0]).toContain("level=ERROR");
    expect(recordedUrls[0]).toContain("fromStartTime=");
    expect(recordedHeaders[0]["Authorization"]).toMatch(/^Basic /);
  });

  it("includes all signatures when minOccurrences=1", async () => {
    const fixture = await loadFixture();
    let firstCall = true;
    const stubFetch = makeFetchStubFromFixture(fixture, {
      recordedUrls: [],
      recordedHeaders: [],
      responder: () => {
        if (firstCall) {
          firstCall = false;
          return fixture;
        }
        return { data: [] };
      },
    });

    restoreFactory = setLangfuseClientFactory(() => {
      return createLangfuseClient({
        publicKey: "pk",
        secretKey: "sk",
        host: "http://localhost:3100",
        fetchImpl: stubFetch,
      }) as LangfuseClient;
    });

    const tool = getTool(server, "ralph_hero__collate_debug");
    const result = await tool.handler({ dryRun: true, minOccurrences: 1 }, {});
    const payload = parsePayload(result);
    expect(payload.errorGroups).toBe(3);
    expect(payload.totalOccurrences).toBe(10);
  });

  it("returns toolError when dryRun=false (Phase 3b stub)", async () => {
    const fixture = await loadFixture();
    restoreFactory = setLangfuseClientFactory(() => {
      return createLangfuseClient({
        publicKey: "pk",
        secretKey: "sk",
        host: "http://localhost:3100",
        fetchImpl: makeFetchStubFromFixture(fixture, {
          recordedUrls: [],
          recordedHeaders: [],
        }),
      }) as LangfuseClient;
    });

    const tool = getTool(server, "ralph_hero__collate_debug");
    const result = await tool.handler({ dryRun: false }, {});
    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toContain("Phase 3b");
  });

  it("returns toolError when Langfuse credentials missing", async () => {
    // Don't override the factory — default factory reads env which won't have
    // creds in test environment.
    const originalPK = process.env.LANGFUSE_PUBLIC_KEY;
    const originalSK = process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    try {
      const tool = getTool(server, "ralph_hero__collate_debug");
      const result = await tool.handler({ dryRun: true }, {});
      expect(result.isError).toBe(true);
      const payload = parsePayload(result);
      expect(payload.error).toContain("Langfuse client unavailable");
    } finally {
      if (originalPK !== undefined) process.env.LANGFUSE_PUBLIC_KEY = originalPK;
      if (originalSK !== undefined) process.env.LANGFUSE_SECRET_KEY = originalSK;
    }
  });

  it("invalid 'since' input returns toolError", async () => {
    restoreFactory = setLangfuseClientFactory(() => {
      return createLangfuseClient({
        publicKey: "pk",
        secretKey: "sk",
        fetchImpl: makeFetchStubFromFixture(
          { data: [] },
          { recordedUrls: [], recordedHeaders: [] },
        ),
      }) as LangfuseClient;
    });
    const tool = getTool(server, "ralph_hero__collate_debug");
    const result = await tool.handler({ dryRun: true, since: "not-a-date" }, {});
    expect(result.isError).toBe(true);
  });
});
