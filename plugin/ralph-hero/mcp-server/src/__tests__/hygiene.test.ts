/**
 * Tests for project hygiene report pure functions.
 *
 * All functions under test are pure (no I/O), so no mocking is needed.
 * Follows the dashboard.test.ts pattern with makeItem() factory and fixed NOW.
 */

import { describe, it, expect } from "vitest";
import {
  findArchiveCandidates,
  findStaleItems,
  findOrphanedItems,
  findFieldGaps,
  findWipViolations,
  findDuplicateCandidates,
  normalizeTitle,
  titleSimilarity,
  buildHygieneReport,
  formatHygieneMarkdown,
  DEFAULT_HYGIENE_CONFIG,
  type HygieneReport,
} from "../lib/hygiene.js";
import {
  groupDashboardItemsByRepo,
  type DashboardItem,
} from "../lib/dashboard.js";

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
// findArchiveCandidates
// ---------------------------------------------------------------------------

describe("findArchiveCandidates", () => {
  it("includes Done items older than archiveDays", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        closedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
      }),
    ];
    const result = findArchiveCandidates(items, NOW, 14);
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  it("excludes Done items younger than archiveDays", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        closedAt: new Date(NOW - 3 * DAY_MS).toISOString(),
      }),
    ];
    expect(findArchiveCandidates(items, NOW, 14)).toHaveLength(0);
  });

  it("includes Canceled items older than archiveDays", () => {
    const items = [
      makeItem({
        number: 2,
        workflowState: "Canceled",
        updatedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
      }),
    ];
    expect(findArchiveCandidates(items, NOW, 14)).toHaveLength(1);
  });

  it("excludes non-terminal items", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "In Progress",
        updatedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
      }),
    ];
    expect(findArchiveCandidates(items, NOW, 14)).toHaveLength(0);
  });

  it("uses closedAt when available for Done items", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        updatedAt: new Date(NOW - 20 * DAY_MS).toISOString(), // old
        closedAt: new Date(NOW - 3 * DAY_MS).toISOString(), // recent
      }),
    ];
    // closedAt is 3 days, archiveDays is 14 — should NOT be candidate
    expect(findArchiveCandidates(items, NOW, 14)).toHaveLength(0);
  });

  it("excludes Done parents with open children", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        closedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
        subIssueCount: 1,
      }),
    ];
    expect(findArchiveCandidates(items, NOW, 14)).toHaveLength(0);
  });

  it("includes Done parents with no children when age criteria met", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        closedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
        subIssueCount: 0,
      }),
    ];
    expect(findArchiveCandidates(items, NOW, 14)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// findStaleItems
// ---------------------------------------------------------------------------

describe("findStaleItems", () => {
  it("includes non-terminal items older than staleDays", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
      }),
    ];
    const result = findStaleItems(items, NOW, 7);
    expect(result).toHaveLength(1);
  });

  it("excludes recently updated items", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "In Progress",
        updatedAt: new Date(NOW - 2 * DAY_MS).toISOString(),
      }),
    ];
    expect(findStaleItems(items, NOW, 7)).toHaveLength(0);
  });

  it("excludes Done items", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        updatedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
      }),
    ];
    expect(findStaleItems(items, NOW, 7)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findOrphanedItems
// ---------------------------------------------------------------------------

describe("findOrphanedItems", () => {
  it("includes unassigned Backlog items older than orphanDays", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        assignees: [],
        updatedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
      }),
    ];
    expect(findOrphanedItems(items, NOW, 14)).toHaveLength(1);
  });

  it("excludes Backlog items with assignees", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        assignees: ["alice"],
        updatedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
      }),
    ];
    expect(findOrphanedItems(items, NOW, 14)).toHaveLength(0);
  });

  it("excludes non-Backlog items", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "In Progress",
        assignees: [],
        updatedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
      }),
    ];
    expect(findOrphanedItems(items, NOW, 14)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findFieldGaps
// ---------------------------------------------------------------------------

describe("findFieldGaps", () => {
  it("detects missing estimate on non-terminal items", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        estimate: null,
        priority: "P1",
      }),
    ];
    const gaps = findFieldGaps(items, NOW);
    expect(gaps.missingEstimate).toHaveLength(1);
    expect(gaps.missingPriority).toHaveLength(0);
  });

  it("detects missing priority on non-terminal items", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        estimate: "S",
        priority: null,
      }),
    ];
    const gaps = findFieldGaps(items, NOW);
    expect(gaps.missingEstimate).toHaveLength(0);
    expect(gaps.missingPriority).toHaveLength(1);
  });

  it("excludes Done items from field gap detection", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        estimate: null,
        priority: null,
      }),
    ];
    const gaps = findFieldGaps(items, NOW);
    expect(gaps.missingEstimate).toHaveLength(0);
    expect(gaps.missingPriority).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findWipViolations
// ---------------------------------------------------------------------------

