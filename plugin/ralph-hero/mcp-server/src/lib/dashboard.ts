/**
 * Dashboard aggregation, health detection, and formatting — pure functions.
 *
 * All functions are side-effect-free: items in, data out.
 * I/O (GraphQL fetching) lives in tools/dashboard-tools.ts.
 */

import {
  STATE_ORDER,
  LOCK_STATES,
  TERMINAL_STATES,
  HUMAN_STATES,
} from "./workflow-states.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Pre-processed project item for dashboard consumption. */
export interface DashboardItem {
  number: number;
  title: string;
  updatedAt: string; // ISO timestamp
  closedAt: string | null; // For Done/Canceled filtering
  workflowState: string | null;
  priority: string | null; // P0, P1, P2, P3
  estimate: string | null; // XS, S, M, L, XL
  assignees: string[];
  blockedBy: Array<{ number: number; workflowState: string | null }>;
}

/** One row in the pipeline snapshot. */
export interface PhaseSnapshot {
  state: string;
  count: number;
  issues: Array<{
    number: number;
    title: string;
    priority: string | null;
    estimate: string | null;
    assignees: string[];
    ageHours: number;
    isLocked: boolean;
    blockedBy: Array<{ number: number; workflowState: string | null }>;
  }>;
}

export interface HealthWarning {
  type:
    | "wip_exceeded"
    | "stuck_issue"
    | "blocked"
    | "pipeline_gap"
    | "lock_collision"
    | "oversized_in_pipeline";
  severity: "info" | "warning" | "critical";
  message: string;
  issues: number[];
}

export interface DashboardData {
  generatedAt: string; // ISO timestamp
  totalIssues: number;
  phases: PhaseSnapshot[];
  health: {
    ok: boolean;
    warnings: HealthWarning[];
  };
}

export interface HealthConfig {
  stuckThresholdHours: number; // default: 48
  criticalStuckHours: number; // default: 96
  wipLimits: Record<string, number>; // default: {}
  doneWindowDays: number; // default: 7
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  stuckThresholdHours: 48,
  criticalStuckHours: 96,
  wipLimits: {},
  doneWindowDays: 7,
};

// ---------------------------------------------------------------------------
// Priority helpers
// ---------------------------------------------------------------------------

const PRIORITY_RANK: Record<string, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

function priorityRank(p: string | null): number {
  if (p === null) return 99;
  return PRIORITY_RANK[p] ?? 99;
}

// ---------------------------------------------------------------------------
// Oversized estimate helpers
// ---------------------------------------------------------------------------

const OVERSIZED_ESTIMATES = new Set(["M", "L", "XL"]);

// ---------------------------------------------------------------------------
// Phase ordering: STATE_ORDER + extras (Human Needed, Canceled)
// ---------------------------------------------------------------------------

/**
 * Full phase list: ordered pipeline states first, then extras.
 * "Human Needed" and "Canceled" are valid states but not in STATE_ORDER.
 */
function buildPhaseOrder(): string[] {
  const phases = [...STATE_ORDER];
  if (!phases.includes("Human Needed")) phases.push("Human Needed");
  if (!phases.includes("Canceled")) phases.push("Canceled");
  return phases;
}

// ---------------------------------------------------------------------------
// aggregateByPhase
// ---------------------------------------------------------------------------

/**
 * Group project items by workflow state, ordered by pipeline position.
 *
 * - Phases follow STATE_ORDER, with Human Needed and Canceled appended.
 * - Issues within each phase are sorted by priority (P0 first).
 * - "Done" items are filtered to those updated within `doneWindowDays`.
 * - "Canceled" items are filtered the same way.
 * - Items with unknown/null workflow state go into an "Unknown" bucket.
 */
export function aggregateByPhase(
  items: DashboardItem[],
  now: number,
  config: HealthConfig = DEFAULT_HEALTH_CONFIG,
): PhaseSnapshot[] {
  const phaseOrder = buildPhaseOrder();
  const buckets = new Map<string, DashboardItem[]>();

  // Initialize all known phases
  for (const state of phaseOrder) {
    buckets.set(state, []);
  }

  // Bucket each item
  for (const item of items) {
    const state = item.workflowState ?? "Unknown";
    if (!buckets.has(state)) {
      buckets.set(state, []);
    }
    buckets.get(state)!.push(item);
  }

  // Filter Done and Canceled to recent window
  const windowMs = config.doneWindowDays * 24 * 60 * 60 * 1000;
  for (const terminalState of ["Done", "Canceled"]) {
    const bucket = buckets.get(terminalState);
    if (bucket) {
      buckets.set(
        terminalState,
        bucket.filter((item) => {
          const ts = item.closedAt ?? item.updatedAt;
          return now - new Date(ts).getTime() <= windowMs;
        }),
      );
    }
  }

  // Build snapshots in order
  const snapshots: PhaseSnapshot[] = [];
  const processedStates = new Set<string>();

  // Ordered phases first
  for (const state of phaseOrder) {
    processedStates.add(state);
    const bucket = buckets.get(state) || [];
    snapshots.push(buildSnapshot(state, bucket, now));
  }

  // Any unknown/extra states
  for (const [state, bucket] of buckets) {
    if (!processedStates.has(state)) {
      snapshots.push(buildSnapshot(state, bucket, now));
    }
  }

  return snapshots;
}

