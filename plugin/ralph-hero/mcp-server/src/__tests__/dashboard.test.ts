/**
 * Tests for dashboard aggregation, health detection, and formatting.
 *
 * All functions under test are pure (no I/O), so no mocking is needed.
 */

import { describe, it, expect } from "vitest";
import {
  aggregateByPhase,
  detectHealthIssues,
  buildDashboard,
  computeArchiveStats,
  formatMarkdown,
  formatAscii,
  DEFAULT_HEALTH_CONFIG,
  type DashboardItem,
  type PhaseSnapshot,
  type HealthConfig,
} from "../lib/dashboard.js";
import { STATE_ORDER } from "../lib/workflow-states.js";
import { toDashboardItems, type RawDashboardItem } from "../tools/dashboard-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date("2026-02-16T12:00:00Z").getTime();

function makeItem(overrides: Partial<DashboardItem> = {}): DashboardItem {
  return {
    number: 1,
    title: "Test issue",
    updatedAt: new Date(NOW - 1 * HOUR_MS).toISOString(), // 1h ago
    closedAt: null,
    workflowState: "Backlog",
    priority: null,
    estimate: null,
    assignees: [],
    blockedBy: [],
    ...overrides,
  };
}

function findPhase(phases: PhaseSnapshot[], state: string): PhaseSnapshot {
  const phase = phases.find((p) => p.state === state);
  if (!phase) throw new Error(`Phase "${state}" not found`);
  return phase;
}

// ---------------------------------------------------------------------------
// aggregateByPhase
// ---------------------------------------------------------------------------

