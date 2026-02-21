---
date: 2026-02-21
github_issue: 278
github_url: https://github.com/cdubiel08/ralph-hero/issues/278
status: complete
type: research
---

# GH-278: `update_project` ignores `projectNumber` parameter

## Problem Statement

When calling `update_project(projectNumber: 5, closed: true)`, the tool always operates on the default project (e.g., #3) instead of the specified project (#5). This caused the wrong project to be closed during a real usage scenario.

## Root Cause

The bug is in how `FieldOptionCache.getProjectId()` is called throughout the codebase. The call chain in `update_project` (and most other tools) is:

1. `resolveFullConfig(client, args)` correctly resolves `projectNumber` from args (e.g., `5`)
2. `ensureFieldCache(client, fieldCache, projectOwner, projectNumber)` correctly populates the cache **keyed by project number 5**
3. `fieldCache.getProjectId()` is called **without passing the project number**

The problem is in `FieldOptionCache.resolveEntry()` (`/home/chad_a_dubiel/projects/ralph-hero/plugin/ralph-hero/mcp-server/src/lib/cache.ts`, lines 222-232):

```typescript
private resolveEntry(projectNumber?: number): ProjectCacheData | undefined {
  if (projectNumber !== undefined) {
    return this.projects.get(projectNumber);
  }
  if (this.defaultProjectNumber !== undefined) {
    return this.projects.get(this.defaultProjectNumber);
  }
  return undefined;
}
```

When `projectNumber` is not passed, it falls back to `this.defaultProjectNumber` -- the **first** project ever populated into the cache. If the default project (#3) was cached first (e.g., by any earlier tool call), then `getProjectId()` always returns project #3's ID, regardless of which project was just cached by `ensureFieldCache`.

## Scope of Impact

This bug affects **every tool** that calls `fieldCache.getProjectId()` without passing `projectNumber`. Searching the codebase reveals the following affected call sites:

### `project-management-tools.ts` (14 calls, all missing `projectNumber`):
- `archive_item` (line 65)
- `remove_from_project` (line 138)
- `add_to_project` (line 201)
- `link_repository` (line 274)
- `clear_field` (line 369)
- `create_draft_issue` (line 442)
- `reorder_item` (line 572)
- **`update_project` (line 686)** -- the reported bug
- `delete_field` (line 747)
- `update_collaborators` (line 831)
- `create_status_update` (line 949)
- `bulk_archive` (line 1199)
- `link_team` (line 1367)

### Other files (also missing `projectNumber`):
- `issue-tools.ts` (lines 185, 854, 1621)
- `project-tools.ts` (line 886)
- `batch-tools.ts` (line 279)
- `hygiene-tools.ts` (line 98)
- `lib/helpers.ts` (lines 161, 230) -- `resolveProjectItemId` and `updateProjectItemField`

### Already correct:
- `dashboard-tools.ts` (line 359) -- passes `fieldCache.getProjectId(pn)`

## Key Discovery: `helpers.ts` shared helpers propagate the bug

The shared helpers `resolveProjectItemId()` and `updateProjectItemField()` in `lib/helpers.ts` also call `fieldCache.getProjectId()` without a project number. These helpers are used by many tools, meaning even tools that correctly resolve `projectNumber` will still hit the wrong project when these helpers look up field IDs and project item IDs.

## Fix Approach

### Recommended: Thread `projectNumber` through all `fieldCache` method calls

**Change pattern from:**
```typescript
const projectId = fieldCache.getProjectId();
```

**To:**
```typescript
const projectId = fieldCache.getProjectId(projectNumber);
```

This must be done at every call site listed above. The `FieldOptionCache` API already supports the optional `projectNumber` parameter on all methods (`getProjectId`, `getFieldId`, `resolveOptionId`, `getOptionNames`, `getFieldNames`). No changes to the cache class itself are needed.

### Detailed changes needed:

1. **`project-management-tools.ts`**: Every tool handler already calls `resolveFullConfig()` which returns `projectNumber`. Pass `projectNumber` to all `fieldCache.getProjectId()`, `fieldCache.getFieldId()`, `fieldCache.getFieldNames()`, and `fieldCache.resolveOptionId()` calls.

2. **`lib/helpers.ts`**: The shared helpers (`resolveProjectItemId`, `updateProjectItemField`, `syncStatusField`) need a `projectNumber` parameter added to their signatures, then threaded to all `fieldCache` calls within them. This is a signature change that will require updating all callers.

3. **`issue-tools.ts`**, **`batch-tools.ts`**, **`hygiene-tools.ts`**, **`project-tools.ts`**, **`view-tools.ts`**, **`routing-tools.ts`**: Update all `fieldCache` calls to pass `projectNumber`.

### Alternative considered: Set `defaultProjectNumber` on each `ensureFieldCache` call

Could modify `ensureFieldCache` to always update `defaultProjectNumber` to the most recently requested project. This would be a smaller change but creates a race condition risk if tools run concurrently, and violates the principle that the "default" should be stable.

**Not recommended** -- threading the parameter is safer and more explicit.

## Risks

- **Large surface area**: ~30+ call sites need updating across 7+ files. Each is a simple mechanical change, but the volume increases risk of missing one.
- **Signature changes to shared helpers**: `resolveProjectItemId`, `updateProjectItemField`, and `syncStatusField` in `helpers.ts` will need an additional `projectNumber` parameter, requiring updates to all their callers.
- **Test coverage**: No existing tests for `update_project`. The cache tests confirm `getProjectId(N)` works correctly when called with a project number, so the cache layer is sound -- only the tool layer needs fixing.

## Recommended Next Steps

1. Add `projectNumber` parameter to `resolveProjectItemId`, `updateProjectItemField`, `getCurrentFieldValue`, and `syncStatusField` in `lib/helpers.ts`
2. Update all call sites in `project-management-tools.ts`, `issue-tools.ts`, `batch-tools.ts`, `hygiene-tools.ts`, `project-tools.ts`, `view-tools.ts`, and `routing-tools.ts`
3. Add a targeted test for `update_project` with a non-default `projectNumber`
4. Consider adding a lint rule or code review checklist item: "all `fieldCache` method calls must pass `projectNumber`"
