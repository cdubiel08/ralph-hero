---
date: 2026-02-20
status: complete
github_issue: 158
github_url: https://github.com/cdubiel08/ralph-hero/issues/158
primary_issue: 158
---

# Core `project_hygiene` Reporting Tool - Implementation Plan

## Overview

Single issue implementation: GH-158 — Create core `project_hygiene` MCP tool with 6 report sections and summary stats.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-158 | Create core `project_hygiene` reporting tool | S |

## Current State Analysis

- The existing `pipeline_dashboard` tool in `dashboard-tools.ts` provides real-time phase snapshots and health warnings but lacks a hygiene-focused report.
- The dashboard follows a clean two-layer pattern: pure functions in `lib/dashboard.ts` (no I/O) + tool registration in `tools/dashboard-tools.ts` (I/O layer with GraphQL queries).
- `DashboardItem` (exported from `lib/dashboard.ts:20-30`) already has all fields hygiene needs: `updatedAt`, `closedAt`, `workflowState`, `priority`, `estimate`, `assignees`, `blockedBy`.
- `dashboard-tools.ts` has `DASHBOARD_ITEMS_QUERY` (line 179), `toDashboardItems()` (line 150), and `getFieldValue()` (line 135) — all currently module-private.
- `TERMINAL_STATES` from `lib/workflow-states.ts:27` provides `["Done", "Canceled"]` for archive candidate detection.
- Test file `dashboard.test.ts` demonstrates the pure-function testing pattern with `HOUR_MS`/`DAY_MS` constants, fixed `NOW`, and `makeItem()` factory.

## Desired End State

### Verification
- [x] `ralph_hero__project_hygiene` tool registered and functional
- [x] 6 report sections: archive candidates, stale items, orphaned items, field gaps, WIP violations, summary
- [x] Pure functions in `lib/hygiene.ts` with `now` parameter injection for testability
- [x] I/O layer in `tools/hygiene-tools.ts` reusing dashboard query infrastructure
- [x] JSON and markdown output formats supported
- [x] Tests pass for all pure functions
- [x] `npm run build` and `npm test` succeed

## What We're NOT Doing
- No `list_status_updates` query tool
- No duplicate candidate detection (GH-159 scope)
- No extracting `DashboardItem` query to shared module (only export existing privates)
- No changes to dashboard health checks (independent implementations for different purposes)
- No `createdAt` field addition to `DashboardItem` (use `updatedAt` as proxy for age)

## Implementation Approach

Follow the dashboard two-layer pattern exactly. Create `lib/hygiene.ts` with pure functions that take `DashboardItem[]` and return report data. Create `tools/hygiene-tools.ts` as the I/O layer that fetches data (reusing exported dashboard query infrastructure) and calls pure functions. Export `DASHBOARD_ITEMS_QUERY` and `toDashboardItems()` from `dashboard-tools.ts` to avoid query duplication.

---

## Phase 1: GH-158 — Create core `project_hygiene` reporting tool
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/158 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0158-project-hygiene-reporting-tool.md

### Changes Required

#### 1. Export `DASHBOARD_ITEMS_QUERY` and `toDashboardItems` from dashboard-tools.ts
**File**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`
**Where**: Lines 135-222

**Changes**:
- Change `function toDashboardItems` (line 150) to `export function toDashboardItems`
- Change `const DASHBOARD_ITEMS_QUERY` (line 179) to `export const DASHBOARD_ITEMS_QUERY`
- Change `interface RawDashboardItem` (line 113) to `export interface RawDashboardItem`

No other changes to this file. The `getFieldValue` function stays private — hygiene doesn't need it directly since it works with `DashboardItem` (already has fields extracted).

#### 2. Create `lib/hygiene.ts` — pure report functions
**File**: `plugin/ralph-hero/mcp-server/src/lib/hygiene.ts` (new file)

**Contents**:

```typescript
/**
 * Project hygiene report — pure functions.
 *
 * All functions are side-effect-free: DashboardItems in, report data out.
 * I/O (GraphQL fetching) lives in tools/hygiene-tools.ts.
 */

