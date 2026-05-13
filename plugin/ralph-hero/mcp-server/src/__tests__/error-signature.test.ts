import { describe, it, expect } from "vitest";
import {
  normalizeErrorMessage,
  buildSignatureKey,
  hashSignature,
  groupSpansBySignature,
  getErrorType,
  getErrorMessage,
  observationToSpan,
  type SignatureSpan,
} from "../lib/error-signature.js";
import type { LangfuseObservation } from "../lib/langfuse-client.js";

// ---------------------------------------------------------------------------
// normalizeErrorMessage
// ---------------------------------------------------------------------------

describe("normalizeErrorMessage", () => {
  it("replaces #N issue numbers", () => {
    expect(normalizeErrorMessage("Issue #42 not found")).toBe(
      "Issue #N not found",
    );
  });

  it("replaces multiple issue numbers in one message", () => {
    expect(normalizeErrorMessage("Issue #123 and #456 collide")).toBe(
      "Issue #N and #N collide",
    );
  });

  it("replaces bare digit numbers (no hash) too", () => {
    // "Issue 42 not found" (no hash) — bare numbers normalize to <N>.
    expect(normalizeErrorMessage("Issue 42 not found")).toBe(
      "Issue <N> not found",
    );
  });

  it("collapses different issue numbers to the same signature", () => {
    expect(normalizeErrorMessage("not found: #100")).toBe(
      normalizeErrorMessage("not found: #999"),
    );
  });

  it("replaces ISO timestamps (with and without millis)", () => {
    expect(
      normalizeErrorMessage("at 2026-05-11T03:14:15.123Z something happened"),
    ).toBe("at <TS> something happened");
    expect(
      normalizeErrorMessage("at 2026-05-11T03:14:15Z something happened"),
    ).toBe("at <TS> something happened");
  });

  it("replaces UUIDs", () => {
    expect(
      normalizeErrorMessage(
        "node 550e8400-e29b-41d4-a716-446655440000 missing",
      ),
    ).toBe("node <ID> missing");
  });

  it("replaces long hex hashes", () => {
    expect(normalizeErrorMessage("commit a1b2c3d4e5f6 failed")).toBe(
      "commit <HASH> failed",
    );
    // Short hex (<8 chars) is below HASH threshold. Trailing digits still get
    // collapsed by the bare-number rule: "abc7" -> "abc<N>".
    expect(normalizeErrorMessage("status abc7 ok")).toBe("status abc<N> ok");
  });

  it("replaces double-quoted dynamic strings with <STR>", () => {
    expect(normalizeErrorMessage('Cannot open "path/to/file.txt"')).toBe(
      "Cannot open <STR>",
    );
  });

  it("handles nested quoted strings", () => {
    expect(
      normalizeErrorMessage('Cannot read "foo/bar" and "baz/qux"'),
    ).toBe("Cannot read <STR> and <STR>");
  });

  it("prefers <STR> over <TS> for a quoted ISO timestamp", () => {
    expect(normalizeErrorMessage('timestamp "2026-05-11T03:14:15Z" bad'))
      .toBe("timestamp <STR> bad");
  });

  it("collapses whitespace", () => {
    expect(normalizeErrorMessage("foo   bar\n\tbaz")).toBe("foo bar baz");
  });

  it("truncates to 200 chars", () => {
    const long = "x".repeat(500);
    expect(normalizeErrorMessage(long)).toHaveLength(200);
  });

  it("handles empty and whitespace input", () => {
    expect(normalizeErrorMessage("")).toBe("");
    expect(normalizeErrorMessage("   ")).toBe("");
  });

  it("handles mixed timestamps + UUIDs in one message", () => {
    expect(
      normalizeErrorMessage(
        "fail at 2026-05-11T03:14:15Z for id 550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe("fail at <TS> for id <ID>");
  });
});

// ---------------------------------------------------------------------------
// buildSignatureKey + hashSignature
// ---------------------------------------------------------------------------

describe("buildSignatureKey", () => {
  it("concatenates with colons", () => {
    expect(buildSignatureKey("ralph_hero.graphql", "rate_limit", "limited"))
      .toBe("ralph_hero.graphql:rate_limit:limited");
  });
});

describe("hashSignature", () => {
  it("returns 8-char hex", () => {
    const h = hashSignature("a:b:c");
    expect(h).toHaveLength(8);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic", () => {
    expect(hashSignature("same key")).toBe(hashSignature("same key"));
  });

  it("differs across different keys", () => {
    expect(hashSignature("a:b:c")).not.toBe(hashSignature("a:b:d"));
  });
});

// ---------------------------------------------------------------------------
// getErrorType / getErrorMessage
// ---------------------------------------------------------------------------

describe("getErrorType", () => {
  it("reads hoisted errorType field", () => {
    const span: SignatureSpan = {
      name: "x",
      traceId: "t",
      startTime: "2026-01-01T00:00:00Z",
      errorType: "rate_limit",
    };
    expect(getErrorType(span)).toBe("rate_limit");
  });

  it("falls back to metadata.ralph_hero.error_type", () => {
    const span: SignatureSpan = {
      name: "x",
      traceId: "t",
      startTime: "2026-01-01T00:00:00Z",
      metadata: { "ralph_hero.error_type": "graphql" },
    };
    expect(getErrorType(span)).toBe("graphql");
  });

  it("returns 'unknown' when nothing matches", () => {
    expect(
      getErrorType({
        name: "x",
        traceId: "t",
        startTime: "2026-01-01T00:00:00Z",
      }),
    ).toBe("unknown");
  });
});

describe("getErrorMessage", () => {
  it("prefers top-level message", () => {
    expect(
      getErrorMessage({
        name: "x",
        traceId: "t",
        startTime: "2026-01-01T00:00:00Z",
        message: "boom",
      }),
    ).toBe("boom");
  });

  it("falls back to metadata.exception.message", () => {
    expect(
      getErrorMessage({
        name: "x",
        traceId: "t",
        startTime: "2026-01-01T00:00:00Z",
        metadata: { exception: { message: "wrapped" } },
      }),
    ).toBe("wrapped");
  });

  it("falls back to metadata.error string", () => {
    expect(
      getErrorMessage({
        name: "x",
        traceId: "t",
        startTime: "2026-01-01T00:00:00Z",
        metadata: { error: "from meta" },
      }),
    ).toBe("from meta");
  });
});

// ---------------------------------------------------------------------------
// observationToSpan
// ---------------------------------------------------------------------------

describe("observationToSpan", () => {
  it("hoists ralph_hero.error_type from metadata", () => {
    const obs: LangfuseObservation = {
      id: "o1",
      traceId: "t1",
      name: "ralph_hero.graphql",
      startTime: "2026-05-11T00:00:00Z",
      type: "SPAN",
      level: "ERROR",
      statusMessage: "boom",
      metadata: { "ralph_hero.error_type": "graphql" },
    };
    const span = observationToSpan(obs);
    expect(span.errorType).toBe("graphql");
    expect(span.message).toBe("boom");
    expect(span.level).toBe("ERROR");
  });
});

// ---------------------------------------------------------------------------
// groupSpansBySignature
// ---------------------------------------------------------------------------

function makeSpan(overrides: Partial<SignatureSpan> = {}): SignatureSpan {
  return {
    name: "ralph_hero.graphql",
    traceId: "t-default",
    startTime: "2026-05-11T00:00:00Z",
    errorType: "graphql",
    message: "Issue #42 not found",
    ...overrides,
  };
}

describe("groupSpansBySignature", () => {
  it("collapses near-identical messages into one group", () => {
    const spans = [
      makeSpan({ message: "Issue #1 not found", traceId: "t1" }),
      makeSpan({ message: "Issue #2 not found", traceId: "t2" }),
      makeSpan({ message: "Issue #3 not found", traceId: "t3" }),
    ];
    const groups = groupSpansBySignature(spans, { minOccurrences: 1 });
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].signature).toContain("#N");
    expect(groups[0].hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("applies minOccurrences filter (default 3)", () => {
    const spans = [
      makeSpan({ message: "rare", traceId: "t1" }),
      makeSpan({ message: "rare", traceId: "t2" }),
      makeSpan({ message: "common", traceId: "t3" }),
      makeSpan({ message: "common", traceId: "t4" }),
      makeSpan({ message: "common", traceId: "t5" }),
    ];
    const groups = groupSpansBySignature(spans);
    // Default minOccurrences=3: only "common" survives
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
  });

  it("honors minOccurrences=1 boundary", () => {
    const spans = [makeSpan({ traceId: "t1" })];
    const groups = groupSpansBySignature(spans, { minOccurrences: 1 });
    expect(groups).toHaveLength(1);
  });

  it("separates groups by error type", () => {
    const spans = [
      makeSpan({ errorType: "graphql", message: "x", traceId: "t1" }),
      makeSpan({ errorType: "graphql", message: "x", traceId: "t2" }),
      makeSpan({ errorType: "graphql", message: "x", traceId: "t3" }),
      makeSpan({ errorType: "rate_limit", message: "x", traceId: "t4" }),
      makeSpan({ errorType: "rate_limit", message: "x", traceId: "t5" }),
      makeSpan({ errorType: "rate_limit", message: "x", traceId: "t6" }),
    ];
    const groups = groupSpansBySignature(spans);
    expect(groups).toHaveLength(2);
  });

  it("sorts by count desc", () => {
    const spans = [
      makeSpan({ message: "rare", errorType: "graphql", traceId: "tr1" }),
      makeSpan({ message: "rare", errorType: "graphql", traceId: "tr2" }),
      makeSpan({ message: "rare", errorType: "graphql", traceId: "tr3" }),
      makeSpan({ message: "common", errorType: "network", traceId: "tc1" }),
      makeSpan({ message: "common", errorType: "network", traceId: "tc2" }),
      makeSpan({ message: "common", errorType: "network", traceId: "tc3" }),
      makeSpan({ message: "common", errorType: "network", traceId: "tc4" }),
    ];
    const groups = groupSpansBySignature(spans, { minOccurrences: 3 });
    expect(groups[0].count).toBeGreaterThanOrEqual(groups[1].count);
    expect(groups[0].count).toBe(4);
  });

  it("tracks firstSeen and lastSeen by startTime", () => {
    const spans = [
      makeSpan({ traceId: "t1", startTime: "2026-05-11T01:00:00Z" }),
      makeSpan({ traceId: "t2", startTime: "2026-05-11T03:00:00Z" }),
      makeSpan({ traceId: "t3", startTime: "2026-05-11T02:00:00Z" }),
    ];
    const groups = groupSpansBySignature(spans, { minOccurrences: 1 });
    expect(groups[0].firstSeen).toBe("2026-05-11T01:00:00Z");
    expect(groups[0].lastSeen).toBe("2026-05-11T03:00:00Z");
  });

  it("builds exampleTraceUrl with <defaultProjectId> placeholder", () => {
    const spans = [
      makeSpan({ traceId: "trace-abc" }),
      makeSpan({ traceId: "trace-abc" }),
      makeSpan({ traceId: "trace-abc" }),
    ];
    const groups = groupSpansBySignature(spans, {
      minOccurrences: 1,
      langfuseHost: "http://localhost:3100",
    });
    expect(groups[0].exampleTraceUrl).toBe(
      "http://localhost:3100/project/<defaultProjectId>/traces/trace-abc",
    );
  });

  it("uses provided projectId in exampleTraceUrl", () => {
    const spans = [
      makeSpan({ traceId: "trace-xyz" }),
      makeSpan({ traceId: "trace-xyz" }),
      makeSpan({ traceId: "trace-xyz" }),
    ];
    const groups = groupSpansBySignature(spans, {
      minOccurrences: 1,
      langfuseHost: "https://cloud.langfuse.com",
      projectId: "proj-1",
    });
    expect(groups[0].exampleTraceUrl).toBe(
      "https://cloud.langfuse.com/project/proj-1/traces/trace-xyz",
    );
  });

  it("keeps at most 3 sampleSpans, most-recent first", () => {
    const spans = [
      makeSpan({ traceId: "t1", startTime: "2026-05-11T00:00:00Z" }),
      makeSpan({ traceId: "t2", startTime: "2026-05-11T01:00:00Z" }),
      makeSpan({ traceId: "t3", startTime: "2026-05-11T02:00:00Z" }),
      makeSpan({ traceId: "t4", startTime: "2026-05-11T03:00:00Z" }),
      makeSpan({ traceId: "t5", startTime: "2026-05-11T04:00:00Z" }),
    ];
    const groups = groupSpansBySignature(spans, { minOccurrences: 1 });
    expect(groups[0].sampleSpans).toHaveLength(3);
    expect(groups[0].sampleSpans[0].traceId).toBe("t5");
    expect(groups[0].sampleSpans[1].traceId).toBe("t4");
    expect(groups[0].sampleSpans[2].traceId).toBe("t3");
  });
});