describe("aggregateByPhase", () => {
  it("groups items correctly by workflow state", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog" }),
      makeItem({ number: 2, workflowState: "Backlog" }),
      makeItem({ number: 3, workflowState: "In Progress" }),
    ];

    const phases = aggregateByPhase(items, NOW);
    expect(findPhase(phases, "Backlog").count).toBe(2);
    expect(findPhase(phases, "In Progress").count).toBe(1);
    expect(findPhase(phases, "Research Needed").count).toBe(0);
  });

  it("orders phases by STATE_ORDER with Human Needed and Canceled appended", () => {
    const items = [makeItem({ workflowState: "Done" })];
    const phases = aggregateByPhase(items, NOW);

    const stateNames = phases.map((p) => p.state);

    // STATE_ORDER comes first
    for (let i = 0; i < STATE_ORDER.length; i++) {
      expect(stateNames[i]).toBe(STATE_ORDER[i]);
    }

    // Human Needed and Canceled after STATE_ORDER
    expect(stateNames).toContain("Human Needed");
    expect(stateNames).toContain("Canceled");
    expect(stateNames.indexOf("Human Needed")).toBeGreaterThan(
      stateNames.indexOf("Done"),
    );
  });

  it("sorts issues within phase by priority (P0 first)", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog", priority: "P3" }),
      makeItem({ number: 2, workflowState: "Backlog", priority: "P0" }),
      makeItem({ number: 3, workflowState: "Backlog", priority: "P1" }),
      makeItem({ number: 4, workflowState: "Backlog", priority: null }),
    ];

    const phases = aggregateByPhase(items, NOW);
    const backlog = findPhase(phases, "Backlog");
    expect(backlog.issues.map((i) => i.number)).toEqual([2, 3, 1, 4]);
  });

  it("computes ageHours correctly from updatedAt", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 24 * HOUR_MS).toISOString(), // 24h ago
      }),
    ];

    const phases = aggregateByPhase(items, NOW);
    const issue = findPhase(phases, "Backlog").issues[0];
    expect(issue.ageHours).toBeCloseTo(24, 1);
  });

  it("filters Done items to within doneWindowDays", () => {
    const config: HealthConfig = { ...DEFAULT_HEALTH_CONFIG, doneWindowDays: 7 };
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        updatedAt: new Date(NOW - 3 * DAY_MS).toISOString(), // 3 days ago
      }),
      makeItem({
        number: 2,
        workflowState: "Done",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(), // 10 days ago
      }),
    ];

    const phases = aggregateByPhase(items, NOW, config);
    const done = findPhase(phases, "Done");
    expect(done.count).toBe(1);
    expect(done.issues[0].number).toBe(1);
  });

  it("uses closedAt for Done filtering when available", () => {
    const config: HealthConfig = { ...DEFAULT_HEALTH_CONFIG, doneWindowDays: 7 };
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(), // 10 days ago
        closedAt: new Date(NOW - 2 * DAY_MS).toISOString(), // closed 2 days ago
      }),
    ];

    const phases = aggregateByPhase(items, NOW, config);
    expect(findPhase(phases, "Done").count).toBe(1);
  });

  it("groups Canceled items separately from Done", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Done" }),
      makeItem({ number: 2, workflowState: "Canceled" }),
    ];

    const phases = aggregateByPhase(items, NOW);
    expect(findPhase(phases, "Done").count).toBe(1);
    expect(findPhase(phases, "Canceled").count).toBe(1);
  });

  it("groups items without workflow state into Unknown", () => {
    const items = [makeItem({ number: 1, workflowState: null })];

    const phases = aggregateByPhase(items, NOW);
    const unknown = findPhase(phases, "Unknown");
    expect(unknown.count).toBe(1);
    expect(unknown.issues[0].number).toBe(1);
  });

  it("returns empty phases with 0 counts for empty project", () => {
    const phases = aggregateByPhase([], NOW);
    expect(phases.length).toBeGreaterThan(0);
    for (const phase of phases) {
      expect(phase.count).toBe(0);
      expect(phase.issues).toEqual([]);
    }
  });

  it("sets isLocked for lock states", () => {
    const items = [
      makeItem({ number: 1, workflowState: "In Progress" }),
      makeItem({ number: 2, workflowState: "Backlog" }),
    ];

    const phases = aggregateByPhase(items, NOW);
    expect(findPhase(phases, "In Progress").issues[0].isLocked).toBe(true);
    expect(findPhase(phases, "Backlog").issues[0].isLocked).toBe(false);
  });

  it("filters Canceled items to within doneWindowDays", () => {
    const config: HealthConfig = { ...DEFAULT_HEALTH_CONFIG, doneWindowDays: 7 };
    const items = [
      makeItem({
        number: 1,
        workflowState: "Canceled",
        updatedAt: new Date(NOW - 3 * DAY_MS).toISOString(),
      }),
      makeItem({
        number: 2,
        workflowState: "Canceled",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
      }),
    ];

    const phases = aggregateByPhase(items, NOW, config);
    expect(findPhase(phases, "Canceled").count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// detectHealthIssues
// ---------------------------------------------------------------------------

describe("detectHealthIssues", () => {
  // WIP exceeded
  it("wip_exceeded: detects when phase count > limit", () => {
    const phases: PhaseSnapshot[] = [
      {
        state: "In Progress",
        count: 4,
        issues: [1, 2, 3, 4].map((n) => ({
          number: n,
          title: `Issue ${n}`,
          priority: null,
          estimate: null,
          assignees: [],
          ageHours: 1,
          isLocked: true,
          blockedBy: [],
        })),
      },
    ];
    const config: HealthConfig = {
      ...DEFAULT_HEALTH_CONFIG,
      wipLimits: { "In Progress": 3 },
    };

    const warnings = detectHealthIssues(phases, config);
    const wip = warnings.filter((w) => w.type === "wip_exceeded");
    expect(wip.length).toBe(1);
    expect(wip[0].severity).toBe("warning");
    expect(wip[0].issues).toEqual([1, 2, 3, 4]);
  });

  it("wip_exceeded: no warning when at or below limit", () => {
    const phases: PhaseSnapshot[] = [
      {
        state: "In Progress",
        count: 3,
        issues: [1, 2, 3].map((n) => ({
          number: n,
          title: `Issue ${n}`,
          priority: null,
          estimate: null,
          assignees: [],
          ageHours: 1,
          isLocked: true,
          blockedBy: [],
        })),
      },
    ];
    const config: HealthConfig = {
      ...DEFAULT_HEALTH_CONFIG,
      wipLimits: { "In Progress": 3 },
    };

    const warnings = detectHealthIssues(phases, config);
    expect(warnings.filter((w) => w.type === "wip_exceeded").length).toBe(0);
  });

  // Stuck issue
  it("stuck_issue warning: issue > 48h in non-terminal state", () => {
    const phases: PhaseSnapshot[] = [
      {
        state: "Research Needed",
        count: 1,
        issues: [
          {
            number: 10,
            title: "Stuck",
            priority: null,
            estimate: null,
            assignees: [],
            ageHours: 60,
            isLocked: false,
            blockedBy: [],
          },
        ],
      },
    ];

    const warnings = detectHealthIssues(phases);
    const stuck = warnings.filter((w) => w.type === "stuck_issue");
    expect(stuck.length).toBe(1);
    expect(stuck[0].severity).toBe("warning");
    expect(stuck[0].issues).toEqual([10]);
  });

  it("stuck_issue critical: issue > 96h", () => {
    const phases: PhaseSnapshot[] = [
      {
        state: "Research Needed",
        count: 1,
        issues: [
          {
            number: 10,
            title: "Very stuck",
            priority: null,
            estimate: null,
            assignees: [],
            ageHours: 100,
            isLocked: false,
            blockedBy: [],
          },
        ],
      },
    ];

    const warnings = detectHealthIssues(phases);
    const stuck = warnings.filter((w) => w.type === "stuck_issue");
    expect(stuck.length).toBe(1);
    expect(stuck[0].severity).toBe("critical");
  });

  it("stuck_issue: does not flag terminal states", () => {
    const phases: PhaseSnapshot[] = [
      {
        state: "Done",
        count: 1,
        issues: [
          {
            number: 10,
            title: "Done long ago",
            priority: null,
            estimate: null,
            assignees: [],
            ageHours: 200,
            isLocked: false,
            blockedBy: [],
          },
        ],
      },
    ];

    const warnings = detectHealthIssues(phases);
    expect(warnings.filter((w) => w.type === "stuck_issue").length).toBe(0);
  });

  it("stuck_issue: does not flag Human Needed", () => {
    const phases: PhaseSnapshot[] = [
      {
        state: "Human Needed",
        count: 1,
        issues: [
          {
            number: 10,
            title: "Waiting for human",
            priority: null,
            estimate: null,
            assignees: [],
            ageHours: 200,
            isLocked: false,
            blockedBy: [],
          },
        ],
      },
    ];

    const warnings = detectHealthIssues(phases);
    expect(warnings.filter((w) => w.type === "stuck_issue").length).toBe(0);
  });

  it("stuck_issue: does not flag Plan in Review (human action expected)", () => {
    const phases: PhaseSnapshot[] = [
      {
        state: "Plan in Review",
        count: 1,
        issues: [
          {
            number: 10,
            title: "Awaiting review",
            priority: null,
            estimate: null,
            assignees: [],
            ageHours: 200,
            isLocked: false,
            blockedBy: [],
          },
        ],
      },
    ];

    const warnings = detectHealthIssues(phases);
    expect(warnings.filter((w) => w.type === "stuck_issue").length).toBe(0);
  });

  // Blocked
  it("blocked: detects issue with open blocker", () => {
    const phases: PhaseSnapshot[] = [
      {
        state: "Ready for Plan",
        count: 1,
        issues: [
          {
            number: 10,
            title: "Blocked issue",
            priority: null,
            estimate: null,
            assignees: [],
            ageHours: 1,
            isLocked: false,
            blockedBy: [{ number: 5, workflowState: "In Progress" }],
          },
        ],
      },
    ];

    const warnings = detectHealthIssues(phases);
    const blocked = warnings.filter((w) => w.type === "blocked");
    expect(blocked.length).toBe(1);
    expect(blocked[0].message).toContain("#5");
  });

  it("blocked: ignores resolved (Done) blockers", () => {
    const phases: PhaseSnapshot[] = [
      {
        state: "Ready for Plan",
        count: 1,
        issues: [
          {
            number: 10,
            title: "Was blocked",
            priority: null,
            estimate: null,
            assignees: [],
            ageHours: 1,
            isLocked: false,
            blockedBy: [{ number: 5, workflowState: "Done" }],
          },
        ],
      },
    ];

    const warnings = detectHealthIssues(phases);
    expect(warnings.filter((w) => w.type === "blocked").length).toBe(0);
  });

  it("blocked: ignores Canceled blockers", () => {
    const phases: PhaseSnapshot[] = [
      {
        state: "Ready for Plan",
        count: 1,
        issues: [
          {
            number: 10,
            title: "Was blocked",
            priority: null,
            estimate: null,
            assignees: [],
            ageHours: 1,
            isLocked: false,
            blockedBy: [{ number: 5, workflowState: "Canceled" }],
          },
        ],
      },
    ];

    const warnings = detectHealthIssues(phases);
    expect(warnings.filter((w) => w.type === "blocked").length).toBe(0);
  });

  // Pipeline gap
  it("pipeline_gap: flags empty non-terminal phases", () => {
    const phases: PhaseSnapshot[] = [
      { state: "Research Needed", count: 0, issues: [] },
    ];

    const warnings = detectHealthIssues(phases);
    const gaps = warnings.filter((w) => w.type === "pipeline_gap");
    expect(gaps.length).toBe(1);
    expect(gaps[0].severity).toBe("info");
  });

  it("pipeline_gap: does not flag empty Backlog", () => {
    const phases: PhaseSnapshot[] = [
      { state: "Backlog", count: 0, issues: [] },
    ];

    const warnings = detectHealthIssues(phases);
    expect(warnings.filter((w) => w.type === "pipeline_gap").length).toBe(0);
  });

  it("pipeline_gap: does not flag empty Human Needed", () => {
    const phases: PhaseSnapshot[] = [
      { state: "Human Needed", count: 0, issues: [] },
    ];

    const warnings = detectHealthIssues(phases);
    expect(warnings.filter((w) => w.type === "pipeline_gap").length).toBe(0);
  });

  // Lock collision
  it("lock_collision: detects 2+ issues in same lock state", () => {
    const phases: PhaseSnapshot[] = [
      {
        state: "In Progress",
        count: 2,
        issues: [
          {
            number: 1,
            title: "A",
            priority: null,
            estimate: null,
            assignees: [],
            ageHours: 1,
            isLocked: true,
            blockedBy: [],
          },
          {
            number: 2,
            title: "B",
            priority: null,
            estimate: null,
            assignees: [],
            ageHours: 1,
            isLocked: true,
            blockedBy: [],
          },
        ],
      },
    ];

    const warnings = detectHealthIssues(phases);
    const collisions = warnings.filter((w) => w.type === "lock_collision");
    expect(collisions.length).toBe(1);
    expect(collisions[0].severity).toBe("critical");
  });

  it("lock_collision: ok with 1 issue per lock state", () => {
    const phases: PhaseSnapshot[] = [
      {
        state: "In Progress",
        count: 1,
        issues: [
          {
            number: 1,
            title: "A",
            priority: null,
            estimate: null,
            assignees: [],
            ageHours: 1,
            isLocked: true,
            blockedBy: [],
          },
        ],
      },
    ];

    const warnings = detectHealthIssues(phases);
    expect(warnings.filter((w) => w.type === "lock_collision").length).toBe(0);
  });

  // Oversized in pipeline
  it("oversized_in_pipeline: M/L/XL past Backlog flagged", () => {
    const phases: PhaseSnapshot[] = [
      {
        state: "Research Needed",
        count: 1,
        issues: [
          {
            number: 10,
            title: "Big issue",
            priority: null,
            estimate: "L",
            assignees: [],
            ageHours: 1,
            isLocked: false,
            blockedBy: [],
          },
        ],
      },
    ];

    const warnings = detectHealthIssues(phases);
    const oversized = warnings.filter(
      (w) => w.type === "oversized_in_pipeline",
    );
    expect(oversized.length).toBe(1);
    expect(oversized[0].severity).toBe("warning");
  });

  it("oversized_in_pipeline: M/L/XL in Backlog not flagged", () => {
    const phases: PhaseSnapshot[] = [
      {
        state: "Backlog",
        count: 1,
        issues: [
          {
            number: 10,
            title: "Big backlog",
            priority: null,
            estimate: "XL",
            assignees: [],
            ageHours: 1,
            isLocked: false,
            blockedBy: [],
          },
        ],
      },
    ];

    const warnings = detectHealthIssues(phases);
    expect(
      warnings.filter((w) => w.type === "oversized_in_pipeline").length,
    ).toBe(0);
  });

  it("oversized_in_pipeline: XS/S not flagged anywhere", () => {
    const phases: PhaseSnapshot[] = [
      {
        state: "In Progress",
        count: 1,
        issues: [
          {
            number: 10,
            title: "Small",
            priority: null,
            estimate: "S",
            assignees: [],
            ageHours: 1,
            isLocked: true,
            blockedBy: [],
          },
        ],
      },
    ];

    const warnings = detectHealthIssues(phases);
    expect(
      warnings.filter((w) => w.type === "oversized_in_pipeline").length,
    ).toBe(0);
  });

  // Multiple warnings
  it("returns multiple warnings correctly", () => {
    const phases: PhaseSnapshot[] = [
      {
        state: "In Progress",
        count: 2,
        issues: [
          {
            number: 1,
            title: "A",
            priority: null,
            estimate: "M",
            assignees: [],
            ageHours: 100,
            isLocked: true,
            blockedBy: [{ number: 5, workflowState: "Backlog" }],
          },
          {
            number: 2,
            title: "B",
            priority: null,
            estimate: null,
            assignees: [],
            ageHours: 1,
            isLocked: true,
            blockedBy: [],
          },
        ],
      },
    ];

    const warnings = detectHealthIssues(phases);
    const types = warnings.map((w) => w.type);
    expect(types).toContain("lock_collision");
    expect(types).toContain("stuck_issue");
    expect(types).toContain("blocked");
    expect(types).toContain("oversized_in_pipeline");
  });

  it("health.ok is true when no warnings", () => {
    const phases: PhaseSnapshot[] = [
      {
        state: "Backlog",
        count: 1,
        issues: [
          {
            number: 1,
            title: "OK",
            priority: null,
            estimate: "S",
            assignees: [],
            ageHours: 1,
            isLocked: false,
            blockedBy: [],
          },
        ],
      },
    ];

    const warnings = detectHealthIssues(phases);
    expect(warnings.length).toBe(0);
  });

  it("sorts warnings by severity (critical first)", () => {
    const phases: PhaseSnapshot[] = [
      { state: "Research Needed", count: 0, issues: [] }, // pipeline_gap (info)
      {
        state: "In Progress",
        count: 2,
        issues: [
          {
            number: 1,
            title: "A",
            priority: null,
            estimate: null,
            assignees: [],
            ageHours: 60,
            isLocked: true,
            blockedBy: [],
          },
          {
            number: 2,
            title: "B",
            priority: null,
            estimate: null,
            assignees: [],
            ageHours: 1,
            isLocked: true,
            blockedBy: [],
          },
        ],
      }, // lock_collision (critical) + stuck (warning)
    ];

    const warnings = detectHealthIssues(phases);
    expect(warnings.length).toBeGreaterThan(1);
    // critical should come first
    expect(warnings[0].severity).toBe("critical");
    // info should come last
    expect(warnings[warnings.length - 1].severity).toBe("info");
  });
});

// ---------------------------------------------------------------------------
// formatMarkdown
// ---------------------------------------------------------------------------

describe("formatMarkdown", () => {
  const dashboard = buildDashboard(
    [
      makeItem({ number: 1, workflowState: "Backlog", priority: "P1", estimate: "S" }),
      makeItem({ number: 2, workflowState: "Backlog", priority: "P0", estimate: "XS" }),
      makeItem({ number: 3, workflowState: "In Progress" }),
    ],
    DEFAULT_HEALTH_CONFIG,
    NOW,
  );

  it("produces table with Phase/Count/Issues columns", () => {
    const md = formatMarkdown(dashboard);
    expect(md).toContain("| Phase | Count | Issues |");
    expect(md).toContain("|-------|------:|--------|");
  });

  it("includes health warnings section when warnings exist", () => {
    const unhealthy = buildDashboard(
      [
        makeItem({
          number: 1,
          workflowState: "In Progress",
          updatedAt: new Date(NOW - 100 * HOUR_MS).toISOString(),
        }),
      ],
      DEFAULT_HEALTH_CONFIG,
      NOW,
    );
    const md = formatMarkdown(unhealthy);
    expect(md).toContain("**Health Warnings**:");
  });

  it("shows All clear when healthy", () => {
    // Use manually constructed data to avoid pipeline_gap warnings from empty phases
    const healthy: import("../lib/dashboard.js").DashboardData = {
      generatedAt: new Date(NOW).toISOString(),
      totalIssues: 1,
      phases: [{ state: "Backlog", count: 1, issues: [] }],
      health: { ok: true, warnings: [] },
      archive: { eligibleForArchive: 0, eligibleItems: [], recentlyCompleted: 0, archiveThresholdDays: 14 },
    };
    const md = formatMarkdown(healthy);
    expect(md).toContain("**Health**: All clear");
  });

  it("includes timestamp header", () => {
    const md = formatMarkdown(dashboard);
    expect(md).toContain("# Pipeline Status");
    expect(md).toContain("_Generated:");
  });

  it("handles 0-count phases", () => {
    const md = formatMarkdown(dashboard);
    // Research Needed has 0 items
    expect(md).toContain("| Research Needed | 0 |");
  });

  it("truncates long issue lists with more indicator", () => {
    // Create 15 items in one phase
    const items = Array.from({ length: 15 }, (_, i) =>
      makeItem({ number: i + 1, workflowState: "Backlog" }),
    );
    const d = buildDashboard(items, DEFAULT_HEALTH_CONFIG, NOW);
    const md = formatMarkdown(d, 5);
    expect(md).toContain("... +10 more");
  });

  it("includes issue priority and estimate in listing", () => {
    const md = formatMarkdown(dashboard);
    expect(md).toContain("#2, P0, XS");
    expect(md).toContain("#1, P1, S");
  });
});

// ---------------------------------------------------------------------------
// formatAscii
// ---------------------------------------------------------------------------

describe("formatAscii", () => {
  const dashboard = buildDashboard(
    [
      makeItem({ number: 1, workflowState: "Backlog" }),
      makeItem({ number: 2, workflowState: "Backlog" }),
      makeItem({ number: 3, workflowState: "In Progress" }),
    ],
    DEFAULT_HEALTH_CONFIG,
    NOW,
  );

  it("produces bar chart with proportional bars", () => {
    const ascii = formatAscii(dashboard);
    // Backlog has 2, In Progress has 1 — Backlog bar should be longer
    const lines = ascii.split("\n");
    const backlogLine = lines.find((l) => l.includes("Backlog"));
    const ipLine = lines.find((l) => l.includes("In Progress"));
    expect(backlogLine).toBeDefined();
    expect(ipLine).toBeDefined();
    // Backlog should have more block chars than In Progress
    const backlogBlocks = (backlogLine!.match(/\u2588/g) || []).length;
    const ipBlocks = (ipLine!.match(/\u2588/g) || []).length;
    expect(backlogBlocks).toBeGreaterThan(ipBlocks);
  });

  it("shows health summary line", () => {
    const ascii = formatAscii(dashboard);
    // This dashboard has pipeline gaps (info level)
    expect(ascii).toContain("Health:");
  });

  it("handles 0-count phases with empty bar marker", () => {
    const ascii = formatAscii(dashboard);
    // Research Needed has 0 items, should show ░
    const lines = ascii.split("\n");
    const rnLine = lines.find((l) => l.includes("Research Needed"));
    expect(rnLine).toBeDefined();
    expect(rnLine).toContain("\u2591");
    expect(rnLine).toContain(" 0");
  });

  it("includes timestamp header", () => {
    const ascii = formatAscii(dashboard);
    expect(ascii).toContain("Pipeline Status (");
  });

  it("shows Health: OK when no warnings", () => {
    // Use manually constructed data to avoid pipeline_gap warnings from empty phases
    const healthy: import("../lib/dashboard.js").DashboardData = {
      generatedAt: new Date(NOW).toISOString(),
      totalIssues: 1,
      phases: [{ state: "Backlog", count: 1, issues: [] }],
      health: { ok: true, warnings: [] },
      archive: { eligibleForArchive: 0, eligibleItems: [], recentlyCompleted: 0, archiveThresholdDays: 14 },
    };
    const ascii = formatAscii(healthy);
    expect(ascii).toContain("Health: OK");
  });

  it("shows warning counts by severity", () => {
    const unhealthy = buildDashboard(
      [
        makeItem({
          number: 1,
          workflowState: "In Progress",
          updatedAt: new Date(NOW - 100 * HOUR_MS).toISOString(),
        }),
        makeItem({
          number: 2,
          workflowState: "In Progress",
        }),
      ],
      DEFAULT_HEALTH_CONFIG,
      NOW,
    );
    const ascii = formatAscii(unhealthy);
    expect(ascii).toContain("critical");
  });
});

// ---------------------------------------------------------------------------
// buildDashboard (integration)
// ---------------------------------------------------------------------------

describe("buildDashboard", () => {
  it("end-to-end: items in, full DashboardData out", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog", priority: "P0" }),
      makeItem({ number: 2, workflowState: "In Progress" }),
      makeItem({ number: 3, workflowState: "Done" }),
    ];

    const data = buildDashboard(items, DEFAULT_HEALTH_CONFIG, NOW);

    expect(data.generatedAt).toBeTruthy();
    expect(data.totalIssues).toBe(3);
    expect(data.phases.length).toBeGreaterThan(0);
    expect(data.health).toBeDefined();
    expect(typeof data.health.ok).toBe("boolean");
    expect(Array.isArray(data.health.warnings)).toBe(true);
  });

  it("with default config produces expected structure", () => {
    const data = buildDashboard([], DEFAULT_HEALTH_CONFIG, NOW);

    expect(data.totalIssues).toBe(0);
    expect(data.health.ok).toBe(false); // pipeline gaps generate info warnings
    // All phases should be present
    for (const state of STATE_ORDER) {
      expect(data.phases.find((p) => p.state === state)).toBeDefined();
    }
  });

  it("with custom WIP limits triggers wip_exceeded", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog" }),
      makeItem({ number: 2, workflowState: "Backlog" }),
      makeItem({ number: 3, workflowState: "Backlog" }),
    ];
    const config: HealthConfig = {
      ...DEFAULT_HEALTH_CONFIG,
      wipLimits: { Backlog: 2 },
    };

    const data = buildDashboard(items, config, NOW);
    const wip = data.health.warnings.filter((w) => w.type === "wip_exceeded");
    expect(wip.length).toBe(1);
    expect(wip[0].issues).toEqual([1, 2, 3]);
  });

  it("generatedAt is valid ISO timestamp", () => {
    const data = buildDashboard([], DEFAULT_HEALTH_CONFIG, NOW);
    const parsed = new Date(data.generatedAt);
    expect(parsed.getTime()).toBe(NOW);
  });

  it("includes archive stats in output", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        updatedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
      }),
      makeItem({
        number: 2,
        workflowState: "Done",
        updatedAt: new Date(NOW - 3 * DAY_MS).toISOString(),
      }),
    ];

    const data = buildDashboard(items, DEFAULT_HEALTH_CONFIG, NOW);
    expect(data.archive).toBeDefined();
    expect(data.archive.archiveThresholdDays).toBe(14);
    expect(data.archive.eligibleForArchive).toBe(1);
    expect(data.archive.eligibleItems[0].number).toBe(1);
    expect(data.archive.recentlyCompleted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeArchiveStats
// ---------------------------------------------------------------------------

describe("computeArchiveStats", () => {
  it("marks Done items beyond threshold as eligible", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        updatedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
      }),
    ];

    const stats = computeArchiveStats(items, NOW, 14, 7);
    expect(stats.eligibleForArchive).toBe(1);
    expect(stats.eligibleItems[0].number).toBe(1);
    expect(stats.eligibleItems[0].staleDays).toBe(20);
  });

  it("marks Canceled items beyond threshold as eligible", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Canceled",
        updatedAt: new Date(NOW - 18 * DAY_MS).toISOString(),
      }),
    ];

    const stats = computeArchiveStats(items, NOW, 14, 7);
    expect(stats.eligibleForArchive).toBe(1);
    expect(stats.eligibleItems[0].workflowState).toBe("Canceled");
  });

  it("does not mark Done items within threshold as eligible", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        updatedAt: new Date(NOW - 5 * DAY_MS).toISOString(),
      }),
    ];

    const stats = computeArchiveStats(items, NOW, 14, 7);
    expect(stats.eligibleForArchive).toBe(0);
  });

  it("never marks non-terminal items as eligible", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 100 * DAY_MS).toISOString(),
      }),
      makeItem({
        number: 2,
        workflowState: "In Progress",
        updatedAt: new Date(NOW - 100 * DAY_MS).toISOString(),
      }),
    ];

    const stats = computeArchiveStats(items, NOW, 14, 7);
    expect(stats.eligibleForArchive).toBe(0);
  });

  it("counts recently completed items within doneWindowDays", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        updatedAt: new Date(NOW - 3 * DAY_MS).toISOString(),
      }),
      makeItem({
        number: 2,
        workflowState: "Done",
        updatedAt: new Date(NOW - 5 * DAY_MS).toISOString(),
      }),
      makeItem({
        number: 3,
        workflowState: "Done",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
      }),
    ];

    const stats = computeArchiveStats(items, NOW, 14, 7);
    expect(stats.recentlyCompleted).toBe(2);
  });

  it("sorts eligible items by staleDays descending", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        updatedAt: new Date(NOW - 15 * DAY_MS).toISOString(),
      }),
      makeItem({
        number: 2,
        workflowState: "Done",
        updatedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
      }),
      makeItem({
        number: 3,
        workflowState: "Canceled",
        updatedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
      }),
    ];

    const stats = computeArchiveStats(items, NOW, 14, 7);
    expect(stats.eligibleItems.map((i) => i.number)).toEqual([2, 3, 1]);
  });

  it("uses closedAt when available, falls back to updatedAt", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        updatedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
        closedAt: new Date(NOW - 5 * DAY_MS).toISOString(), // closed recently
      }),
    ];

    const stats = computeArchiveStats(items, NOW, 14, 7);
    // Should use closedAt (5 days) not updatedAt (20 days), so NOT eligible
    expect(stats.eligibleForArchive).toBe(0);
    expect(stats.recentlyCompleted).toBe(1);
  });

  it("returns 0 eligible and 0 recent for empty items", () => {
    const stats = computeArchiveStats([], NOW, 14, 7);
    expect(stats.eligibleForArchive).toBe(0);
    expect(stats.eligibleItems).toEqual([]);
    expect(stats.recentlyCompleted).toBe(0);
    expect(stats.archiveThresholdDays).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// formatMarkdown archive section
// ---------------------------------------------------------------------------

describe("formatMarkdown archive section", () => {
  it("includes archive eligibility section with eligible items", () => {
    const items = [
      makeItem({
        number: 42,
        title: "Fix login timeout",
        workflowState: "Done",
        updatedAt: new Date(NOW - 21 * DAY_MS).toISOString(),
      }),
    ];
    const d = buildDashboard(items, DEFAULT_HEALTH_CONFIG, NOW);
    const md = formatMarkdown(d);
    expect(md).toContain("## Archive Eligibility");
    expect(md).toContain("**Eligible for archive**: 1 items");
    expect(md).toContain("| #42 | Fix login timeout | Done | 21 |");
  });

  it("shows 0 eligible with no table when nothing to archive", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        updatedAt: new Date(NOW - 3 * DAY_MS).toISOString(),
      }),
    ];
    const d = buildDashboard(items, DEFAULT_HEALTH_CONFIG, NOW);
    const md = formatMarkdown(d);
    expect(md).toContain("**Eligible for archive**: 0 items");
    expect(md).not.toContain("| # | Title | State | Stale Days |");
  });
});

