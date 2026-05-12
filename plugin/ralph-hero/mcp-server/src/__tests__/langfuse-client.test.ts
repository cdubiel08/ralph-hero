import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createLangfuseClient,
  type LangfusePage,
  type LangfuseObservation,
} from "../lib/langfuse-client.js";

// ---------------------------------------------------------------------------
// Fetch stub helpers
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

function makeFetchStub(
  responder: (url: string) => unknown,
  recorded: RecordedCall[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    const reqHeaders = init?.headers as Record<string, string> | undefined;
    if (reqHeaders) {
      for (const [k, v] of Object.entries(reqHeaders)) headers[k] = v;
    }
    recorded.push({ url, headers });

    const value = responder(url);
    if (value instanceof Response) return value;
    if (value && typeof value === "object" && "status" in (value as object)) {
      const v = value as { status: number; body?: unknown; statusText?: string };
      return new Response(JSON.stringify(v.body ?? null), {
        status: v.status,
        statusText: v.statusText ?? "",
      });
    }
    return new Response(JSON.stringify(value), { status: 200 });
  }) as unknown as typeof fetch;
}

function makeObservation(
  overrides: Partial<LangfuseObservation> = {},
): LangfuseObservation {
  return {
    id: "obs-1",
    traceId: "trace-1",
    name: "ralph_hero.graphql",
    startTime: "2026-05-11T00:00:00Z",
    type: "SPAN",
    level: "ERROR",
    statusMessage: "boom",
    metadata: { "ralph_hero.error_type": "graphql" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createLangfuseClient — construction
// ---------------------------------------------------------------------------

describe("createLangfuseClient", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_HOST;
  });

  afterEach(() => {
    // Restore env vars touched by tests.
    process.env = { ...originalEnv };
  });

  it("throws when publicKey/secretKey missing", () => {
    expect(() => createLangfuseClient()).toThrow(/Langfuse credentials missing/);
  });

  it("uses default host when none provided", () => {
    const client = createLangfuseClient({
      publicKey: "pk",
      secretKey: "sk",
      fetchImpl: makeFetchStub(() => ({ data: [], meta: {} }), []),
    });
    expect(client.host).toBe("http://localhost:3100");
  });

  it("strips trailing slashes from host", () => {
    const client = createLangfuseClient({
      host: "https://example.com////",
      publicKey: "pk",
      secretKey: "sk",
      fetchImpl: makeFetchStub(() => ({ data: [] }), []),
    });
    expect(client.host).toBe("https://example.com");
  });

  it("reads credentials from env vars", () => {
    process.env.LANGFUSE_PUBLIC_KEY = "env-pk";
    process.env.LANGFUSE_SECRET_KEY = "env-sk";
    expect(() =>
      createLangfuseClient({
        fetchImpl: makeFetchStub(() => ({ data: [] }), []),
      }),
    ).not.toThrow();
    // Restore manually since we don't use afterEach here
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
  });

  // -------------------------------------------------------------------------
  // queryTraces
  // -------------------------------------------------------------------------
  it("queryTraces hits /api/public/traces with basic auth", async () => {
    const recorded: RecordedCall[] = [];
    const client = createLangfuseClient({
      host: "http://localhost:3100",
      publicKey: "pk-lf-local-dev",
      secretKey: "sk-lf-local-dev",
      fetchImpl: makeFetchStub(
        () => ({ data: [{ id: "t1", timestamp: "now" }] }),
        recorded,
      ),
    });
    const result = await client.queryTraces({ limit: 10 });
    expect(result.data).toHaveLength(1);
    expect(recorded[0].url).toContain("/api/public/traces");
    expect(recorded[0].url).toContain("limit=10");
    expect(recorded[0].headers["Authorization"]).toMatch(/^Basic /);
    // base64("pk-lf-local-dev:sk-lf-local-dev")
    const expected = Buffer.from(
      "pk-lf-local-dev:sk-lf-local-dev",
      "utf-8",
    ).toString("base64");
    expect(recorded[0].headers["Authorization"]).toBe(`Basic ${expected}`);
  });

  // -------------------------------------------------------------------------
  // queryObservations
  // -------------------------------------------------------------------------
  it("queryObservations passes filters as query params", async () => {
    const recorded: RecordedCall[] = [];
    const client = createLangfuseClient({
      publicKey: "pk",
      secretKey: "sk",
      fetchImpl: makeFetchStub(() => ({ data: [makeObservation()] }), recorded),
    });
    await client.queryObservations({
      type: "SPAN",
      level: "ERROR",
      fromStartTime: "2026-05-10T00:00:00Z",
      limit: 50,
      page: 1,
    });
    const url = recorded[0].url;
    expect(url).toContain("/api/public/observations");
    expect(url).toContain("type=SPAN");
    expect(url).toContain("level=ERROR");
    expect(url).toContain("fromStartTime=");
    expect(url).toContain("limit=50");
    expect(url).toContain("page=1");
  });

  it("queryObservations throws on non-2xx response", async () => {
    const client = createLangfuseClient({
      publicKey: "pk",
      secretKey: "sk",
      fetchImpl: makeFetchStub(
        () => ({ status: 401, body: { error: "unauthorized" } }),
        [],
      ),
    });
    await expect(client.queryObservations()).rejects.toThrow(
      /Langfuse request failed: 401/,
    );
  });

  // -------------------------------------------------------------------------
  // queryAllObservations pagination
  // -------------------------------------------------------------------------
  it("queryAllObservations paginates until empty page", async () => {
    const recorded: RecordedCall[] = [];
    let page = 0;
    const pages: LangfusePage<LangfuseObservation>[] = [
      {
        data: [
          makeObservation({ id: "o1", traceId: "t1" }),
          makeObservation({ id: "o2", traceId: "t2" }),
        ],
        meta: { totalPages: 2, page: 1, limit: 2 },
      },
      {
        data: [makeObservation({ id: "o3", traceId: "t3" })],
        meta: { totalPages: 2, page: 2, limit: 2 },
      },
      { data: [] },
    ];
    const client = createLangfuseClient({
      publicKey: "pk",
      secretKey: "sk",
      fetchImpl: makeFetchStub(() => {
        const out = pages[page] ?? { data: [] };
        page += 1;
        return out;
      }, recorded),
    });

    const all = await client.queryAllObservations({ limit: 2 });
    // Page 1 has 2 items (== limit), continues. Page 2 has 1 item (< limit), stops.
    expect(all).toHaveLength(3);
    expect(recorded).toHaveLength(2);
    expect(recorded[0].url).toContain("page=1");
    expect(recorded[1].url).toContain("page=2");
  });

  it("queryAllObservations stops at maxPages", async () => {
    const recorded: RecordedCall[] = [];
    const client = createLangfuseClient({
      publicKey: "pk",
      secretKey: "sk",
      // Always return a full page so the loop would never stop on its own
      fetchImpl: makeFetchStub(
        () => ({
          data: [
            makeObservation({ id: "x" }),
            makeObservation({ id: "y" }),
          ],
          meta: {},
        }),
        recorded,
      ),
    });
    const all = await client.queryAllObservations({ limit: 2 }, 3);
    expect(recorded).toHaveLength(3);
    expect(all).toHaveLength(6);
  });
});
