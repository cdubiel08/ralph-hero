---
date: 2026-02-20
github_issue: 158
github_url: https://github.com/cdubiel08/ralph-hero/issues/158
status: complete
type: research
---

# GH-158: Create Core `project_hygiene` Reporting Tool

## Problem Statement

Project boards accumulate stale Done/Canceled items, issues missing field values (Estimate, Priority), orphaned Backlog entries with no assignee, and WIP violations. The existing `pipeline_dashboard` provides real-time phase snapshots and health warnings but lacks a hygiene-focused report. A `project_hygiene` tool should generate an actionable report with 6 sections: archive candidates, stale items, orphaned items, field gaps, WIP violations, and summary stats.

## Current State Analysis

### Dashboard Architecture (the pattern to follow)

The dashboard system uses a clean two-layer split:

**`lib/dashboard.ts`** (pure functions, no I/O):
- `DashboardItem` interface — input type with `number`, `title`, `updatedAt`, `closedAt`, `workflowState`, `priority`, `estimate`, `assignees`, `blockedBy` (lines 20-30)
- `HealthConfig` interface + `DEFAULT_HEALTH_CONFIG` — configurable thresholds (lines 71-83)
- `aggregateByPhase()` — groups by workflow state (lines 135-191)
- `detectHealthIssues()` — produces `HealthWarning[]` (lines 231-343)
- `buildDashboard()` — orchestrator (lines 353-370)
- `formatMarkdown()` / `formatAscii()` — output formatters (lines 379-477)
- `now: number = Date.now()` parameter injection for testability

**`tools/dashboard-tools.ts`** (I/O layer):
- `DASHBOARD_ITEMS_QUERY` — GraphQL query fetching items with field values (lines 179-222)
- `toDashboardItems()` — raw → typed converter (lines 150-173)
- `getFieldValue()` — extracts single-select values from `fieldValues.nodes` (lines 135-145)
- `registerDashboardTools()` — MCP tool registration
- `paginateConnection` call with `maxItems: 500` (lines 294-300)

### What the Dashboard Query Already Fetches

The `DASHBOARD_ITEMS_QUERY` fetches for each Issue:
- `number`, `title`, `state`, `updatedAt`, `closedAt`
- `assignees(first: 5) { nodes { login } }`
- `fieldValues(first: 20)` → `ProjectV2ItemFieldSingleSelectValue` with `name` and `field.name`

This is **almost exactly what hygiene needs**. The only missing field is `createdAt` (useful for orphan detection but not strictly required — `updatedAt` can proxy).

### Existing `DashboardItem` Reuse

The `DashboardItem` interface already has all fields hygiene needs:
- `updatedAt` — for staleness and archive candidacy
- `closedAt` — for Done/Canceled window
- `workflowState` — for filtering by state category
- `priority` / `estimate` — for field gap detection
- `assignees` — for orphan detection
- `blockedBy` — currently hardcoded `[]` but not needed for hygiene

**Key insight**: `project_hygiene` can reuse `DashboardItem` as its input type and `toDashboardItems()` as its converter, avoiding duplicate type definitions.

### Workflow State Constants

From `lib/workflow-states.ts`:
- `TERMINAL_STATES = ["Done", "Canceled"]` — for archive candidate detection
- `STATE_ORDER` — 9 canonical states from Backlog to Done
- `LOCK_STATES` — exclusive ownership states
- No existing constant for "active non-terminal" states — would need `STATE_ORDER` minus terminal

## Implementation Plan

### Architecture: `lib/hygiene.ts` + `tools/hygiene-tools.ts`

Follow the dashboard two-layer pattern:

**`lib/hygiene.ts`** — pure report functions:

```typescript
export interface HygieneConfig {
  archiveDays: number;     // default: 14
  staleDays: number;       // default: 7
  orphanDays: number;      // default: 14
  wipLimits: Record<string, number>;  // default: {}
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
  ageDays: number;         // days since updatedAt
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
```

**Six pure functions** (all take `DashboardItem[]`, `now`, and config):

1. `findArchiveCandidates(items, now, archiveDays)` — items where `workflowState ∈ TERMINAL_STATES` AND `age > archiveDays`
2. `findStaleItems(items, now, staleDays)` — items where `workflowState ∉ TERMINAL_STATES` AND `age > staleDays`
3. `findOrphanedItems(items, now, orphanDays)` — items where `workflowState === "Backlog"` AND `assignees.length === 0` AND `age > orphanDays`
4. `findFieldGaps(items)` — items where `estimate === null` OR `priority === null` (filtered to non-terminal)
5. `findWipViolations(items, wipLimits)` — count items per active state, flag exceeding limits
6. `buildHygieneReport(items, config, now)` — orchestrator calling all 5 + computing summary

Plus formatters:
- `formatHygieneMarkdown(report)` — markdown table per section
- (JSON is just `toolSuccess(report)` — no formatter needed)

**`tools/hygiene-tools.ts`** — I/O layer:

```typescript
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
      repo: z.string().optional().describe("Repository name. Defaults to env var"),
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
    async (args) => { ... }
  );
}
```

### Data Fetching — Reuse Dashboard Query

