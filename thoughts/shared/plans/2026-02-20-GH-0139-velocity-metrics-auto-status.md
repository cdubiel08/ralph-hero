---
date: 2026-02-20
status: draft
github_issues: [139]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/139
primary_issue: 139
---

# Velocity Metrics and Auto-Status Determination - Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-139 | Add velocity metrics and auto-status determination to dashboard library | S |

## Current State Analysis

The dashboard library (`lib/dashboard.ts`) provides:
- `DashboardItem` type with `number`, `title`, `updatedAt`, `closedAt`, `workflowState`, `priority`, `estimate`, `assignees`, `blockedBy`
- `aggregateByPhase()` groups items by workflow state, filters Done/Canceled by `doneWindowDays` time window
- `detectHealthIssues()` produces `HealthWarning[]` with 6 types and 3 severity levels (`critical`, `warning`, `info`)
- `buildDashboard()` orchestrates both into `DashboardData`
- `formatMarkdown()` and `formatAscii()` render output

Key patterns to leverage:
- Done time-window filtering already exists in `aggregateByPhase()` (lines 158-170)
- Age calculation: `(now - new Date(item.updatedAt).getTime()) / (1000 * 60 * 60)` (lines 212-214)
- `HealthWarning.severity` already classifies as `critical`/`warning`/`info` — direct input for risk scoring
- Test pattern: fixed `NOW` timestamp, `makeItem(overrides)` factory, `findPhase()` helper

Known gaps:
- `DashboardItem` lacks `createdAt` — "newly added" highlights will use `updatedAt` for Backlog items as approximation
- `blockedBy` always empty in practice (pre-existing gap, not introduced here)

## Desired End State
### Verification
- [x] `lib/metrics.ts` exports 4 pure functions: `calculateVelocity`, `calculateRiskScore`, `determineStatus`, `extractHighlights`
- [x] `MetricsConfig` interface with configurable thresholds and sensible defaults
- [x] `pipeline_dashboard` tool exposes metrics via optional `includeMetrics` param
- [x] `__tests__/metrics.test.ts` covers all functions with edge cases
- [x] `npm test` passes
- [x] `npm run build` succeeds

## What We're NOT Doing
- Adding `createdAt` to `DashboardItem` or the GraphQL query (future enhancement; approximate with `updatedAt` for now)
- Resolving the `blockedBy` data gap (pre-existing, tracked separately)
- Posting status updates (handled by GH-138 `create_status_update` tool)
- Skill definition (handled by GH-140 `project_report` skill)
- Modifying `buildDashboard()` return type (metrics stay separate per Approach A)

## Implementation Approach

Create `lib/metrics.ts` as a standalone pure-function module (Approach A from research). Functions take `DashboardData` or its components as input — no I/O, no side effects. The `pipeline_dashboard` tool optionally invokes metrics and includes results in its response. Tests follow `dashboard.test.ts` patterns exactly.

---

## Phase 1: GH-139 — Velocity Metrics and Auto-Status
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/139 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0139-velocity-metrics-auto-status.md

### Changes Required

#### 1. New file: `mcp-server/src/lib/metrics.ts`
**File**: `plugin/ralph-hero/mcp-server/src/lib/metrics.ts`

**Types to define:**
```typescript
export interface MetricsConfig {
  velocityWindowDays: number;     // default: 7
  atRiskThreshold: number;        // default: 2
  offTrackThreshold: number;      // default: 6
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
```

**Default config:**
```typescript
export const DEFAULT_METRICS_CONFIG: MetricsConfig = {
  velocityWindowDays: 7,
  atRiskThreshold: 2,
  offTrackThreshold: 6,
  severityWeights: { critical: 3, warning: 1, info: 0 },
};
```

**Functions to implement:**

1. `calculateVelocity(items: DashboardItem[], windowDays: number, now: number): number`
   - Filter items where `workflowState === "Done"` and `closedAt` (or `updatedAt` fallback) is within `windowDays` of `now`
   - Return count of matching items
   - Reuse the same time-window filtering pattern from `aggregateByPhase()` lines 158-166

2. `calculateRiskScore(warnings: HealthWarning[], weights: Record<string, number>): number`
   - Sum `weights[warning.severity]` for each warning
   - Unknown severities default to weight 0
   - Return total

3. `determineStatus(riskScore: number, config: Pick<MetricsConfig, "atRiskThreshold" | "offTrackThreshold">): ProjectHealthStatus`
   - If `riskScore >= config.offTrackThreshold` return `"OFF_TRACK"`
   - Else if `riskScore >= config.atRiskThreshold` return `"AT_RISK"`
   - Else return `"ON_TRACK"`

