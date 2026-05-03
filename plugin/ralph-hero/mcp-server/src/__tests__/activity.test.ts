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
