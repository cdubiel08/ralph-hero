---
date: 2026-02-21
status: draft
github_issues: [278]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/278
primary_issue: 278
---

# Fix `fieldCache` calls ignoring `projectNumber` override - Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-278 | bug: `update_project` ignores `projectNumber` parameter, always targets default project | S |

## Current State Analysis

All `FieldOptionCache` methods (`getProjectId`, `getFieldId`, `resolveOptionId`, `getOptionNames`, `getFieldNames`) accept an optional `projectNumber` parameter. When omitted, they fall back to `defaultProjectNumber` (the first project ever cached). The bug is that ~40+ call sites across 8 files never pass `projectNumber`, causing all tools to silently operate on the default project regardless of the `projectNumber` override.

The `FieldOptionCache` API is correct. The `resolveFullConfig()` helper correctly resolves `projectNumber` from args. The shared helpers (`resolveProjectItemId`, `updateProjectItemField`, `getCurrentFieldValue`, `syncStatusField`) don't accept a `projectNumber` parameter in their signatures, so they can't thread it to their internal `fieldCache` calls.

The one file that already does this correctly is `dashboard-tools.ts` (line 359: `fieldCache.getProjectId(pn)`).

## Desired End State
### Verification
- [x] All `fieldCache` method calls pass `projectNumber` explicitly
- [x] Shared helpers in `lib/helpers.ts` accept and thread `projectNumber`
- [x] `update_project(projectNumber: 5)` resolves to project #5, not the default
- [x] All existing tests pass
- [x] New test verifies `fieldCache` calls receive `projectNumber` for a non-default project

## What We're NOT Doing
- Not changing the `FieldOptionCache` class itself (its API is already correct)
- Not changing `resolveFullConfig()` (it already resolves `projectNumber` correctly)
- Not adding a lint rule (that can be a follow-up)
- Not adding integration tests against live GitHub API

## Implementation Approach

The fix follows a bottom-up strategy: first update the shared helpers in `lib/helpers.ts` to accept `projectNumber`, then update all tool-layer callers to pass `projectNumber` through. Each call site is a mechanical 1-line change. The volume (~40 sites) is the main risk, mitigated by grep-based verification.

---

## Phase 1: GH-278 - Thread `projectNumber` through all `fieldCache` method calls
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/278 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0278-update-project-ignores-project-number.md

### Changes Required

#### 1. Update shared helper signatures in `lib/helpers.ts`

**File**: `plugin/ralph-hero/mcp-server/src/lib/helpers.ts`

**Changes**:

a) `resolveProjectItemId` (line 154): Add `projectNumber?: number` parameter. Pass to `fieldCache.getProjectId(projectNumber)` on line 161.

```typescript
// Before:
export async function resolveProjectItemId(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<string> {
  const projectId = fieldCache.getProjectId();

// After:
export async function resolveProjectItemId(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  repo: string,
  issueNumber: number,
  projectNumber?: number,
): Promise<string> {
  const projectId = fieldCache.getProjectId(projectNumber);
```

b) `updateProjectItemField` (line 223): Add `projectNumber?: number` parameter. Pass to all 3 `fieldCache` calls (lines 230, 235, 240, 242).

```typescript
// Before:
export async function updateProjectItemField(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  projectItemId: string,
  fieldName: string,
  optionName: string,
): Promise<void> {
  const projectId = fieldCache.getProjectId();
  ...
  const fieldId = fieldCache.getFieldId(fieldName);
  ...
  const optionId = fieldCache.resolveOptionId(fieldName, optionName);
  ...
  const validOptions = fieldCache.getOptionNames(fieldName);

// After:
export async function updateProjectItemField(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  projectItemId: string,
  fieldName: string,
  optionName: string,
  projectNumber?: number,
): Promise<void> {
  const projectId = fieldCache.getProjectId(projectNumber);
  ...
  const fieldId = fieldCache.getFieldId(fieldName, projectNumber);
  ...
  const optionId = fieldCache.resolveOptionId(fieldName, optionName, projectNumber);
  ...
  const validOptions = fieldCache.getOptionNames(fieldName, projectNumber);
```

c) `getCurrentFieldValue` (line 268): Add `projectNumber?: number` parameter. Pass to `resolveProjectItemId` call on line 276.

```typescript
// Before:
export async function getCurrentFieldValue(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  repo: string,
  issueNumber: number,
  fieldName: string,
): Promise<string | undefined> {
  const projectItemId = await resolveProjectItemId(
    client, fieldCache, owner, repo, issueNumber,
  );

// After:
export async function getCurrentFieldValue(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  repo: string,
  issueNumber: number,
  fieldName: string,
  projectNumber?: number,
): Promise<string | undefined> {
  const projectItemId = await resolveProjectItemId(
    client, fieldCache, owner, repo, issueNumber, projectNumber,
  );
```

d) `syncStatusField` (line 507): Add `projectNumber?: number` parameter. Pass to `fieldCache.getFieldId`, `fieldCache.resolveOptionId`, and `updateProjectItemField` calls (lines 516, 519, 523).

