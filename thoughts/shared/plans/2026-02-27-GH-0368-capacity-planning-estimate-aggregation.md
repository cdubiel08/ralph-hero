---
date: 2026-02-27
status: draft
github_issues: [368]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/368
primary_issue: 368
---

# Add Capacity Planning with Estimate Aggregation - Implementation Plan

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-368 | Add capacity planning with estimate aggregation per pipeline stage | S |

## Current State Analysis

`pipeline_dashboard` returns per-phase issue counts but no effort aggregation. The `PhaseSnapshot` interface (`dashboard.ts:45-58`) has `count: number` and per-issue `estimate: string | null` but no `estimatePoints` sum. `buildSnapshot()` (`dashboard.ts:247-274`) passes estimate strings through without conversion. The only numeric mapping lives in `project-tools.ts:97-103` `ESTIMATE_OPTIONS` descriptions (XS=1, S=2, M=3, L=4, XL=5) but no reusable constant exists. `formatMarkdown()` (`dashboard.ts:693-712`) renders a Phase/Count/Issues table with no points column. The `ralph-report/SKILL.md` pipeline template (`lines 71-73`) uses `{state}` and `{count}` only.

## Desired End State

### Verification
- [x] Each `PhaseSnapshot` includes `estimatePoints: number` summing point values of all issues in that phase
- [x] `formatMarkdown()` output includes a "Points" column in the pipeline table
- [x] Unknown/null estimates contribute 0 points (safe default)
- [x] `ralph-report/SKILL.md` pipeline template references estimate points

## What We're NOT Doing

- Not adding a separate `ESTIMATE_POINTS` to `types.ts` or shared module (only `dashboard.ts` needs it)
- Not adding per-issue `points` field to `PhaseSnapshot.issues` (the per-issue `estimate` string already conveys this)
- Not modifying `dashboard-tools.ts` (the `DashboardItem` shape is unchanged; `estimatePoints` flows through `PhaseSnapshot`)
- Not adding velocity-in-points metrics (out of scope — velocity remains count-based)
- Not modifying `project-tools.ts` `ESTIMATE_OPTIONS` descriptions (they stay as documentation)

## Implementation Approach

Four changes in `dashboard.ts`, one test file, one skill template:
1. Add `ESTIMATE_POINTS` constant near `OVERSIZED_ESTIMATES` (line 159)
2. Add `estimatePoints` field to `PhaseSnapshot` interface (line 47)
3. Sum points in `buildSnapshot()` return object (line 259)
4. Add "Points" column to `formatMarkdown()` pipeline table (lines 693-712)
5. Add tests for the new field
6. Update `ralph-report/SKILL.md` pipeline template

---

## Phase 1: Add estimate aggregation to pipeline dashboard
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/368 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0368-capacity-planning-estimate-aggregation.md

### Changes Required

#### 1. Add `ESTIMATE_POINTS` constant
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Line**: After line 159 (after `OVERSIZED_ESTIMATES`)
**Change**: Add new constant:

```typescript
const ESTIMATE_POINTS: Record<string, number> = {
  XS: 1,
  S: 2,
  M: 3,
  L: 4,
  XL: 5,
};
```

Values match `ESTIMATE_OPTIONS` descriptions in `project-tools.ts:97-103`.

#### 2. Add `estimatePoints` to `PhaseSnapshot` interface
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Lines**: 45-58 (PhaseSnapshot interface)
**Change**: Add `estimatePoints: number` field after `count` (line 47):

```typescript
export interface PhaseSnapshot {
  state: string;
  count: number;
  estimatePoints: number;  // <-- NEW: sum of point values for all issues
  issues: Array<{
    // ... unchanged
  }>;
}
```

#### 3. Sum points in `buildSnapshot()`
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Lines**: 257-273 (return object in buildSnapshot)
**Change**: Add `estimatePoints` calculation after `count` (line 259):

```typescript
return {
  state,
  count: sorted.length,
  estimatePoints: sorted.reduce(
    (sum, item) => sum + (item.estimate ? (ESTIMATE_POINTS[item.estimate] ?? 0) : 0),
    0,
  ),
  issues: sorted.map((item) => ({
    // ... unchanged
  })),
};
```

#### 4. Add "Points" column to `formatMarkdown()` pipeline table
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Lines**: 693-694 (table header), 712 (data row)
**Change**: Update header and data rows:

Replace header (lines 693-694):
```typescript
  lines.push("| Phase | Count | Issues |");
  lines.push("|-------|------:|--------|");
```

With:
```typescript
  lines.push("| Phase | Count | Points | Issues |");
  lines.push("|-------|------:|-------:|--------|");
```

Replace data row push (line 712):
```typescript
    lines.push(`| ${phase.state} | ${phase.count} | ${truncated} |`);
```

