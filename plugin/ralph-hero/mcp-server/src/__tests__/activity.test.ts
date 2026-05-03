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
