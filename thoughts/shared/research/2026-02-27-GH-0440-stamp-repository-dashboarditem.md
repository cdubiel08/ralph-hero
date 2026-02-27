---
date: 2026-02-27
github_issue: 440
github_url: https://github.com/cdubiel08/ralph-hero/issues/440
status: complete
type: research
---

# GH-440: Stamp Repository Field on DashboardItem via GraphQL Query Update

## Problem Statement

`pipeline_dashboard` fetches no repository data for project items. For multi-repo enterprise projects, each `DashboardItem` has no way to identify which repository the issue belongs to. This prevents repo-level grouping in the dashboard (sibling issue #441). This issue adds `repository { nameWithOwner }` to the dashboard GraphQL query and stamps `repository?: string` on each `DashboardItem` — the foundational data layer for repo grouping.

## Current State Analysis

### `DashboardItem` Interface (`dashboard.ts:30-42`)

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
  projectNumber?: number;    // optional — only set in multi-project mode
  projectTitle?: string;     // optional — only set in multi-project mode
}
```

No `repository` field exists. `projectNumber` and `projectTitle` are the existing optional fields — they use the `?` pattern and are stamped with conditional spread in `toDashboardItems()`.

### `RawDashboardItem` Type (`dashboard-tools.ts:121-141`)

```typescript
export interface RawDashboardItem {
  id: string;
  type: string;
  content: {
    __typename?: string;
    number?: number;
    title?: string;
    state?: string;
    updatedAt?: string;
    closedAt?: string | null;
    assignees?: { nodes: Array<{ login: string }> };
    trackedInIssues?: { nodes: Array<{ number: number; state: string }> };
  } | null;
  fieldValues: { nodes: Array<{ ... }> };
}
```

No `repository` field in `content`. This needs `repository?: { nameWithOwner: string; name: string } | null` added to the `content` shape.

### `DASHBOARD_ITEMS_QUERY` Issue Fragment (`dashboard-tools.ts:205-213`)

```graphql
... on Issue {
  __typename
  number
  title
  state
  updatedAt
  closedAt
  assignees(first: 5) { nodes { login } }
}
```

No `repository` field. Needs `repository { nameWithOwner name }` added (7 fields currently, becomes 8).

### `toDashboardItems()` Function (`dashboard-tools.ts:160-189`)

```typescript
items.push({
  number: r.content.number,
  title: r.content.title ?? "(untitled)",
  updatedAt: r.content.updatedAt ?? new Date(0).toISOString(),
  closedAt: r.content.closedAt ?? null,
  workflowState: getFieldValue(r, "Workflow State"),
  priority: getFieldValue(r, "Priority"),
  estimate: getFieldValue(r, "Estimate"),
  assignees: r.content.assignees?.nodes?.map((a) => a.login) ?? [],
  blockedBy: [],
  ...(projectNumber !== undefined ? { projectNumber } : {}),
  ...(projectTitle !== undefined ? { projectTitle } : {}),
});
```

The conditional spread pattern at lines 183-184 is the established way to stamp optional fields. The `repository` field follows the same pattern but draws from `r.content.repository` (part of the raw item) rather than a function argument.

### Repository Pattern in `issue-tools.ts` (`issue-tools.ts:221`)

```graphql
repository { name nameWithOwner }
```

This is the established pattern for fetching repository identity on Issue objects. `nameWithOwner` gives the canonical `owner/repo` format (e.g., `cdubiel08/ralph-hero`). Both `name` (short) and `nameWithOwner` (full) are fetched in `issue-tools.ts`; for the dashboard we only need `nameWithOwner` as `DashboardItem.repository`.

### Test Coverage (`dashboard.test.ts:1238-1301`)

The `describe("toDashboardItems", ...)` block at line 1264 has 4 test cases using the `makeRawItem()` helper (lines 1238-1262). `makeRawItem` builds `RawDashboardItem` objects with:
- `content.__typename: "Issue"`
- No `repository` field currently

The 4 existing tests cover:
- `projectNumber` stamped when argument passed
- `projectNumber` absent when argument omitted
- `projectTitle` stamped when argument passed
- Non-Issue items (`PullRequest`, `DraftIssue`) filtered out

A 5th test case is needed: verify `repository` is stamped as `nameWithOwner` when `content.repository` is present, and absent when `content.repository` is null.

The broader `makeItem()` helper (lines 36-49) used by `buildDashboard`, `formatMarkdown`, etc. tests doesn't set `repository` — since it's optional, all existing downstream tests continue to pass without modification.

## Key Discoveries

### `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:30-42`
`DashboardItem` interface — needs `repository?: string` added after `projectTitle?: string`. Field stores `nameWithOwner` format (`"owner/repo"`).

### `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:121-141`
`RawDashboardItem.content` — needs `repository?: { nameWithOwner: string; name: string } | null` added. This TypeScript type mirrors the GraphQL response shape.

### `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:205-213`
`DASHBOARD_ITEMS_QUERY` Issue fragment — needs `repository { nameWithOwner name }` added. Pattern comes directly from `issue-tools.ts:221`.

### `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:183-184`
`toDashboardItems()` spread lines — add one new spread line:
```typescript
...(r.content.repository ? { repository: r.content.repository.nameWithOwner } : {}),
```
Unlike `projectNumber`/`projectTitle` (function args), `repository` comes from `r.content.repository` (the raw item). The condition checks truthiness (null/undefined both handled).

### `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts:1238-1262`
`makeRawItem()` — can accept optional `repository` override to test stamping. Extend to support `content.repository` via overrides, add 1 new test case.

## Potential Approaches

### Option A: Minimal — Add to Issue fragment only (Recommended)

Add `repository { nameWithOwner name }` only to the `... on Issue` fragment in `DASHBOARD_ITEMS_QUERY`. The `... on PullRequest` and `... on DraftIssue` fragments are left unchanged (and `toDashboardItems()` already filters those out anyway).

**Pros:**
- Minimal GraphQL payload increase (1 nested object per issue)
- Follows established `issue-tools.ts` pattern exactly
- TypeScript change is confined to `RawDashboardItem.content` (which already covers all types in one interface)
- `toDashboardItems()` guard `r.content.__typename !== "Issue"` ensures only Issues reach the spread; no defensive `??` needed for PR/DraftIssue shapes

**Cons:**
- None identified

### Option B: Add to all content types

Add `repository` to Issue, PullRequest, and DraftIssue fragments.

**Pros:** More complete data
**Cons:** DraftIssues don't have a repository in GitHub's schema (they're draft-only). PRs have `repository` but the dashboard filters PRs out in `toDashboardItems()`. Unnecessary complexity.

## Recommendation

**Option A** — Add `repository { nameWithOwner name }` to the Issue fragment only. Four targeted changes: interface, type, query, mapper. One new test. This is a pure data plumbing change with no behavior change for existing callers.

## Risks

- **Existing tests unaffected**: `makeRawItem()` doesn't set `repository` on `content` — since the new spread is conditional (`r.content.repository ? ...`), items without `repository` get `undefined` for the field (absent from object), not `"undefined"` string. No existing assertion breaks.
- **GraphQL cost**: Adds one `repository` object per Issue item in the dashboard. Negligible — `repository` is a single scalar-bearing object, not a paginated list.
- **`nameWithOwner` is always present for Issues**: GitHub guarantees Issues always belong to a repository. `content.repository` being null is only theoretically possible for non-Issue types (which are already filtered). The conditional spread is defensive but practically always true for dashboard items.
- **Downstream (#441)**: The `repository?: string` field on `DashboardItem` is the exact input `repoBreakdowns` aggregation in #441 needs. The optional type `string | undefined` means #441 must handle undefined (item belongs to unknown repo) gracefully.

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` - Add `repository?: string` to `DashboardItem` interface
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` - Add `repository` to `RawDashboardItem.content`, add to `DASHBOARD_ITEMS_QUERY` Issue fragment, stamp in `toDashboardItems()`
- `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts` - Add `repository` test case to `describe("toDashboardItems", ...)`

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` - `repository { nameWithOwner name }` fetch pattern at line 221