describe("findWipViolations", () => {
  it("flags states exceeding WIP limit", () => {
    const items = [
      makeItem({ number: 1, workflowState: "In Progress" }),
      makeItem({ number: 2, workflowState: "In Progress" }),
      makeItem({ number: 3, workflowState: "In Progress" }),
      makeItem({ number: 4, workflowState: "In Progress" }),
    ];
    const violations = findWipViolations(items, NOW, { "In Progress": 3 });
    expect(violations).toHaveLength(1);
    expect(violations[0].count).toBe(4);
    expect(violations[0].limit).toBe(3);
  });

  it("does not flag states within WIP limit", () => {
    const items = [
      makeItem({ number: 1, workflowState: "In Progress" }),
      makeItem({ number: 2, workflowState: "In Progress" }),
    ];
    expect(
      findWipViolations(items, NOW, { "In Progress": 3 }),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildHygieneReport
// ---------------------------------------------------------------------------

describe("buildHygieneReport", () => {
  it("produces summary matching section counts", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        closedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
      }),
      makeItem({
        number: 2,
        workflowState: "Backlog",
        assignees: [],
        updatedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
      }),
      makeItem({
        number: 3,
        workflowState: "In Progress",
        estimate: null,
        priority: null,
      }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);

    expect(report.summary.archiveCandidateCount).toBe(
      report.archiveCandidates.length,
    );
    expect(report.summary.staleCount).toBe(report.staleItems.length);
    expect(report.summary.orphanCount).toBe(report.orphanedItems.length);
    expect(report.totalItems).toBe(3);
  });

  it("computes field coverage percentage", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        estimate: "S",
        priority: "P1",
      }),
      makeItem({
        number: 2,
        workflowState: "Backlog",
        estimate: null,
        priority: null,
      }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    expect(report.summary.fieldCoveragePercent).toBe(50);
  });

  it("returns 100% field coverage when no non-terminal items", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Done", estimate: null }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    expect(report.summary.fieldCoveragePercent).toBe(100);
  });

  it("includes generatedAt as valid ISO timestamp", () => {
    const report = buildHygieneReport([], DEFAULT_HYGIENE_CONFIG, NOW);
    const parsed = new Date(report.generatedAt);
    expect(parsed.getTime()).toBe(NOW);
  });

  it("aggregates items merged from multiple projects across all 6 sections", () => {
    // Simulate the merged item set the tool layer hands to
    // buildHygieneReport when projectNumbers spans two projects.
    // The fetch loop is exercised by the dashboard-tool tests for
    // fetchDashboardItems; here we validate that the pure-function
    // composition produces a report aggregating items from both projects.
    const items: DashboardItem[] = [
      // Project 3 items — exercises every section
      makeItem({
        number: 1,
        title: "Add caching to API layer",
        workflowState: "Done",
        closedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
        projectNumber: 3,
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 2,
        title: "Refactor auth module",
        workflowState: "In Progress",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        projectNumber: 3,
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 3,
        title: "Migrate to v2 API",
        workflowState: "Backlog",
        assignees: [],
        updatedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
        projectNumber: 3,
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 4,
        title: "Update README",
        workflowState: "In Progress",
        estimate: null,
        priority: null,
        projectNumber: 3,
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 5,
        title: "Investigate CPU spike",
        workflowState: "In Progress",
        projectNumber: 3,
        repository: "owner/repo-a",
      }),
      // Project 5 items — also exercises every section, plus a near-duplicate
      // of #1 to verify cross-project duplicate detection on the merged set.
      makeItem({
        number: 101,
        title: "Add caching to API layers",
        workflowState: "Backlog",
        projectNumber: 5,
        repository: "owner/repo-b",
      }),
      makeItem({
        number: 102,
        title: "Old retro doc",
        workflowState: "Canceled",
        updatedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
        projectNumber: 5,
        repository: "owner/repo-b",
      }),
      makeItem({
        number: 103,
        title: "Stale ticket",
        workflowState: "Plan in Progress",
        updatedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
        projectNumber: 5,
        repository: "owner/repo-b",
      }),
      makeItem({
        number: 104,
        title: "Backlog item B",
        workflowState: "Backlog",
        assignees: [],
        updatedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
        projectNumber: 5,
        repository: "owner/repo-b",
      }),
      makeItem({
        number: 105,
        title: "In progress item B",
        workflowState: "In Progress",
        projectNumber: 5,
        repository: "owner/repo-b",
      }),
    ];

    const report = buildHygieneReport(
      items,
      { ...DEFAULT_HYGIENE_CONFIG, wipLimits: { "In Progress": 2 } },
      NOW,
    );

    // totalItems sums across both projects
    expect(report.totalItems).toBe(10);

    // Archive candidates: from both projects (#1 from proj 3, #102 from proj 5)
    expect(report.archiveCandidates.length).toBe(2);
    const archiveNums = report.archiveCandidates.map((i) => i.number).sort((a, b) => a - b);
    expect(archiveNums).toEqual([1, 102]);

    // Stale items: any non-terminal item older than staleDays (7 by default).
    // From proj 3: #2 (10d, In Progress), #3 (20d, Backlog).
    // From proj 5: #103 (30d, Plan in Progress), #104 (20d, Backlog).
    // Items aggregate across both projects.
    const staleNums = report.staleItems.map((i) => i.number).sort((a, b) => a - b);
    expect(staleNums).toEqual([2, 3, 103, 104]);

    // Orphaned items: #3 from proj 3, #104 from proj 5
    const orphanNums = report.orphanedItems.map((i) => i.number).sort((a, b) => a - b);
    expect(orphanNums).toEqual([3, 104]);

    // Field gaps: #4 from proj 3 has missing estimate AND missing priority.
    // No project-5 item has both null — verify both projects are reachable
    // by ensuring field gap items come from both 3 and 5 if any others
    // had nulls. Here we validate that #4 appears in both gap arrays.
    const missingEstNums = report.fieldGaps.missingEstimate.map((i) => i.number);
    const missingPrioNums = report.fieldGaps.missingPriority.map((i) => i.number);
    expect(missingEstNums).toContain(4);
    expect(missingPrioNums).toContain(4);

    // WIP violations: 4 In Progress items across the two projects (#2, #4, #5, #105)
    // — limit is 2, so violation should report all 4 items, drawn from both projects.
    expect(report.wipViolations).toHaveLength(1);
    expect(report.wipViolations[0].state).toBe("In Progress");
    expect(report.wipViolations[0].count).toBe(4);
    const violationNums = report.wipViolations[0].items
      .map((i) => i.number)
      .sort((a, b) => a - b);
    expect(violationNums).toEqual([2, 4, 5, 105]);

    // Duplicate candidates: #1 (proj 3) and #101 (proj 5) — but #1 is Done
    // (terminal), so duplicate detection skips it. Verify cross-project
    // detection still works by checking summary counts at minimum.
    // (The richer cross-project duplicate scenario is covered separately
    // when items are non-terminal; this test focuses on aggregation.)
    expect(report.summary.duplicateCandidateCount).toBe(
      report.duplicateCandidates.length,
    );
  });

  it("aggregates duplicate candidates across multiple projects", () => {
    // Both items non-terminal so duplicate detection picks them up.
    const items: DashboardItem[] = [
      makeItem({
        number: 1,
        title: "Add caching to API layer",
        workflowState: "Backlog",
        projectNumber: 3,
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 101,
        title: "Add caching to API layers",
        workflowState: "Backlog",
        projectNumber: 5,
        repository: "owner/repo-b",
      }),
    ];

    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);

    expect(report.totalItems).toBe(2);
    expect(report.duplicateCandidates).toHaveLength(1);
    const pair = report.duplicateCandidates[0].items;
    const pairNums = [pair[0].number, pair[1].number].sort((a, b) => a - b);
    expect(pairNums).toEqual([1, 101]);
  });
});