```typescript
// Before:
export async function syncStatusField(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  projectItemId: string,
  workflowState: string,
): Promise<void> {
  ...
  const statusFieldId = fieldCache.getFieldId("Status");
  const statusOptionId = fieldCache.resolveOptionId("Status", targetStatus);
  ...
  await updateProjectItemField(client, fieldCache, projectItemId, "Status", targetStatus);

// After:
export async function syncStatusField(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  projectItemId: string,
  workflowState: string,
  projectNumber?: number,
): Promise<void> {
  ...
  const statusFieldId = fieldCache.getFieldId("Status", projectNumber);
  const statusOptionId = fieldCache.resolveOptionId("Status", targetStatus, projectNumber);
  ...
  await updateProjectItemField(client, fieldCache, projectItemId, "Status", targetStatus, projectNumber);
```

#### 2. Update `project-management-tools.ts` (19 call sites)

**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`

**Changes**: Every tool handler already calls `resolveFullConfig()` which returns `projectNumber`. Thread it to all `fieldCache.*()`, `resolveProjectItemId()`, and `updateProjectItemField()` calls. The pattern is:

```typescript
// Before (repeated ~19 times across the file):
const projectId = fieldCache.getProjectId();

// After:
const projectId = fieldCache.getProjectId(projectNumber);
```

Specific call sites (line numbers from research):
- `archive_item`: line 65 (`getProjectId`), line 70 (`resolveProjectItemId`)
- `remove_from_project`: line 138 (`getProjectId`), line 143 (`resolveProjectItemId`)
- `add_to_project`: line 201 (`getProjectId`)
- `link_repository`: line 274 (`getProjectId`)
- `clear_field`: line 369 (`getProjectId`), line 374 (`getFieldId`), line 376 (`getFieldNames`), line 383 (`resolveProjectItemId`)
- `create_draft_issue`: line 442 (`getProjectId`), line 468/472/476 (`updateProjectItemField`)
- `reorder_item`: line 572 (`getProjectId`), line 577/587 (`resolveProjectItemId`)
- `update_project`: line 686 (`getProjectId`)
- `delete_field`: line 747 (`getProjectId`), line 752 (`getFieldId`), line 754 (`getFieldNames`)
- `update_collaborators`: line 831 (`getProjectId`)
- `create_status_update`: line 949 (`getProjectId`)
- `bulk_archive`: line 1199 (`getProjectId`)
- `link_team`: line 1367 (`getProjectId`)

#### 3. Update `issue-tools.ts` (15+ call sites)

**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`

**Changes**: Thread `projectNumber` from `resolveFullConfig()` to all `fieldCache.*()`, `resolveProjectItemId()`, `updateProjectItemField()`, `getCurrentFieldValue()`, and `syncStatusField()` calls.

Key call sites:
- Line 185: `fieldCache.getProjectId()` → `fieldCache.getProjectId(projectNumber)`
- Line 854: `fieldCache.getProjectId()` → `fieldCache.getProjectId(projectNumber)`
- Line 890, 900, 910: `updateProjectItemField(...)` → add `projectNumber` as last arg
- Line 1096: `getCurrentFieldValue(...)` → add `projectNumber` as last arg
- Line 1106: `resolveProjectItemId(...)` → add `projectNumber` as last arg
- Line 1115: `updateProjectItemField(...)` → add `projectNumber` as last arg
- Line 1124: `syncStatusField(...)` → add `projectNumber` as last arg
- Line 1174: `resolveProjectItemId(...)` → add `projectNumber` as last arg
- Line 1182: `updateProjectItemField(...)` → add `projectNumber` as last arg
- Line 1230: `resolveProjectItemId(...)` → add `projectNumber` as last arg
- Line 1238: `updateProjectItemField(...)` → add `projectNumber` as last arg
- Line 1621: `fieldCache.getProjectId()` → `fieldCache.getProjectId(projectNumber)`
- Line 1868: `resolveProjectItemId(...)` → add `projectNumber` as last arg

#### 4. Update `batch-tools.ts` (7 call sites)

**File**: `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts`

**Changes**: Thread `projectNumber` to all `fieldCache.*()` calls:
- Line 279: `fieldCache.getProjectId()` → `fieldCache.getProjectId(projectNumber)`
- Line 287: `fieldCache.resolveOptionId(...)` → add `projectNumber` as last arg
- Line 289: `fieldCache.getOptionNames(...)` → add `projectNumber` as last arg
- Line 443: `fieldCache.getFieldId(...)` → add `projectNumber` as last arg
- Line 444: `fieldCache.resolveOptionId(...)` → add `projectNumber` as last arg
- Line 460: `fieldCache.getFieldId("Status")` → `fieldCache.getFieldId("Status", projectNumber)`
- Line 462: `fieldCache.resolveOptionId("Status", targetStatus)` → add `projectNumber`

#### 5. Update `project-tools.ts` (1 call site)

