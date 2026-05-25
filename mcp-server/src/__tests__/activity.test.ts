/**
 * Tests for the pure activity-log read library at `lib/activity.ts`.
 *
 * Uses fs-mock and temp directories — no real filesystem dependencies.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readActivity, type ActivityReadConfig } from "../lib/activity.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<ActivityReadConfig> = {}): ActivityReadConfig {
  return {
    rootDir: tmpDir,
    since: null,
    until: null,
    kinds: null,
    category: "work",
    project: null,
    limit: 100,
    compact: false,
    now: new Date("2026-05-02T12:00:00Z"),
    ...overrides,
  };
}

describe("readActivity — empty cases", () => {
  it("returns empty when activity dir doesn't exist", () => {
    const result = readActivity({ ...makeConfig(), rootDir: "/nonexistent/path" });
    expect(result.events).toEqual([]);
    expect(result.cursor_advanced_to).toBeNull();
    expect(result.skipped_lines).toBe(0);
  });

  it("returns empty when dir exists but no JSONL files", () => {
    const result = readActivity(makeConfig());
    expect(result.events).toEqual([]);
    expect(result.cursor_advanced_to).toBeNull();
  });
});

function writeEvents(rootDir: string, dateYMD: string, events: object[]) {
  const [y, m, d] = dateYMD.split("-");
  const dir = path.join(rootDir, y, m);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${d}.jsonl`);
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe("readActivity — populated log", () => {
  it("returns events from today's file in chronological order", () => {
    const events = [
      { ts: "2026-05-02T08:00:00Z", kind: "skill_invoked", category: "work", actor: "ralph-hero:hello" },
      { ts: "2026-05-02T09:00:00Z", kind: "tool_called", category: "work", actor: "claude", target: { tool: "ralph_hero__save_issue" } },
      { ts: "2026-05-02T10:00:00Z", kind: "tool_called", category: "meta", actor: "claude", target: { tool: "ralph_hero__get_issue" } },
    ];
    writeEvents(tmpDir, "2026-05-02", events);
    const result = readActivity(makeConfig({ category: "work" }));
    expect(result.events).toHaveLength(2);
    expect(result.events[0].ts).toBe("2026-05-02T08:00:00Z");
    expect(result.events[1].ts).toBe("2026-05-02T09:00:00Z");
    expect(result.cursor_advanced_to).toBe("2026-05-02T09:00:00Z");
  });

  it("walks multiple daily files", () => {
    writeEvents(tmpDir, "2026-05-01", [
      { ts: "2026-05-01T12:00:00Z", kind: "skill_invoked", category: "work" },
    ]);
    writeEvents(tmpDir, "2026-05-02", [
      { ts: "2026-05-02T08:00:00Z", kind: "tool_called", category: "work" },
    ]);
    const result = readActivity(makeConfig({
      category: "work",
      since: "2026-05-01T00:00:00Z",
    }));
    expect(result.events).toHaveLength(2);
    expect(result.events[0].ts).toBe("2026-05-01T12:00:00Z");
  });
});

describe("readActivity — compact projection", () => {
  it("projects events to {ts, kind, tool, project} when compact: true", () => {
    writeEvents(tmpDir, "2026-05-02", [
      {
        ts: "2026-05-02T12:00:00.000Z",
        kind: "tool_called",
        category: "work",
        actor: "claude",
        target: { tool: "Write" },
        project: "ralph-hero",
        session_id: "abc-123",
      },
    ]);

    const result = readActivity(makeConfig({ compact: true, since: "2026-05-01T00:00:00Z" }));

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({
      ts: "2026-05-02T12:00:00.000Z",
      kind: "tool_called",
      tool: "Write",
      project: "ralph-hero",
    });
    // Verbose fields are absent
    expect("actor" in result.events[0]).toBe(false);
    expect("session_id" in result.events[0]).toBe(false);
    expect("category" in result.events[0]).toBe(false);
    expect("target" in result.events[0]).toBe(false);
  });

  it("compact mode handles missing tool field gracefully", () => {
    writeEvents(tmpDir, "2026-05-02", [
      {
        ts: "2026-05-02T12:00:00.000Z",
        kind: "session_start",
        category: "work",
        target: {},
        project: "ralph-hero",
      },
    ]);

    const result = readActivity(makeConfig({ compact: true, since: "2026-05-01T00:00:00Z" }));

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({
      ts: "2026-05-02T12:00:00.000Z",
      kind: "session_start",
      project: "ralph-hero",
    });
    expect("tool" in result.events[0]).toBe(false);
  });

  it("compact mode omits project when event lacks one", () => {
    writeEvents(tmpDir, "2026-05-02", [
      {
        ts: "2026-05-02T12:00:00.000Z",
        kind: "tool_called",
        category: "work",
        target: { tool: "Read" },
      },
    ]);

    const result = readActivity(makeConfig({ compact: true, since: "2026-05-01T00:00:00Z" }));

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({
      ts: "2026-05-02T12:00:00.000Z",
      kind: "tool_called",
      tool: "Read",
    });
    expect("project" in result.events[0]).toBe(false);
  });

  it("compact: false preserves the full event shape (default behavior)", () => {
    writeEvents(tmpDir, "2026-05-02", [
      {
        ts: "2026-05-02T12:00:00.000Z",
        kind: "tool_called",
        category: "work",
        actor: "claude",
        target: { tool: "Write" },
        project: "ralph-hero",
        session_id: "abc-123",
      },
    ]);

    const result = readActivity(makeConfig({ compact: false, since: "2026-05-01T00:00:00Z" }));

    expect(result.events).toHaveLength(1);
    const ev = result.events[0] as Record<string, unknown>;
    expect(ev.actor).toBe("claude");
    expect(ev.session_id).toBe("abc-123");
    expect(ev.category).toBe("work");
    expect(ev.target).toEqual({ tool: "Write" });
  });
});

describe("readActivity — error tolerance", () => {
  it("skips corrupt JSONL lines and counts them", () => {
    const dir = path.join(tmpDir, "2026", "05");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "02.jsonl"),
      [
        '{"ts":"2026-05-02T08:00:00Z","kind":"tool_called","category":"work"}',
        'not json at all',
        '{"ts":"2026-05-02T09:00:00Z","kind":"tool_called","category":"work"}',
        '{"ts":"invalid-date","kind":"x","category":"work"}',
      ].join("\n"),
    );
    const result = readActivity(makeConfig({ category: "work" }));
    expect(result.events).toHaveLength(2);
    expect(result.skipped_lines).toBe(2);
  });

  it("handles sparse logs (missing days within range)", () => {
    writeEvents(tmpDir, "2026-05-01", [{ ts: "2026-05-01T12:00:00Z", kind: "x", category: "work" }]);
    // Skip 2026-05-02
    writeEvents(tmpDir, "2026-05-03", [{ ts: "2026-05-03T12:00:00Z", kind: "x", category: "work" }]);
    const result = readActivity(makeConfig({ category: "work", since: "2026-05-01T00:00:00Z" }));
    expect(result.events).toHaveLength(2);
  });
});
