import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readLogEvents,
  buildSignature,
  hashSignature,
  groupErrors,
  aggregateStats,
} from "../tools/debug-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolEvent(overrides: Record<string, unknown> = {}) {
  return {
    ts: "2026-02-22T10:00:00.000Z",
    cat: "tool" as const,
    tool: "ralph_hero__get_issue",
    params: { number: 42 },
    durationMs: 100,
    ok: true,
    ...overrides,
  };
}

function makeGraphQLEvent(overrides: Record<string, unknown> = {}) {
  return {
    ts: "2026-02-22T10:00:00.000Z",
    cat: "graphql" as const,
    operation: "GetIssue",
    durationMs: 50,
    status: 200,
    ...overrides,
  };
}

function makeHookEvent(overrides: Record<string, unknown> = {}) {
  return {
    ts: "2026-02-22T10:00:00.000Z",
    cat: "hook" as const,
    hook: "worker-stop-gate",
    exitCode: 0,
    ...overrides,
  };
}

async function writeLogFile(dir: string, filename: string, events: object[]) {
  const content = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(join(dir, filename), content);
}

// ---------------------------------------------------------------------------
// readLogEvents
// ---------------------------------------------------------------------------

describe("readLogEvents", () => {
  let logDir: string;

  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "ralph-debug-tools-test-"));
  });

  afterEach(async () => {
    await rm(logDir, { recursive: true, force: true });
  });

  it("reads and parses JSONL files", async () => {
    await writeLogFile(logDir, "session-2026-02-22-100000-ab12.jsonl", [
      makeToolEvent(),
      makeToolEvent({ tool: "ralph_hero__list_issues", durationMs: 200 }),
    ]);

    const { events, sessionsAnalyzed } = await readLogEvents(
      logDir,
      new Date("2026-02-01"),
    );
    expect(events).toHaveLength(2);
    expect(sessionsAnalyzed).toBe(1);
  });

  it("filters events by since date", async () => {
    await writeLogFile(logDir, "session-2026-02-22-100000-ab12.jsonl", [
      makeToolEvent({ ts: "2026-02-20T10:00:00.000Z" }),
      makeToolEvent({ ts: "2026-02-22T10:00:00.000Z" }),
    ]);

    const { events } = await readLogEvents(
      logDir,
      new Date("2026-02-21"),
    );
    expect(events).toHaveLength(1);
    expect(events[0].ts).toBe("2026-02-22T10:00:00.000Z");
  });

  it("handles multiple session files", async () => {
    await writeLogFile(logDir, "session-2026-02-22-100000-ab12.jsonl", [
      makeToolEvent(),
    ]);
    await writeLogFile(logDir, "session-2026-02-22-110000-cd34.jsonl", [
      makeToolEvent({ tool: "other_tool" }),
    ]);

    const { events, sessionsAnalyzed } = await readLogEvents(
      logDir,
      new Date("2026-02-01"),
    );
    expect(events).toHaveLength(2);
    expect(sessionsAnalyzed).toBe(2);
  });

  it("skips malformed lines", async () => {
    const content = [
      JSON.stringify(makeToolEvent()),
      "not valid json",
      JSON.stringify(makeToolEvent({ tool: "second" })),
    ].join("\n");
    await writeFile(
      join(logDir, "session-2026-02-22-100000-ab12.jsonl"),
      content,
    );

    const { events } = await readLogEvents(logDir, new Date("2026-02-01"));
    expect(events).toHaveLength(2);
  });

  it("returns empty for non-existent directory", async () => {
    const { events, sessionsAnalyzed } = await readLogEvents(
      "/tmp/does-not-exist-" + Date.now(),
      new Date("2026-02-01"),
    );
    expect(events).toHaveLength(0);
    expect(sessionsAnalyzed).toBe(0);
  });

  it("ignores non-session files", async () => {
    await writeFile(join(logDir, "other-file.jsonl"), JSON.stringify(makeToolEvent()));
    await writeFile(join(logDir, "readme.txt"), "not a log");

    const { events } = await readLogEvents(logDir, new Date("2026-02-01"));
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Error Signature & Grouping
// ---------------------------------------------------------------------------

describe("buildSignature", () => {
  it("builds signature from tool error", () => {
    const sig = buildSignature(
      makeToolEvent({ ok: false, error: "Issue 42 not found" }),
    );
    expect(sig).toContain("tool:");
    expect(sig).toContain("ralph_hero__get_issue");
    expect(sig).toContain("error");
  });

  it("builds signature from hook event with exit code", () => {
    const sig = buildSignature(
      makeHookEvent({ exitCode: 2, error: "No matching tasks" }),
    );
    expect(sig).toContain("hook:");
    expect(sig).toContain("worker-stop-gate");
    expect(sig).toContain("exit:2");
  });

  it("normalizes numbers in error messages", () => {
    const sig1 = buildSignature(
      makeToolEvent({ ok: false, error: "Issue 42 not found" }),
    );
    const sig2 = buildSignature(
      makeToolEvent({ ok: false, error: "Issue 99 not found" }),
    );
    expect(sig1).toBe(sig2);
  });

  it("normalizes hashes in error messages", () => {
    const sig1 = buildSignature(
      makeToolEvent({ ok: false, error: "Node abc12345 not found" }),
    );
    const sig2 = buildSignature(
      makeToolEvent({ ok: false, error: "Node def67890 not found" }),
    );
    expect(sig1).toBe(sig2);
  });
});

describe("hashSignature", () => {
  it("returns 8-char hex string", () => {
    const hash = hashSignature("tool:get_issue:error:not found");
    expect(hash).toHaveLength(8);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic", () => {
    const sig = "tool:get_issue:error:not found";
    expect(hashSignature(sig)).toBe(hashSignature(sig));
  });

  it("differs for different signatures", () => {
    const h1 = hashSignature("tool:get_issue:error:not found");
    const h2 = hashSignature("tool:list_issues:error:timeout");
    expect(h1).not.toBe(h2);
  });
});

describe("groupErrors", () => {
  it("groups similar errors together", () => {
    const events = [
      makeToolEvent({ ok: false, error: "Issue 1 not found" }),
      makeToolEvent({ ok: false, error: "Issue 2 not found" }),
      makeToolEvent({ ok: false, error: "Issue 3 not found" }),
      makeToolEvent({ ok: true }), // not an error — should be excluded
    ];

    const groups = groupErrors(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
  });

  it("separates different error types", () => {
    const events = [
      makeToolEvent({ ok: false, error: "Not found" }),
      makeToolEvent({ ok: false, error: "Rate limited", tool: "ralph_hero__list_issues" }),
      makeHookEvent({ exitCode: 2, error: "No tasks" }),
    ];

    const groups = groupErrors(events);
    expect(groups).toHaveLength(3);
  });

  it("includes blocked events", () => {
    const events = [
      makeHookEvent({ blocked: true, error: "Write blocked" }),
    ];

    const groups = groupErrors(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(1);
  });

  it("tracks first and last seen", () => {
    const events = [
      makeToolEvent({ ok: false, error: "fail", ts: "2026-02-20T10:00:00Z" }),
      makeToolEvent({ ok: false, error: "fail", ts: "2026-02-22T10:00:00Z" }),
      makeToolEvent({ ok: false, error: "fail", ts: "2026-02-21T10:00:00Z" }),
    ];

    const groups = groupErrors(events);
    expect(groups[0].firstSeen).toBe("2026-02-20T10:00:00Z");
    expect(groups[0].lastSeen).toBe("2026-02-22T10:00:00Z");
  });

  it("sorts by count descending", () => {
    const events = [
      makeToolEvent({ ok: false, error: "rare", tool: "tool_a" }),
      makeToolEvent({ ok: false, error: "common", tool: "tool_b" }),
      makeToolEvent({ ok: false, error: "common", tool: "tool_b" }),
      makeToolEvent({ ok: false, error: "common", tool: "tool_b" }),
    ];

    const groups = groupErrors(events);
    expect(groups[0].count).toBe(3);
    expect(groups[1].count).toBe(1);
  });

  it("returns empty for no errors", () => {
    const events = [
      makeToolEvent({ ok: true }),
      makeGraphQLEvent({ status: 200 }),
    ];

    const groups = groupErrors(events);
    expect(groups).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stats Aggregation
// ---------------------------------------------------------------------------

describe("aggregateStats", () => {
  const events = [
    makeToolEvent({ tool: "get_issue", durationMs: 100, ok: true }),
    makeToolEvent({ tool: "get_issue", durationMs: 200, ok: true }),
    makeToolEvent({ tool: "get_issue", durationMs: 300, ok: false, error: "fail" }),
    makeToolEvent({ tool: "list_issues", durationMs: 150, ok: true }),
    makeGraphQLEvent(), // non-tool — should be excluded from tool stats
  ];

  it("computes totals", () => {
    const stats = aggregateStats(events, "tool");
    expect(stats.totalToolCalls).toBe(4);
    expect(stats.totalErrors).toBe(1);
    expect(stats.errorRate).toBeCloseTo(0.25);
  });

  it("groups by tool", () => {
    const stats = aggregateStats(events, "tool");
    expect(Object.keys(stats.groups)).toHaveLength(2);

    expect(stats.groups["get_issue"].calls).toBe(3);
    expect(stats.groups["get_issue"].errors).toBe(1);
    expect(stats.groups["get_issue"].avgDurationMs).toBe(200);
    expect(stats.groups["get_issue"].errorRate).toBeCloseTo(1 / 3);

    expect(stats.groups["list_issues"].calls).toBe(1);
    expect(stats.groups["list_issues"].errors).toBe(0);
    expect(stats.groups["list_issues"].avgDurationMs).toBe(150);
  });

  it("groups by category", () => {
    const stats = aggregateStats(events, "category");
    expect(Object.keys(stats.groups)).toHaveLength(1);
    expect(stats.groups["tool"].calls).toBe(4);
  });

  it("groups by day", () => {
    const dayEvents = [
      makeToolEvent({ ts: "2026-02-20T10:00:00Z", durationMs: 100 }),
      makeToolEvent({ ts: "2026-02-20T11:00:00Z", durationMs: 200 }),
      makeToolEvent({ ts: "2026-02-21T10:00:00Z", durationMs: 300 }),
    ];

    const stats = aggregateStats(dayEvents, "day");
    expect(Object.keys(stats.groups)).toHaveLength(2);
    expect(stats.groups["2026-02-20"].calls).toBe(2);
    expect(stats.groups["2026-02-21"].calls).toBe(1);
  });

  it("handles empty events", () => {
    const stats = aggregateStats([], "tool");
    expect(stats.totalToolCalls).toBe(0);
    expect(stats.totalErrors).toBe(0);
    expect(stats.errorRate).toBe(0);
    expect(Object.keys(stats.groups)).toHaveLength(0);
  });
});