// ---------------------------------------------------------------------------
// formatHygieneMarkdown
// ---------------------------------------------------------------------------

describe("formatHygieneMarkdown", () => {
  it("produces markdown with header and summary", () => {
    const report = buildHygieneReport([], DEFAULT_HYGIENE_CONFIG, NOW);
    const md = formatHygieneMarkdown(report);
    expect(md).toContain("# Project Hygiene Report");
    expect(md).toContain("## Summary");
  });

  it("includes archive candidates section when present", () => {
    const items = [
      makeItem({
        number: 42,
        workflowState: "Done",
        closedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
      }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    const md = formatHygieneMarkdown(report);
    expect(md).toContain("## Archive Candidates");
    expect(md).toContain("#42");
  });

  it("omits empty sections", () => {
    const report = buildHygieneReport([], DEFAULT_HYGIENE_CONFIG, NOW);
    const md = formatHygieneMarkdown(report);
    expect(md).not.toContain("## Archive Candidates");
    expect(md).not.toContain("## Stale Items");
    expect(md).not.toContain("## Orphaned Items");
  });

  it("includes field gaps section with subsections", () => {
    const items = [
      makeItem({ number: 10, workflowState: "Backlog", estimate: null }),
      makeItem({ number: 11, workflowState: "Backlog", priority: null }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    const md = formatHygieneMarkdown(report);
    expect(md).toContain("## Field Gaps");
    expect(md).toContain("### Missing Estimate");
    expect(md).toContain("### Missing Priority");
  });

  it("includes duplicate candidates section when present", () => {
    const items = [
      makeItem({ number: 1, title: "Add caching to API layer", workflowState: "Backlog" }),
      makeItem({ number: 2, title: "Add caching to API layers", workflowState: "Backlog" }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    const md = formatHygieneMarkdown(report);
    expect(md).toContain("## Duplicate Candidates");
    expect(md).toContain("#1");
    expect(md).toContain("#2");
    expect(md).toContain("Similarity");
  });

  it("omits duplicate candidates section when empty", () => {
    const items = [
      makeItem({ number: 1, title: "Add caching", workflowState: "Backlog" }),
      makeItem({ number: 2, title: "Fix auth bug", workflowState: "Backlog" }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    const md = formatHygieneMarkdown(report);
    expect(md).not.toContain("## Duplicate Candidates");
  });
});

// ---------------------------------------------------------------------------
// normalizeTitle
// ---------------------------------------------------------------------------

describe("normalizeTitle", () => {
  it("strips common prefixes", () => {
    expect(normalizeTitle("Add caching to API")).toBe("caching to api");
    expect(normalizeTitle("Create bulk_archive tool")).toBe("bulk_archive tool");
    expect(normalizeTitle("Fix login bug")).toBe("login bug");
    expect(normalizeTitle("Implement new feature")).toBe("new feature");
  });

  it("lowercases and removes punctuation", () => {
    expect(normalizeTitle('Add `bulk_archive` tool: "v2"')).toBe("bulk_archive tool v2");
  });

  it("preserves titles without common prefixes", () => {
    expect(normalizeTitle("Dashboard improvements")).toBe("dashboard improvements");
  });
});

// ---------------------------------------------------------------------------
// titleSimilarity
// ---------------------------------------------------------------------------

describe("titleSimilarity", () => {
  it("returns 1 for identical titles", () => {
    expect(titleSimilarity("caching to API", "caching to API")).toBe(1);
  });

  it("returns high similarity for minor differences", () => {
    const sim = titleSimilarity("Add caching to API layer", "Add caching to API layers");
    expect(sim).toBeGreaterThan(0.8);
  });

  it("returns low similarity for different titles", () => {
    const sim = titleSimilarity("Add caching", "Fix auth bug");
    expect(sim).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// findDuplicateCandidates
// ---------------------------------------------------------------------------

describe("findDuplicateCandidates", () => {
  it("detects similar titles", () => {
    const items = [
      makeItem({ number: 1, title: "Add caching to API layer", workflowState: "Backlog" }),
      makeItem({ number: 2, title: "Add caching to API layers", workflowState: "Backlog" }),
    ];
    const result = findDuplicateCandidates(items, NOW, 0.8);
    expect(result).toHaveLength(1);
    expect(result[0].items[0].number).toBe(1);
    expect(result[0].items[1].number).toBe(2);
    expect(result[0].similarity).toBeGreaterThanOrEqual(0.8);
  });

  it("ignores dissimilar titles", () => {
    const items = [
      makeItem({ number: 1, title: "Add caching", workflowState: "Backlog" }),
      makeItem({ number: 2, title: "Fix auth bug", workflowState: "Backlog" }),
    ];
    expect(findDuplicateCandidates(items, NOW, 0.8)).toHaveLength(0);
  });

  it("normalizes common prefixes", () => {
    const items = [
      makeItem({ number: 1, title: "Create bulk_archive tool", workflowState: "Backlog" }),
      makeItem({ number: 2, title: "Implement bulk_archive tool", workflowState: "Backlog" }),
    ];
    const result = findDuplicateCandidates(items, NOW, 0.8);
    expect(result).toHaveLength(1);
  });

  it("skips terminal state items", () => {
    const items = [
      makeItem({ number: 1, title: "Add caching to API", workflowState: "Done" }),
      makeItem({ number: 2, title: "Add caching to the API", workflowState: "Done" }),
    ];
    expect(findDuplicateCandidates(items, NOW, 0.8)).toHaveLength(0);
  });

  it("handles short titles without false positives", () => {
    const items = [
      makeItem({ number: 1, title: "Fix login flow", workflowState: "Backlog" }),
      makeItem({ number: 2, title: "Fix batch jobs", workflowState: "Backlog" }),
    ];
    // These should NOT match — different topics despite same prefix
    expect(findDuplicateCandidates(items, NOW, 0.8)).toHaveLength(0);
  });

  it("respects similarity threshold", () => {
    const items = [
      makeItem({ number: 1, title: "Add caching to API endpoints", workflowState: "Backlog" }),
      makeItem({ number: 2, title: "Add caching to API routes", workflowState: "Backlog" }),
    ];
    // Low threshold catches more
    const low = findDuplicateCandidates(items, NOW, 0.5);
    expect(low.length).toBeGreaterThanOrEqual(1);
    // Very high threshold may miss
    const high = findDuplicateCandidates(items, NOW, 0.99);
    expect(high).toHaveLength(0);
  });

  it("includes duplicateCandidates in buildHygieneReport", () => {
    const items = [
      makeItem({ number: 1, title: "Add caching to API layer", workflowState: "Backlog" }),
      makeItem({ number: 2, title: "Add caching to API layers", workflowState: "Backlog" }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    expect(report.duplicateCandidates).toHaveLength(1);
    expect(report.summary.duplicateCandidateCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// repository field preservation (Phase 1)
// ---------------------------------------------------------------------------

describe("repository field preservation", () => {
  it("findArchiveCandidates preserves repository on items", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        closedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
        repository: "owner/repo-a",
      }),
    ];
    const result = findArchiveCandidates(items, NOW, 14);
    expect(result).toHaveLength(1);
    expect(result[0].repository).toBe("owner/repo-a");
  });

  it("findStaleItems preserves repository on items", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "owner/repo-b",
      }),
    ];
    const result = findStaleItems(items, NOW, 7);
    expect(result).toHaveLength(1);
    expect(result[0].repository).toBe("owner/repo-b");
  });

  it("findOrphanedItems preserves repository on items", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        assignees: [],
        updatedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
        repository: "owner/repo-c",
      }),
    ];
    const result = findOrphanedItems(items, NOW, 14);
    expect(result).toHaveLength(1);
    expect(result[0].repository).toBe("owner/repo-c");
  });

  it("findFieldGaps preserves repository on missingEstimate and missingPriority", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        estimate: null,
        priority: "P1",
        repository: "owner/repo-d",
      }),
      makeItem({
        number: 2,
        workflowState: "Backlog",
        estimate: "S",
        priority: null,
        repository: "owner/repo-e",
      }),
    ];
    const gaps = findFieldGaps(items, NOW);
    expect(gaps.missingEstimate).toHaveLength(1);
    expect(gaps.missingEstimate[0].repository).toBe("owner/repo-d");
    expect(gaps.missingPriority).toHaveLength(1);
    expect(gaps.missingPriority[0].repository).toBe("owner/repo-e");
  });

  it("findWipViolations preserves repository on items inside each violation", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "In Progress",
        repository: "owner/repo-f",
      }),
      makeItem({
        number: 2,
        workflowState: "In Progress",
        repository: "owner/repo-g",
      }),
      makeItem({
        number: 3,
        workflowState: "In Progress",
        repository: "owner/repo-h",
      }),
    ];
    const violations = findWipViolations(items, NOW, { "In Progress": 2 });
    expect(violations).toHaveLength(1);
    expect(violations[0].items).toHaveLength(3);
    expect(violations[0].items[0].repository).toBe("owner/repo-f");
    expect(violations[0].items[1].repository).toBe("owner/repo-g");
    expect(violations[0].items[2].repository).toBe("owner/repo-h");
  });

  it("findDuplicateCandidates preserves repository on both items in each pair", () => {
    const items = [
      makeItem({
        number: 1,
        title: "Add caching to API layer",
        workflowState: "Backlog",
        repository: "owner/repo-i",
      }),
      makeItem({
        number: 2,
        title: "Add caching to API layers",
        workflowState: "Backlog",
        repository: "owner/repo-j",
      }),
    ];
    const result = findDuplicateCandidates(items, NOW, 0.8);
    expect(result).toHaveLength(1);
    expect(result[0].items[0].repository).toBe("owner/repo-i");
    expect(result[0].items[1].repository).toBe("owner/repo-j");
  });

  it("toHygieneItem omits repository key when source has none (no undefined value)", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        closedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
        // no repository field
      }),
    ];
    const result = findArchiveCandidates(items, NOW, 14);
    expect(result).toHaveLength(1);
    expect("repository" in result[0]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// repoBreakdowns auto-emission (Phase 3)
// ---------------------------------------------------------------------------

describe("repoBreakdowns auto-emission", () => {
  it("single-repo input produces report.repoBreakdowns === undefined", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 2,
        workflowState: "In Progress",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "owner/repo-a",
      }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    expect(report.repoBreakdowns).toBeUndefined();
  });

  it("zero-item input produces report.repoBreakdowns === undefined", () => {
    const report = buildHygieneReport([], DEFAULT_HYGIENE_CONFIG, NOW);
    expect(report.repoBreakdowns).toBeUndefined();
  });

  it("2-repo input produces repoBreakdowns with exactly 2 keys matching repo names", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 2,
        workflowState: "Backlog",
        repository: "owner/repo-b",
      }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    expect(report.repoBreakdowns).toBeDefined();
    expect(Object.keys(report.repoBreakdowns!).sort()).toEqual([
      "owner/repo-a",
      "owner/repo-b",
    ]);
  });

  it("each per-repo breakdown contains only items from that repo", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 2,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "owner/repo-b",
      }),
      makeItem({
        number: 3,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "owner/repo-b",
      }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    expect(report.repoBreakdowns).toBeDefined();

    const repoA = report.repoBreakdowns!["owner/repo-a"];
    expect(repoA).toBeDefined();
    expect(repoA.staleItems).toHaveLength(1);
    expect(repoA.staleItems[0].number).toBe(1);

    const repoB = report.repoBreakdowns!["owner/repo-b"];
    expect(repoB).toBeDefined();
    expect(repoB.staleItems).toHaveLength(2);
    const staleNumbers = repoB.staleItems.map((i) => i.number).sort();
    expect(staleNumbers).toEqual([2, 3]);
  });

  it("items with no repository bucketed under '(unknown)' when other repos present", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 2,
        workflowState: "Backlog",
        // no repository
      }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    expect(report.repoBreakdowns).toBeDefined();
    expect(Object.keys(report.repoBreakdowns!).sort()).toEqual([
      "(unknown)",
      "owner/repo-a",
    ]);
    expect(report.repoBreakdowns!["(unknown)"].repoName).toBe("(unknown)");
  });

  it("per-repo summary counts match per-repo section lengths", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        closedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 2,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "owner/repo-b",
      }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    const repoA = report.repoBreakdowns!["owner/repo-a"];
    expect(repoA.summary.archiveCandidateCount).toBe(
      repoA.archiveCandidates.length,
    );
    expect(repoA.summary.archiveCandidateCount).toBe(1);
    const repoB = report.repoBreakdowns!["owner/repo-b"];
    expect(repoB.summary.staleCount).toBe(repoB.staleItems.length);
    expect(repoB.summary.staleCount).toBe(1);
  });

  it("per-repo breakdowns do NOT recursively contain repoBreakdowns", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 2,
        workflowState: "Backlog",
        repository: "owner/repo-b",
      }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    for (const [, breakdown] of Object.entries(report.repoBreakdowns!)) {
      // HygieneRepoBreakdown shape: no repoBreakdowns field exists on it
      expect(
        (breakdown as Record<string, unknown>).repoBreakdowns,
      ).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// formatHygieneMarkdown — Per-Repository Breakdown rendering (Phase 3)
// ---------------------------------------------------------------------------

describe("formatHygieneMarkdown — Per-Repository Breakdown", () => {
  it("single-repo input does NOT contain 'Per-Repository Breakdown' (regression-safe)", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "owner/repo-a",
      }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    const md = formatHygieneMarkdown(report);
    expect(md).not.toContain("Per-Repository Breakdown");
    expect(md).not.toContain("## Per-Repository Breakdown");
  });

  it("zero-repo input does NOT contain 'Per-Repository Breakdown'", () => {
    const report = buildHygieneReport([], DEFAULT_HYGIENE_CONFIG, NOW);
    const md = formatHygieneMarkdown(report);
    expect(md).not.toContain("Per-Repository Breakdown");
  });

  it("2-repo input contains '## Per-Repository Breakdown' and one '### owner/repo' heading per repo", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 2,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "owner/repo-b",
      }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    const md = formatHygieneMarkdown(report);
    expect(md).toContain("## Per-Repository Breakdown");
    expect(md).toContain("### owner/repo-a");
    expect(md).toContain("### owner/repo-b");
  });

  it("per-repo sub-sections render in alphabetical repo-name order", () => {
    const items = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "zeta/repo",
      }),
      makeItem({
        number: 2,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "alpha/repo",
      }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    const md = formatHygieneMarkdown(report);
    const alphaIdx = md.indexOf("### alpha/repo");
    const zetaIdx = md.indexOf("### zeta/repo");
    expect(alphaIdx).toBeGreaterThan(0);
    expect(zetaIdx).toBeGreaterThan(0);
    expect(alphaIdx).toBeLessThan(zetaIdx);
  });

  it("per-repo sub-section omits empty section tables", () => {
    // repo-a: a Done archive candidate only (no stale/orphan/etc).
    // repo-b: a Backlog item with assignee, age 10d → stale only (no orphan,
    // no archive). Both repos exercise different sections.
    const items = [
      makeItem({
        number: 1,
        workflowState: "Done",
        closedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
        estimate: "S",
        priority: "P1",
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 2,
        workflowState: "Backlog",
        assignees: ["alice"],
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        estimate: "S",
        priority: "P1",
        repository: "owner/repo-b",
      }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    const md = formatHygieneMarkdown(report);
    // Per-Repository Breakdown should appear
    expect(md).toContain("## Per-Repository Breakdown");

    const aStart = md.indexOf("### owner/repo-a");
    const bStart = md.indexOf("### owner/repo-b");
    expect(aStart).toBeLessThan(bStart);

    // The repo-a sub-section should contain Archive Candidates only.
    const repoASlice = md.slice(aStart, bStart);
    expect(repoASlice).toContain("#### Archive Candidates");
    expect(repoASlice).not.toContain("#### Stale Items");
    expect(repoASlice).not.toContain("#### Orphaned Items");
    expect(repoASlice).not.toContain("#### Field Gaps");
    expect(repoASlice).not.toContain("#### WIP Violations");
    expect(repoASlice).not.toContain("#### Duplicate Candidates");

    // The repo-b sub-section should contain Stale Items only.
    const repoBSlice = md.slice(bStart);
    expect(repoBSlice).toContain("#### Stale Items");
    expect(repoBSlice).not.toContain("#### Archive Candidates");
    expect(repoBSlice).not.toContain("#### Orphaned Items");
    expect(repoBSlice).not.toContain("#### Field Gaps");
    expect(repoBSlice).not.toContain("#### WIP Violations");
    expect(repoBSlice).not.toContain("#### Duplicate Candidates");
  });

  it("byte-identical markdown for single-repo input vs no-repo input (backward-compat)", () => {
    // This guards Phase 3's backward-compat promise: when repoBreakdowns is
    // undefined the markdown formatter must produce the same output it
    // produced before Phase 3 existed.
    const itemsWithRepo = [
      makeItem({
        number: 42,
        workflowState: "Done",
        closedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
        repository: "owner/repo-a",
      }),
    ];
    const itemsNoRepo = [
      makeItem({
        number: 42,
        workflowState: "Done",
        closedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
      }),
    ];
    const reportWithRepo = buildHygieneReport(
      itemsWithRepo,
      DEFAULT_HYGIENE_CONFIG,
      NOW,
    );
    const reportNoRepo = buildHygieneReport(
      itemsNoRepo,
      DEFAULT_HYGIENE_CONFIG,
      NOW,
    );

    expect(reportWithRepo.repoBreakdowns).toBeUndefined();
    expect(reportNoRepo.repoBreakdowns).toBeUndefined();

    const mdWithRepo = formatHygieneMarkdown(reportWithRepo);
    const mdNoRepo = formatHygieneMarkdown(reportNoRepo);
    expect(mdWithRepo).toBe(mdNoRepo);
    expect(mdWithRepo).not.toContain("Per-Repository Breakdown");
  });

  it("renders per-repo Stale Items rows with correct issue numbers", () => {
    const items = [
      makeItem({
        number: 101,
        title: "Repo A stale item",
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 202,
        title: "Repo B stale item",
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "owner/repo-b",
      }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    const md = formatHygieneMarkdown(report);

    const aStart = md.indexOf("### owner/repo-a");
    const bStart = md.indexOf("### owner/repo-b");
    const repoASlice = md.slice(aStart, bStart);
    const repoBSlice = md.slice(bStart);

    expect(repoASlice).toContain("#101");
    expect(repoASlice).toContain("Repo A stale item");
    expect(repoASlice).not.toContain("#202");

    expect(repoBSlice).toContain("#202");
    expect(repoBSlice).toContain("Repo B stale item");
    expect(repoBSlice).not.toContain("#101");
  });
});

// ---------------------------------------------------------------------------
// groupBy=repo composition (Phase 4)
//
// The tool layer (hygiene-tools.ts) implements groupBy=repo by composing
// groupDashboardItemsByRepo + buildHygieneReport per repo group. These
// tests exercise that pure-function composition directly — no tool-layer
// mocking is required. They validate the response-shape contract from
// the issue's acceptance criteria:
//
//   { groupBy: "repo", repos: Record<string, HygieneReport> }
//
// and the markdown contract:
//
//   "# Project Hygiene (by repo)" with one "## owner/repo" heading per repo
// ---------------------------------------------------------------------------

describe("groupBy=repo composition (Phase 4)", () => {
  it("composes groupDashboardItemsByRepo + buildHygieneReport into a per-repo report map", () => {
    const items: DashboardItem[] = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 2,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "owner/repo-b",
      }),
    ];

    const repoGroups = groupDashboardItemsByRepo(items);
    const repoResults: Record<string, HygieneReport> = {};
    for (const [repoName, repoItems] of Object.entries(repoGroups)) {
      repoResults[repoName] = buildHygieneReport(
        repoItems,
        DEFAULT_HYGIENE_CONFIG,
        NOW,
      );
    }

    expect(Object.keys(repoResults).sort()).toEqual([
      "owner/repo-a",
      "owner/repo-b",
    ]);
    expect(repoResults["owner/repo-a"].totalItems).toBe(1);
    expect(repoResults["owner/repo-b"].totalItems).toBe(1);
  });

  it("buckets items with no repository under '(unknown)'", () => {
    const items: DashboardItem[] = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 2,
        workflowState: "Backlog",
        // no repository
      }),
    ];

    const repoGroups = groupDashboardItemsByRepo(items);
    expect(Object.keys(repoGroups).sort()).toEqual([
      "(unknown)",
      "owner/repo-a",
    ]);

    const repoResults: Record<string, HygieneReport> = {};
    for (const [repoName, repoItems] of Object.entries(repoGroups)) {
      repoResults[repoName] = buildHygieneReport(
        repoItems,
        DEFAULT_HYGIENE_CONFIG,
        NOW,
      );
    }
    expect(repoResults["(unknown)"]).toBeDefined();
    expect(repoResults["(unknown)"].totalItems).toBe(1);
    expect(repoResults["owner/repo-a"].totalItems).toBe(1);
  });

  it("each per-repo HygieneReport contains only that repo's items in every section", () => {
    // Each repo gets one item that exercises a different hygiene section so
    // we can verify partitioning across all six sections at once.
    const items: DashboardItem[] = [
      // repo-a: archive (Done, old) + stale (Backlog, old) + WIP violation
      makeItem({
        number: 11,
        title: "Repo A archive",
        workflowState: "Done",
        closedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 12,
        title: "Repo A stale",
        workflowState: "Backlog",
        assignees: [],
        updatedAt: new Date(NOW - 20 * DAY_MS).toISOString(),
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 13,
        title: "Repo A wip",
        workflowState: "In Progress",
        repository: "owner/repo-a",
      }),
      // repo-b: only an in-progress item that doesn't trip any threshold
      makeItem({
        number: 21,
        title: "Repo B active",
        workflowState: "In Progress",
        estimate: "S",
        priority: "P1",
        repository: "owner/repo-b",
      }),
    ];

    const repoGroups = groupDashboardItemsByRepo(items);
    const repoResults: Record<string, HygieneReport> = {};
    for (const [repoName, repoItems] of Object.entries(repoGroups)) {
      repoResults[repoName] = buildHygieneReport(
        repoItems,
        { ...DEFAULT_HYGIENE_CONFIG, wipLimits: { "In Progress": 0 } },
        NOW,
      );
    }

    const repoA = repoResults["owner/repo-a"];
    const repoB = repoResults["owner/repo-b"];

    // repo-a has the archive candidate, stale item, and WIP violation
    expect(repoA.archiveCandidates.map((i) => i.number)).toEqual([11]);
    expect(repoA.staleItems.map((i) => i.number)).toEqual([12]);
    expect(repoA.wipViolations).toHaveLength(1);
    expect(repoA.wipViolations[0].items.map((i) => i.number)).toEqual([13]);

    // repo-b sections should NOT contain any repo-a issue numbers
    const repoBNumbersAll = [
      ...repoB.archiveCandidates,
      ...repoB.staleItems,
      ...repoB.orphanedItems,
      ...repoB.fieldGaps.missingEstimate,
      ...repoB.fieldGaps.missingPriority,
      ...repoB.duplicateCandidates.flatMap((d) => d.items),
      ...repoB.wipViolations.flatMap((v) => v.items),
    ].map((i) => i.number);
    expect(repoBNumbersAll).not.toContain(11);
    expect(repoBNumbersAll).not.toContain(12);
    expect(repoBNumbersAll).not.toContain(13);

    // repo-b has its own WIP violation containing only #21
    expect(repoB.wipViolations).toHaveLength(1);
    expect(repoB.wipViolations[0].items.map((i) => i.number)).toEqual([21]);
  });

  it("markdown composition produces one '## owner/repo' heading per repo", () => {
    const items: DashboardItem[] = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 2,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "owner/repo-b",
      }),
    ];

    // Replicate the tool-layer composition for markdown output.
    const repoGroups = groupDashboardItemsByRepo(items);
    const sortedRepoNames = Object.keys(repoGroups).sort((a, b) =>
      a.localeCompare(b),
    );
    let md = "# Project Hygiene (by repo)\n\n";
    for (const repoName of sortedRepoNames) {
      const repoItems = repoGroups[repoName];
      const sub = buildHygieneReport(repoItems, DEFAULT_HYGIENE_CONFIG, NOW);
      md += `## ${repoName} (${repoItems.length} items)\n\n`;
      md += formatHygieneMarkdown(sub) + "\n\n";
    }

    expect(md).toContain("# Project Hygiene (by repo)");
    expect(md).toContain("## owner/repo-a (1 items)");
    expect(md).toContain("## owner/repo-b (1 items)");
    // Headings appear in alphabetical order (deterministic).
    const aIdx = md.indexOf("## owner/repo-a");
    const bIdx = md.indexOf("## owner/repo-b");
    expect(aIdx).toBeGreaterThan(0);
    expect(bIdx).toBeGreaterThan(0);
    expect(aIdx).toBeLessThan(bIdx);
  });

  it("renders repos in alphabetical order regardless of input order", () => {
    const items: DashboardItem[] = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "zeta/last",
      }),
      makeItem({
        number: 2,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "alpha/first",
      }),
      makeItem({
        number: 3,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "mid/middle",
      }),
    ];

    const repoGroups = groupDashboardItemsByRepo(items);
    const sortedRepoNames = Object.keys(repoGroups).sort((a, b) =>
      a.localeCompare(b),
    );
    expect(sortedRepoNames).toEqual([
      "alpha/first",
      "mid/middle",
      "zeta/last",
    ]);
  });

  it("composes correctly across multiple projects (multi-project + groupBy=repo)", () => {
    // The tool concats items from multiple projects before grouping — verify
    // the composition surfaces items from both projects in the right repo
    // bucket.
    const items: DashboardItem[] = [
      makeItem({
        number: 1,
        title: "Issue from project 3 in repo-a",
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        projectNumber: 3,
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 2,
        title: "Issue from project 5 in repo-a",
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        projectNumber: 5,
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 3,
        title: "Issue from project 5 in repo-b",
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        projectNumber: 5,
        repository: "owner/repo-b",
      }),
    ];

    const repoGroups = groupDashboardItemsByRepo(items);
    const repoResults: Record<string, HygieneReport> = {};
    for (const [repoName, repoItems] of Object.entries(repoGroups)) {
      repoResults[repoName] = buildHygieneReport(
        repoItems,
        DEFAULT_HYGIENE_CONFIG,
        NOW,
      );
    }

    expect(repoResults["owner/repo-a"].totalItems).toBe(2);
    expect(repoResults["owner/repo-b"].totalItems).toBe(1);

    // repo-a's stale items should include both #1 (project 3) and #2 (project 5)
    const repoAStaleNums = repoResults["owner/repo-a"].staleItems
      .map((i) => i.number)
      .sort((a, b) => a - b);
    expect(repoAStaleNums).toEqual([1, 2]);
  });

  it("when groupBy is omitted, buildHygieneReport on the merged set is the response shape (no regression)", () => {
    // Phase 3 already covers the merged-shape regression; this assertion
    // confirms the Phase 4 branch does not affect the default (groupBy
    // omitted) path: a merged report has the standard HygieneReport shape
    // with no `groupBy` or `repos` keys.
    const items: DashboardItem[] = [
      makeItem({
        number: 1,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "owner/repo-a",
      }),
      makeItem({
        number: 2,
        workflowState: "Backlog",
        updatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        repository: "owner/repo-b",
      }),
    ];
    const merged = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);

    // Standard fields present
    expect(merged.totalItems).toBe(2);
    expect(merged.staleItems).toBeDefined();
    expect(merged.summary).toBeDefined();
    // Phase 3 emits repoBreakdowns when items span >=2 repos; this is the
    // default path, NOT the groupBy=repo path.
    expect(merged.repoBreakdowns).toBeDefined();
    // Confirm the merged report has no `groupBy` or `repos` field — those
    // belong to the groupBy=repo response shape only.
    expect((merged as unknown as Record<string, unknown>).groupBy).toBeUndefined();
    expect((merged as unknown as Record<string, unknown>).repos).toBeUndefined();
  });
});
