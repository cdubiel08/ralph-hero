---
date: 2026-02-21
github_issue: 146
github_url: https://github.com/cdubiel08/ralph-hero/issues/146
status: complete
type: research
---

# GH-146: Add Cross-Project Aggregation and Health Indicators to Dashboard

## Problem Statement

The `pipeline_dashboard` tool can fetch items from multiple projects (via `projectNumbers` parameter, implemented in #145), but `buildDashboard` merges all items into a single flat result. There is no per-project breakdown, and health detection has no cross-project awareness. Users managing multiple projects cannot see which project is healthy vs struggling without running separate dashboard queries.

## Current State Analysis

### DashboardItem ([dashboard.ts:20-32](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L20-L32))

Already has multi-project fields from #145:
```typescript
projectNumber?: number;  // Source project number (multi-project)
projectTitle?: string;   // Human-readable project title (multi-project)
```

These are populated by `toDashboardItems()` in [dashboard-tools.ts:158-187](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts#L158-L187) when multi-project data is fetched.

### DashboardData ([dashboard.ts:75-84](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L75-L84))

Current structure:
```typescript
interface DashboardData {
  generatedAt: string;
  totalIssues: number;
  phases: PhaseSnapshot[];
  health: { ok: boolean; warnings: HealthWarning[] };
  archive: ArchiveStats;
}
```

No `projectBreakdowns` field exists. This is the main gap.

### HealthWarning Types ([dashboard.ts:50-61](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L50-L61))

Current types: `wip_exceeded`, `stuck_issue`, `blocked`, `pipeline_gap`, `lock_collision`, `oversized_in_pipeline`.

Missing cross-project types proposed by #146: `unbalanced_workload`, `cross_project_blocking`.

### buildDashboard ([dashboard.ts:431-455](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L431-L455))

Simple orchestrator: `aggregateByPhase` -> `detectHealthIssues` -> `computeArchiveStats` -> return. Does not group by project.

### Formatters ([dashboard.ts:464-593](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L464-L593))

Two formatters:
- `formatMarkdown(data, issuesPerPhase)` -- renders phase table + health section + archive section
- `formatAscii(data)` -- renders bar chart + health summary + archive summary

Neither has per-project section support.

### Tool Layer ([dashboard-tools.ts:328-455](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts#L328-L455))

Already fetches from multiple projects (loop at line 349), merges into `allItems`, passes to `buildDashboard`. The tool layer is multi-project-ready -- the gap is in the pure function layer.

### Existing Tests ([dashboard.test.ts:1255-1286](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts#L1255-L1286))

Three multi-project tests exist:
1. Aggregates items from multiple projects correctly (flat aggregate)
2. Items from different projects with same issue number are distinct
3. Preserves projectNumber and projectTitle through makeItem

No per-project breakdown or cross-project health tests.

### Metrics Module ([metrics.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/metrics.ts))

Separate module with velocity, risk score, status, highlights. Works on flat `DashboardData`. Could benefit from per-project metrics, but that's out of scope for #146 (metrics extension would be a separate issue).

## Key Discoveries

### 1. projectNumber Is Already on Every Item

Since `toDashboardItems()` tags each item with `projectNumber` and `projectTitle`, the per-project breakdown can be computed by grouping `items` by `projectNumber` before calling `aggregateByPhase` and `detectHealthIssues`. No data fetching changes needed.

### 2. Single-Project Backward Compatibility

When items have no `projectNumber` (single-project mode), or all items share the same `projectNumber`, the `projectBreakdowns` field should be omitted or contain a single entry. The issue's acceptance criteria explicitly requires: "Single-project mode produces no `projectBreakdowns` (backward compat)."

### 3. Cross-Project Health Detection Is Novel

The two proposed health indicators require new detection logic:

**`unbalanced_workload`**: "One project has >3x items in active states vs another." This needs:
- Definition of "active states" (non-terminal, non-Backlog: Research Needed through In Review)
- Comparison across projects (at least 2 projects required)
- 3x threshold is arbitrary but reasonable as a starting point

**`cross_project_blocking`**: "Items blocked by issues in a different project (future -- detect via issue references)." The issue description marks this as "future" scope. Currently, `DashboardItem.blockedBy` only has issue numbers, not project numbers. Detecting cross-project blocking would require enriching `blockedBy` with project context, which is not available in the current data model. **Recommendation**: Defer `cross_project_blocking` to a future issue and focus on `unbalanced_workload` only.

### 4. Formatter Complexity

Both formatters would need per-project sections. The issue proposes:
- Combined summary table first (existing behavior, unchanged)
- Per-project detail sections below (new)

This is additive -- existing output is preserved, new sections appended.

### 5. DashboardData Type Extension Is Clean

Adding `projectBreakdowns` as an optional field:
```typescript
interface DashboardData {
  // ... existing fields unchanged ...
  projectBreakdowns?: Record<number, {
    projectTitle: string;
    phases: PhaseSnapshot[];
    health: { ok: boolean; warnings: HealthWarning[] };
  }>;
}
```

This preserves backward compatibility. JSON consumers that don't know about `projectBreakdowns` simply ignore it.

## Potential Approaches

### Approach A: Extend buildDashboard (Recommended)

Add per-project grouping directly in `buildDashboard`:

1. Group items by `projectNumber`
2. For each project group: call `aggregateByPhase` and `detectHealthIssues`
3. Run cross-project health detection on the per-project results
4. Attach as `projectBreakdowns` field

**Pros**: Single orchestration point, reuses existing pure functions, clean interface.
**Cons**: `buildDashboard` grows more complex (currently 15 lines, would become ~35 lines).

### Approach B: Separate buildProjectBreakdowns Function

Create a new pure function `buildProjectBreakdowns(items, config)` that produces the breakdown, called alongside `buildDashboard` in the tool layer.

**Pros**: Keeps `buildDashboard` unchanged, separation of concerns.
**Cons**: Tool layer must coordinate two functions, breakdown is disconnected from main dashboard.

### Recommendation

**Approach A** is better. The breakdown is conceptually part of the dashboard data, not a separate concern. The tool layer should remain a thin I/O wrapper.

## Implementation Details

### New Types

```typescript
// Add to HealthWarning.type union:
| "unbalanced_workload"

// Add to DashboardData:
projectBreakdowns?: Record<number, {
  projectTitle: string;
  phases: PhaseSnapshot[];
  health: { ok: boolean; warnings: HealthWarning[] };
}>;
```

### New Pure Function: detectCrossProjectHealth

```typescript
function detectCrossProjectHealth(
  breakdowns: Record<number, { phases: PhaseSnapshot[] }>,
): HealthWarning[]
```

Logic:
1. For each project, count items in "active" states (non-terminal, non-Backlog)
2. If max active count > 3x min active count (among projects with > 0 items), emit `unbalanced_workload` warning
3. Return warnings array

### buildDashboard Changes

After existing logic, add:
1. Group items by `projectNumber` (skip if all items have same or undefined `projectNumber`)
2. For each project: `aggregateByPhase` + `detectHealthIssues`
3. Call `detectCrossProjectHealth` on the breakdowns
4. Merge cross-project warnings into `dashboard.health.warnings`
5. Set `projectBreakdowns` on result

### Formatter Changes

**formatMarkdown**: After existing phase table + health section, if `data.projectBreakdowns` is present and has > 1 project:
- Add `## Per-Project Breakdown` heading
- For each project: sub-heading with title, mini phase table, health summary

**formatAscii**: After existing output, if `data.projectBreakdowns` is present and has > 1 project:
- Add separator line
- For each project: title, bar chart subset, health summary

### Test Plan

1. **buildDashboard with single project**: No `projectBreakdowns` in result (backward compat)
2. **buildDashboard with multi-project**: `projectBreakdowns` present with correct per-project phase counts
3. **detectCrossProjectHealth**: `unbalanced_workload` triggered when 3x threshold exceeded; not triggered when balanced
4. **formatMarkdown with projectBreakdowns**: Per-project sections rendered after aggregate
5. **formatAscii with projectBreakdowns**: Per-project sections rendered after aggregate
6. **Edge case**: All items from one project in multi-project mode (no unbalanced warning since only 1 active project)

## Files to Change

| File | Change | Risk |
|------|--------|------|
| [`lib/dashboard.ts:50-61`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L50-L61) | Add `unbalanced_workload` to HealthWarning type | Low |
| [`lib/dashboard.ts:75-84`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L75-L84) | Add optional `projectBreakdowns` to DashboardData | Low |
| [`lib/dashboard.ts:431-455`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L431-L455) | Extend `buildDashboard` with per-project grouping | Medium |
| [`lib/dashboard.ts` (new function)](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts) | Add `detectCrossProjectHealth` pure function | Low |
| [`lib/dashboard.ts:464-542`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L464-L542) | Extend `formatMarkdown` with per-project sections | Medium |
| [`lib/dashboard.ts:547-593`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L547-L593) | Extend `formatAscii` with per-project sections | Medium |
| [`__tests__/dashboard.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts) | Add tests for breakdowns, cross-project health, formatters | Low |

**No changes needed in**:
- `dashboard-tools.ts` -- tool layer already merges multi-project items correctly; `buildDashboard` changes propagate automatically through the JSON response
- `types.ts` -- no new config resolution needed
- `metrics.ts` -- per-project metrics are out of scope

## Risks and Considerations

1. **`cross_project_blocking` is deferred**: The issue description marks this as "future." The current `DashboardItem.blockedBy` has no `projectNumber` on blockers. Implementing this requires enriching the data model -- should be a separate issue.

2. **"Active states" definition**: The `unbalanced_workload` check needs a clear definition of which states count as "active." Recommended: all states in `STATE_ORDER` that are NOT in `TERMINAL_STATES` and NOT "Backlog". This means Research Needed through In Review.

3. **Performance**: `aggregateByPhase` is called N+1 times (once for the aggregate, once per project). Since it's a pure function operating on in-memory arrays, the cost is negligible.

4. **Formatter output length**: Per-project sections could make the output verbose for many projects. Consider limiting to the first 5 projects with a "+N more" truncation.

## Recommended Next Steps

1. Extend `HealthWarning` type with `unbalanced_workload`
2. Add `projectBreakdowns` to `DashboardData`
3. Implement `detectCrossProjectHealth` pure function
4. Extend `buildDashboard` with per-project grouping logic
5. Update both formatters with per-project sections
6. Write tests for all new functionality
7. Defer `cross_project_blocking` to a follow-up issue