function buildSnapshot(
  state: string,
  items: DashboardItem[],
  now: number,
): PhaseSnapshot {
  // Sort by priority (P0 first)
  const sorted = [...items].sort(
    (a, b) => priorityRank(a.priority) - priorityRank(b.priority),
  );

  return {
    state,
    count: sorted.length,
    issues: sorted.map((item) => ({
      number: item.number,
      title: item.title,
      priority: item.priority,
      estimate: item.estimate,
      assignees: item.assignees,
      ageHours: Math.max(
        0,
        (now - new Date(item.updatedAt).getTime()) / (1000 * 60 * 60),
      ),
      isLocked: LOCK_STATES.includes(state),
      blockedBy: item.blockedBy,
    })),
  };
}

// ---------------------------------------------------------------------------
// detectHealthIssues
// ---------------------------------------------------------------------------

/**
 * Scan phase snapshots for health problems.
 *
 * Returns warnings sorted by severity (critical first).
 */
export function detectHealthIssues(
  phases: PhaseSnapshot[],
  config: HealthConfig = DEFAULT_HEALTH_CONFIG,
): HealthWarning[] {
  const warnings: HealthWarning[] = [];

  for (const phase of phases) {
    // WIP exceeded
    const wipLimit = config.wipLimits[phase.state];
    if (wipLimit !== undefined && phase.count > wipLimit) {
      warnings.push({
        type: "wip_exceeded",
        severity: "warning",
        message: `${phase.state}: ${phase.count} issues (WIP limit: ${wipLimit})`,
        issues: phase.issues.map((i) => i.number),
      });
    }

    // Lock collision: multiple issues in same lock state
    if (LOCK_STATES.includes(phase.state) && phase.count > 1) {
      warnings.push({
        type: "lock_collision",
        severity: "critical",
        message: `${phase.state}: ${phase.count} issues in lock state (expected at most 1)`,
        issues: phase.issues.map((i) => i.number),
      });
    }

    // Pipeline gap: empty non-terminal phase (excluding Backlog and Human Needed)
    if (
      phase.count === 0 &&
      !TERMINAL_STATES.includes(phase.state) &&
      phase.state !== "Backlog" &&
      phase.state !== "Human Needed" &&
      phase.state !== "Unknown" &&
      STATE_ORDER.includes(phase.state)
    ) {
      warnings.push({
        type: "pipeline_gap",
        severity: "info",
        message: `${phase.state}: empty (pipeline gap)`,
        issues: [],
      });
    }

    // Per-issue checks
    for (const issue of phase.issues) {
      // Stuck issue: non-terminal, non-human state, age exceeds threshold
      if (
        !TERMINAL_STATES.includes(phase.state) &&
        !HUMAN_STATES.includes(phase.state)
      ) {
        if (issue.ageHours > config.criticalStuckHours) {
          warnings.push({
            type: "stuck_issue",
            severity: "critical",
            message: `#${issue.number} stuck in ${phase.state} for ${Math.round(issue.ageHours)}h (critical threshold: ${config.criticalStuckHours}h)`,
            issues: [issue.number],
          });
        } else if (issue.ageHours > config.stuckThresholdHours) {
          warnings.push({
            type: "stuck_issue",
            severity: "warning",
            message: `#${issue.number} stuck in ${phase.state} for ${Math.round(issue.ageHours)}h (threshold: ${config.stuckThresholdHours}h)`,
            issues: [issue.number],
          });
        }
      }

      // Blocked: has blockedBy with non-Done blocker
      const openBlockers = issue.blockedBy.filter(
        (b) => b.workflowState !== "Done" && b.workflowState !== "Canceled",
      );
      if (openBlockers.length > 0) {
        warnings.push({
          type: "blocked",
          severity: "warning",
          message: `#${issue.number} blocked by ${openBlockers.map((b) => `#${b.number}`).join(", ")}`,
          issues: [issue.number],
        });
      }

      // Oversized in pipeline: M/L/XL estimate past Backlog
      if (
        issue.estimate &&
        OVERSIZED_ESTIMATES.has(issue.estimate) &&
        phase.state !== "Backlog" &&
        !TERMINAL_STATES.includes(phase.state) &&
        phase.state !== "Human Needed"
      ) {
        warnings.push({
          type: "oversized_in_pipeline",
          severity: "warning",
          message: `#${issue.number} has ${issue.estimate} estimate in ${phase.state} (should be split to XS/S)`,
          issues: [issue.number],
        });
      }
    }
  }

  // Sort: critical first, then warning, then info
  const severityOrder: Record<string, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  warnings.sort(
    (a, b) =>
      (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99),
  );

  return warnings;
}

