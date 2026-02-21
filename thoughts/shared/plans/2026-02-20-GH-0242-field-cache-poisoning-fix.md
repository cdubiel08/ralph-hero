---
date: 2026-02-20
status: draft
github_issues: [242]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/242
primary_issue: 242
---

# Fix FieldOptionCache Poisoning in setup_project - Implementation Plan

## Overview

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-242 | setup_project poisons FieldOptionCache when creating new project | XS |

## Current State Analysis

`ensureFieldCacheForNewProject` in [`project-tools.ts:1260-1270`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L1260-L1270) calls `fieldCache.clear()` which wipes ALL project entries from the multi-project `FieldOptionCache` (including the default workflow project), then repopulates with only the newly created project. This causes all subsequent `update_workflow_state` calls on the default project to fail with "The item does not exist in the project".

The `FieldOptionCache` already supports multi-project storage via `Map<number, ProjectCacheData>` (GH-144 refactor). The `clear()` call is unnecessary — `ensureFieldCache` handles "populate if not present" logic correctly via `isPopulated(projectNumber)`.

## Desired End State

### Verification
- [ ] `setup_project` creates a new project without clearing existing cache entries
- [ ] After `setup_project`, `update_workflow_state` on the default project still works
- [ ] New project's fields are correctly cached
- [ ] `defaultProjectNumber` remains unchanged after `setup_project`
- [ ] All existing tests pass
- [ ] New structural test verifies `fieldCache.clear()` is not called

## What We're NOT Doing

- Changing the `FieldOptionCache` class itself (it's correct as-is)
- Changing `copy_project` (it doesn't call `ensureFieldCacheForNewProject`)
- Adding integration tests that call the GitHub API
- Changing how `defaultProjectNumber` is tracked

## Implementation Approach

Replace the two destructive `clear()` calls in `ensureFieldCacheForNewProject` with targeted invalidation. The `fieldCache.clear()` call is simply removed (no replacement needed — `ensureFieldCache` already adds the new project without disturbing existing entries). The `client.getCache().clear()` is replaced with `invalidatePrefix("query:")` to preserve stable node ID lookups while ensuring fresh API responses for the new project.

---

## Phase 1: GH-242 - Fix ensureFieldCacheForNewProject

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/242 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0242-field-cache-poisoning.md

### Changes Required

#### 1. Remove destructive cache clearing
**File**: `mcp-server/src/tools/project-tools.ts`
**Location**: `ensureFieldCacheForNewProject` function (lines 1260-1270)

**Before**:
```typescript
async function ensureFieldCacheForNewProject(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  number: number,
): Promise<void> {
  // Clear any stale cache and force refresh
  fieldCache.clear();
  client.getCache().clear();
  await ensureFieldCache(client, fieldCache, owner, number);
}
```

**After**:
```typescript
async function ensureFieldCacheForNewProject(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  number: number,
): Promise<void> {
  // Invalidate query cache to force fresh API responses for the new project.
  // Do NOT clear fieldCache — other projects' data must be preserved (GH-242).
  client.getCache().invalidatePrefix("query:");
  await ensureFieldCache(client, fieldCache, owner, number);
}
```

#### 2. Add structural test
**File**: `mcp-server/src/__tests__/project-tools.test.ts`
**Changes**: Add test block at end of file:

```typescript
describe("ensureFieldCacheForNewProject structural (GH-242)", () => {
  it("does NOT call fieldCache.clear()", () => {
    expect(projectToolsSrc).not.toContain("fieldCache.clear()");
  });

  it("uses invalidatePrefix for targeted cache invalidation", () => {
    expect(projectToolsSrc).toContain('invalidatePrefix("query:")');
  });
});
```

### Success Criteria
- [ ] Automated: `npm run build` passes
- [ ] Automated: `npm test` passes (all existing + 2 new tests)
- [ ] Manual: Call `setup_project` then `update_workflow_state` on default project — should succeed

---

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0242-field-cache-poisoning.md
- GH-144 multi-project cache refactor (provides the correct infrastructure)
- [`cache.ts:213-216`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts#L213-L216) — `FieldOptionCache.clear()`
- [`cache.ts:147-149`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts#L147-L149) — `defaultProjectNumber` guard
