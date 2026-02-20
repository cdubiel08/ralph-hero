---
date: 2026-02-20
github_issue: 139
github_url: https://github.com/cdubiel08/ralph-hero/issues/139
status: complete
type: research
---

# GH-139: Add Velocity Metrics and Auto-Status Determination to Dashboard Library

## Problem Statement

The dashboard library (`lib/dashboard.ts`) provides phase-by-phase pipeline snapshots and health warnings, but lacks velocity tracking (throughput over time), risk scoring (numeric aggregation of health indicators), and automatic status determination (ON_TRACK/AT_RISK/OFF_TRACK). These metrics are needed by the `project_report` skill (#140) to auto-generate status update content for the `create_status_update` tool (#138).

## Current State Analysis

### Dashboard Library (`lib/dashboard.ts`)

The library is a pure-function module with no I/O. Key components:

- **`DashboardItem`** ([dashboard.ts:20-30](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L20)): Input type with `number`, `title`, `updatedAt`, `closedAt`, `workflowState`, `priority`, `estimate`, `assignees`, `blockedBy`
- **`aggregateByPhase()`** ([dashboard.ts:135-191](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L135)): Groups items by workflow state, filters Done/Canceled by `doneWindowDays` time window
- **`detectHealthIssues()`** ([dashboard.ts:231-343](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L231)): Produces 6 types of `HealthWarning` — stuck, wip_exceeded, lock_collision, pipeline_gap, blocked, oversized_in_pipeline
- **`buildDashboard()`** ([dashboard.ts:353-370](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L353)): Orchestrates aggregation + health detection, returns `DashboardData`

### Existing Patterns to Leverage

1. **Done time-window filtering** ([dashboard.ts:158-166](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L158)): Already filters Done items by `doneWindowDays`. The velocity calculation can reuse this exact pattern — count Done items within a configurable window.

2. **Age calculation** ([dashboard.ts:212-214](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L212)): `ageHours = (now - new Date(item.updatedAt).getTime()) / (1000 * 60 * 60)` — same date math pattern for time-window comparisons.

3. **Health warnings as risk inputs**: The existing `HealthWarning` array from `detectHealthIssues()` already categorizes issues by severity (`critical`, `warning`, `info`). Risk scoring can aggregate these directly.

4. **Pure-function test pattern** ([dashboard.test.ts:27-48](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts#L27)): Fixed `NOW` timestamp, `makeItem(overrides)` factory, `findPhase()` helper. New metrics tests should follow this exact pattern.

### No Existing Metrics Implementation

- No `metrics.ts` file exists in `src/lib/`
- Zero references to "velocity", "risk score", "throughput" in any source file
- Prior research (GH-20 pipeline analytics) explored throughput metrics but was dropped as redundant with `pipeline_dashboard`

## Key Discoveries

### 1. Velocity Is a Simple Count

Velocity = count of items that moved to Done within a time window. The data is already available:
- `aggregateByPhase()` already filters Done items by `doneWindowDays`
- The Done phase's `count` after filtering IS the velocity for that window
- For more precise velocity, filter raw `DashboardItem[]` where `workflowState === "Done"` and `closedAt` (or `updatedAt` fallback) is within the window

### 2. Risk Score Maps Naturally to Warnings

The health warnings already classify issues by type and severity. A weighted sum produces a numeric risk score:

| Severity | Weight | Rationale |
|----------|--------|-----------|
| `critical` | 3 | Immediate attention needed (stuck >96h, lock collision) |
| `warning` | 1 | Action needed but not urgent (stuck >48h, WIP exceeded, blocked, oversized) |
| `info` | 0 | Informational only (pipeline gap) |

Risk score = `Σ(severity_weight * count)`. Example: 2 critical + 3 warnings = 6 + 3 = 9.

### 3. Status Determination Uses Thresholds

Map risk score to `ProjectV2StatusUpdateStatus` enum:

| Condition | Status |
|-----------|--------|
| `riskScore >= offTrackThreshold` (default: 6) | `OFF_TRACK` |
| `riskScore >= atRiskThreshold` (default: 2) | `AT_RISK` |
| `riskScore < atRiskThreshold` | `ON_TRACK` |

Thresholds should be configurable. `INACTIVE` and `COMPLETE` status values are outside auto-determination scope (they represent project lifecycle, not health).

### 4. Highlights Are Time-Windowed Queries

- **Recently completed**: Items in Done phase within the time window (already computed by `aggregateByPhase`)
- **Newly added**: Items where `createdAt` is within the window — but `DashboardItem` does NOT currently include `createdAt`. Either add it to the type and GraphQL query, or use `updatedAt` for items in Backlog as an approximation.

### 5. `blockedBy` Data Gap

`DashboardItem.blockedBy` is always an empty array today ([dashboard-tools.ts:168](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts#L168)). The comment reads "blockedBy requires separate queries; omit for now". This means the `blocked` health warning never fires, and blocked items won't factor into risk score. This is a pre-existing limitation, not introduced by this issue.

## Potential Approaches

### Approach A: Separate `metrics.ts` Module (Recommended)

Create `lib/metrics.ts` as pure functions that take `DashboardData` (output of `buildDashboard()`) as input:

```typescript
// lib/metrics.ts
export interface MetricsConfig {
  velocityWindowDays: number;   // default: 7
  atRiskThreshold: number;      // default: 2
  offTrackThreshold: number;    // default: 6
  severityWeights: Record<string, number>; // default: {critical:3, warning:1, info:0}
}

export function calculateVelocity(items: DashboardItem[], windowDays: number, now: number): number;
export function calculateRiskScore(warnings: HealthWarning[], weights: Record<string, number>): number;
export function determineStatus(riskScore: number, config: MetricsConfig): ProjectV2StatusUpdateStatus;
export function extractHighlights(dashboard: DashboardData, windowDays: number): Highlights;
```

**Pros:** Clean separation, testable in isolation, doesn't bloat `dashboard.ts`, follows existing module pattern
**Cons:** Additional import in dashboard-tools.ts

### Approach B: Extend `buildDashboard()` Return Type

Add metrics directly to `DashboardData`:

```typescript
interface DashboardData {
  // ... existing fields ...
  metrics?: {
    velocity: number;
    riskScore: number;
    autoStatus: string;
    highlights: { recentlyCompleted: ..., newlyAdded: ... };
  }
}
```

**Pros:** Single function call returns everything
**Cons:** Couples metrics to dashboard, makes `buildDashboard()` more complex, metrics config mixed with health config

### Recommendation: Approach A

Keep `metrics.ts` as a separate pure-function module. The `pipeline_dashboard` tool can optionally call it and include metrics in its response. The `project_report` skill (#140) will call both `buildDashboard()` and metrics functions.

## Risks

1. **`createdAt` not in `DashboardItem`**: "Newly added" highlights need `createdAt`, which is not fetched in the dashboard GraphQL query. Options: add `createdAt` to the query and type, or approximate with `updatedAt` for Backlog items.
2. **`blockedBy` always empty**: Blocked items won't factor into risk score. This is a known gap, not a new risk.
3. **Threshold tuning**: Default risk thresholds need to be reasonable. Starting with `atRisk: 2, offTrack: 6` and making them configurable avoids hardcoding assumptions.
4. **Velocity window alignment**: Velocity window should match `doneWindowDays` by default to avoid confusion.

## Recommended Next Steps

1. Create `lib/metrics.ts` with four pure functions: `calculateVelocity`, `calculateRiskScore`, `determineStatus`, `extractHighlights`
2. Create `__tests__/metrics.test.ts` following dashboard test patterns (fixed NOW, makeItem factory)
3. Add `createdAt` to `DashboardItem` type and dashboard GraphQL query for "newly added" highlights
4. Expose metrics optionally in `pipeline_dashboard` tool response (add `includeMetrics` boolean param)
5. Make thresholds configurable via tool params with sensible defaults
