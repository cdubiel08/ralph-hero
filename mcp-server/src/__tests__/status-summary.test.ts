/**
 * Tests for `buildStatusSummary` — a pure projection over the existing
 * dashboard aggregation (`aggregateByPhase`/`detectHealthIssues`) and
 * metrics primitives (`calculateVelocity`/`calculateRiskScore`/
 * `determineStatus`). No I/O, so no mocking is needed.
 *
 * Style mirrors dashboard.test.ts (pure-function-only harness).
 */

import { describe, it, expect } from "vitest";
import { buildStatusSummary } from "../lib/status-summary.js";
import {
  DEFAULT_HEALTH_CONFIG,
  type DashboardItem,
  type HealthConfig,
} from "../lib/dashboard.js";
import {
  calculateVelocity,
  calculateRiskScore,
  determineStatus,
  DEFAULT_METRICS_CONFIG,
  type MetricsConfig,
} from "../lib/metrics.js";
import { aggregateByPhase, detectHealthIssues } from "../lib/dashboard.js";

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
    updatedAt: new Date(NOW - 1 * HOUR_MS).toISOString(),
    closedAt: null,
    workflowState: "Backlog",
    priority: null,
    estimate: null,
    assignees: [],
    subIssueCount: 0,
    blockedBy: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildStatusSummary
// ---------------------------------------------------------------------------

describe("buildStatusSummary", () => {
  it("returns an all-zero/empty summary for empty items", () => {
    const summary = buildStatusSummary([], DEFAULT_HEALTH_CONFIG, DEFAULT_METRICS_CONFIG, NOW);
    expect(summary.totalIssues).toBe(0);
    expect(summary.phaseCounts).toEqual({});
    expect(summary.stuckIssues).toEqual([]);
    expect(summary.wipViolations).toBe(0);
    expect(summary.blockedDeps).toBe(0);
    expect(summary.velocity).toBe(0);
    expect(summary.riskScore).toBe(0);
    expect(summary.health).toBe("ON_TRACK");
  });

  it("totalIssues equals items.length", () => {
    const items = [
      makeItem({ number: 1 }),
      makeItem({ number: 2, workflowState: "In Progress" }),
      makeItem({ number: 3, workflowState: "Done" }),
    ];
    const summary = buildStatusSummary(items, DEFAULT_HEALTH_CONFIG, DEFAULT_METRICS_CONFIG, NOW);
    expect(summary.totalIssues).toBe(3);
  });

  it("phaseCounts omits zero-count phases", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog" }),
      makeItem({ number: 2, workflowState: "Backlog" }),
      makeItem({ number: 3, workflowState: "In Progress" }),
    ];
    const summary = buildStatusSummary(items, DEFAULT_HEALTH_CONFIG, DEFAULT_METRICS_CONFIG, NOW);
    expect(summary.phaseCounts).toEqual({ Backlog: 2, "In Progress": 1 });
    expect(summary.phaseCounts["Research Needed"]).toBeUndefined();
  });

  it("stuckIssues returns at most 5 entries sorted descending by ageHours with correct shape", () => {
    const config: HealthConfig = { ...DEFAULT_HEALTH_CONFIG, stuckThresholdHours: 48 };
    // 7 issues in In Progress, all older than the 48h threshold, with
    // distinct ages so we can assert descending order.
    const items = Array.from({ length: 7 }, (_, i) =>
      makeItem({
        number: 100 + i,
        title: `Stuck issue ${i}`,
        workflowState: "In Progress",
        updatedAt: new Date(NOW - (50 + i * 10) * HOUR_MS).toISOString(),
      }),
    );

    const summary = buildStatusSummary(items, config, DEFAULT_METRICS_CONFIG, NOW);
    expect(summary.stuckIssues.length).toBeLessThanOrEqual(5);
    expect(summary.stuckIssues).toHaveLength(5);

    // Descending by ageHours
    for (let i = 1; i < summary.stuckIssues.length; i++) {
      expect(summary.stuckIssues[i - 1].ageHours).toBeGreaterThanOrEqual(
        summary.stuckIssues[i].ageHours,
      );
    }

    // Shape + values for the oldest (highest index → oldest updatedAt)
    const oldest = summary.stuckIssues[0];
    expect(oldest.number).toBe(106);
    expect(oldest.title).toBe("Stuck issue 6");
    expect(oldest.state).toBe("In Progress");
    expect(oldest.ageHours).toBeGreaterThan(0);
  });

  it("wipViolations/blockedDeps equal the count of matching HealthWarning types", () => {
    const config: HealthConfig = {
      ...DEFAULT_HEALTH_CONFIG,
      wipLimits: { "In Progress": 1 },
    };
    const items = [
      makeItem({ number: 1, workflowState: "In Progress" }),
      makeItem({ number: 2, workflowState: "In Progress" }),
      makeItem({
        number: 3,
        workflowState: "Ready for Plan",
        blockedBy: [{ number: 99, workflowState: "In Progress" }],
      }),
    ];

    const summary = buildStatusSummary(items, config, DEFAULT_METRICS_CONFIG, NOW);

    // Cross-check directly against the underlying primitives.
    const phases = aggregateByPhase(items, NOW, config);
    const warnings = detectHealthIssues(phases, config);
    const expectedWip = warnings.filter((w) => w.type === "wip_exceeded").length;
    const expectedBlocked = warnings.filter((w) => w.type === "blocked").length;

    expect(summary.wipViolations).toBe(expectedWip);
    expect(summary.wipViolations).toBeGreaterThan(0);
    expect(summary.blockedDeps).toBe(expectedBlocked);
    expect(summary.blockedDeps).toBeGreaterThan(0);
  });

  it("velocity/riskScore/health match hand-computed values, proving delegation not reimplementation", () => {
    const healthConfig: HealthConfig = { ...DEFAULT_HEALTH_CONFIG };
    const metricsConfig: MetricsConfig = { ...DEFAULT_METRICS_CONFIG };
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        closedAt: new Date(NOW - 1 * DAY_MS).toISOString(),
      }),
      makeItem({
        number: 2,
        workflowState: "Done",
        closedAt: new Date(NOW - 20 * DAY_MS).toISOString(), // outside window
      }),
      makeItem({
        number: 3,
        workflowState: "In Progress",
        updatedAt: new Date(NOW - 200 * HOUR_MS).toISOString(), // critical stuck
      }),
    ];

    const summary = buildStatusSummary(items, healthConfig, metricsConfig, NOW);

    const phases = aggregateByPhase(items, NOW, healthConfig);
    const warnings = detectHealthIssues(phases, healthConfig);
    const expectedVelocity = calculateVelocity(items, metricsConfig.velocityWindowDays, NOW);
    const expectedRiskScore = calculateRiskScore(warnings, metricsConfig.severityWeights);
    const expectedHealth = determineStatus(expectedRiskScore, metricsConfig);

    expect(summary.velocity).toBe(expectedVelocity);
    expect(summary.riskScore).toBe(expectedRiskScore);
    expect(summary.health).toBe(expectedHealth);
  });
});
