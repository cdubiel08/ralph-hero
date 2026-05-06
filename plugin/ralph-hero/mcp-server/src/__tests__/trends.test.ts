/**
 * Tests for `computeTrends` + `renderSparkline` (Phase 3, GH-1024).
 */

import { describe, expect, it, vi } from "vitest";
import { computeTrends, renderSparkline } from "../lib/trends.js";
import type { Snapshot } from "../lib/snapshots.js";
import { SNAPSHOT_SCHEMA_VERSION } from "../lib/snapshots.js";

interface MakeSnapshotInput {
  hoursAgo: number;
  velocity?: number;
  riskScore?: number;
  wipByPhase?: Record<string, number>;
  leadTimeP50Hours?: number | null;
  schemaVersion?: number;
}

const NOW = Date.UTC(2026, 4, 5, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

function makeSnapshot(input: MakeSnapshotInput): Snapshot {
  const capturedAt = new Date(NOW - input.hoursAgo * HOUR).toISOString();
  const snap: Snapshot = {
    schemaVersion: (input.schemaVersion ??
      SNAPSHOT_SCHEMA_VERSION) as typeof SNAPSHOT_SCHEMA_VERSION,
    capturedAt,
    owner: "octocat",
    projectNumber: 7,
    velocity: input.velocity ?? 0,
    windowDays: 7,
    riskScore: input.riskScore ?? 0,
    status: "green",
    wipByPhase: input.wipByPhase ?? {},
    pointsByPhase: {},
    doneInWindow: 0,
    newInWindow: 0,
    warnings: { critical: 0, warning: 0, info: 0 },
  };
  if (input.leadTimeP50Hours !== undefined) {
    (snap as Snapshot & {
      cycleTime?: { leadTimeP50Hours: number | null };
    }).cycleTime = { leadTimeP50Hours: input.leadTimeP50Hours };
  }
  return snap;
}

describe("computeTrends", () => {
  it("returns four series in canonical order even for empty input", () => {
    const trends = computeTrends([], NOW);
    expect(trends.map((t) => t.metric)).toEqual([
      "velocity",
      "riskScore",
      "wipTotal",
      "leadTimeP50Hours",
    ]);
    for (const t of trends) {
      expect(t.points).toEqual([]);
      expect(t.delta1d).toBeNull();
      expect(t.delta7d).toBeNull();
      expect(t.delta30d).toBeNull();
    }
  });

  it("returns all-null deltas for a single snapshot", () => {
    const snaps = [makeSnapshot({ hoursAgo: 0, velocity: 5, riskScore: 2 })];
    const [velocity] = computeTrends(snaps, NOW);
    expect(velocity.points).toHaveLength(1);
    expect(velocity.points[0].value).toBe(5);
    expect(velocity.delta1d).toBeNull();
    expect(velocity.delta7d).toBeNull();
    expect(velocity.delta30d).toBeNull();
  });

  it("computes delta1d when two snapshots are 25h apart, leaves 7d/30d null", () => {
    const snaps = [
      makeSnapshot({ hoursAgo: 25, velocity: 10 }),
      makeSnapshot({ hoursAgo: 0, velocity: 14 }),
    ];
    const [velocity] = computeTrends(snaps, NOW);
    expect(velocity.delta1d).toBe(4);
    expect(velocity.delta7d).toBeNull();
    expect(velocity.delta30d).toBeNull();
  });

  it("computes 7d and 30d deltas when older history is available", () => {
    const snaps = [
      makeSnapshot({ hoursAgo: 30 * 24 + 1, velocity: 1 }),
      makeSnapshot({ hoursAgo: 7 * 24 + 1, velocity: 5 }),
      makeSnapshot({ hoursAgo: 25, velocity: 9 }),
      makeSnapshot({ hoursAgo: 0, velocity: 12 }),
    ];
    const [velocity] = computeTrends(snaps, NOW);
    expect(velocity.delta1d).toBe(12 - 9);
    expect(velocity.delta7d).toBe(12 - 5);
    expect(velocity.delta30d).toBe(12 - 1);
  });

  it("handles gappy series by using nearest-prior sample", () => {
    const snaps: Snapshot[] = [];
    for (let day = 9; day >= 0; day--) {
      if (day === 5) continue;
      snaps.push(makeSnapshot({ hoursAgo: day * 24, velocity: 10 - day }));
    }
    const [velocity] = computeTrends(snaps, NOW);
    expect(velocity.points.length).toBe(9);
    expect(velocity.delta1d).not.toBeNull();
    expect(velocity.delta7d).not.toBeNull();
  });

  it("returns all-null deltas for leadTimeP50Hours when cycleTime is unset", () => {
    const snaps = [
      makeSnapshot({ hoursAgo: 25, velocity: 1 }),
      makeSnapshot({ hoursAgo: 0, velocity: 2 }),
    ];
    const lead = computeTrends(snaps, NOW).find(
      (t) => t.metric === "leadTimeP50Hours",
    )!;
    expect(lead.points).toHaveLength(2);
    expect(lead.points.every((p) => p.value === null)).toBe(true);
    expect(lead.delta1d).toBeNull();
    expect(lead.delta7d).toBeNull();
    expect(lead.delta30d).toBeNull();
  });

  it("computes leadTimeP50Hours deltas when cycleTime is populated", () => {
    const snaps = [
      makeSnapshot({ hoursAgo: 25, leadTimeP50Hours: 100 }),
      makeSnapshot({ hoursAgo: 0, leadTimeP50Hours: 80 }),
    ];
    const lead = computeTrends(snaps, NOW).find(
      (t) => t.metric === "leadTimeP50Hours",
    )!;
    expect(lead.delta1d).toBe(-20);
  });

  it("normalizes input order before computing deltas", () => {
    const a = makeSnapshot({ hoursAgo: 25, velocity: 10 });
    const b = makeSnapshot({ hoursAgo: 0, velocity: 14 });
    const sorted = computeTrends([a, b], NOW);
    const shuffled = computeTrends([b, a], NOW);
    expect(shuffled).toEqual(sorted);
  });

  it("computes wipTotal as sum of wipByPhase values", () => {
    const snaps = [
      makeSnapshot({
        hoursAgo: 0,
        wipByPhase: { Backlog: 3, "In Progress": 2, Done: 5 },
      }),
    ];
    const wip = computeTrends(snaps, NOW).find(
      (t) => t.metric === "wipTotal",
    )!;
    expect(wip.points[0].value).toBe(10);
  });

  it("skips snapshots with unknown schemaVersion via console.warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = makeSnapshot({ hoursAgo: 0, velocity: 5 });
    const bogus = makeSnapshot({ hoursAgo: 1, velocity: 99, schemaVersion: 999 });
    const trends = computeTrends([ok, bogus], NOW);
    const velocity = trends.find((t) => t.metric === "velocity")!;
    expect(velocity.points).toHaveLength(1);
    expect(velocity.points[0].value).toBe(5);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("populates a sparkline for each series", () => {
    const snaps = [
      makeSnapshot({ hoursAgo: 48, velocity: 1 }),
      makeSnapshot({ hoursAgo: 24, velocity: 5 }),
      makeSnapshot({ hoursAgo: 0, velocity: 10 }),
    ];
    const [velocity] = computeTrends(snaps, NOW);
    expect(velocity.sparkline).toBeDefined();
    expect(velocity.sparkline!.length).toBe(3);
    expect(velocity.sparkline!.startsWith("▁")).toBe(true);
    expect(velocity.sparkline!.endsWith("█")).toBe(true);
  });
});

describe("renderSparkline", () => {
  it("returns empty string for empty input", () => {
    expect(renderSparkline([])).toBe("");
  });

  it("returns empty string when all values are null", () => {
    expect(renderSparkline([null, null, null])).toBe("");
  });

  it("renders a single value as the middle bucket", () => {
    expect(renderSparkline([42])).toBe("▄");
  });

  it("renders all-equal values as repeated middle buckets", () => {
    expect(renderSparkline([7, 7, 7])).toBe("▄▄▄");
  });

  it("renders monotonic up [1..8] as ▁▂▃▄▅▆▇█", () => {
    expect(renderSparkline([1, 2, 3, 4, 5, 6, 7, 8])).toBe("▁▂▃▄▅▆▇█");
  });

  it("renders monotonic down [8..1] as █▇▆▅▄▃▂▁", () => {
    expect(renderSparkline([8, 7, 6, 5, 4, 3, 2, 1])).toBe("█▇▆▅▄▃▂▁");
  });

  it("renders nulls as spaces preserving x-axis alignment", () => {
    const out = renderSparkline([1, null, 3]);
    expect(out.length).toBe(3);
    expect(out[1]).toBe(" ");
  });

  it("handles large dynamic range without throwing", () => {
    const out = renderSparkline([1, 1000]);
    expect(out.length).toBe(2);
    expect(out[0]).toBe("▁");
    expect(out[1]).toBe("█");
  });
});