**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`

**Changes**:
- Line 886: `fieldCache.getProjectId()` → `fieldCache.getProjectId(projectNumber)`

#### 6. Update `view-tools.ts` (2 call sites)

**File**: `plugin/ralph-hero/mcp-server/src/tools/view-tools.ts`

**Changes**:
- Line 138: `fieldCache.getFieldId(args.fieldName)` → `fieldCache.getFieldId(args.fieldName, projectNumber)`
- Line 141: `fieldCache.getFieldNames()` → `fieldCache.getFieldNames(projectNumber)`

#### 7. Update `hygiene-tools.ts` (1 call site)

**File**: `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts`

**Changes**:
- Line 98: `fieldCache.getProjectId()` → `fieldCache.getProjectId(projectNumber)`

#### 8. Update `relationship-tools.ts` (8 call sites)

**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`

**Changes**: Thread `projectNumber` to all helper calls:
- Line 721: `getCurrentFieldValue(...)` → add `projectNumber` as last arg
- Line 753: `resolveProjectItemId(...)` → add `projectNumber` as last arg
- Line 760: `updateProjectItemField(...)` → add `projectNumber` as last arg
- Line 769: `syncStatusField(...)` → add `projectNumber` as last arg
- Line 929: `getCurrentFieldValue(...)` → add `projectNumber` as last arg
- Line 983: `getCurrentFieldValue(...)` → add `projectNumber` as last arg
- Line 1009: `resolveProjectItemId(...)` → add `projectNumber` as last arg
- Line 1016: `updateProjectItemField(...)` → add `projectNumber` as last arg
- Line 1023: `syncStatusField(...)` → add `projectNumber` as last arg

#### 9. Update `routing-tools.ts` (2 call sites)

**File**: `plugin/ralph-hero/mcp-server/src/tools/routing-tools.ts`

**Changes**: The `validate_rules` case (line 145-152) uses `client.config.projectNumber` directly. Thread it to the `fieldCache` calls:
- Line 159: `fieldCache.resolveOptionId("Workflow State", ...)` → add `projectNumber` as last arg
- Line 164: `fieldCache.getOptionNames("Workflow State")` → add `projectNumber` as last arg

#### 10. Update `lib/routing-config.ts` (2 call sites)

**File**: `plugin/ralph-hero/mcp-server/src/lib/routing-config.ts`

**Changes**: The `validateRulesLive` function accepts a `fieldCache` but no `projectNumber`. Add `projectNumber?: number` to its signature and thread to:
- Line 111: `fieldCache.resolveOptionId("Workflow State", ...)` → add `projectNumber`
- Line 116: `fieldCache.getOptionNames("Workflow State")` → add `projectNumber`

Then update the caller in `routing-tools.ts` to pass `projectNumber`.

#### 11. Add targeted test

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-number-override.test.ts`

**Changes**: Add a new test section that verifies the `FieldOptionCache` is called with `projectNumber` in a multi-project scenario. Since the cache class itself is already tested, this test should verify the pattern:

```typescript
describe("fieldCache calls with projectNumber", () => {
  it("getProjectId returns correct project when projectNumber is passed", () => {
    const cache = new FieldOptionCache();
    // Populate two projects
    cache.populate(3, "PVT_3", [{ id: "F1", name: "Status", options: [{ id: "O1", name: "Todo" }] }]);
    cache.populate(5, "PVT_5", [{ id: "F2", name: "Status", options: [{ id: "O2", name: "Done" }] }]);

    // Without projectNumber: returns default (first populated = #3)
    expect(cache.getProjectId()).toBe("PVT_3");
    // With projectNumber: returns correct project
    expect(cache.getProjectId(5)).toBe("PVT_5");
    expect(cache.getProjectId(3)).toBe("PVT_3");
  });

  it("getFieldId returns correct field for non-default project", () => {
    const cache = new FieldOptionCache();
    cache.populate(3, "PVT_3", [{ id: "F1_3", name: "Status", options: [] }]);
    cache.populate(5, "PVT_5", [{ id: "F1_5", name: "Status", options: [] }]);

    expect(cache.getFieldId("Status")).toBe("F1_3"); // default
    expect(cache.getFieldId("Status", 5)).toBe("F1_5");
  });
});
```

### Success Criteria
- [x] Automated: `npm test` passes with all existing + new tests
- [x] Automated: `grep -r 'fieldCache\.\(getProjectId\|getFieldId\|resolveOptionId\|getOptionNames\|getFieldNames\)()' src/` returns 0 matches (no bare calls remain)
- [ ] Manual: Verify `update_project(projectNumber: N)` resolves to the correct project in the response

---

## Integration Testing
- [x] All existing tests pass (`npm test`)
- [x] Grep audit confirms zero bare `fieldCache.*()` calls remain in `src/` (excluding `__tests__/`)
- [x] Build succeeds (`npm run build`)

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0278-update-project-ignores-project-number.md
- Related: GH-151 (projectNumber override parameter was added to schemas but not threaded to fieldCache calls)
- Correct example: `dashboard-tools.ts` line 359 — `fieldCache.getProjectId(pn)`
