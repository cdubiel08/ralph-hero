/**
 * Telemetry tests — verify lazy SDK init, token-scrubbing SpanProcessor,
 * and the pure `redactTokenAttributes()` helper.
 *
 * No live Langfuse traffic; all assertions are in-process using an
 * in-memory span exporter.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { redactTokenAttributes, TokenScrubbingSpanProcessor, initTelemetry } from "../lib/telemetry.js";

describe("redactTokenAttributes (pure)", () => {
  it("redacts values matching /^ghp_/ (personal access token shape)", () => {
    const out = redactTokenAttributes({
      RALPH_HERO_GITHUB_TOKEN: "ghp_fakefake1234567890",
    });
    expect(out.RALPH_HERO_GITHUB_TOKEN).toBe("[REDACTED]");
  });

  it("redacts values matching /^ghs_/ (server-to-server token shape)", () => {
    const out = redactTokenAttributes({
      some_attr: "ghs_serverservertoken",
    });
    expect(out.some_attr).toBe("[REDACTED]");
  });

  it("redacts keys ending in _TOKEN (case-insensitive)", () => {
    const out = redactTokenAttributes({
      RALPH_HERO_GITHUB_TOKEN: "anything-here",
      some_token: "anything-here-too",
    });
    expect(out.RALPH_HERO_GITHUB_TOKEN).toBe("[REDACTED]");
    expect(out.some_token).toBe("[REDACTED]");
  });

  it("redacts the Authorization key (case-insensitive)", () => {
    const out = redactTokenAttributes({
      Authorization: "Basic abc",
      authorization: "Bearer xyz",
    });
    expect(out.Authorization).toBe("[REDACTED]");
    expect(out.authorization).toBe("[REDACTED]");
  });

  it("leaves non-token values unchanged", () => {
    const out = redactTokenAttributes({
      harmless: "value",
      operation: "getIssue",
      "ralph_hero.rate_limit.remaining": 4500,
      "ralph_hero.rate_limit.cost": 1,
    });
    expect(out.harmless).toBe("value");
    expect(out.operation).toBe("getIssue");
    expect(out["ralph_hero.rate_limit.remaining"]).toBe(4500);
    expect(out["ralph_hero.rate_limit.cost"]).toBe(1);
  });

  it("returns an empty object for undefined input", () => {
    expect(redactTokenAttributes(undefined)).toEqual({});
  });

  it("does not match _token in the middle of a key (only at the end)", () => {
    const out = redactTokenAttributes({
      my_token_thing: "preserved",
    });
    expect(out.my_token_thing).toBe("preserved");
  });

  it("preserves non-string values that look like tokens-by-value", () => {
    // A number can't trip TOKEN_VALUE_RE — only strings match
    const out = redactTokenAttributes({
      count: 42,
      enabled: true,
    });
    expect(out.count).toBe(42);
    expect(out.enabled).toBe(true);
  });
});

describe("initTelemetry (lazy / RALPH_DEBUG guard)", () => {
  const originalDebug = process.env.RALPH_DEBUG;

  beforeEach(() => {
    delete process.env.RALPH_DEBUG;
  });

  afterEach(() => {
    if (originalDebug === undefined) {
      delete process.env.RALPH_DEBUG;
    } else {
      process.env.RALPH_DEBUG = originalDebug;
    }
  });

  it("returns null when RALPH_DEBUG is unset (zero overhead path)", async () => {
    const sdk = await initTelemetry();
    expect(sdk).toBeNull();
  });

  it("returns null when RALPH_DEBUG is the literal string 'false'", async () => {
    process.env.RALPH_DEBUG = "false";
    const sdk = await initTelemetry();
    expect(sdk).toBeNull();
  });

  it("returns null when RALPH_DEBUG is any value other than 'true'", async () => {
    process.env.RALPH_DEBUG = "1";
    const sdk = await initTelemetry();
    expect(sdk).toBeNull();
  });

  it("returns a NodeSDK-shaped object when RALPH_DEBUG=true", async () => {
    process.env.RALPH_DEBUG = "true";
    const sdk = (await initTelemetry()) as { shutdown: () => Promise<void> } | null;
    expect(sdk).not.toBeNull();
    expect(typeof sdk?.shutdown).toBe("function");
    // Flush + shut down so vitest doesn't leak the exporter handle.
    await sdk?.shutdown();
  });
});

describe("TokenScrubbingSpanProcessor (in-memory span)", () => {
  it("redacts attributes set before span end", async () => {
    // Spin up a minimal tracer provider with an in-memory exporter and the
    // scrubbing processor in front of it. This exercises the same flow that
    // initTelemetry wires for the real NodeSDK.
    const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } =
      await import("@opentelemetry/sdk-trace-base");

    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [
        new TokenScrubbingSpanProcessor(),
        new SimpleSpanProcessor(exporter),
      ],
    });

    const tracer = provider.getTracer("test");

    const span = tracer.startSpan("test-span");
    span.setAttribute("RALPH_HERO_GITHUB_TOKEN", "ghp_fakefake1234567890");
    span.setAttribute("Authorization", "Basic abc");
    span.setAttribute("harmless", "value");
    span.setAttribute("ralph_hero.operation", "getIssue");
    span.end();

    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const attrs = spans[0].attributes;
    expect(attrs.RALPH_HERO_GITHUB_TOKEN).toBe("[REDACTED]");
    expect(attrs.Authorization).toBe("[REDACTED]");
    expect(attrs.harmless).toBe("value");
    expect(attrs["ralph_hero.operation"]).toBe("getIssue");

    await provider.shutdown();
  });
});
