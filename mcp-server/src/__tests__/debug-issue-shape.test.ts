/**
 * Unit tests for `debug-issue-shape.ts`.
 *
 * Verifies that:
 *   1. The hash marker is on its own line in the canonical `**Hash**: \`<h>\``
 *      shape Phase 3b's dedup regex relies on.
 *   2. Token-shaped values (`ghp_*`, basic-auth, `_TOKEN` keys) are scrubbed
 *      from titles, bodies, and serialised attribute bags.
 *   3. The Langfuse trace URL is present and clickable.
 *   4. Comment bodies include the hash + new-occurrence count + trace URL.
 */

import { describe, expect, it } from "vitest";
import {
  buildIssueBody,
  buildCommentBody,
  scrubTokensFromString,
  scrubTokensFromAttrs,
} from "../lib/debug-issue-shape.js";
import type { SignatureGroup, SignatureSpan } from "../lib/error-signature.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSpan(overrides: Partial<SignatureSpan> = {}): SignatureSpan {
  return {
    name: "ralph_hero.graphql",
    traceId: "trace-abc-123",
    startTime: "2026-05-11T10:00:00.000Z",
    endTime: "2026-05-11T10:00:01.000Z",
    metadata: {
      "ralph_hero.operation": "GetIssue",
      "ralph_hero.error_type": "graphql",
    },
    errorType: "graphql",
    message: "Issue 42 not found",
    level: "ERROR",
    ...overrides,
  };
}

function makeGroup(overrides: Partial<SignatureGroup> = {}): SignatureGroup {
  return {
    signature: "ralph_hero.graphql:graphql:Issue #N not found",
    hash: "a1b2c3d4",
    count: 5,
    firstSeen: "2026-05-11T10:00:00.000Z",
    lastSeen: "2026-05-11T12:30:00.000Z",
    exampleTraceUrl:
      "http://localhost:3100/project/abc/traces/trace-abc-123",
    sampleSpans: [makeSpan()],
    ...overrides,
  };
}

const env = {
  mcpVersion: "2.5.127",
  nodeVersion: "v22.1.0",
  os: "darwin 23.4.0",
};

// ---------------------------------------------------------------------------
// scrubTokensFromString
// ---------------------------------------------------------------------------