4. `extractHighlights(data: DashboardData, windowDays: number, now: number): Highlights`
   - `recentlyCompleted`: Find the "Done" phase in `data.phases`, return its issues (already filtered by time window via `aggregateByPhase`)
   - `newlyAdded`: Find the "Backlog" phase, filter issues where `ageHours * 3600000 < windowDays * DAY_MS` (i.e., `ageHours < windowDays * 24`), return matching items
   - Map to `{ number, title }` for each

5. `calculateMetrics(items: DashboardItem[], data: DashboardData, config: MetricsConfig, now: number): MetricsResult`
   - Convenience orchestrator that calls all four functions and returns a combined result
   - `velocity = calculateVelocity(items, config.velocityWindowDays, now)`
   - `riskScore = calculateRiskScore(data.health.warnings, config.severityWeights)`
   - `status = determineStatus(riskScore, config)`
   - `highlights = extractHighlights(data, config.velocityWindowDays, now)`

#### 2. New file: `mcp-server/src/__tests__/metrics.test.ts`
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/metrics.test.ts`

**Test structure** (follow `dashboard.test.ts` patterns):
- Same `NOW`, `HOUR_MS`, `DAY_MS` constants
- Same `makeItem()` factory (import `DashboardItem` type from `dashboard.js`)
- Import `buildDashboard` from `dashboard.js` for integration tests

**Test cases:**

`describe("calculateVelocity")`:
- Returns count of Done items within window (closedAt within 7 days)
- Uses updatedAt fallback when closedAt is null
- Excludes Done items outside window
- Ignores non-Done items (Backlog, In Progress, etc.)
- Returns 0 for empty items array
- Returns 0 when no Done items in window

`describe("calculateRiskScore")`:
- Returns 0 for empty warnings array
- Sums weights correctly: 2 critical (3 each) + 1 warning (1) = 7
- Treats unknown severity as 0
- Single critical = 3, single warning = 1, single info = 0
- Custom weights override defaults

`describe("determineStatus")`:
- OFF_TRACK when riskScore >= offTrackThreshold (6)
- AT_RISK when riskScore >= atRiskThreshold (2) but < offTrackThreshold
- ON_TRACK when riskScore < atRiskThreshold
- Boundary: exactly at threshold returns the higher status (>= comparison)

`describe("extractHighlights")`:
- recentlyCompleted returns Done phase issues
- newlyAdded returns recent Backlog items (ageHours < windowDays * 24)
- Excludes old Backlog items
- Handles missing Done/Backlog phases gracefully (empty arrays)

`describe("calculateMetrics")`:
- Integration: items with mixed states produce correct velocity, risk, status, highlights
- Healthy project: 0 warnings, positive velocity = ON_TRACK
- Unhealthy project: multiple critical warnings = OFF_TRACK

#### 3. Modified file: `mcp-server/src/tools/dashboard-tools.ts`
**File**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`

**Changes:**
- Add import: `import { calculateMetrics, DEFAULT_METRICS_CONFIG, type MetricsConfig as MetricsConfigType, type MetricsResult } from "../lib/metrics.js";`
- Add new optional params to `pipeline_dashboard` tool schema:
  ```typescript
  includeMetrics: z.boolean().optional().default(false)
    .describe("Include velocity metrics, risk score, and auto-status (default: false)"),
  velocityWindowDays: z.number().optional().default(7)
    .describe("Days to look back for velocity calculation (default: 7)"),
  atRiskThreshold: z.number().optional().default(2)
    .describe("Risk score threshold for AT_RISK status (default: 2)"),
  offTrackThreshold: z.number().optional().default(6)
    .describe("Risk score threshold for OFF_TRACK status (default: 6)"),
  ```
- After `buildDashboard()` call, if `args.includeMetrics`:
  - Build `MetricsConfig` from args
  - Call `calculateMetrics(dashboardItems, dashboard, metricsConfig, Date.now())`
  - Spread metrics into the response object alongside dashboard data

### Success Criteria
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm test` — all tests pass including new metrics tests
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` — compiles without errors
- [ ] Manual: `pipeline_dashboard` with `includeMetrics: false` (default) returns same response as before
- [ ] Manual: `pipeline_dashboard` with `includeMetrics: true` returns additional `metrics` object with `velocity`, `riskScore`, `status`, `highlights`

---

## Integration Testing
- [x] Build succeeds: `npm run build`
- [x] All existing dashboard tests still pass (no regressions)
- [x] New metrics tests pass: `npm test -- --reporter=verbose`
- [ ] `pipeline_dashboard` without `includeMetrics` is unchanged (backward compatible)
- [ ] `pipeline_dashboard` with `includeMetrics: true` returns metrics block

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0139-velocity-metrics-auto-status.md
- Dashboard library: [plugin/ralph-hero/mcp-server/src/lib/dashboard.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts)
- Dashboard tests: [plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts)
- Dashboard tool: [plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts)
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/119
- Related: GH-138 (create_status_update tool), GH-140 (project_report skill)
