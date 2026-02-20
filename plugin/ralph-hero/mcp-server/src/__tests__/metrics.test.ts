/**
 * Tests for velocity metrics, risk scoring, and auto-status determination.
 *
 * All functions under test are pure (no I/O), so no mocking is needed.
 * Follows dashboard.test.ts patterns: fixed NOW, makeItem factory.
 */

import { describe, it, expect } from "vitest";
import {
  calculateVelocity,
  calculateRiskScore,
  determineStatus,
  extractHighlights,
  calculateMetrics,
  DEFAULT_METRICS_CONFIG,
} from "../lib/metrics.js";
import {
  buildDashboard,
  DEFAULT_HEALTH_CONFIG,
  type DashboardItem,
  type DashboardData,
  type HealthWarning,
} from "../lib/dashboard.js";

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

function makeWarning(
  overrides: Partial<HealthWarning> = {},
): HealthWarning {
  return {
    type: "stuck_issue",
    severity: "warning",
    message: "test warning",
    issues: [1],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// calculateVelocity
// ---------------------------------------------------------------------------

describe("calculateVelocity", () => {
  it("returns count of Done items within window (closedAt within 7 days)", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        closedAt: new Date(NOW - 2 * DAY_MS).toISOString(),
      }),
      makeItem({
        number: 2,
        workflowState: "Done",
        closedAt: new Date(NOW - 5 * DAY_MS).toISOString(),
      }),
    ];

    expect(calculateVelocity(items, 7, NOW)).toBe(2);
  });

  it("uses updatedAt fallback when closedAt is null", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        closedAt: null,
        updatedAt: new Date(NOW - 3 * DAY_MS).toISOString(),
      }),
    ];

    expect(calculateVelocity(items, 7, NOW)).toBe(1);
  });

  it("excludes Done items outside window", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        closedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
      }),
    ];

    expect(calculateVelocity(items, 7, NOW)).toBe(0);
  });

  it("ignores non-Done items", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog" }),
      makeItem({ number: 2, workflowState: "In Progress" }),
      makeItem({ number: 3, workflowState: "Canceled" }),
    ];

    expect(calculateVelocity(items, 7, NOW)).toBe(0);
  });

  it("returns 0 for empty items array", () => {
    expect(calculateVelocity([], 7, NOW)).toBe(0);
  });

  it("returns 0 when no Done items in window", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        closedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
      }),
      makeItem({ number: 2, workflowState: "Backlog" }),
    ];

    expect(calculateVelocity(items, 7, NOW)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// calculateRiskScore
// ---------------------------------------------------------------------------

describe("calculateRiskScore", () => {
  const weights = { critical: 3, warning: 1, info: 0 };

  it("returns 0 for empty warnings array", () => {
    expect(calculateRiskScore([], weights)).toBe(0);
  });

  it("sums weights correctly: 2 critical + 1 warning = 7", () => {
    const warnings = [
      makeWarning({ severity: "critical" }),
      makeWarning({ severity: "critical" }),
      makeWarning({ severity: "warning" }),
    ];

    expect(calculateRiskScore(warnings, weights)).toBe(7);
  });

  it("treats unknown severity as 0", () => {
    const warnings = [
      makeWarning({ severity: "unknown" as HealthWarning["severity"] }),
    ];

    expect(calculateRiskScore(warnings, weights)).toBe(0);
  });

  it("single critical = 3", () => {
    expect(
      calculateRiskScore([makeWarning({ severity: "critical" })], weights),
    ).toBe(3);
  });

  it("single warning = 1", () => {
    expect(
      calculateRiskScore([makeWarning({ severity: "warning" })], weights),
    ).toBe(1);
  });

  it("single info = 0", () => {
    expect(
      calculateRiskScore([makeWarning({ severity: "info" })], weights),
    ).toBe(0);
  });

  it("custom weights override defaults", () => {
    const customWeights = { critical: 10, warning: 5, info: 2 };
    const warnings = [
      makeWarning({ severity: "critical" }),
      makeWarning({ severity: "info" }),
    ];

    expect(calculateRiskScore(warnings, customWeights)).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// determineStatus
// ---------------------------------------------------------------------------

describe("determineStatus", () => {
  const config = { atRiskThreshold: 2, offTrackThreshold: 6 };

  it("OFF_TRACK when riskScore >= offTrackThreshold", () => {
    expect(determineStatus(6, config)).toBe("OFF_TRACK");
    expect(determineStatus(10, config)).toBe("OFF_TRACK");
  });

  it("AT_RISK when riskScore >= atRiskThreshold but < offTrackThreshold", () => {
    expect(determineStatus(2, config)).toBe("AT_RISK");
    expect(determineStatus(5, config)).toBe("AT_RISK");
  });

  it("ON_TRACK when riskScore < atRiskThreshold", () => {
    expect(determineStatus(0, config)).toBe("ON_TRACK");
    expect(determineStatus(1, config)).toBe("ON_TRACK");
  });

  it("boundary: exactly at threshold returns the higher status", () => {
    expect(determineStatus(2, config)).toBe("AT_RISK");
    expect(determineStatus(6, config)).toBe("OFF_TRACK");
  });
});

// ---------------------------------------------------------------------------
// extractHighlights
// ---------------------------------------------------------------------------

describe("extractHighlights", () => {
  it("recentlyCompleted returns Done phase issues", () => {
    const data: DashboardData = {
      generatedAt: new Date(NOW).toISOString(),
      totalIssues: 2,
      phases: [
        {
          state: "Done",
          count: 2,
          issues: [
            {
              number: 1,
              title: "Completed A",
              priority: null,
              estimate: null,
              assignees: [],
              ageHours: 24,
              isLocked: false,
              blockedBy: [],
            },
            {
              number: 2,
              title: "Completed B",
              priority: null,
              estimate: null,
              assignees: [],
              ageHours: 48,
              isLocked: false,
              blockedBy: [],
            },
          ],
        },
      ],
      health: { ok: true, warnings: [] },
    };

    const highlights = extractHighlights(data, 7, NOW);
    expect(highlights.recentlyCompleted).toEqual([
      { number: 1, title: "Completed A" },
      { number: 2, title: "Completed B" },
    ]);
  });

  it("newlyAdded returns recent Backlog items", () => {
    const data: DashboardData = {
      generatedAt: new Date(NOW).toISOString(),
      totalIssues: 2,
      phases: [
        {
          state: "Backlog",
          count: 2,
          issues: [
            {
              number: 10,
              title: "New item",
              priority: null,
              estimate: null,
              assignees: [],
              ageHours: 12, // < 7*24 = 168h
              isLocked: false,
              blockedBy: [],
            },
            {
              number: 11,
              title: "Old item",
              priority: null,
              estimate: null,
              assignees: [],
              ageHours: 200, // > 168h
              isLocked: false,
              blockedBy: [],
            },
          ],
        },
      ],
      health: { ok: true, warnings: [] },
    };

    const highlights = extractHighlights(data, 7, NOW);
    expect(highlights.newlyAdded).toEqual([
      { number: 10, title: "New item" },
    ]);
  });

  it("excludes old Backlog items", () => {
    const data: DashboardData = {
      generatedAt: new Date(NOW).toISOString(),
      totalIssues: 1,
      phases: [
        {
          state: "Backlog",
          count: 1,
          issues: [
            {
              number: 1,
              title: "Old",
              priority: null,
              estimate: null,
              assignees: [],
              ageHours: 500,
              isLocked: false,
              blockedBy: [],
            },
          ],
        },
      ],
      health: { ok: true, warnings: [] },
    };

    const highlights = extractHighlights(data, 7, NOW);
    expect(highlights.newlyAdded).toEqual([]);
  });

  it("handles missing Done/Backlog phases gracefully", () => {
    const data: DashboardData = {
      generatedAt: new Date(NOW).toISOString(),
      totalIssues: 1,
      phases: [
        { state: "In Progress", count: 1, issues: [] },
      ],
      health: { ok: true, warnings: [] },
    };

    const highlights = extractHighlights(data, 7, NOW);
    expect(highlights.recentlyCompleted).toEqual([]);
    expect(highlights.newlyAdded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// calculateMetrics (integration)
// ---------------------------------------------------------------------------

describe("calculateMetrics", () => {
  it("items with mixed states produce correct velocity, risk, status, highlights", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        closedAt: new Date(NOW - 2 * DAY_MS).toISOString(),
      }),
      makeItem({
        number: 2,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 1 * HOUR_MS).toISOString(),
      }),
      makeItem({
        number: 3,
        workflowState: "In Progress",
        updatedAt: new Date(NOW - 100 * HOUR_MS).toISOString(),
      }),
    ];

    const dashboard = buildDashboard(items, DEFAULT_HEALTH_CONFIG, NOW);
    const result = calculateMetrics(items, dashboard, DEFAULT_METRICS_CONFIG, NOW);

    expect(result.velocity).toBe(1);
    expect(result.riskScore).toBeGreaterThan(0); // stuck + pipeline gaps
    expect(typeof result.status).toBe("string");
    expect(result.highlights.recentlyCompleted.length).toBe(1);
    expect(result.highlights.newlyAdded.length).toBe(1);
  });

  it("healthy project: 0 warnings, positive velocity = ON_TRACK", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        closedAt: new Date(NOW - 1 * DAY_MS).toISOString(),
      }),
    ];

    // Manually construct dashboard without pipeline_gap warnings
    const data: DashboardData = {
      generatedAt: new Date(NOW).toISOString(),
      totalIssues: 1,
      phases: [
        {
          state: "Done",
          count: 1,
          issues: [
            {
              number: 1,
              title: "Test issue",
              priority: null,
              estimate: null,
              assignees: [],
              ageHours: 24,
              isLocked: false,
              blockedBy: [],
            },
          ],
        },
      ],
      health: { ok: true, warnings: [] },
    };

    const result = calculateMetrics(items, data, DEFAULT_METRICS_CONFIG, NOW);
    expect(result.velocity).toBe(1);
    expect(result.riskScore).toBe(0);
    expect(result.status).toBe("ON_TRACK");
  });

  it("unhealthy project: multiple critical warnings = OFF_TRACK", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog" }),
    ];

    const data: DashboardData = {
      generatedAt: new Date(NOW).toISOString(),
      totalIssues: 1,
      phases: [],
      health: {
        ok: false,
        warnings: [
          makeWarning({ severity: "critical" }),
          makeWarning({ severity: "critical" }),
          makeWarning({ severity: "warning" }),
        ],
      },
    };

    const result = calculateMetrics(items, data, DEFAULT_METRICS_CONFIG, NOW);
    expect(result.riskScore).toBe(7); // 3+3+1
    expect(result.status).toBe("OFF_TRACK");
  });
});