// ---------------------------------------------------------------------------
// buildDashboard
// ---------------------------------------------------------------------------

/**
 * Orchestrator: aggregate items by phase, detect health issues, return
 * a complete DashboardData snapshot.
 */
export function buildDashboard(
  items: DashboardItem[],
  config: HealthConfig = DEFAULT_HEALTH_CONFIG,
  now: number = Date.now(),
): DashboardData {
  const phases = aggregateByPhase(items, now, config);
  const warnings = detectHealthIssues(phases, config);

  return {
    generatedAt: new Date(now).toISOString(),
    totalIssues: items.length,
    phases,
    health: {
      ok: warnings.length === 0,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Formatters (used by Phase 2 tool, but pure functions live here)
// ---------------------------------------------------------------------------

/**
 * Render dashboard data as a markdown table with health section.
 */
export function formatMarkdown(
  data: DashboardData,
  issuesPerPhase: number = 10,
): string {
  const lines: string[] = [];

  lines.push(`# Pipeline Status`);
  lines.push(`_Generated: ${data.generatedAt}_`);
  lines.push("");
  lines.push(`**Total issues**: ${data.totalIssues}`);
  lines.push("");

  // Phase table
  lines.push("| Phase | Count | Issues |");
  lines.push("|-------|------:|--------|");

  for (const phase of data.phases) {
    const issueList = phase.issues
      .slice(0, issuesPerPhase)
      .map((i) => {
        const parts = [`#${i.number}`];
        if (i.priority) parts.push(i.priority);
        if (i.estimate) parts.push(i.estimate);
        return parts.join(", ");
      })
      .join("; ");

    const truncated =
      phase.issues.length > issuesPerPhase
        ? `${issueList}; ... +${phase.issues.length - issuesPerPhase} more`
        : issueList;

    lines.push(`| ${phase.state} | ${phase.count} | ${truncated} |`);
  }

  // Health section
  lines.push("");
  if (data.health.ok) {
    lines.push("**Health**: All clear");
  } else {
    lines.push("**Health Warnings**:");
    lines.push("");
    for (const w of data.health.warnings) {
      const icon =
        w.severity === "critical"
          ? "[CRITICAL]"
          : w.severity === "warning"
            ? "[WARNING]"
            : "[INFO]";
      lines.push(`- ${icon} ${w.message}`);
    }
  }

  return lines.join("\n");
}

/**
 * Render dashboard data as an ASCII bar chart.
 */
export function formatAscii(data: DashboardData): string {
  const lines: string[] = [];

  lines.push(`Pipeline Status (${data.generatedAt})`);
  const maxCount = Math.max(1, ...data.phases.map((p) => p.count));
  const maxBarWidth = 30;

  for (const phase of data.phases) {
    const label = phase.state.padStart(20);
    const barLen = Math.round((phase.count / maxCount) * maxBarWidth);
    const bar = barLen > 0 ? "\u2588".repeat(barLen) : "\u2591";
    lines.push(`${label} ${bar} ${phase.count}`);
  }

  // Health summary
  lines.push("");
  if (data.health.ok) {
    lines.push("Health: OK");
  } else {
    const critical = data.health.warnings.filter(
      (w) => w.severity === "critical",
    ).length;
    const warn = data.health.warnings.filter(
      (w) => w.severity === "warning",
    ).length;
    const info = data.health.warnings.filter(
      (w) => w.severity === "info",
    ).length;
    const parts: string[] = [];
    if (critical > 0) parts.push(`${critical} critical`);
    if (warn > 0) parts.push(`${warn} warning`);
    if (info > 0) parts.push(`${info} info`);
    lines.push(`Health: ${parts.join(", ")}`);
    for (const w of data.health.warnings) {
      lines.push(`  ${w.severity.toUpperCase()}: ${w.message}`);
    }
  }

  return lines.join("\n");
}
