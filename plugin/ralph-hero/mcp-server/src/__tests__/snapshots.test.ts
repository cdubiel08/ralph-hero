/**
 * Tests for the snapshot persistence module (`lib/snapshots.ts`).
 *
 * All file I/O is redirected to a per-test tmpdir via the
 * `__setSnapshotRoot` test hook so we never touch the real
 * `~/.ralph-hero/snapshots/` directory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  __setSnapshotRoot,
  appendSnapshot,
  fetchTransitionedIssues,
  readSnapshots,
  snapshotPath,
  toSnapshot,
  SNAPSHOT_SCHEMA_VERSION,
  type Snapshot,
} from "../lib/snapshots.js";
import type { DashboardData, DashboardItem } from "../lib/dashboard.js";
import type { MetricsResult } from "../lib/metrics.js";
import type { GitHubClient } from "../github-client.js";
import { buildTransitionComment } from "../lib/transition-comments.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "snapshots-test-"));
  __setSnapshotRoot(tmpRoot);
});

afterEach(async () => {
  __setSnapshotRoot(null);
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    capturedAt: "2026-05-05T12:00:00.000Z",
    owner: "octocat",
    projectNumber: 7,
    velocity: 3,
    windowDays: 7,
    riskScore: 1,
    status: "ON_TRACK",
    wipByPhase: { Backlog: 5, "In Progress": 2, Done: 3 },
    pointsByPhase: { Backlog: 7, "In Progress": 4, Done: 5 },
    doneInWindow: 3,
    newInWindow: 1,
    warnings: { critical: 0, warning: 1, info: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// snapshotPath
// ---------------------------------------------------------------------------

describe("snapshotPath", () => {
  it("partitions by owner and project number", () => {
    expect(snapshotPath("octocat", 7)).toBe(
      path.join(tmpRoot, "octocat", "7.jsonl"),
    );
    expect(snapshotPath("acme", 42)).toBe(
      path.join(tmpRoot, "acme", "42.jsonl"),
    );
  });
});

// ---------------------------------------------------------------------------
// appendSnapshot + readSnapshots round-trip
// ---------------------------------------------------------------------------

describe("appendSnapshot / readSnapshots", () => {
  it("creates parent directory and writes one row per call", async () => {
    const s1 = makeSnapshot({ capturedAt: "2026-05-01T00:00:00.000Z" });
    const s2 = makeSnapshot({ capturedAt: "2026-05-02T00:00:00.000Z" });

    await appendSnapshot(s1);
    await appendSnapshot(s2);

    const file = snapshotPath("octocat", 7);
    const raw = await fs.readFile(file, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);

    const rows = await readSnapshots("octocat", 7);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(s1);
    expect(rows[1]).toEqual(s2);
  });

  it("returns [] when the file does not exist", async () => {
    const rows = await readSnapshots("nobody", 999);
    expect(rows).toEqual([]);
  });

  it("partitions different (owner, project) pairs into different files", async () => {
    await appendSnapshot(makeSnapshot({ owner: "alice", projectNumber: 1 }));
    await appendSnapshot(makeSnapshot({ owner: "alice", projectNumber: 2 }));
    await appendSnapshot(makeSnapshot({ owner: "bob", projectNumber: 1 }));

    expect((await readSnapshots("alice", 1)).map((r) => r.projectNumber)).toEqual([1]);
    expect((await readSnapshots("alice", 2)).map((r) => r.projectNumber)).toEqual([2]);
    expect((await readSnapshots("bob", 1)).map((r) => r.owner)).toEqual(["bob"]);
  });

  it("tolerates malformed lines and bad-shape lines", async () => {
    const file = snapshotPath("octocat", 7);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const goodLine = JSON.stringify(makeSnapshot()) + "\n";
    const malformed = "{not valid json\n";
    const wrongShape = JSON.stringify({ hello: "world" }) + "\n";
    await fs.writeFile(file, malformed + goodLine + wrongShape, "utf8");

    // suppress console.warn during this test
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const rows = await readSnapshots("octocat", 7);
      expect(rows).toHaveLength(1);
      expect(rows[0].owner).toBe("octocat");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("filters by `since` lower bound", async () => {
    await appendSnapshot(makeSnapshot({ capturedAt: "2026-05-01T00:00:00.000Z" }));
    await appendSnapshot(makeSnapshot({ capturedAt: "2026-05-03T00:00:00.000Z" }));
    await appendSnapshot(makeSnapshot({ capturedAt: "2026-05-05T00:00:00.000Z" }));

    const rows = await readSnapshots(
      "octocat",
      7,
      new Date("2026-05-03T00:00:00.000Z"),
    );
    expect(rows.map((r) => r.capturedAt)).toEqual([
      "2026-05-03T00:00:00.000Z",
      "2026-05-05T00:00:00.000Z",
    ]);
  });

  it("skips rows with an unknown schemaVersion", async () => {
    const file = snapshotPath("octocat", 7);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const future = JSON.stringify({ ...makeSnapshot(), schemaVersion: 99 }) + "\n";
    const current = JSON.stringify(makeSnapshot()) + "\n";
    await fs.writeFile(file, future + current, "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const rows = await readSnapshots("octocat", 7);
      expect(rows).toHaveLength(1);
      expect(rows[0].schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// toSnapshot
// ---------------------------------------------------------------------------

describe("toSnapshot", () => {
  function makeData(): DashboardData {
    return {
      generatedAt: "2026-05-05T12:00:00.000Z",
      totalIssues: 5,
      phases: [
        {
          state: "Backlog",
          count: 3,
          estimatePoints: 4,
          issues: [],
        },
        {
          state: "In Progress",
          count: 1,
          estimatePoints: 2,
          issues: [],
        },
        {
          state: "Done",
          count: 1,
          estimatePoints: 1,
          issues: [],
        },
      ],
      health: {
        ok: false,
        warnings: [
          { type: "blocked", severity: "critical", message: "x", issues: [1] },
          { type: "stuck_issue", severity: "warning", message: "y", issues: [2] },
          { type: "stuck_issue", severity: "warning", message: "z", issues: [3] },
          { type: "pipeline_gap", severity: "info", message: "g", issues: [] },
        ],
      },
      archive: {
        eligibleForArchive: 0,
        eligibleItems: [],
        recentlyCompleted: 0,
        archiveThresholdDays: 14,
      },
    };
  }

  function makeMetrics(): MetricsResult {
    return {
      velocity: 4,
      riskScore: 5,
      status: "AT_RISK",
      highlights: {
        recentlyCompleted: [{ number: 10, title: "Done thing" }],
        newlyAdded: [
          { number: 11, title: "New thing" },
          { number: 12, title: "Another new thing" },
        ],
      },
    };
  }

  it("derives wipByPhase, pointsByPhase, warning counts, and doneInWindow from inputs", () => {
    const snap = toSnapshot({
      owner: "octocat",
      projectNumber: 7,
      data: makeData(),
      metrics: makeMetrics(),
      windowDays: 7,
      capturedAt: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(snap.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(snap.capturedAt).toBe("2026-05-05T12:00:00.000Z");
    expect(snap.owner).toBe("octocat");
    expect(snap.projectNumber).toBe(7);
    expect(snap.velocity).toBe(4);
    expect(snap.riskScore).toBe(5);
    expect(snap.status).toBe("AT_RISK");
    expect(snap.windowDays).toBe(7);
    expect(snap.wipByPhase).toEqual({ Backlog: 3, "In Progress": 1, Done: 1 });
    expect(snap.pointsByPhase).toEqual({ Backlog: 4, "In Progress": 2, Done: 1 });
    expect(snap.doneInWindow).toBe(1);
    expect(snap.newInWindow).toBe(2);
    expect(snap.warnings).toEqual({ critical: 1, warning: 2, info: 1 });
    expect(snap.cycleTime).toBeUndefined();
  });

  it("defaults capturedAt to current time when not provided", () => {
    const before = Date.now();
    const snap = toSnapshot({
      owner: "octocat",
      projectNumber: 7,
      data: makeData(),
      metrics: makeMetrics(),
      windowDays: 7,
    });
    const after = Date.now();
    const ts = new Date(snap.capturedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("includes cycleTime when provided in input", () => {
    const snap = toSnapshot({
      owner: "octocat",
      projectNumber: 7,
      data: {
        generatedAt: "2026-05-05T12:00:00.000Z",
        totalIssues: 0,
        phases: [],
        health: { ok: true, warnings: [] },
        archive: {
          eligibleForArchive: 0,
          eligibleItems: [],
          recentlyCompleted: 0,
          archiveThresholdDays: 14,
        },
      },
      metrics: {
        velocity: 0,
        riskScore: 0,
        status: "ON_TRACK",
        highlights: { recentlyCompleted: [], newlyAdded: [] },
      },
      windowDays: 7,
      cycleTime: {
        leadTimeP50Hours: 5,
        leadTimeP90Hours: 7,
        perPhaseDwellHours: { "In Progress": { p50: 3, p90: 4, n: 2 } },
        sampleSize: 2,
      },
    });
    expect(snap.cycleTime?.sampleSize).toBe(2);
    expect(snap.cycleTime?.leadTimeP50Hours).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// fetchTransitionedIssues
// ---------------------------------------------------------------------------

function makeDashboardItem(overrides: Partial<DashboardItem> = {}): DashboardItem {
  return {
    number: 100,
    title: "Test issue",
    updatedAt: "2026-05-04T00:00:00.000Z",
    closedAt: "2026-05-04T05:00:00.000Z",
    workflowState: "Done",
    priority: "P1",
    estimate: "S",
    assignees: [],
    subIssueCount: 0,
    blockedBy: [],
    repository: "octocat/repo",
    ...overrides,
  } as DashboardItem;
}

interface MockClientCtl {
  client: GitHubClient;
  query: ReturnType<typeof vi.fn>;
}

function createMockRepoClient(
  perIssue: (number: number) => unknown | Error,
): MockClientCtl {
  const query = vi.fn(async (_q: string, vars: Record<string, unknown>) => {
    const result = perIssue(vars.number as number);
    if (result instanceof Error) throw result;
    return result;
  });
  const client = {
    query,
    projectQuery: vi.fn(),
    mutate: vi.fn(),
    projectMutate: vi.fn(),
    config: {},
  } as unknown as GitHubClient;
  return { client, query };
}

describe("fetchTransitionedIssues", () => {
  it("returns one TransitionedIssue per item with at least one transition", async () => {
    const transitionComment = buildTransitionComment({
      from: "In Progress",
      to: "Done",
      command: "ralph_merge",
      at: "2026-05-04T05:00:00.000Z",
    });
    const { client } = createMockRepoClient(() => ({
      repository: {
        issue: {
          comments: {
            nodes: [
              { body: `Some prose. ${transitionComment}`, createdAt: "2026-05-04T05:00:00.000Z" },
            ],
          },
        },
      },
    }));

    const items = [makeDashboardItem({ number: 100 })];
    const out = await fetchTransitionedIssues(client, items);
    expect(out).toHaveLength(1);
    expect(out[0].issueNumber).toBe(100);
    expect(out[0].transitions).toHaveLength(1);
    expect(out[0].transitions[0].to).toBe("Done");
    expect(out[0].closedAt).toBe("2026-05-04T05:00:00.000Z");
  });

  it("returns [] when comments contain no transitions", async () => {
    const { client } = createMockRepoClient(() => ({
      repository: {
        issue: {
          comments: {
            nodes: [
              { body: "Just a normal comment", createdAt: "2026-05-04T05:00:00.000Z" },
            ],
          },
        },
      },
    }));

    const out = await fetchTransitionedIssues(client, [makeDashboardItem({ number: 100 })]);
    expect(out).toEqual([]);
  });

  it("logs warning and continues when one issue's fetch throws", async () => {
    const goodTransition = buildTransitionComment({
      from: "In Progress",
      to: "Done",
      command: "ralph_merge",
      at: "2026-05-04T05:00:00.000Z",
    });
    const { client } = createMockRepoClient((number) => {
      if (number === 101) return new Error("rate limited");
      return {
        repository: {
          issue: {
            comments: {
              nodes: [
                { body: goodTransition, createdAt: "2026-05-04T05:00:00.000Z" },
              ],
            },
          },
        },
      };
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const items = [
        makeDashboardItem({ number: 101 }),
        makeDashboardItem({ number: 102 }),
      ];
      const out = await fetchTransitionedIssues(client, items);
      expect(out).toHaveLength(1);
      expect(out[0].issueNumber).toBe(102);
      expect(warnSpy).toHaveBeenCalled();
      const warnMsg = warnSpy.mock.calls[0][0] as string;
      expect(warnMsg).toContain("101");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("skips items without a resolvable repository field", async () => {
    const { client, query } = createMockRepoClient(() => ({
      repository: { issue: { comments: { nodes: [] } } },
    }));
    const items = [makeDashboardItem({ number: 100, repository: undefined })];
    const out = await fetchTransitionedIssues(client, items);
    expect(out).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("returns [] for empty input without making any queries", async () => {
    const { client, query } = createMockRepoClient(() => ({}));
    const out = await fetchTransitionedIssues(client, []);
    expect(out).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
