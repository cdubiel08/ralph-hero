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
  buildHygieneReport,
  formatHygieneMarkdown,
  DEFAULT_HYGIENE_CONFIG,
} from "../lib/hygiene.js";
import type { DashboardItem } from "../lib/dashboard.js";

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
});
