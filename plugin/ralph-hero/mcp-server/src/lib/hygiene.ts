/**
 * Project hygiene report — pure functions.
 *
 * All functions are side-effect-free: DashboardItems in, report data out.
 * I/O (GraphQL fetching) lives in tools/hygiene-tools.ts.
 */

import { TERMINAL_STATES } from "./workflow-states.js";
import { groupDashboardItemsByRepo } from "./dashboard.js";
import type { DashboardItem } from "./dashboard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HygieneConfig {
  archiveDays: number; // default: 14
  staleDays: number; // default: 7
  orphanDays: number; // default: 14
  wipLimits: Record<string, number>; // default: {}
  similarityThreshold: number; // default: 0.8
}

export const DEFAULT_HYGIENE_CONFIG: HygieneConfig = {
  archiveDays: 14,
  staleDays: 7,
  orphanDays: 14,
  wipLimits: {},
  similarityThreshold: 0.8,
};

export interface HygieneItem {
  number: number;
  title: string;
  workflowState: string | null;
  ageDays: number;
  repository?: string; // "owner/repo" nameWithOwner format
}

export interface DuplicateCandidate {
  items: [HygieneItem, HygieneItem];
  similarity: number; // 0-1
}

export interface HygieneSummary {
  archiveCandidateCount: number;
  staleCount: number;
  orphanCount: number;
  fieldCoveragePercent: number;
  wipViolationCount: number;
  duplicateCandidateCount: number;
}

export interface HygieneRepoBreakdown {
  repoName: string;
  archiveCandidates: HygieneItem[];
  staleItems: HygieneItem[];
  orphanedItems: HygieneItem[];
  fieldGaps: { missingEstimate: HygieneItem[]; missingPriority: HygieneItem[] };
  wipViolations: Array<{
    state: string;
    count: number;
    limit: number;
    items: HygieneItem[];
  }>;
  duplicateCandidates: DuplicateCandidate[];
  summary: HygieneSummary;
}