With:
```typescript
    lines.push(`| ${phase.state} | ${phase.count} | ${phase.estimatePoints} | ${truncated} |`);
```

#### 5. Add tests for `estimatePoints`
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts`
**Location**: Inside or after the `describe("buildDashboard", ...)` block (lines 921-994)
**Change**: Add test cases using existing `makeItem()` helper (lines 36-49) and `findPhase()` helper (lines 51-55):

```typescript
describe("estimatePoints aggregation", () => {
  it("sums estimate points per phase", () => {
    const items = [
      makeItem({ number: 1, workflowState: "In Progress", estimate: "XS" }),
      makeItem({ number: 2, workflowState: "In Progress", estimate: "S" }),
      makeItem({ number: 3, workflowState: "In Progress", estimate: "M" }),
    ];
    const data = buildDashboard(items, DEFAULT_HEALTH_CONFIG, NOW);
    const phase = findPhase(data.phases, "In Progress");
    expect(phase.estimatePoints).toBe(6); // 1 + 2 + 3
  });

  it("treats null estimates as 0 points", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog", estimate: "S" }),
      makeItem({ number: 2, workflowState: "Backlog", estimate: null }),
    ];
    const data = buildDashboard(items, DEFAULT_HEALTH_CONFIG, NOW);
    const phase = findPhase(data.phases, "Backlog");
    expect(phase.estimatePoints).toBe(2); // 2 + 0
  });

  it("returns 0 points for empty phase", () => {
    const data = buildDashboard([], DEFAULT_HEALTH_CONFIG, NOW);
    for (const phase of data.phases) {
      expect(phase.estimatePoints).toBe(0);
    }
  });

  it("sums all estimate sizes correctly", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Backlog", estimate: "XS" }),
      makeItem({ number: 2, workflowState: "Backlog", estimate: "S" }),
      makeItem({ number: 3, workflowState: "Backlog", estimate: "M" }),
      makeItem({ number: 4, workflowState: "Backlog", estimate: "L" }),
      makeItem({ number: 5, workflowState: "Backlog", estimate: "XL" }),
    ];
    const data = buildDashboard(items, DEFAULT_HEALTH_CONFIG, NOW);
    const phase = findPhase(data.phases, "Backlog");
    expect(phase.estimatePoints).toBe(15); // 1+2+3+4+5
  });
});
```

Also update existing `formatMarkdown` tests that assert on table output to include the new "Points" column. The test at lines 758-833 (`describe("formatMarkdown", ...)`) will need its expected table header and row assertions updated from `| Phase | Count | Issues |` to `| Phase | Count | Points | Issues |`.

#### 6. Update `ralph-report/SKILL.md` pipeline template
**File**: `plugin/ralph-hero/skills/ralph-report/SKILL.md`
**Lines**: 71-73 (pipeline summary table template)
**Change**: Add Points column to template:

Replace:
```markdown
| Phase | Count |
|-------|------:|
| {state} | {count} |
```

With:
```markdown
| Phase | Count | Points |
|-------|------:|-------:|
| {state} | {count} | {estimatePoints} |
```

### File Ownership Summary

| File | Action |
|------|--------|
| `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` | MODIFY (add constant at ~160, add field to interface at ~47, add sum in buildSnapshot at ~259, add column in formatMarkdown at ~693-712) |
| `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts` | MODIFY (add estimatePoints test cases, update formatMarkdown assertions) |
| `plugin/ralph-hero/skills/ralph-report/SKILL.md` | MODIFY (lines 71-73: add Points column to template) |

### Success Criteria

- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes
- [x] Automated: `grep -q "estimatePoints" plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` exits 0
- [x] Automated: `grep -q "ESTIMATE_POINTS" plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` exits 0
- [x] Automated: `grep -q "Points" plugin/ralph-hero/skills/ralph-report/SKILL.md` exits 0
- [x] Manual: `PhaseSnapshot` interface includes `estimatePoints: number` field
- [x] Manual: `buildSnapshot()` sums points using `ESTIMATE_POINTS` mapping
- [x] Manual: `formatMarkdown()` pipeline table includes "Points" column
- [x] Manual: Null/unknown estimates contribute 0 points (no errors)

## Integration Testing

- [x] Run `npm test` in `plugin/ralph-hero/mcp-server/` — all existing + new tests pass
- [x] Verify `formatMarkdown()` output includes Points column with correct alignment
- [x] Verify `buildDashboard()` end-to-end test includes `estimatePoints` in phase snapshots

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0368-capacity-planning-estimate-aggregation.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/368
- Pattern reference: `OVERSIZED_ESTIMATES` constant at `dashboard.ts:159`
- Point values source: `ESTIMATE_OPTIONS` in `project-tools.ts:97-103`
