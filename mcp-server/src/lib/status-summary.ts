/**
 * Compact pipeline status projection — pure functions.
 *
 * `buildStatusSummary` is a thin projection over the existing dashboard
 * aggregation (`aggregateByPhase` / `detectHealthIssues` in `./dashboard.js`)
 * and metrics primitives (`calculateVelocity` / `calculateRiskScore` /
 * `determineStatus` in `./metrics.js`). It intentionally does not
 * reimplement any bucketing, warning-detection, or scoring logic — it only
 * reshapes their outputs into the compact ~1-2KB shape that
 * `ralph_hero__pipeline_dashboard`'s `view: "summary"` returns (GH-1610
 * merged the formerly standalone summary tool into `pipeline_dashboard`
 * behind that enum; see `mcp-server/src/tools/dashboard-tools.ts`).
 */

import {
  aggregateByPhase,
  detectHealthIssues,
  DEFAULT_HEALTH_CONFIG,
  type DashboardItem,
  type HealthConfig,
} from "./dashboard.js";
import {
  calculateVelocity,
  calculateRiskScore,
  determineStatus,
  DEFAULT_METRICS_CONFIG,
  type MetricsConfig,
  type ProjectHealthStatus,
} from "./metrics.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineStatusSummary {
  health: ProjectHealthStatus;
  riskScore: number;
  velocity: number;
  totalIssues: number;
  phaseCounts: Record<string, number>;
  stuckIssues: Array<{
    number: number;
    title: string;
    state: string;
    ageHours: number;
  }>;
  wipViolations: number;
  blockedDeps: number;
}

// ---------------------------------------------------------------------------
// buildStatusSummary
// ---------------------------------------------------------------------------

/**
 * Project a compact status summary from raw dashboard items.
 *
 * Delegates all bucketing/scoring to the existing dashboard + metrics
 * primitives; this function only reshapes their outputs.
 */
export function buildStatusSummary(
  items: DashboardItem[],
  healthConfig: HealthConfig = DEFAULT_HEALTH_CONFIG,
  metricsConfig: MetricsConfig = DEFAULT_METRICS_CONFIG,
  now: number = Date.now(),
): PipelineStatusSummary {
  const phases = aggregateByPhase(items, now, healthConfig);
  const warnings = detectHealthIssues(phases, healthConfig);

  // Index issue -> {title, state, ageHours} by iterating phases (issue
  // entries themselves carry no `state` field — it's implied by the
  // enclosing PhaseSnapshot).
  const issueIndex = new Map<
    number,
    { title: string; state: string; ageHours: number }
  >();
  for (const phase of phases) {
    for (const issue of phase.issues) {
      issueIndex.set(issue.number, {
        title: issue.title,
        state: phase.state,
        ageHours: issue.ageHours,
      });
    }
  }

  // phaseCounts: non-zero phase buckets only.
  const phaseCounts: Record<string, number> = {};
  for (const phase of phases) {
    if (phase.count > 0) {
      phaseCounts[phase.state] = phase.count;
    }
  }

  // stuckIssues: top 5 by ageHours desc, sourced from stuck_issue warnings.
  const stuckIssues = warnings
    .filter((w) => w.type === "stuck_issue")
    .map((w) => {
      const issueNumber = w.issues[0];
      const info = issueIndex.get(issueNumber);
      return info
        ? {
            number: issueNumber,
            title: info.title,
            state: info.state,
            ageHours: info.ageHours,
          }
        : null;
    })
    .filter(
      (entry): entry is { number: number; title: string; state: string; ageHours: number } =>
        entry !== null,
    )
    .sort((a, b) => b.ageHours - a.ageHours)
    .slice(0, 5);

  const wipViolations = warnings.filter((w) => w.type === "wip_exceeded").length;
  const blockedDeps = warnings.filter((w) => w.type === "blocked").length;

  const velocity = calculateVelocity(items, metricsConfig.velocityWindowDays, now);
  const riskScore = calculateRiskScore(warnings, metricsConfig.severityWeights);
  const health = determineStatus(riskScore, metricsConfig);

  return {
    health,
    riskScore,
    velocity,
    totalIssues: items.length,
    phaseCounts,
    stuckIssues,
    wipViolations,
    blockedDeps,
  };
}
