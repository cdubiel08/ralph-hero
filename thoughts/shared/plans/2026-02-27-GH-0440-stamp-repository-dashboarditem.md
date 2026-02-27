---
date: 2026-02-27
status: draft
github_issues: [440]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/440
primary_issue: 440
---

# Stamp Repository Field on DashboardItem via GraphQL Query Update - Implementation Plan

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-440 | Stamp repository field on DashboardItem via GraphQL query update | S |

## Current State Analysis

`DashboardItem` interface at `dashboard.ts:30-42` has 9 required fields and 2 optional fields (`projectNumber?`, `projectTitle?`). No repository data exists. `DASHBOARD_ITEMS_QUERY` at `dashboard-tools.ts:205-213` fetches `__typename`, `number`, `title`, `state`, `updatedAt`, `closedAt`, `assignees` for Issues but no `repository`. `RawDashboardItem.content` at `dashboard-tools.ts:121-141` mirrors this — no `repository` field. `toDashboardItems()` at `dashboard-tools.ts:160-189` stamps optional fields via conditional spread at lines 183-184. Test coverage via `describe("toDashboardItems", ...)` at `dashboard.test.ts:1264` uses `makeRawItem()` helper at lines 1238-1262.

## Desired End State

### Verification
- [x] `DashboardItem` has `repository?: string` field in `nameWithOwner` format
- [x] `DASHBOARD_ITEMS_QUERY` fetches `repository { nameWithOwner name }` for Issue type
- [x] `toDashboardItems()` stamps `repository` when present using conditional spread
- [x] All existing dashboard tests still pass (field is optional)
- [x] New test verifies repository stamping from raw item

## What We're NOT Doing

- Not adding `repoBreakdowns` aggregation (sibling issue #441)
- Not modifying `formatMarkdown()` output — repository is data-layer only in this issue
- Not adding repository to `PullRequest` or `DraftIssue` fragments (filtered out by `toDashboardItems()`)
- Not modifying `makeItem()` test helper — downstream tests don't need repository
- Not modifying `buildDashboard()` — it passes `DashboardItem[]` through unchanged

## Implementation Approach

Four changes in 2 source files, plus 1 test file:
1. Add `repository?: string` to `DashboardItem` interface
2. Add `repository` to `RawDashboardItem.content` type
3. Add `repository { nameWithOwner name }` to `DASHBOARD_ITEMS_QUERY` Issue fragment
4. Stamp `repository` via conditional spread in `toDashboardItems()`
5. Add test case in `describe("toDashboardItems", ...)`

---

## Phase 1: Stamp repository field on DashboardItem
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/440 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0440-stamp-repository-dashboarditem.md

### Changes Required

#### 1. Add `repository?: string` to `DashboardItem` interface
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Location**: After `projectTitle?: string` (line 42, inside the interface)
**Change**: Add new optional field:

```typescript
  projectTitle?: string;     // existing
  repository?: string;       // NEW: "owner/repo" nameWithOwner format
}
```

#### 2. Add `repository` to `RawDashboardItem.content` type
**File**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`
**Location**: Inside `content` type (after `trackedInIssues` at ~line 132)
**Change**: Add optional repository field to the content union:

```typescript
    trackedInIssues?: { nodes: Array<{ number: number; state: string }> };
    repository?: { nameWithOwner: string; name: string } | null;  // NEW
```

#### 3. Add `repository` to `DASHBOARD_ITEMS_QUERY` Issue fragment
**File**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`
**Location**: Inside `... on Issue` fragment (after `assignees(first: 5) { nodes { login } }` at ~line 213)
**Change**: Add repository fetch (follows pattern from `issue-tools.ts:221`):

```graphql
              assignees(first: 5) { nodes { login } }
              repository { nameWithOwner name }
```

#### 4. Stamp `repository` in `toDashboardItems()` via conditional spread
**File**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`
**Location**: After `projectTitle` spread (line 184), inside the `items.push({...})` block
**Change**: Add one new conditional spread line:

```typescript
      ...(projectNumber !== undefined ? { projectNumber } : {}),
      ...(projectTitle !== undefined ? { projectTitle } : {}),
      ...(r.content.repository ? { repository: r.content.repository.nameWithOwner } : {}),
```

This follows the exact same pattern as `projectNumber`/`projectTitle` but reads from `r.content.repository` (the raw GraphQL response) instead of a function argument.

#### 5. Add test case for repository stamping
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts`
**Location**: Inside `describe("toDashboardItems", ...)` block (after line ~1285, after existing test cases)
**Change**: Add two test cases using the existing `makeRawItem()` helper:

```typescript
  it("stamps repository from content when present", () => {
    const raw = [
      makeRawItem({
        content: {
          ...makeRawItem().content,
          repository: { nameWithOwner: "owner/my-repo", name: "my-repo" },
        },
      }),
    ];
    const items = toDashboardItems(raw);
    expect(items[0].repository).toBe("owner/my-repo");
  });

  it("omits repository when content.repository is null", () => {
    const raw = [makeRawItem()];
    const items = toDashboardItems(raw);
    expect(items[0].repository).toBeUndefined();
  });
```

The first test verifies that `repository` is stamped as `nameWithOwner` string. The second verifies that when the raw item has no `repository` (default `makeRawItem()`), the field is absent from the result.

### File Ownership Summary

| File | Action |
|------|--------|
| `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` | MODIFY (add `repository?: string` to `DashboardItem` interface after line 42) |
| `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` | MODIFY (add to `RawDashboardItem.content` at ~132, add to `DASHBOARD_ITEMS_QUERY` at ~213, add spread at ~184) |
| `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts` | MODIFY (add 2 test cases in `describe("toDashboardItems", ...)` block after ~1285) |

### Success Criteria

- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes
- [x] Automated: `grep -q "repository?: string" plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` exits 0
- [x] Automated: `grep -q "repository { nameWithOwner name }" plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` exits 0
- [x] Automated: `grep -q "r.content.repository" plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` exits 0
- [x] Manual: `DashboardItem` interface has `repository?: string` after `projectTitle`
- [x] Manual: `toDashboardItems()` stamps `repository` using same conditional spread pattern as `projectNumber`/`projectTitle`
- [x] Manual: `DASHBOARD_ITEMS_QUERY` fetches `repository { nameWithOwner name }` only in Issue fragment (not PR/DraftIssue)
- [x] Manual: Existing `makeItem()` helper tests unmodified — all downstream tests pass unchanged

## Integration Testing

- [x] Run full test suite: `cd plugin/ralph-hero/mcp-server && npm test`
- [x] Verify existing `toDashboardItems` tests still pass (projectNumber, projectTitle, non-Issue filtering)
- [x] Verify new tests cover: repository present → stamped as nameWithOwner, repository absent → undefined
- [x] Verify `buildDashboard` and `formatMarkdown` tests still pass (repository is optional, no behavior change)

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0440-stamp-repository-dashboarditem.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/440
- Parent: https://github.com/cdubiel08/ralph-hero/issues/430
- Sibling: https://github.com/cdubiel08/ralph-hero/issues/441 (depends on this issue)
- Pattern reference: `toDashboardItems()` spread at `dashboard-tools.ts:183-184`, `repository` fetch at `issue-tools.ts:221`