The hygiene tool can **reuse `DASHBOARD_ITEMS_QUERY` and `toDashboardItems()`** from `dashboard-tools.ts`. Two options:

**Option A: Import from dashboard-tools.ts** — export `DASHBOARD_ITEMS_QUERY` and `toDashboardItems()` so hygiene can import them.
- Pro: No duplication
- Con: Creates cross-tool dependency

**Option B: Duplicate the query** — copy the query into hygiene-tools.ts.
- Pro: No coupling between tools
- Con: Duplicated query maintenance

**Option C: Extract to shared module** — move the query and converter to `lib/project-items.ts`.
- Pro: Clean shared layer, both tools import from same place
- Con: Refactor effort

**Recommendation: Option A for now** (export from dashboard-tools.ts), migrate to Option C if a third tool needs the same query. The `DashboardItem` type is already exported from `lib/dashboard.ts`, so the pure function layer has no coupling issue.

### Age Calculation

Follow the dashboard pattern exactly:

```typescript
function ageDays(updatedAt: string, now: number): number {
  return Math.max(0, (now - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24));
}
```

This mirrors `ageHours` in `dashboard.ts:212-214` but in days.

### Overlap with Existing Dashboard Health Checks

Two hygiene sections overlap with `detectHealthIssues()`:

| Hygiene Section | Dashboard Equivalent | Difference |
|----------------|---------------------|------------|
| WIP violations | `wip_exceeded` warning | Same logic — reuse or delegate |
| Stale items | `stuck_issue` warning | Different thresholds (days vs hours), different scope |

**Recommendation**: Implement hygiene sections independently. They serve different purposes (hygiene = actionable cleanup, dashboard = real-time health). Sharing the `WIP violations` logic would couple the two systems unnecessarily.

### Tests

Follow `dashboard.test.ts` pattern:

```typescript
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date("2026-02-16T12:00:00Z").getTime();

function makeItem(overrides: Partial<DashboardItem> = {}): DashboardItem {
  return {
    number: 1, title: "Test", updatedAt: new Date(NOW - 1 * HOUR_MS).toISOString(),
    closedAt: null, workflowState: "Backlog", priority: null, estimate: null,
    assignees: [], blockedBy: [],
    ...overrides,
  };
}
```

Test cases per section:
1. **Archive candidates**: Done item 20 days old → included; Done item 3 days old → excluded; Open item → excluded
2. **Stale items**: Backlog item 10 days old → included; In Progress item 2 days old → excluded; Done item → excluded
3. **Orphaned items**: Backlog, no assignee, 20 days old → included; Backlog with assignee → excluded; Non-Backlog → excluded
4. **Field gaps**: Item missing estimate → in `missingEstimate`; Item missing priority → in `missingPriority`; Done item missing both → excluded
5. **WIP violations**: 4 items in "In Progress" with limit 3 → violation; 2 items with limit 3 → no violation
6. **buildHygieneReport**: Integration test, verify summary stats match section counts

### Group Context

Parent #114 has 2 children:
- **#158** (this issue, S): Core hygiene tool — 6 report sections
- **#159** (order 2): Duplicate candidate detection via fuzzy title matching — depends on #158

Sibling issues under Epic #96:
- #115: Archive stats in dashboard (researched)
- #116: Integrate hygiene into ralph-loop.sh (researched, depends on #158)
- #113: bulk_archive tool (split into #153-#157)

## Risks

1. **Query performance**: Fetching all project items (up to 500) is the same cost as `pipeline_dashboard`. No additional API calls needed beyond what `paginateConnection` already does.

2. **DashboardItem reuse**: If `DashboardItem` gains fields that hygiene doesn't need, the type still works — extra fields are harmless. If hygiene needs fields that `DashboardItem` doesn't have (e.g., `createdAt`), the type would need extending — but this can be deferred.

3. **Threshold tuning**: Default values (14-day archive, 7-day stale, 14-day orphan) are reasonable starting points. Making them configurable via tool params avoids hardcoding assumptions.

## File Changes

| File | Change | Effort |
|------|--------|--------|
| `lib/hygiene.ts` | New — `HygieneConfig`, `HygieneReport`, 6 pure functions, markdown formatter | Primary |
| `tools/hygiene-tools.ts` | New — tool registration, data fetching, format dispatch | Primary |
| `tools/dashboard-tools.ts` | Export `DASHBOARD_ITEMS_QUERY` and `toDashboardItems()` | Minor |
| `index.ts` | Add `import { registerHygieneTools }` and call | Minor |
| `__tests__/hygiene.test.ts` | New — pure function tests following dashboard pattern | Secondary |

## Recommended Approach

1. Create `lib/hygiene.ts` with `HygieneConfig`, `DEFAULT_HYGIENE_CONFIG`, report interfaces, 6 pure section functions, `buildHygieneReport()` orchestrator, and `formatHygieneMarkdown()`
2. Create `tools/hygiene-tools.ts` — register tool, reuse dashboard query/converter, call pure functions
3. Export `DASHBOARD_ITEMS_QUERY` and `toDashboardItems()` from `dashboard-tools.ts`
4. Wire in `index.ts`
5. Create `__tests__/hygiene.test.ts` following `dashboard.test.ts` factory pattern
