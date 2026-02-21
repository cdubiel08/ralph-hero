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
  projectNumber?: number; // Source project number (multi-project)
  projectTitle?: string; // Human-readable project title (multi-project)
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
    | "oversized_in_pipeline"
    | "unbalanced_workload";
  severity: "info" | "warning" | "critical";
  message: string;
  issues: number[];
}

export interface ArchiveStats {
  eligibleForArchive: number;
  eligibleItems: Array<{
    number: number;
    title: string;
    workflowState: string;
    staleDays: number;
  }>;
  recentlyCompleted: number;
  archiveThresholdDays: number;
}

export interface ProjectBreakdown {
  projectTitle: string;
  phases: PhaseSnapshot[];
  health: { ok: boolean; warnings: HealthWarning[] };
}

export interface DashboardData {
  generatedAt: string; // ISO timestamp
  totalIssues: number;
  phases: PhaseSnapshot[];
  health: {
    ok: boolean;
    warnings: HealthWarning[];
  };
  archive: ArchiveStats;
  projectBreakdowns?: Record<number, ProjectBreakdown>;
}

export interface HealthConfig {
  stuckThresholdHours: number; // default: 48
  criticalStuckHours: number; // default: 96
  wipLimits: Record<string, number>; // default: {}
  doneWindowDays: number; // default: 7
  archiveThresholdDays: number; // default: 14
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  stuckThresholdHours: 48,
  criticalStuckHours: 96,
  wipLimits: {},
  doneWindowDays: 7,
  archiveThresholdDays: 14,
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
// detectCrossProjectHealth
// ---------------------------------------------------------------------------

/**
 * Detect health issues that span multiple projects.
 *
 * Currently detects:
 * - unbalanced_workload: one project has >3x active items vs another
 *
 * "Active" = states in STATE_ORDER that are NOT terminal and NOT "Backlog".
 */
export function detectCrossProjectHealth(
  breakdowns: Record<number, { phases: PhaseSnapshot[] }>,
): HealthWarning[] {
  const warnings: HealthWarning[] = [];
  const projectNumbers = Object.keys(breakdowns).map(Number);

  // Count active items per project
  const activeCounts: Array<{ projectNumber: number; count: number }> = [];
  for (const pn of projectNumbers) {
    const { phases } = breakdowns[pn];
    let active = 0;
    for (const phase of phases) {
      if (
        phase.state !== "Backlog" &&
        !TERMINAL_STATES.includes(phase.state) &&
        STATE_ORDER.includes(phase.state)
      ) {
        active += phase.count;
      }
    }
    if (active > 0) {
      activeCounts.push({ projectNumber: pn, count: active });
    }
  }

  // Need at least 2 projects with active items to compare
  if (activeCounts.length < 2) {
    return warnings;
  }

  const maxEntry = activeCounts.reduce((a, b) =>
    a.count > b.count ? a : b,
  );
  const minEntry = activeCounts.reduce((a, b) =>
    a.count < b.count ? a : b,
  );

  if (maxEntry.count > 3 * minEntry.count) {
    warnings.push({
      type: "unbalanced_workload",
      severity: "warning",
      message: `Unbalanced workload: project ${maxEntry.projectNumber} has ${maxEntry.count} active items vs project ${minEntry.projectNumber} with ${minEntry.count}`,
      issues: [],
    });
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// computeArchiveStats
// ---------------------------------------------------------------------------

const ARCHIVE_TERMINAL_STATES = new Set(["Done", "Canceled"]);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute archive eligibility stats from project items.
 *
 * - "Eligible for archive": Done/Canceled items stale beyond archiveThresholdDays
 * - "Recently completed": Done/Canceled items within doneWindowDays
 * - Staleness computed from closedAt (preferred) or updatedAt (fallback)
 * - Zero additional API calls — works on already-fetched items.
 */
export function computeArchiveStats(
  items: DashboardItem[],
  now: number,
  archiveThresholdDays: number,
  doneWindowDays: number,
): ArchiveStats {
  const thresholdMs = archiveThresholdDays * DAY_MS;
  const recentMs = doneWindowDays * DAY_MS;

  const eligible: ArchiveStats["eligibleItems"] = [];
  let recentlyCompleted = 0;

  for (const item of items) {
    if (!item.workflowState || !ARCHIVE_TERMINAL_STATES.has(item.workflowState)) {
      continue;
    }

    const ts = item.closedAt ?? item.updatedAt;
    const ageMs = now - new Date(ts).getTime();
    const staleDays = Math.floor(ageMs / DAY_MS);

    if (ageMs > thresholdMs) {
      eligible.push({
        number: item.number,
        title: item.title,
        workflowState: item.workflowState,
        staleDays,
      });
    }

    if (ageMs <= recentMs) {
      recentlyCompleted++;
    }
  }

  // Sort by staleDays descending (stalest first)
  eligible.sort((a, b) => b.staleDays - a.staleDays);

  return {
    eligibleForArchive: eligible.length,
    eligibleItems: eligible,
    recentlyCompleted,
    archiveThresholdDays,
  };
}

// ---------------------------------------------------------------------------
// buildDashboard
// ---------------------------------------------------------------------------

/**
 * Orchestrator: aggregate items by phase, detect health issues, compute
 * archive stats, return a complete DashboardData snapshot.
 */
export function buildDashboard(
  items: DashboardItem[],
  config: HealthConfig = DEFAULT_HEALTH_CONFIG,
  now: number = Date.now(),
): DashboardData {
  const phases = aggregateByPhase(items, now, config);
  const warnings = detectHealthIssues(phases, config);
  const archive = computeArchiveStats(
    items,
    now,
    config.archiveThresholdDays,
    config.doneWindowDays,
  );

  // Per-project breakdown (only when items span multiple projects)
  const projectGroups = new Map<number, DashboardItem[]>();
  for (const item of items) {
    if (item.projectNumber !== undefined) {
      const group = projectGroups.get(item.projectNumber);
      if (group) {
        group.push(item);
      } else {
        projectGroups.set(item.projectNumber, [item]);
      }
    }
  }

  let projectBreakdowns: Record<number, ProjectBreakdown> | undefined;

  if (projectGroups.size >= 2) {
    projectBreakdowns = {};
    for (const [pn, projectItems] of projectGroups) {
      const pPhases = aggregateByPhase(projectItems, now, config);
      const pWarnings = detectHealthIssues(pPhases, config);
      projectBreakdowns[pn] = {
        projectTitle: projectItems[0].projectTitle ?? `Project ${pn}`,
        phases: pPhases,
        health: { ok: pWarnings.length === 0, warnings: pWarnings },
      };
    }

    // Cross-project health detection
    const crossWarnings = detectCrossProjectHealth(projectBreakdowns);
    if (crossWarnings.length > 0) {
      warnings.push(...crossWarnings);
      // Re-sort by severity
      const severityRank: Record<string, number> = {
        critical: 0,
        warning: 1,
        info: 2,
      };
      warnings.sort(
        (a, b) =>
          (severityRank[a.severity] ?? 99) -
          (severityRank[b.severity] ?? 99),
      );
    }
  }

  return {
    generatedAt: new Date(now).toISOString(),
    totalIssues: items.length,
    phases,
    health: {
      ok: warnings.length === 0,
      warnings,
    },
    archive,
    ...(projectBreakdowns ? { projectBreakdowns } : {}),
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

  // Archive eligibility section
  if (data.archive) {
    lines.push("");
    lines.push("## Archive Eligibility");
    lines.push("");
    lines.push(
      `**Eligible for archive**: ${data.archive.eligibleForArchive} items (stale > ${data.archive.archiveThresholdDays} days in Done/Canceled)`,
    );
    lines.push(
      `**Recently completed**: ${data.archive.recentlyCompleted} items`,
    );

    if (data.archive.eligibleItems.length > 0) {
      lines.push("");
      lines.push("| # | Title | State | Stale Days |");
      lines.push("|---|-------|-------|------------|");
      for (const item of data.archive.eligibleItems) {
        lines.push(
          `| #${item.number} | ${item.title} | ${item.workflowState} | ${item.staleDays} |`,
        );
      }
    }
  }

  // Per-project breakdown (only for multi-project)
  if (
    data.projectBreakdowns &&
    Object.keys(data.projectBreakdowns).length > 1
  ) {
    lines.push("");
    lines.push("## Per-Project Breakdown");

    const sortedProjects = Object.entries(data.projectBreakdowns)
      .map(([pn, bd]) => ({ projectNumber: Number(pn), ...bd }))
      .sort((a, b) => a.projectNumber - b.projectNumber);

    for (const project of sortedProjects) {
      lines.push("");
      lines.push(`### ${project.projectTitle}`);
      lines.push("");

      const nonZeroPhases = project.phases.filter((p) => p.count > 0);
      if (nonZeroPhases.length > 0) {
        lines.push("| Phase | Count |");
        lines.push("|-------|------:|");
        for (const phase of nonZeroPhases) {
          lines.push(`| ${phase.state} | ${phase.count} |`);
        }
      } else {
        lines.push("_No active items_");
      }

      lines.push("");
      if (project.health.ok) {
        lines.push("**Health**: All clear");
      } else {
        for (const w of project.health.warnings) {
          const icon =
            w.severity === "critical"
              ? "[CRITICAL]"
              : w.severity === "warning"
                ? "[WARNING]"
                : "[INFO]";
          lines.push(`- ${icon} ${w.message}`);
        }
      }
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

  // Archive summary
  if (data.archive) {
    lines.push(
      `Archive: ${data.archive.eligibleForArchive} eligible (threshold: ${data.archive.archiveThresholdDays}d), ${data.archive.recentlyCompleted} recent`,
    );
  }

  // Per-project breakdown (only for multi-project)
  if (
    data.projectBreakdowns &&
    Object.keys(data.projectBreakdowns).length > 1
  ) {
    lines.push("");
    lines.push("--- Per-Project ---");

    const sortedProjects = Object.entries(data.projectBreakdowns)
      .map(([pn, bd]) => ({ projectNumber: Number(pn), ...bd }))
      .sort((a, b) => a.projectNumber - b.projectNumber);

    for (const project of sortedProjects) {
      lines.push("");
      lines.push(project.projectTitle);

      const nonZeroPhases = project.phases.filter((p) => p.count > 0);
      if (nonZeroPhases.length > 0) {
        const projMax = Math.max(1, ...nonZeroPhases.map((p) => p.count));
        for (const phase of nonZeroPhases) {
          const label = phase.state.padStart(20);
          const barLen = Math.round((phase.count / projMax) * 20);
          const bar = barLen > 0 ? "\u2588".repeat(barLen) : "\u2591";
          lines.push(`${label} ${bar} ${phase.count}`);
        }
      }

      if (project.health.ok) {
        lines.push("  Health: OK");
      } else {
        for (const w of project.health.warnings) {
          lines.push(`  ${w.severity.toUpperCase()}: ${w.message}`);
        }
      }
    }
  }

  return lines.join("\n");
}