// ---------------------------------------------------------------------------
// formatAscii archive section
// ---------------------------------------------------------------------------

describe("formatAscii archive section", () => {
  it("includes archive summary line", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        updatedAt: new Date(NOW - 21 * DAY_MS).toISOString(),
      }),
    ];
    const d = buildDashboard(items, DEFAULT_HEALTH_CONFIG, NOW);
    const ascii = formatAscii(d);
    expect(ascii).toContain("Archive: 1 eligible (threshold: 14d), 0 recent");
  });
});

// ---------------------------------------------------------------------------
// toDashboardItems
// ---------------------------------------------------------------------------

function makeRawItem(overrides: Partial<RawDashboardItem> = {}): RawDashboardItem {
  return {
    id: "item-1",
    type: "ISSUE",
    content: {
      __typename: "Issue",
      number: 1,
      title: "Test issue",
      state: "OPEN",
      updatedAt: new Date(NOW - 1 * HOUR_MS).toISOString(),
      closedAt: null,
      assignees: { nodes: [{ login: "alice" }] },
    },
    fieldValues: {
      nodes: [
        {
          __typename: "ProjectV2ItemFieldSingleSelectValue",
          name: "Backlog",
          field: { name: "Workflow State" },
        },
      ],
    },
    ...overrides,
  };
}

