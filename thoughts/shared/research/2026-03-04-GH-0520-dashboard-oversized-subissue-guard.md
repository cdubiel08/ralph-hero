---
date: 2026-03-04
github_issue: 520
github_url: https://github.com/cdubiel08/ralph-hero/issues/520
status: complete
type: research
---

# Dashboard: suppress oversized_in_pipeline for issues with sub-issues

## Problem Statement

The `detectHealthIssues()` function in `dashboard.ts` fires an `oversized_in_pipeline` warning for any M/L/XL issue not in Backlog/terminal state, even if the issue has already been split into sub-issues. Parent/umbrella issues legitimately have M/L/XL estimates and pass through pipeline states — they should not be flagged as "should be split" when they already have children.

## Current State Analysis

### Data Pipeline (End-to-End)

The data flow for `oversized_in_pipeline` is:

```
DASHBOARD_ITEMS_QUERY (GraphQL)
  → RawDashboardItem[]
  → toDashboardItems()
  → DashboardItem[]
  → aggregateByPhase()
  → buildSnapshot()
  → PhaseSnapshot[]
  → detectHealthIssues()  ← oversized_in_pipeline fires here
```

At no point in this pipeline is sub-issue count fetched, mapped, or made available to the check.

### Key Discoveries

**1. DASHBOARD_ITEMS_QUERY missing subIssues field**

[`plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:207-216`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts#L207-L216) — The `... on Issue` fragment fetches:

```graphql
... on Issue {
  __typename
  number
  title
  state
  updatedAt
  closedAt
  assignees(first: 5) { nodes { login } }
  repository { nameWithOwner name }
}
```

No `subIssues { totalCount }` field is present. This is the root cause — the API never returns sub-issue data.

**2. DashboardItem has no subIssueCount field**

[`plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:30-43`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L30-L43):

```typescript
export interface DashboardItem {
  number: number;
  title: string;
  updatedAt: string;
  closedAt: string | null;
  workflowState: string | null;
  priority: string | null;
  estimate: string | null;
  assignees: string[];
  blockedBy: Array<{ number: number; workflowState: string | null }>;
  projectNumber?: number;
  projectTitle?: string;
  repository?: string;
}
```

No `subIssueCount` field.

**3. PhaseSnapshot issue shape has no subIssueCount field**

[`plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:46-60`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L46-L60):

```typescript
export interface PhaseSnapshot {
  state: string;
  count: number;
  estimatePoints: number;
  issues: Array<{
    number: number;
    title: string;
    priority: string | null;
    estimate: string | null;
    assignees: string[];
    ageHours: number;
    isLocked: boolean;
    blockedBy: Array<{ number: number; workflowState: string | null }>;
  }>;
}
```

No `subIssueCount` field on the inline issue shape.

**4. detectHealthIssues() oversized check has no sub-issue guard**

[`plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:388-402`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L388-L402):

```typescript
if (
  issue.estimate &&
  OVERSIZED_ESTIMATES.has(issue.estimate) &&
  phase.state !== "Backlog" &&
  !TERMINAL_STATES.includes(phase.state) &&
  phase.state !== "Human Needed"
) {
  warnings.push({
    type: "oversized_in_pipeline",
    ...
  });
}
```

Missing: `issue.subIssueCount === 0` condition.

**5. The pattern already exists in pipeline-detection.ts**

[`plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:40`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L40) — `IssueState` has `subIssueCount: number`.

[`plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:146`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts#L146):

```typescript
const oversized = issues.filter(
  (i) => i.estimate !== null && OVERSIZED_ESTIMATES.has(i.estimate) && i.subIssueCount === 0,
);
```

This is exactly the guard that needs to be added to the dashboard health check.

**6. toDashboardItems() and buildSnapshot() are straightforward pass-throughs**

[`plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:161-191`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts#L161-L191) — `toDashboardItems()` maps raw response to `DashboardItem[]`. Adding `subIssueCount: r.content.subIssues?.totalCount ?? 0` is straightforward.

[`plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:264-295`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L264-L295) — `buildSnapshot()` directly maps each field from `DashboardItem` to the issue shape. Adding `subIssueCount: item.subIssueCount` is a one-liner.

**7. RawDashboardItem has trackedInIssues (not fetched, wrong field anyway)**

`RawDashboardItem.content` has a `trackedInIssues` field typed in TypeScript but never fetched by the GraphQL query. This is the wrong field — we want `subIssues { totalCount }` (child issues), not `trackedInIssues` (parent trackers).

**8. Existing tests need subIssueCount: 0 added**

[`plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts:571-687`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts#L571-L687) — The `oversized_in_pipeline` test fixtures create inline issue shapes without `subIssueCount`. Once added to `PhaseSnapshot.issues` type, all existing fixtures will need `subIssueCount: 0` added (or it can have a default value).

## Recommended Approach

Thread `subIssueCount` through the data pipeline and add the guard — exactly mirroring the existing `pipeline-detection.ts` pattern. This is a pure data-plumbing + guard addition with zero logic complexity.

**4 changes, all mechanical:**

1. Add `subIssues { totalCount }` to `DASHBOARD_ITEMS_QUERY` Issue fragment
2. Add `subIssueCount?: { totalCount: number }` (or `subIssues?: { totalCount: number }`) to `RawDashboardItem.content`, `DashboardItem`, and `PhaseSnapshot.issues`; map in `toDashboardItems()` and `buildSnapshot()`
3. Add `issue.subIssueCount === 0` to the `oversized_in_pipeline` conditional
4. Update tests: add `subIssueCount: 0` to existing fixtures; add new test for parent issue not flagged

**Alternative considered**: Use `trackedInIssues` already in the TypeScript type — rejected because that's the wrong relationship (trackers, not children) and it's not even fetched.

## Risks

- **Low**: GraphQL field `subIssues { totalCount }` is stable GitHub API — same field used by `ralph_hero__get_issue` via `subIssuesSummary.total`
- **Low**: TypeScript changes are additive (no breaking changes to existing consumers of `DashboardItem` or `PhaseSnapshot`)
- **Low**: Existing tests must add `subIssueCount: 0` to fixtures — if the field has a default value this is optional, but explicit is cleaner

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` - Add `subIssues { totalCount }` to DASHBOARD_ITEMS_QUERY Issue fragment; add to RawDashboardItem type; map in toDashboardItems()
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` - Add `subIssueCount: number` to DashboardItem and PhaseSnapshot issue shape; map in buildSnapshot(); add `issue.subIssueCount === 0` guard in detectHealthIssues()
- `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts` - Add `subIssueCount: 0` to existing oversized_in_pipeline test fixtures; add new test for parent/umbrella issue not flagged

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts` - Reference pattern for subIssueCount guard (line 146)
- `plugin/ralph-hero/mcp-server/src/__tests__/pipeline-detection.test.ts` - Reference test patterns for subIssueCount scenarios
