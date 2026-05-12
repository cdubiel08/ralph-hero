/**
 * Verifies that `createGitHubClient`'s GraphQL executor emits a
 * `ralph_hero.graphql` span with the expected attributes for both success
 * and failure paths. Uses an in-memory span exporter — no live OTel SDK
 * or Langfuse traffic.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";

// Mock @octokit/graphql so we can drive success/failure paths deterministically.
const mockGraphqlImpl = vi.fn();
vi.mock("@octokit/graphql", () => {
  const mockGraphql = vi.fn((...args: unknown[]) => mockGraphqlImpl(...args));
  // Octokit's graphql.defaults() returns a callable that we route through the
  // same mock — defaults are metadata only for our purposes.
  (mockGraphql as unknown as { defaults: typeof mockGraphql }).defaults = vi
    .fn()
    .mockReturnValue(mockGraphql);
  return { graphql: mockGraphql };
});

// Defer importing the client until after the mock is registered.
let createGitHubClient: typeof import("../github-client.js").createGitHubClient;

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(async () => {
  trace.setGlobalTracerProvider(provider);
  createGitHubClient = (await import("../github-client.js")).createGitHubClient;
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});

describe("github-client span emission", () => {
  it("emits a ralph_hero.graphql span on success with rate-limit attributes", async () => {
    exporter.reset();
    mockGraphqlImpl.mockResolvedValueOnce({
      viewer: { login: "test-user" },
      rateLimit: { remaining: 4500, cost: 1, limit: 5000, resetAt: "", nodeCount: 1 },
    });

    const client = createGitHubClient({ token: "tok", owner: "o", repo: "r" });
    const result = await client.query<{ viewer: { login: string } }>(
      "query getViewer { viewer { login } }",
    );
    expect(result.viewer.login).toBe("test-user");

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("ralph_hero.graphql");
    expect(spans[0].attributes["ralph_hero.operation"]).toBe("getViewer");
    expect(spans[0].attributes["ralph_hero.rate_limit.remaining"]).toBe(4500);
    expect(spans[0].attributes["ralph_hero.rate_limit.cost"]).toBe(1);
  });

  it("marks the span as ERROR with ralph_hero.error_type=graphql on failure", async () => {
    exporter.reset();
    mockGraphqlImpl.mockRejectedValueOnce(
      Object.assign(new Error("Field 'foo' not found"), { status: 422 }),
    );

    const client = createGitHubClient({ token: "tok", owner: "o", repo: "r" });
    await expect(
      client.query("query badQuery { foo }"),
    ).rejects.toThrow(/foo/);

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("ralph_hero.graphql");
    expect(spans[0].attributes["ralph_hero.error_type"]).toBe("graphql");
    // SpanStatusCode.ERROR === 2
    expect(spans[0].status.code).toBe(2);
  });

  it("classifies fetch-level errors (no status) as network", async () => {
    exporter.reset();
    mockGraphqlImpl.mockRejectedValueOnce(new Error("ECONNRESET"));

    const client = createGitHubClient({ token: "tok", owner: "o", repo: "r" });
    await expect(client.query("query x { a }")).rejects.toThrow(/ECONNRESET/);

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["ralph_hero.error_type"]).toBe("network");
  });

  it("classifies 403 with retry-after as rate_limit", async () => {
    exporter.reset();
    // The github-client retries after sleeping on retry-after — for the
    // assertion we want to see the error span, so mock both the rate-limited
    // error and a successful retry. Note the implementation calls setTimeout
    // with retry-after seconds * 1000; we keep it small.
    mockGraphqlImpl
      .mockRejectedValueOnce(
        Object.assign(new Error("rate limited"), {
          status: 403,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce({
        viewer: { login: "after-retry" },
        rateLimit: { remaining: 100, cost: 1, limit: 5000, resetAt: "", nodeCount: 1 },
      });

    const client = createGitHubClient({ token: "tok", owner: "o", repo: "r" });
    await client.query("query rateLimitedQuery { viewer { login } }");

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    // First call: rate-limited error span; second call: successful retry span
    expect(spans.length).toBeGreaterThanOrEqual(1);
    const rateLimitSpan = spans.find(
      (s) => s.attributes["ralph_hero.error_type"] === "rate_limit",
    );
    expect(rateLimitSpan).toBeDefined();
  });
});
