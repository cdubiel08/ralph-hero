/**
 * Velocity metrics, risk scoring, and auto-status determination — pure functions.
 *
 * All functions are side-effect-free: dashboard data in, metrics out.
 * Designed to complement lib/dashboard.ts without modifying it.
 */

import type { DashboardItem, DashboardData, HealthWarning } from "./dashboard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetricsConfig {
  velocityWindowDays: number; // default: 7
  atRiskThreshold: number; // default: 2
  offTrackThreshold: number; // default: 6
  severityWeights: Record<string, number>; // default: { critical: 3, warning: 1, info: 0 }
}

export type ProjectHealthStatus = "ON_TRACK" | "AT_RISK" | "OFF_TRACK";

export interface Highlights {
  recentlyCompleted: Array<{ number: number; title: string }>;
  newlyAdded: Array<{ number: number; title: string }>;
}

export interface MetricsResult {
  velocity: number;
  riskScore: number;
  status: ProjectHealthStatus;
  highlights: Highlights;
}

export const DEFAULT_METRICS_CONFIG: MetricsConfig = {
  velocityWindowDays: 7,
  atRiskThreshold: 2,
  offTrackThreshold: 6,
  severityWeights: { critical: 3, warning: 1, info: 0 },
};

// ---------------------------------------------------------------------------
// calculateVelocity
// ---------------------------------------------------------------------------

/**
 * Count items that moved to Done within a time window.
 *
 * Uses closedAt if available, otherwise falls back to updatedAt.
 * Only counts items whose workflowState is "Done".
 */
export function calculateVelocity(
  items: DashboardItem[],
  windowDays: number,
  now: number,
): number {
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  return items.filter((item) => {
    if (item.workflowState !== "Done") return false;
    const ts = item.closedAt ?? item.updatedAt;
    return now - new Date(ts).getTime() <= windowMs;
  }).length;
}

// ---------------------------------------------------------------------------
// calculateRiskScore
// ---------------------------------------------------------------------------

/**
 * Aggregate health warnings into a numeric risk score.
 *
 * Each warning contributes its severity weight. Unknown severities
 * default to 0.
 */
export function calculateRiskScore(
  warnings: HealthWarning[],
  weights: Record<string, number>,
): number {
  return warnings.reduce(
    (score, w) => score + (weights[w.severity] ?? 0),
    0,
  );
}

// ---------------------------------------------------------------------------
// determineStatus
// ---------------------------------------------------------------------------

/**
 * Map a risk score to a project health status using configurable thresholds.
 */
export function determineStatus(
  riskScore: number,
  config: Pick<MetricsConfig, "atRiskThreshold" | "offTrackThreshold">,
): ProjectHealthStatus {
  if (riskScore >= config.offTrackThreshold) return "OFF_TRACK";
  if (riskScore >= config.atRiskThreshold) return "AT_RISK";
  return "ON_TRACK";
}

// ---------------------------------------------------------------------------
// extractHighlights
// ---------------------------------------------------------------------------

/**
 * Extract recently completed and newly added items from dashboard data.
 *
 * - recentlyCompleted: items in the "Done" phase (already time-filtered
 *   by aggregateByPhase)
 * - newlyAdded: items in "Backlog" whose ageHours is within the window
 *   (approximation since DashboardItem lacks createdAt)
 */
export function extractHighlights(
  data: DashboardData,
  windowDays: number,
  now: number,
): Highlights {
  void now; // reserved for future createdAt-based filtering

  const donePhase = data.phases.find((p) => p.state === "Done");
  const recentlyCompleted = (donePhase?.issues ?? []).map((i) => ({
    number: i.number,
    title: i.title,
  }));

  const backlogPhase = data.phases.find((p) => p.state === "Backlog");
  const maxAgeHours = windowDays * 24;
  const newlyAdded = (backlogPhase?.issues ?? [])
    .filter((i) => i.ageHours < maxAgeHours)
    .map((i) => ({
      number: i.number,
      title: i.title,
    }));

  return { recentlyCompleted, newlyAdded };
}

// ---------------------------------------------------------------------------
// calculateMetrics
// ---------------------------------------------------------------------------

/**
 * Convenience orchestrator: compute all metrics from raw items and
 * dashboard data in one call.
 */
export function calculateMetrics(
  items: DashboardItem[],
  data: DashboardData,
  config: MetricsConfig = DEFAULT_METRICS_CONFIG,
  now: number = Date.now(),
): MetricsResult {
  const velocity = calculateVelocity(items, config.velocityWindowDays, now);
  const riskScore = calculateRiskScore(
    data.health.warnings,
    config.severityWeights,
  );
  const status = determineStatus(riskScore, config);
  const highlights = extractHighlights(data, config.velocityWindowDays, now);

  return { velocity, riskScore, status, highlights };
}