describe("scrubTokensFromString", () => {
  it("replaces ghp_ tokens with [REDACTED]", () => {
    const out = scrubTokensFromString(
      "Authorization: token ghp_abcdef1234567890ABCDEF",
    );
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("ghp_abcdef1234567890ABCDEF");
  });

  it("replaces ghs_ tokens", () => {
    const out = scrubTokensFromString("token ghs_thisisaserverappkey1234");
    expect(out).toContain("[REDACTED]");
  });

  it("replaces Basic auth header values", () => {
    const out = scrubTokensFromString(
      "Authorization: Basic cGstbGYtbG9jYWwtZGV2OnNrLWxmLWxvY2FsLWRldg==",
    );
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("cGstbGYtbG9jYWw");
  });

  it("leaves non-token strings untouched", () => {
    const input = "Issue #42 not found at /repos/foo/bar";
    expect(scrubTokensFromString(input)).toBe(input);
  });

  it("handles empty string", () => {
    expect(scrubTokensFromString("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// scrubTokensFromAttrs
// ---------------------------------------------------------------------------

describe("scrubTokensFromAttrs", () => {
  it("redacts values for _TOKEN-suffixed keys", () => {
    const out = scrubTokensFromAttrs({
      RALPH_HERO_GITHUB_TOKEN: "ghp_realfake1234567890ABCDEF",
      OTHER_TOKEN: "anything",
      benign: "value",
    });
    expect(out.RALPH_HERO_GITHUB_TOKEN).toBe("[REDACTED]");
    expect(out.OTHER_TOKEN).toBe("[REDACTED]");
    expect(out.benign).toBe("value");
  });

  it("redacts Authorization key case-insensitively", () => {
    const out = scrubTokensFromAttrs({
      authorization: "Basic abcdef==",
      Authorization: "token ghp_abc",
    });
    expect(out.authorization).toBe("[REDACTED]");
    expect(out.Authorization).toBe("[REDACTED]");
  });

  it("scrubs token-shaped substrings out of value strings", () => {
    const out = scrubTokensFromAttrs({
      msg: "got ghp_abcdef1234567890ABCDEFG back",
    });
    expect(out.msg).toContain("[REDACTED]");
    expect(out.msg).not.toContain("ghp_abcdef");
  });

  it("stringifies + scrubs nested objects", () => {
    const out = scrubTokensFromAttrs({
      nested: { inner: "ghp_realfake1234567890ABCDEF" },
    });
    expect(out.nested).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// buildIssueBody
// ---------------------------------------------------------------------------

describe("buildIssueBody", () => {
  it("produces a hash marker line that Phase 3b dedup regex matches", () => {
    const group = makeGroup();
    const { body } = buildIssueBody(group, env);

    // Phase 3b dedup regex: must find `**Hash**: \`<8hex>\`` on its own line.
    const match = body.match(/^\*\*Hash\*\*: `([0-9a-f]{8})`/m);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("a1b2c3d4");
  });

  it("includes the full signature, occurrences table, and Langfuse URL", () => {
    const group = makeGroup();
    const { body } = buildIssueBody(group, env);
    expect(body).toContain("ralph_hero.graphql:graphql:Issue #N not found");
    expect(body).toContain("| 5 | 2026-05-11T10:00:00.000Z |");
    expect(body).toContain(
      "http://localhost:3100/project/abc/traces/trace-abc-123",
    );
  });

  it("includes first-seen environment stamp", () => {
    const { body } = buildIssueBody(makeGroup(), env);
    expect(body).toContain("2.5.127");
    expect(body).toContain("v22.1.0");
    expect(body).toContain("darwin 23.4.0");
  });

  it("renders a [Debug] title prefix with span name + truncated message", () => {
    const group = makeGroup();
    const { title } = buildIssueBody(group, env);
    expect(title.startsWith("[Debug] ralph_hero.graphql: ")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(100);
  });

  it("scrubs ghp_ tokens out of titles and bodies", () => {
    const span = makeSpan({
      message: "401 returned for token ghp_realfake1234567890ABCDEF",
      metadata: {
        Authorization: "Basic cGstbGYtbG9jYWwtZGV2OnNrLWxmLWxvY2FsLWRldg==",
        RALPH_HERO_GITHUB_TOKEN: "ghp_abcdef1234567890ABCDEFG",
      },
    });
    const group = makeGroup({ sampleSpans: [span] });

    const { title, body } = buildIssueBody(group, env);
    expect(title).not.toContain("ghp_");
    expect(body).not.toMatch(/\bghp_[A-Za-z0-9_]{16,}\b/);
    expect(body).not.toContain("cGstbGYtbG9jYWwtZGV2");
    // _TOKEN attribute key should have its value redacted.
    expect(body).toContain("[REDACTED]");
  });

  it("falls back to signature-derived message when no sample span", () => {
    const group = makeGroup({ sampleSpans: [] });
    const { title, body } = buildIssueBody(group, env);
    expect(title).toContain("[Debug]");
    expect(body).toContain("(no sample span available)");
  });

  it("emits the title even when the message is empty (uses signature tail)", () => {
    const span = makeSpan({ message: undefined, metadata: {} });
    const group = makeGroup({
      signature: "ralph_hero.graphql:graphql:",
      sampleSpans: [span],
    });
    const { title } = buildIssueBody(group, env);
    expect(title).toContain("[Debug] ralph_hero.graphql:");
  });
});

// ---------------------------------------------------------------------------
// buildCommentBody
// ---------------------------------------------------------------------------

describe("buildCommentBody", () => {
  it("includes the hash, new count, and a trace URL", () => {
    const group = makeGroup();
    const body = buildCommentBody(
      group,
      7,
      "http://localhost:3100/project/abc/traces/trace-xyz-999",
    );
    expect(body).toContain("a1b2c3d4");
    expect(body).toContain("**7** new occurrences");
    expect(body).toContain("trace-xyz-999");
  });

  it("uses singular form for newCount=1", () => {
    const body = buildCommentBody(makeGroup(), 1, "http://x/y");
    expect(body).toContain("**1** new occurrence ");
    expect(body).not.toContain("**1** new occurrences");
  });

  it("scrubs token-shaped substrings from trace URL", () => {
    const body = buildCommentBody(
      makeGroup(),
      3,
      "http://host/trace?key=ghp_realfake1234567890ABCDEF",
    );
    expect(body).not.toContain("ghp_realfake");
    expect(body).toContain("[REDACTED]");
  });
});