describe("toDashboardItems", () => {
  it("sets projectNumber on items when provided", () => {
    const raw = [makeRawItem()];
    const items = toDashboardItems(raw, 5);
    expect(items).toHaveLength(1);
    expect(items[0].projectNumber).toBe(5);
  });

  it("does not set projectNumber when not provided (backward compat)", () => {
    const raw = [makeRawItem()];
    const items = toDashboardItems(raw);
    expect(items).toHaveLength(1);
    expect(items[0].projectNumber).toBeUndefined();
  });

  it("sets projectTitle on items when provided", () => {
    const raw = [makeRawItem()];
    const items = toDashboardItems(raw, 3, "My Board");
    expect(items[0].projectTitle).toBe("My Board");
  });

  it("filters out non-Issue content types", () => {
    const raw = [
      makeRawItem(),
      makeRawItem({
        id: "item-2",
        content: { __typename: "PullRequest", number: 2, title: "PR" },
      }),
      makeRawItem({
        id: "item-3",
        content: { __typename: "DraftIssue", title: "Draft" },
      }),
    ];
    const items = toDashboardItems(raw);
    expect(items).toHaveLength(1);
    expect(items[0].number).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Multi-project dashboard (buildDashboard integration)
// ---------------------------------------------------------------------------

describe("multi-project dashboard", () => {
  it("aggregates items from multiple projects correctly", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog", projectNumber: 3, projectTitle: "Board A" }),
      makeItem({ number: 2, workflowState: "Backlog", projectNumber: 5, projectTitle: "Board B" }),
      makeItem({ number: 3, workflowState: "In Progress", projectNumber: 3, projectTitle: "Board A" }),
    ];

    const data = buildDashboard(items, DEFAULT_HEALTH_CONFIG, NOW);
    expect(data.totalIssues).toBe(3);
    expect(findPhase(data.phases, "Backlog").count).toBe(2);
    expect(findPhase(data.phases, "In Progress").count).toBe(1);
  });

  it("items from different projects with same issue number are distinct", () => {
    const items = [
      makeItem({ number: 10, workflowState: "Backlog", projectNumber: 3 }),
      makeItem({ number: 10, workflowState: "In Progress", projectNumber: 5 }),
    ];

    const data = buildDashboard(items, DEFAULT_HEALTH_CONFIG, NOW);
    expect(data.totalIssues).toBe(2);
    expect(findPhase(data.phases, "Backlog").count).toBe(1);
    expect(findPhase(data.phases, "In Progress").count).toBe(1);
  });

  it("preserves projectNumber and projectTitle through makeItem", () => {
    const item = makeItem({ number: 7, projectNumber: 3, projectTitle: "My Board" });
    expect(item.projectNumber).toBe(3);
    expect(item.projectTitle).toBe("My Board");
  });
});