import { TERMINAL_STATES } from "./workflow-states.js";
import type { DashboardItem } from "./dashboard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HygieneConfig {
  archiveDays: number;    // default: 14
  staleDays: number;      // default: 7
  orphanDays: number;     // default: 14
  wipLimits: Record<string, number>; // default: {}
}

export const DEFAULT_HYGIENE_CONFIG: HygieneConfig = {
  archiveDays: 14,
  staleDays: 7,
  orphanDays: 14,
  wipLimits: {},
};

export interface HygieneItem {
  number: number;
  title: string;
  workflowState: string | null;
  ageDays: number;
}

export interface HygieneReport {
  generatedAt: string;
  totalItems: number;
  archiveCandidates: HygieneItem[];
  staleItems: HygieneItem[];
  orphanedItems: HygieneItem[];
  fieldGaps: { missingEstimate: HygieneItem[]; missingPriority: HygieneItem[] };
  wipViolations: Array<{ state: string; count: number; limit: number; items: HygieneItem[] }>;
  summary: {
    archiveCandidateCount: number;
    staleCount: number;
    orphanCount: number;
    fieldCoveragePercent: number;
    wipViolationCount: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ageDays(updatedAt: string, now: number): number {
  return Math.max(0, (now - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24));
}

function toHygieneItem(item: DashboardItem, now: number): HygieneItem {
  return {
    number: item.number,
    title: item.title,
    workflowState: item.workflowState,
    ageDays: Math.round(ageDays(item.updatedAt, now) * 10) / 10,
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
): Array<{ state: string; count: number; limit: number; items: HygieneItem[] }> {
  const violations: Array<{ state: string; count: number; limit: number; items: HygieneItem[] }> = [];

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
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Build a complete hygiene report from project items.
 */
export function buildHygieneReport(
  items: DashboardItem[],
  config: HygieneConfig = DEFAULT_HYGIENE_CONFIG,
  now: number = Date.now(),
): HygieneReport {
  const archiveCandidates = findArchiveCandidates(items, now, config.archiveDays);
  const staleItems = findStaleItems(items, now, config.staleDays);
  const orphanedItems = findOrphanedItems(items, now, config.orphanDays);
  const fieldGaps = findFieldGaps(items, now);
  const wipViolations = findWipViolations(items, now, config.wipLimits);

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

  return {
    generatedAt: new Date(now).toISOString(),
    totalItems: items.length,
    archiveCandidates,
    staleItems,
    orphanedItems,
    fieldGaps,
    wipViolations,
    summary: {
      archiveCandidateCount: archiveCandidates.length,
      staleCount: staleItems.length,
      orphanCount: orphanedItems.length,
      fieldCoveragePercent,
      wipViolationCount: wipViolations.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatItemRow(item: HygieneItem): string {
  return `| #${item.number} | ${item.title} | ${item.workflowState ?? "—"} | ${item.ageDays}d |`;
}

/**
 * Render hygiene report as markdown.
 */
export function formatHygieneMarkdown(report: HygieneReport): string {
  const lines: string[] = [];

  lines.push("# Project Hygiene Report");
  lines.push(`_Generated: ${report.generatedAt}_`);
  lines.push("");
  lines.push(`**Total items**: ${report.totalItems}`);
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push(`- Archive candidates: ${report.summary.archiveCandidateCount}`);
  lines.push(`- Stale items: ${report.summary.staleCount}`);
  lines.push(`- Orphaned items: ${report.summary.orphanCount}`);
  lines.push(`- Field coverage: ${report.summary.fieldCoveragePercent}%`);
  lines.push(`- WIP violations: ${report.summary.wipViolationCount}`);
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
  const totalGaps = report.fieldGaps.missingEstimate.length + report.fieldGaps.missingPriority.length;
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

  return lines.join("\n");
}
```

#### 3. Create `tools/hygiene-tools.ts` — I/O layer and tool registration
**File**: `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts` (new file)

**Contents**:

```typescript
/**
 * MCP tool for project board hygiene reporting.
 *
 * Provides a single `ralph_hero__project_hygiene` tool that
 * identifies archive candidates, stale items, orphaned entries,
 * field gaps, and WIP violations.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { paginateConnection } from "../lib/pagination.js";
import {
  buildHygieneReport,
  formatHygieneMarkdown,
  type HygieneConfig,
  DEFAULT_HYGIENE_CONFIG,
} from "../lib/hygiene.js";
import {
  DASHBOARD_ITEMS_QUERY,
  toDashboardItems,
  type RawDashboardItem,
} from "./dashboard-tools.js";
import { toolSuccess, toolError, resolveProjectOwner } from "../types.js";

// ---------------------------------------------------------------------------
// Helper: Ensure field option cache is populated
// ---------------------------------------------------------------------------

// Note: duplicated from dashboard-tools.ts — both tools need it independently.
// Could be extracted to a shared module if a third tool needs it.

interface ProjectCacheResponse {
  id: string;
  fields: {
    nodes: Array<{
      id: string;
      name: string;
      dataType: string;
      options?: Array<{ id: string; name: string }>;
    }>;
  };
}

async function fetchProjectForCache(
  client: GitHubClient,
  owner: string,
  number: number,
): Promise<ProjectCacheResponse | null> {
  const QUERY = `query($owner: String!, $number: Int!) {
    OWNER_TYPE(login: $owner) {
      projectV2(number: $number) {
        id
        fields(first: 50) {
          nodes {
            ... on ProjectV2FieldCommon {
              id
              name
              dataType
            }
            ... on ProjectV2SingleSelectField {
              id
              name
              dataType
              options { id name }
            }
          }
        }
      }
    }
  }`;

  for (const ownerType of ["user", "organization"]) {
    try {
      const result = await client.projectQuery<
        Record<string, { projectV2: ProjectCacheResponse | null }>
      >(
        QUERY.replace("OWNER_TYPE", ownerType),
        { owner, number },
        { cache: true, cacheTtlMs: 10 * 60 * 1000 },
      );
      const project = result[ownerType]?.projectV2;
      if (project) return project;
    } catch {
      // Try next owner type
    }
  }
  return null;
}

async function ensureFieldCache(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  projectNumber: number,
): Promise<void> {
  if (fieldCache.isPopulated()) return;

  const project = await fetchProjectForCache(client, owner, projectNumber);
  if (!project) {
    throw new Error(`Project #${projectNumber} not found for owner "${owner}"`);
  }

  fieldCache.populate(
    project.id,
    project.fields.nodes.map((f) => ({
      id: f.id,
      name: f.name,
      options: f.options,
    })),
  );
}

// ---------------------------------------------------------------------------
// Register hygiene tools
// ---------------------------------------------------------------------------

export function registerHygieneTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  server.tool(
    "ralph_hero__project_hygiene",
    "Generate a project board hygiene report. Identifies archive candidates, stale items, orphaned backlog entries, missing fields, and WIP violations. Returns: report with 6 sections + summary stats.",
    {
      owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
      archiveDays: z.number().optional().default(14)
        .describe("Days before Done/Canceled items become archive candidates (default: 14)"),
      staleDays: z.number().optional().default(7)
        .describe("Days before non-terminal items are flagged as stale (default: 7)"),
      orphanDays: z.number().optional().default(14)
        .describe("Days before unassigned Backlog items are flagged as orphaned (default: 14)"),
      wipLimits: z.record(z.number()).optional()
        .describe('Per-state WIP limits, e.g. { "In Progress": 3 }'),
      format: z.enum(["json", "markdown"]).optional().default("json")
        .describe("Output format (default: json)"),
    },
    async (args) => {
      try {
        const owner = args.owner || resolveProjectOwner(client.config);
        const projectNumber = client.config.projectNumber;

        if (!owner) {
          return toolError("owner is required");
        }
        if (!projectNumber) {
          return toolError("project number is required");
        }

        // Ensure field cache
        await ensureFieldCache(client, fieldCache, owner, projectNumber);

        const projectId = fieldCache.getProjectId();
        if (!projectId) {
          return toolError("Could not resolve project ID");
        }

        // Fetch all project items (reuse dashboard query)
        const result = await paginateConnection<RawDashboardItem>(
          (q, v) => client.projectQuery(q, v),
          DASHBOARD_ITEMS_QUERY,
          { projectId, first: 100 },
          "node.items",
          { maxItems: 500 },
        );

        // Convert to dashboard items
        const dashboardItems = toDashboardItems(result.nodes);

        // Build hygiene config
        const hygieneConfig: HygieneConfig = {
          ...DEFAULT_HYGIENE_CONFIG,
          archiveDays: args.archiveDays ?? 14,
          staleDays: args.staleDays ?? 7,
          orphanDays: args.orphanDays ?? 14,
          wipLimits: args.wipLimits ?? {},
        };

        // Build report
        const report = buildHygieneReport(dashboardItems, hygieneConfig);

        // Format output
        if (args.format === "markdown") {
          return toolSuccess({
            ...report,
            formatted: formatHygieneMarkdown(report),
          });
        }

        return toolSuccess(report);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to generate hygiene report: ${message}`);
      }
    },
  );
}
```

#### 4. Wire `registerHygieneTools` in index.ts
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`
**Where**: After the `registerProjectManagementTools` import (line 22), and after its call (line 306)

**Changes**:
- Add import: `import { registerHygieneTools } from "./tools/hygiene-tools.js";`
- Add registration call after line 306: `registerHygieneTools(server, client, fieldCache);`

#### 5. Add tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/hygiene.test.ts` (new file)

Following the `dashboard.test.ts` pattern with `makeItem()` factory and fixed `NOW`:

```typescript
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

describe("findArchiveCandidates", () => {
  it("includes Done items older than archiveDays", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Done", closedAt: new Date(NOW - 20 * DAY_MS).toISOString() }),
    ];
    const result = findArchiveCandidates(items, NOW, 14);
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  it("excludes Done items younger than archiveDays", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Done", closedAt: new Date(NOW - 3 * DAY_MS).toISOString() }),
    ];
    expect(findArchiveCandidates(items, NOW, 14)).toHaveLength(0);
  });

  it("includes Canceled items older than archiveDays", () => {
    const items = [
      makeItem({ number: 2, workflowState: "Canceled", updatedAt: new Date(NOW - 20 * DAY_MS).toISOString() }),
    ];
    expect(findArchiveCandidates(items, NOW, 14)).toHaveLength(1);
  });

  it("excludes non-terminal items", () => {
    const items = [
      makeItem({ number: 1, workflowState: "In Progress", updatedAt: new Date(NOW - 30 * DAY_MS).toISOString() }),
    ];
    expect(findArchiveCandidates(items, NOW, 14)).toHaveLength(0);
  });
});

describe("findStaleItems", () => {
  it("includes non-terminal items older than staleDays", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog", updatedAt: new Date(NOW - 10 * DAY_MS).toISOString() }),
    ];
    const result = findStaleItems(items, NOW, 7);
    expect(result).toHaveLength(1);
  });

  it("excludes recently updated items", () => {
    const items = [
      makeItem({ number: 1, workflowState: "In Progress", updatedAt: new Date(NOW - 2 * DAY_MS).toISOString() }),
    ];
    expect(findStaleItems(items, NOW, 7)).toHaveLength(0);
  });

  it("excludes Done items", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Done", updatedAt: new Date(NOW - 30 * DAY_MS).toISOString() }),
    ];
    expect(findStaleItems(items, NOW, 7)).toHaveLength(0);
  });
});

describe("findOrphanedItems", () => {
  it("includes unassigned Backlog items older than orphanDays", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog", assignees: [], updatedAt: new Date(NOW - 20 * DAY_MS).toISOString() }),
    ];
    expect(findOrphanedItems(items, NOW, 14)).toHaveLength(1);
  });

  it("excludes Backlog items with assignees", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog", assignees: ["alice"], updatedAt: new Date(NOW - 20 * DAY_MS).toISOString() }),
    ];
    expect(findOrphanedItems(items, NOW, 14)).toHaveLength(0);
  });

  it("excludes non-Backlog items", () => {
    const items = [
      makeItem({ number: 1, workflowState: "In Progress", assignees: [], updatedAt: new Date(NOW - 20 * DAY_MS).toISOString() }),
    ];
    expect(findOrphanedItems(items, NOW, 14)).toHaveLength(0);
  });
});

describe("findFieldGaps", () => {
  it("detects missing estimate on non-terminal items", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog", estimate: null, priority: "P1" }),
    ];
    const gaps = findFieldGaps(items, NOW);
    expect(gaps.missingEstimate).toHaveLength(1);
    expect(gaps.missingPriority).toHaveLength(0);
  });

  it("detects missing priority on non-terminal items", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog", estimate: "S", priority: null }),
    ];
    const gaps = findFieldGaps(items, NOW);
    expect(gaps.missingEstimate).toHaveLength(0);
    expect(gaps.missingPriority).toHaveLength(1);
  });

  it("excludes Done items from field gap detection", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Done", estimate: null, priority: null }),
    ];
    const gaps = findFieldGaps(items, NOW);
    expect(gaps.missingEstimate).toHaveLength(0);
    expect(gaps.missingPriority).toHaveLength(0);
  });
});

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
    expect(findWipViolations(items, NOW, { "In Progress": 3 })).toHaveLength(0);
  });
});

describe("buildHygieneReport", () => {
  it("produces summary matching section counts", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Done", closedAt: new Date(NOW - 20 * DAY_MS).toISOString() }),
      makeItem({ number: 2, workflowState: "Backlog", assignees: [], updatedAt: new Date(NOW - 20 * DAY_MS).toISOString() }),
      makeItem({ number: 3, workflowState: "In Progress", estimate: null, priority: null }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);

    expect(report.summary.archiveCandidateCount).toBe(report.archiveCandidates.length);
    expect(report.summary.staleCount).toBe(report.staleItems.length);
    expect(report.summary.orphanCount).toBe(report.orphanedItems.length);
    expect(report.totalItems).toBe(3);
  });

  it("computes field coverage percentage", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog", estimate: "S", priority: "P1" }),
      makeItem({ number: 2, workflowState: "Backlog", estimate: null, priority: null }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    expect(report.summary.fieldCoveragePercent).toBe(50);
  });
});

describe("formatHygieneMarkdown", () => {
  it("produces markdown with header and summary", () => {
    const report = buildHygieneReport([], DEFAULT_HYGIENE_CONFIG, NOW);
    const md = formatHygieneMarkdown(report);
    expect(md).toContain("# Project Hygiene Report");
    expect(md).toContain("## Summary");
  });

  it("includes archive candidates section when present", () => {
    const items = [
      makeItem({ number: 42, workflowState: "Done", closedAt: new Date(NOW - 20 * DAY_MS).toISOString() }),
    ];
    const report = buildHygieneReport(items, DEFAULT_HYGIENE_CONFIG, NOW);
    const md = formatHygieneMarkdown(report);
    expect(md).toContain("## Archive Candidates");
    expect(md).toContain("#42");
  });
});
```

### Success Criteria
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` succeeds
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes
- [x] Manual: `ralph_hero__project_hygiene` tool appears in MCP tool listing
- [x] Manual: Tool returns correct report with 6 sections + summary

---

## Integration Testing
- [x] Build succeeds: `cd plugin/ralph-hero/mcp-server && npm run build`
- [x] All tests pass: `cd plugin/ralph-hero/mcp-server && npm test`
- [x] No type errors in new code
- [x] Pure function tests cover all 6 sections
- [x] Markdown formatter produces valid output
- [x] Dashboard query export doesn't break existing dashboard tool

## References
- Research GH-158: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0158-project-hygiene-reporting-tool.md
- Dashboard pure functions: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:20-370`
- Dashboard I/O layer: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:113-348`
- Dashboard tests: `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts`
- Workflow states: `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts:27`
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/96
- Parent tracking: https://github.com/cdubiel08/ralph-hero/issues/114
