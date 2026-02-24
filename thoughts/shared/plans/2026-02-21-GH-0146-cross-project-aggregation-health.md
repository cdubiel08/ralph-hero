---
date: 2026-02-21
status: draft
github_issue: 146
github_url: https://github.com/cdubiel08/ralph-hero/issues/146
primary_issue: 146
---

# GH-146: Cross-Project Aggregation and Health Indicators - Implementation Plan

## Overview

Single issue implementation: GH-146 -- Add per-project breakdown and cross-project health detection to the pipeline dashboard.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-146 | Add cross-project aggregation and health indicators to dashboard | S |

## Current State Analysis

- `DashboardItem` already has `projectNumber` and `projectTitle` fields (from closed #145)
- `buildDashboard` merges all items into a flat result -- no per-project breakdown
- `HealthWarning.type` has 6 types; none are cross-project aware
- `DashboardData` has no `projectBreakdowns` field
- Tool layer (`dashboard-tools.ts`) already fetches from multiple projects and tags items -- the gap is in the pure function layer (`lib/dashboard.ts`)
- 3 existing multi-project tests verify flat aggregation works; no per-project breakdown tests
- `aggregateByPhase` and `detectHealthIssues` are reusable pure functions -- per-project breakdown can call them on filtered subsets

## Desired End State

### Verification
- [x] `DashboardData` has optional `projectBreakdowns` field
- [x] `HealthWarning.type` includes `unbalanced_workload`
- [x] `buildDashboard` produces `projectBreakdowns` when items span multiple projects
- [x] `buildDashboard` omits `projectBreakdowns` for single-project mode (backward compat)
- [x] `detectCrossProjectHealth` emits `unbalanced_workload` when 3x threshold exceeded
- [x] `formatMarkdown` renders per-project sections when `projectBreakdowns` is present
- [x] `formatAscii` renders per-project sections when `projectBreakdowns` is present
- [x] `npm run build` and `npm test` pass

## What We're NOT Doing

- Not implementing `cross_project_blocking` health indicator (deferred per research -- requires enriching `blockedBy` with project context)
- Not modifying `dashboard-tools.ts` (tool layer already handles multi-project fetching)
- Not modifying `metrics.ts` (per-project metrics are a separate concern)
- Not adding per-project archive stats (archive stats remain aggregate-only)
- Not limiting formatter output to N projects (keep simple; truncation is a future enhancement if needed)

## Implementation Approach

All changes in `lib/dashboard.ts` (pure functions) and `__tests__/dashboard.test.ts` (tests). No I/O layer changes.

1. Extend types: add `unbalanced_workload` to `HealthWarning.type`, add `projectBreakdowns` to `DashboardData`
2. Add `detectCrossProjectHealth` pure function
3. Extend `buildDashboard` to compute per-project breakdowns
4. Extend both formatters with per-project sections
5. Add tests for all new functionality

---

## Phase 1: GH-146 -- Cross-project aggregation and health indicators
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/146 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0146-cross-project-aggregation-health.md

### Changes Required

#### 1. Extend HealthWarning type
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Where**: `HealthWarning.type` union (lines 50-61)

Add `"unbalanced_workload"` to the type union.

#### 2. Add ProjectBreakdown type and extend DashboardData
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Where**: After `ArchiveStats` interface (line 73), before `DashboardData` (line 75)

Add new interface:
```typescript
export interface ProjectBreakdown {
  projectTitle: string;
  phases: PhaseSnapshot[];
  health: { ok: boolean; warnings: HealthWarning[] };
}
```

Add optional field to `DashboardData`:
```typescript
projectBreakdowns?: Record<number, ProjectBreakdown>;
```

#### 3. Add detectCrossProjectHealth function
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Where**: After `detectHealthIssues` function (after line 360), before `computeArchiveStats`

New exported pure function:
```typescript
export function detectCrossProjectHealth(
  breakdowns: Record<number, { phases: PhaseSnapshot[] }>,
): HealthWarning[]
```

Logic:
1. For each project, count items in "active" states (states in `STATE_ORDER` that are NOT in `TERMINAL_STATES` and NOT `"Backlog"`)
2. If fewer than 2 projects have active items, return empty array
3. Compute `maxActive` and `minActive` across projects with > 0 active items
4. If `maxActive > 3 * minActive`, emit one `unbalanced_workload` warning with severity `"warning"`, message identifying the projects and counts
5. `issues` array should be empty (this is a project-level warning, not issue-level)

#### 4. Extend buildDashboard with per-project grouping
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Where**: `buildDashboard` function (lines 431-455)

After existing aggregate logic, add:
1. Group items by `projectNumber` -- collect distinct `projectNumber` values (skip items where `projectNumber` is undefined)
2. If 2 or more distinct projects found:
   a. For each project: filter items, call `aggregateByPhase`, call `detectHealthIssues`
   b. Build `projectBreakdowns` record keyed by `projectNumber`
   c. Call `detectCrossProjectHealth` on the breakdowns
   d. Merge cross-project warnings into the aggregate `warnings` array
   e. Re-sort all warnings by severity
   f. Update `health.ok` based on merged warnings
   g. Set `projectBreakdowns` on result
3. If 0 or 1 distinct projects: omit `projectBreakdowns` (backward compatible)

#### 5. Extend formatMarkdown with per-project sections
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Where**: `formatMarkdown` function (lines 464-542), after the archive section

If `data.projectBreakdowns` is present and has > 1 entry:
- Add `## Per-Project Breakdown` heading
- For each project (sorted by `projectNumber`):
  - `### [projectTitle]` sub-heading
  - Mini phase table (same format as aggregate, but only non-zero phases)
  - Health summary (warnings for this project, or "All clear")

#### 6. Extend formatAscii with per-project sections
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Where**: `formatAscii` function (lines 547-593), after the archive line

If `data.projectBreakdowns` is present and has > 1 entry:
- Add blank line + `--- Per-Project ---` separator
- For each project (sorted by `projectNumber`):
  - Project title line
  - Mini bar chart (only non-zero phases)
  - Health summary line

#### 7. Add tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts`

Add new `describe` blocks:

**`describe("detectCrossProjectHealth")`**:
- Emits `unbalanced_workload` when one project has > 3x active items vs another
- Does not emit warning when projects are balanced
- Does not emit warning with fewer than 2 active projects
- Ignores terminal and Backlog items in active count

**`describe("buildDashboard multi-project breakdown")`**:
- Omits `projectBreakdowns` for single-project items (backward compat)
- Omits `projectBreakdowns` when no `projectNumber` set
- Produces `projectBreakdowns` with correct per-project phase counts
- Merges `unbalanced_workload` into aggregate health warnings

**`describe("formatMarkdown per-project")`**:
- Renders per-project section when `projectBreakdowns` present
- Omits per-project section when `projectBreakdowns` absent

**`describe("formatAscii per-project")`**:
- Renders per-project section when `projectBreakdowns` present
- Omits per-project section when `projectBreakdowns` absent

### File Ownership

| File | Owner |
|------|-------|
| `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` | GH-146 (types + functions + formatters) |
| `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts` | GH-146 (new test blocks) |

### Success Criteria

#### Automated Verification
- [x] `npm run build` passes
- [x] `npm test` passes
- [x] New `detectCrossProjectHealth` tests pass
- [x] New `buildDashboard` multi-project tests pass
- [x] New formatter tests pass

#### Manual Verification
- [x] Single-project `buildDashboard` output unchanged (no `projectBreakdowns` key)
- [x] Multi-project `buildDashboard` output includes `projectBreakdowns` with per-project phases and health
- [x] `formatMarkdown` shows per-project section only for multi-project data
- [x] `unbalanced_workload` warning surfaces when one project has > 3x active items

---

## Testing Strategy

1. **Unit tests**: Pure function tests for `detectCrossProjectHealth`, `buildDashboard` multi-project path, formatter extensions
2. **Backward compatibility**: Verify single-project mode produces identical output (no `projectBreakdowns`)
3. **Build check**: `npm run build && npm test`

## References

- [Issue #146](https://github.com/cdubiel08/ralph-hero/issues/146)
- [Research document](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0146-cross-project-aggregation-health.md)
- [Parent issue #102: Cross-project dashboard](https://github.com/cdubiel08/ralph-hero/issues/102)
- Closed siblings: [#144](https://github.com/cdubiel08/ralph-hero/issues/144) (config/cache), [#145](https://github.com/cdubiel08/ralph-hero/issues/145) (multi-project fetch), [#150](https://github.com/cdubiel08/ralph-hero/issues/150) (multi-project config), [#151](https://github.com/cdubiel08/ralph-hero/issues/151) (projectNumber override)
