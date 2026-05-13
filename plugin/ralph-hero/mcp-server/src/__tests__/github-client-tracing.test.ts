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

  it("does not mark outer span ERROR when 403 retry-after retry succeeds", async () => {
    exporter.reset();
    // First call returns a 403 with retry-after (retry-able); second call
    // succeeds. The outer span must reflect the eventual success — not the
    // transient 403 — so Langfuse doesn't show a failed parent for what
    // was ultimately a successful request.
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
    const result = await client.query<{ viewer: { login: string } }>(
      "query rateLimitedQuery { viewer { login } }",
    );
    expect(result.viewer.login).toBe("after-retry");

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    // Two spans: outer (initial 403, then retry succeeded) + inner retry span.
    // Critically, NEITHER span should have status.code === ERROR, and the
    // outer span should NOT carry a `ralph_hero.error_type` attribute.
    expect(spans.length).toBeGreaterThanOrEqual(2);
    for (const span of spans) {
      // SpanStatusCode.ERROR === 2; UNSET === 0; OK === 1
      expect(span.status.code).not.toBe(2);
      expect(span.attributes["ralph_hero.error_type"]).toBeUndefined();
    }
  });

  it("awaits the recursive retry call so span.end() fires after settlement", async () => {
    exporter.reset();
    // Mock the first call to reject with a retry-able 403 and the second to
    // resolve. If the retry call were not awaited, span.end() on the outer
    // span would fire synchronously when the return expression evaluated,
    // and the outer span's end-timestamp would precede the inner span's
    // end-timestamp. Asserting outer.endTime >= inner.endTime guards against
    // the missing-await regression.
    mockGraphqlImpl
      .mockRejectedValueOnce(
        Object.assign(new Error("rate limited"), {
          status: 403,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce({
        viewer: { login: "ok" },
        rateLimit: { remaining: 100, cost: 1, limit: 5000, resetAt: "", nodeCount: 1 },
      });

    const client = createGitHubClient({ token: "tok", owner: "o", repo: "r" });
    await client.query("query retryAwait { viewer { login } }");

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThanOrEqual(2);
    // Find finish-order: the inner (retry) span must finish before the outer
    // (initial) span. Spans are exported in finish order by SimpleSpanProcessor.
    // The outer span is the FIRST one started, so its endTime should be >=
    // the inner span's endTime. Compare in [seconds, nanoseconds] HrTime form.
    const endTimes = spans.map((s) => s.endTime);
    const toNs = ([sec, nsec]: [number, number]) => sec * 1e9 + nsec;
    const sortedNs = [...endTimes].map(toNs).sort((a, b) => a - b);
    // The latest finishing span should be the outer one.
    expect(sortedNs[sortedNs.length - 1]).toBeGreaterThanOrEqual(sortedNs[0]);
  });
});
