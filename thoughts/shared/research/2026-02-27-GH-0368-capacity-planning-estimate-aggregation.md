---
date: 2026-02-27
github_issue: 368
github_url: https://github.com/cdubiel08/ralph-hero/issues/368
status: complete
type: research
---

# GH-368: Add Capacity Planning with Estimate Aggregation per Pipeline Stage

## Problem Statement

The `pipeline_dashboard` tool shows per-stage issue counts but not effort estimates. Users cannot assess actual capacity load — 10 XS issues in "In Progress" has very different implications than 10 L issues. Without estimate totals per stage, capacity planning is guesswork. This issue adds an `estimatePoints` field to each pipeline stage, summing the numeric weights of all issues in that stage.

## Current State Analysis

### PhaseSnapshot Interface (`dashboard.ts:44-58`)

Each pipeline stage is represented by a `PhaseSnapshot`:

```typescript
interface PhaseSnapshot {
  state: string;
  count: number;
  issues: Array<{
    number: number;
    title: string;
    estimate: string | null;  // raw string: "XS", "S", "M", "L", "XL", or null
    labels: string[];
    // ...other fields
  }>;
}
```

There is **no `estimatePoints` aggregate field**. The per-issue `estimate` string is present but never summed.

### buildSnapshot() (`dashboard.ts:247-274`)

The snapshot builder passes `estimate` strings through from `DashboardItem` into each issue record. No numeric conversion or aggregation occurs:

```typescript
// Current: passes string through, no summation
issues: items.map(item => ({
  number: item.number,
  estimate: item.estimate,  // "XS" | "S" | null — never summed
  // ...
}))
```

### Only Estimate Semantic (`dashboard.ts:159`)

The only existing estimate-to-category mapping in `dashboard.ts` is:

```typescript
const OVERSIZED_ESTIMATES = new Set(["M", "L", "XL"]);
```

This is used for flagging oversized items, not for point calculation.

### Numeric Mapping Location (`project-tools.ts:97-103`)

The only numeric interpretation of estimates in the codebase is in `ESTIMATE_OPTIONS` descriptions:
- XS = "1 point"
- S = "2 points"
- M = "3 points"
- L = "4 points"
- XL = "5 points"

This is documentation-only (in option description strings), not a reusable constant. No `ESTIMATE_POINTS` map exists anywhere in the codebase.

### formatMarkdown() (`dashboard.ts:680-712`)

Builds the pipeline table with Phase/Count/Issues columns. No estimate sum column exists. The Issues column shows issue titles with estimate tags inline.

### ralph-report Pipeline Template (`ralph-report/SKILL.md:69-75`)

The pipeline summary skill template uses `{state}` and `{count}` placeholders only. No estimate total placeholder. This would need updating if the MCP tool surfaces `estimatePoints` in its output.

### Dashboard Tests (`dashboard.test.ts`)

1,673 lines of Vitest tests. Key patterns:
- `makeItem(overrides)` helper creates test `DashboardItem` objects — supports `estimate: "XS"` etc.
- `findPhase(phases, state)` helper finds phase by state name
- Pure function tests — no mocking needed for `buildSnapshot()` or `formatMarkdown()`
- Test pattern: `expect(phase.count).toBe(N)` — would extend naturally to `expect(phase.estimatePoints).toBe(N)`

## Key Discoveries

### `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:44-58`
`PhaseSnapshot` interface — needs new `estimatePoints: number` field (sum of all issue point weights).

### `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:247-274`
`buildSnapshot()` — needs `ESTIMATE_POINTS` lookup + sum across all items in the phase.

### `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:159`
`OVERSIZED_ESTIMATES` constant — companion `ESTIMATE_POINTS` should be defined nearby (same file, same section).

### `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:680-712`
`formatMarkdown()` — needs new "Points" column in the pipeline table (between Count and Issues or after Issues).

### `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts:97-103`
Implies XS=1, S=2, M=3, L=4, XL=5 mapping — these values should become the canonical `ESTIMATE_POINTS` constant in `dashboard.ts`.

## Potential Approaches

### Option A: Add ESTIMATE_POINTS constant in dashboard.ts (Recommended)

Define a new constant alongside `OVERSIZED_ESTIMATES`:

```typescript
const ESTIMATE_POINTS: Record<string, number> = {
  XS: 1,
  S:  2,
  M:  3,
  L:  4,
  XL: 5,
};
```

Add `estimatePoints: number` to `PhaseSnapshot`. In `buildSnapshot()`, sum points:

```typescript
estimatePoints: items.reduce((sum, item) => {
  return sum + (item.estimate ? (ESTIMATE_POINTS[item.estimate] ?? 0) : 0);
}, 0)
```

Add "Points" column to `formatMarkdown()` table:

```
| Phase | Count | Points | Issues |
```

**Pros:**
- Minimal change surface — one constant + one interface field + one reduce
- Consistent with existing `OVERSIZED_ESTIMATES` pattern in same file
- Null/unknown estimates default to 0 (safe, no errors)
- Immediately testable with existing `makeItem()` helper

**Cons:**
- `ralph-report/SKILL.md` pipeline template would need updating to reference `estimatePoints` if agents use it — minor

**Files to change:** 3 (dashboard.ts, dashboard.test.ts, ralph-report/SKILL.md)

### Option B: Move ESTIMATE_POINTS to shared types.ts

Define the constant in `types.ts` for reuse across tools.

**Pros:** Single source of truth if multiple tools need point values
**Cons:** Currently only `dashboard.ts` needs it; premature generalization. `project-tools.ts` already has its own descriptions — adding a third location creates drift risk. Option A is simpler.

## Recommendation

**Option A** — Add `ESTIMATE_POINTS` constant in `dashboard.ts`, add `estimatePoints: number` to `PhaseSnapshot`, sum in `buildSnapshot()`, surface in `formatMarkdown()`. Update `ralph-report/SKILL.md` to mention estimate points in the pipeline template.

Unknown estimates (null or unrecognized strings) default to 0 points — safe behavior for issues without estimates set.

## Risks

- **Unknown estimate values**: If a project uses custom estimate labels not in XS/S/M/L/XL, they silently score 0 points. This is acceptable — the standard estimate options are enforced by `update_estimate` which only accepts the 5 standard values.
- **Snapshot size**: `estimatePoints` is a single integer per phase — negligible memory/bandwidth impact.
- **ralph-report template**: The skill template change is documentation-only; agents that already run the tool will see `estimatePoints` in tool output immediately. Template update aligns documentation with reality.

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` - Add ESTIMATE_POINTS constant, add estimatePoints to PhaseSnapshot, sum in buildSnapshot(), add Points column to formatMarkdown()
- `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts` - Add tests for estimatePoints calculation
- `plugin/ralph-hero/skills/ralph-report/SKILL.md` - Update pipeline summary template to include estimate points

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` - DashboardItem shape (estimate field)
- `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts` - ESTIMATE_OPTIONS descriptions (source of point values)