export interface HygieneReport {
  generatedAt: string;
  // `boardItems` is the raw count of items on the project board pre-filter.
  // Uniform across discovery tools (next_actions, pipeline_dashboard,
  // project_hygiene). Per-category counts (`summary.archiveCandidateCount`,
  // `summary.staleCount`, etc.) are post-filter and may sum to less than
  // `boardItems`.
  boardItems: number;
  archiveCandidates: HygieneItem[];
  staleItems: HygieneItem[];
  orphanedItems: HygieneItem[];
  fieldGaps: { missingEstimate: HygieneItem[]; missingPriority: HygieneItem[] };
  wipViolations: Array<{
    state: string;
    count: number;
    limit: number;
    items: HygieneItem[];
  }>;
  duplicateCandidates: DuplicateCandidate[];
  summary: HygieneSummary;
  repoBreakdowns?: Record<string, HygieneRepoBreakdown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ageDays(timestamp: string, now: number): number {
  return Math.max(
    0,
    (now - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24),
  );
}

function toHygieneItem(item: DashboardItem, now: number): HygieneItem {
  return {
    number: item.number,
    title: item.title,
    workflowState: item.workflowState,
    ageDays: Math.round(ageDays(item.updatedAt, now) * 10) / 10,
    ...(item.repository ? { repository: item.repository } : {}),
  };
}

// ---------------------------------------------------------------------------
// Section functions
// ---------------------------------------------------------------------------

/**
 * Items in terminal states (Done/Canceled) older than archiveDays.
 */
export function findArchiveCandidates(
  items: DashboardItem[],
  now: number,
  archiveDays: number,
): HygieneItem[] {
  return items
    .filter((item) => {
      if (item.subIssueCount > 0) return false;
      const ws = item.workflowState;
      if (!ws || !TERMINAL_STATES.includes(ws)) return false;
      const ts = item.closedAt ?? item.updatedAt;
      return ageDays(ts, now) > archiveDays;
    })
    .map((item) => toHygieneItem(item, now));
}

/**
 * Non-terminal items not updated for more than staleDays.
 */
export function findStaleItems(
  items: DashboardItem[],
  now: number,
  staleDays: number,
): HygieneItem[] {
  return items
    .filter((item) => {
      const ws = item.workflowState;
      if (ws && TERMINAL_STATES.includes(ws)) return false;
      return ageDays(item.updatedAt, now) > staleDays;
    })
    .map((item) => toHygieneItem(item, now));
}

/**
 * Backlog items with no assignee older than orphanDays.
 */
export function findOrphanedItems(
  items: DashboardItem[],
  now: number,
  orphanDays: number,
): HygieneItem[] {
  return items
    .filter((item) => {
      if (item.workflowState !== "Backlog") return false;
      if (item.assignees.length > 0) return false;
      return ageDays(item.updatedAt, now) > orphanDays;
    })
    .map((item) => toHygieneItem(item, now));
}

/**
 * Non-terminal items missing estimate or priority.
 */
export function findFieldGaps(
  items: DashboardItem[],
  now: number,
): { missingEstimate: HygieneItem[]; missingPriority: HygieneItem[] } {
  const nonTerminal = items.filter((item) => {
    const ws = item.workflowState;
    return !ws || !TERMINAL_STATES.includes(ws);
  });

  return {
    missingEstimate: nonTerminal
      .filter((item) => item.estimate === null)
      .map((item) => toHygieneItem(item, now)),
    missingPriority: nonTerminal
      .filter((item) => item.priority === null)
      .map((item) => toHygieneItem(item, now)),
  };
}

/**
 * States where item count exceeds configured WIP limit.
 */
export function findWipViolations(
  items: DashboardItem[],
  now: number,
  wipLimits: Record<string, number>,
): Array<{
  state: string;
  count: number;
  limit: number;
  items: HygieneItem[];
}> {
  const violations: Array<{
    state: string;
    count: number;
    limit: number;
    items: HygieneItem[];
  }> = [];

  for (const [state, limit] of Object.entries(wipLimits)) {
    const stateItems = items.filter((item) => item.workflowState === state);
    if (stateItems.length > limit) {
      violations.push({
        state,
        count: stateItems.length,
        limit,
        items: stateItems.map((item) => toHygieneItem(item, now)),
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Duplicate detection helpers
// ---------------------------------------------------------------------------

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[m][n];
}

const COMMON_PREFIXES = [
  "add",
  "create",
  "fix",
  "update",
  "remove",
  "implement",
  "refactor",
];

export function normalizeTitle(title: string): string {
  let normalized = title.toLowerCase();
  // Strip common action prefixes
  for (const prefix of COMMON_PREFIXES) {
    if (normalized.startsWith(prefix + " ")) {
      normalized = normalized.slice(prefix.length + 1);
      break;
    }
  }
  // Remove punctuation: backticks, quotes, colons, parentheses
  normalized = normalized.replace(/[`'"():,]/g, "");
  return normalized.trim();
}

export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(na, nb) / maxLen;
}

/**
 * Non-terminal item pairs with similar titles (fuzzy match).
 */
export function findDuplicateCandidates(
  items: DashboardItem[],
  now: number,
  threshold: number,
): DuplicateCandidate[] {
  const nonTerminal = items.filter((item) => {
    const ws = item.workflowState;
    return !ws || !TERMINAL_STATES.includes(ws);
  });

  const candidates: DuplicateCandidate[] = [];

  for (let i = 0; i < nonTerminal.length; i++) {
    for (let j = i + 1; j < nonTerminal.length; j++) {
      const a = nonTerminal[i];
      const b = nonTerminal[j];
      // Skip if normalized length difference > 50%
      const na = normalizeTitle(a.title);
      const nb = normalizeTitle(b.title);
      const maxLen = Math.max(na.length, nb.length);
      if (maxLen > 0 && Math.abs(na.length - nb.length) / maxLen > 0.5) {
        continue;
      }
      const sim = titleSimilarity(a.title, b.title);
      if (sim >= threshold) {
        candidates.push({
          items: [toHygieneItem(a, now), toHygieneItem(b, now)],
          similarity: Math.round(sim * 100) / 100,
        });
      }
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Build a per-repo hygiene breakdown. Runs each section function over the
 * supplied items (a single repo's subset of the merged item set).
 *
 * Does NOT recursively emit `repoBreakdowns` — per-repo breakdowns are flat.
 */
function buildRepoBreakdown(
  repoName: string,
  items: DashboardItem[],
  config: HygieneConfig,
  now: number,
): HygieneRepoBreakdown {
  const archiveCandidates = findArchiveCandidates(
    items,
    now,
    config.archiveDays,
  );
  const staleItems = findStaleItems(items, now, config.staleDays);
  const orphanedItems = findOrphanedItems(items, now, config.orphanDays);
  const fieldGaps = findFieldGaps(items, now);
  const wipViolations = findWipViolations(items, now, config.wipLimits);
  const duplicateCandidates = findDuplicateCandidates(
    items,
    now,
    config.similarityThreshold,
  );

  const nonTerminal = items.filter((item) => {
    const ws = item.workflowState;
    return !ws || !TERMINAL_STATES.includes(ws);
  });
  const withBothFields = nonTerminal.filter(
    (item) => item.estimate !== null && item.priority !== null,
  );
  const fieldCoveragePercent =
    nonTerminal.length > 0
      ? Math.round((withBothFields.length / nonTerminal.length) * 100)
      : 100;

  return {
    repoName,
    archiveCandidates,
    staleItems,
    orphanedItems,
    fieldGaps,
    wipViolations,
    duplicateCandidates,
    summary: {
      archiveCandidateCount: archiveCandidates.length,
      staleCount: staleItems.length,
      orphanCount: orphanedItems.length,
      fieldCoveragePercent,
      wipViolationCount: wipViolations.length,
      duplicateCandidateCount: duplicateCandidates.length,
    },
  };
}

/**
 * Build a complete hygiene report from project items.
 */
export function buildHygieneReport(
  items: DashboardItem[],
  config: HygieneConfig = DEFAULT_HYGIENE_CONFIG,
  now: number = Date.now(),
): HygieneReport {
  const archiveCandidates = findArchiveCandidates(
    items,
    now,
    config.archiveDays,
  );
  const staleItems = findStaleItems(items, now, config.staleDays);
  const orphanedItems = findOrphanedItems(items, now, config.orphanDays);
  const fieldGaps = findFieldGaps(items, now);
  const wipViolations = findWipViolations(items, now, config.wipLimits);
  const duplicateCandidates = findDuplicateCandidates(
    items,
    now,
    config.similarityThreshold,
  );

  // Field coverage: % of non-terminal items with both estimate AND priority
  const nonTerminal = items.filter((item) => {
    const ws = item.workflowState;
    return !ws || !TERMINAL_STATES.includes(ws);
  });
  const withBothFields = nonTerminal.filter(
    (item) => item.estimate !== null && item.priority !== null,
  );
  const fieldCoveragePercent =
    nonTerminal.length > 0
      ? Math.round((withBothFields.length / nonTerminal.length) * 100)
      : 100;

  // Per-repo breakdown (only emitted when items span 2+ repos, mirroring
  // buildDashboard's repoBreakdowns threshold at lib/dashboard.ts:781).
  const repoGroups = groupDashboardItemsByRepo(items);
  let repoBreakdowns: Record<string, HygieneRepoBreakdown> | undefined;
  if (Object.keys(repoGroups).length >= 2) {
    repoBreakdowns = {};
    for (const [repoName, repoItems] of Object.entries(repoGroups)) {
      repoBreakdowns[repoName] = buildRepoBreakdown(
        repoName,
        repoItems,
        config,
        now,
      );
    }
  }

  return {
    generatedAt: new Date(now).toISOString(),
    boardItems: items.length,
    archiveCandidates,
    staleItems,
    orphanedItems,
    fieldGaps,
    wipViolations,
    duplicateCandidates,
    summary: {
      archiveCandidateCount: archiveCandidates.length,
      staleCount: staleItems.length,
      orphanCount: orphanedItems.length,
      fieldCoveragePercent,
      wipViolationCount: wipViolations.length,
      duplicateCandidateCount: duplicateCandidates.length,
    },
    ...(repoBreakdowns ? { repoBreakdowns } : {}),
  };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatItemRow(item: HygieneItem): string {
  return `| #${item.number} | ${item.title} | ${item.workflowState ?? "\u2014"} | ${item.ageDays}d |`;
}

/**
 * Render hygiene report as markdown.
 */
export function formatHygieneMarkdown(report: HygieneReport): string {
  const lines: string[] = [];

  lines.push("# Project Hygiene Report");
  lines.push(`_Generated: ${report.generatedAt}_`);
  lines.push("");
  lines.push(`**Board items**: ${report.boardItems}`);
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push(`- Archive candidates: ${report.summary.archiveCandidateCount}`);
  lines.push(`- Stale items: ${report.summary.staleCount}`);
  lines.push(`- Orphaned items: ${report.summary.orphanCount}`);
  lines.push(`- Field coverage: ${report.summary.fieldCoveragePercent}%`);
  lines.push(`- WIP violations: ${report.summary.wipViolationCount}`);
  lines.push(
    `- Duplicate candidates: ${report.summary.duplicateCandidateCount}`,
  );
  lines.push("");

  // Archive candidates
  if (report.archiveCandidates.length > 0) {
    lines.push("## Archive Candidates");
    lines.push("| Issue | Title | State | Age |");
    lines.push("|-------|-------|-------|-----|");
    for (const item of report.archiveCandidates) {
      lines.push(formatItemRow(item));
    }
    lines.push("");
  }

  // Stale items
  if (report.staleItems.length > 0) {
    lines.push("## Stale Items");
    lines.push("| Issue | Title | State | Age |");
    lines.push("|-------|-------|-------|-----|");
    for (const item of report.staleItems) {
      lines.push(formatItemRow(item));
    }
    lines.push("");
  }

  // Orphaned items
  if (report.orphanedItems.length > 0) {
    lines.push("## Orphaned Items");
    lines.push("| Issue | Title | State | Age |");
    lines.push("|-------|-------|-------|-----|");
    for (const item of report.orphanedItems) {
      lines.push(formatItemRow(item));
    }
    lines.push("");
  }

  // Field gaps
  const totalGaps =
    report.fieldGaps.missingEstimate.length +
    report.fieldGaps.missingPriority.length;
  if (totalGaps > 0) {
    lines.push("## Field Gaps");
    if (report.fieldGaps.missingEstimate.length > 0) {
      lines.push("### Missing Estimate");
      lines.push("| Issue | Title | State | Age |");
      lines.push("|-------|-------|-------|-----|");
      for (const item of report.fieldGaps.missingEstimate) {
        lines.push(formatItemRow(item));
      }
      lines.push("");
    }
    if (report.fieldGaps.missingPriority.length > 0) {
      lines.push("### Missing Priority");
      lines.push("| Issue | Title | State | Age |");
      lines.push("|-------|-------|-------|-----|");
      for (const item of report.fieldGaps.missingPriority) {
        lines.push(formatItemRow(item));
      }
      lines.push("");
    }
  }

  // WIP violations
  if (report.wipViolations.length > 0) {
    lines.push("## WIP Violations");
    for (const v of report.wipViolations) {
      lines.push(`### ${v.state}: ${v.count} items (limit: ${v.limit})`);
      lines.push("| Issue | Title | State | Age |");
      lines.push("|-------|-------|-------|-----|");
      for (const item of v.items) {
        lines.push(formatItemRow(item));
      }
      lines.push("");
    }
  }

  // Duplicate candidates
  if (report.duplicateCandidates.length > 0) {
    lines.push("## Duplicate Candidates");
    lines.push("| Issue A | Title A | Issue B | Title B | Similarity |");
    lines.push("|---------|---------|---------|---------|------------|");
    for (const dup of report.duplicateCandidates) {
      const [a, b] = dup.items;
      lines.push(
        `| #${a.number} | ${a.title} | #${b.number} | ${b.title} | ${dup.similarity.toFixed(2)} |`,
      );
    }
    lines.push("");
  }

  // Per-repository breakdown (only for multi-repo). Mirrors
  // formatMarkdown's per-repo rendering at lib/dashboard.ts:948+.
  if (
    report.repoBreakdowns &&
    Object.keys(report.repoBreakdowns).length >= 2
  ) {
    lines.push("## Per-Repository Breakdown");
    lines.push("");

    const sortedRepos = Object.values(report.repoBreakdowns).sort((a, b) =>
      a.repoName.localeCompare(b.repoName),
    );

    for (const repo of sortedRepos) {
      lines.push(`### ${repo.repoName}`);
      lines.push("");

      let renderedAny = false;

      if (repo.archiveCandidates.length > 0) {
        lines.push("#### Archive Candidates");
        lines.push("| Issue | Title | State | Age |");
        lines.push("|-------|-------|-------|-----|");
        for (const item of repo.archiveCandidates) {
          lines.push(formatItemRow(item));
        }
        lines.push("");
        renderedAny = true;
      }

      if (repo.staleItems.length > 0) {
        lines.push("#### Stale Items");
        lines.push("| Issue | Title | State | Age |");
        lines.push("|-------|-------|-------|-----|");
        for (const item of repo.staleItems) {
          lines.push(formatItemRow(item));
        }
        lines.push("");
        renderedAny = true;
      }

      if (repo.orphanedItems.length > 0) {
        lines.push("#### Orphaned Items");
        lines.push("| Issue | Title | State | Age |");
        lines.push("|-------|-------|-------|-----|");
        for (const item of repo.orphanedItems) {
          lines.push(formatItemRow(item));
        }
        lines.push("");
        renderedAny = true;
      }

      const repoTotalGaps =
        repo.fieldGaps.missingEstimate.length +
        repo.fieldGaps.missingPriority.length;
      if (repoTotalGaps > 0) {
        lines.push("#### Field Gaps");
        if (repo.fieldGaps.missingEstimate.length > 0) {
          lines.push("##### Missing Estimate");
          lines.push("| Issue | Title | State | Age |");
          lines.push("|-------|-------|-------|-----|");
          for (const item of repo.fieldGaps.missingEstimate) {
            lines.push(formatItemRow(item));
          }
          lines.push("");
        }
        if (repo.fieldGaps.missingPriority.length > 0) {
          lines.push("##### Missing Priority");
          lines.push("| Issue | Title | State | Age |");
          lines.push("|-------|-------|-------|-----|");
          for (const item of repo.fieldGaps.missingPriority) {
            lines.push(formatItemRow(item));
          }
          lines.push("");
        }
        renderedAny = true;
      }

      if (repo.wipViolations.length > 0) {
        lines.push("#### WIP Violations");
        for (const v of repo.wipViolations) {
          lines.push(`##### ${v.state}: ${v.count} items (limit: ${v.limit})`);
          lines.push("| Issue | Title | State | Age |");
          lines.push("|-------|-------|-------|-----|");
          for (const item of v.items) {
            lines.push(formatItemRow(item));
          }
          lines.push("");
        }
        renderedAny = true;
      }

      if (repo.duplicateCandidates.length > 0) {
        lines.push("#### Duplicate Candidates");
        lines.push("| Issue A | Title A | Issue B | Title B | Similarity |");
        lines.push("|---------|---------|---------|---------|------------|");
        for (const dup of repo.duplicateCandidates) {
          const [a, b] = dup.items;
          lines.push(
            `| #${a.number} | ${a.title} | #${b.number} | ${b.title} | ${dup.similarity.toFixed(2)} |`,
          );
        }
        lines.push("");
        renderedAny = true;
      }

      if (!renderedAny) {
        lines.push("_No hygiene issues_");
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}
