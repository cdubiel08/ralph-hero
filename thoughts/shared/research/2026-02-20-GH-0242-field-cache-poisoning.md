---
date: 2026-02-20
github_issue: 242
github_url: https://github.com/cdubiel08/ralph-hero/issues/242
status: complete
type: research
---

# GH-242: setup_project Poisons FieldOptionCache When Creating New Project

## Problem Statement

Calling `setup_project` to create a new project (e.g., golden template #4) causes all subsequent `update_workflow_state` calls on the default project (#3) to fail with "The item does not exist in the project". The root cause is `ensureFieldCacheForNewProject` calling `fieldCache.clear()` which wipes ALL project entries from the multi-project cache, then repopulates with only the new project's data.

## Current State Analysis

### `ensureFieldCacheForNewProject` — The Problematic Function

[`project-tools.ts:1260-1270`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L1260-L1270):

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

Line 1267: `fieldCache.clear()` calls `FieldOptionCache.clear()` which:
1. Wipes the entire `projects` Map (all project entries)
2. Resets `defaultProjectNumber` to `undefined`

Then `ensureFieldCache` repopulates the cache with only the new project. After this, `defaultProjectNumber` points to the newly created project, not the original default.

### `FieldOptionCache.clear()` — Nuclear Option

[`cache.ts:213-216`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts#L213-L216):

```typescript
clear(): void {
  this.projects.clear();
  this.defaultProjectNumber = undefined;
}
```

This removes ALL project data. The multi-project support (added in GH-144) stores projects in `Map<number, ProjectCacheData>`, but `clear()` doesn't discriminate — it destroys everything.

### `SessionCache.clear()` — Companion Damage

`ensureFieldCacheForNewProject` also calls `client.getCache().clear()` which wipes the `SessionCache`. This clears all cached API responses including issue node ID lookups, project item ID lookups, and query results. While the `SessionCache` is self-healing (entries get re-fetched on demand), clearing it forces unnecessary API calls.

### Default Project Resolution

[`cache.ts:222-231`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts#L222-L231):

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

When tools call `fieldCache.getProjectId()` without a `projectNumber`, they get whatever `defaultProjectNumber` points to. After `setup_project`, that's the newly created project — not the workflow project the tools expect.

### Impact Radius

All tools that call `fieldCache.getProjectId()` without an explicit `projectNumber` are affected after `setup_project` runs:
- `update_workflow_state` (issue-tools.ts:184)
- `update_estimate` (issue-tools.ts:853)
- `update_priority` (issue-tools.ts:1589)
- `list_project_items` (project-tools.ts:783)
- `archive_item`, `remove_from_project`, `add_to_project`, `link_repository`, `clear_field` (project-management-tools.ts, multiple locations)
- `batch_update` (batch-tools.ts:279)
- `project_hygiene` (hygiene-tools.ts:91)

In total, 20+ call sites across 5 tool files.

### `copy_project` Does NOT Have This Bug

[`project-tools.ts:514-661`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L514-L661): The `copy_project` tool does NOT call `ensureFieldCacheForNewProject`. It creates the copy and returns without touching the field cache. This is correct behavior — the copied project doesn't need to be in the field cache unless the caller wants to use it for field operations.

## Key Discoveries

### 1. The Fix is One Line

Replace `fieldCache.clear()` with project-specific deletion. Since the new project didn't exist before creation, there's nothing to clear for it. We only need to clear stale `SessionCache` entries to force fresh API responses:

```typescript
async function ensureFieldCacheForNewProject(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  number: number,
): Promise<void> {
  // Clear only the SessionCache query entries (force fresh API responses)
  // Do NOT clear fieldCache — other projects' data must be preserved
  client.getCache().invalidatePrefix("query:");
  await ensureFieldCache(client, fieldCache, owner, number);
}
```

This preserves all existing project entries in the `FieldOptionCache` while ensuring the new project gets fresh data from the API. The `ensureFieldCache` function already handles the "populate if not present" logic via `isPopulated(projectNumber)`.

### 2. `SessionCache.clear()` is Also Overkill

`client.getCache().clear()` removes ALL cache entries including stable node ID lookups (`issue-node-id:*`, `project-item-id:*`). These are stable and don't change when a new project is created. Only `query:` prefixed entries (API response caches) might be stale. The fix should use `invalidatePrefix("query:")` instead of `clear()`.

### 3. `defaultProjectNumber` Should Be Stable

The `defaultProjectNumber` is set once (first `populate` call) and should remain the same for the session. After the fix, `setup_project` will `populate(newNumber, ...)` which adds the new project to the map without resetting `defaultProjectNumber`, since the `populate` method only sets `defaultProjectNumber` when it's `undefined` (line 147-149 of cache.ts):

```typescript
if (this.defaultProjectNumber === undefined) {
  this.defaultProjectNumber = projectNumber;
}
```

### 4. No Test Currently Catches This

The `cache.test.ts` file tests `clear()` behavior correctly (lines 149-163) but no test verifies that `ensureFieldCacheForNewProject` preserves existing project data. Since `ensureFieldCacheForNewProject` is an internal function in `project-tools.ts` (not exported), the test would be structural (verify that `fieldCache.clear()` is no longer called in that function).

### 5. Observed Reproduction

During GH-160/161 implementation:
1. Called `setup_project(owner: "cdubiel08", title: "Ralph Golden Template")` — created project #4
2. `ensureFieldCacheForNewProject` cleared all cache, repopulated with project #4
3. Subsequent `update_workflow_state(number: 160, ...)` failed: "The item does not exist in the project" — because it looked up #160 in project #4 (the golden template) instead of project #3 (the workflow project)
4. Workaround: Used raw `gh api graphql` mutations bypassing the MCP server entirely

## Recommended Approach

### Changes

**File**: `mcp-server/src/tools/project-tools.ts`

Replace `ensureFieldCacheForNewProject` (lines 1260-1270):

Before:
```typescript
async function ensureFieldCacheForNewProject(
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  owner: string,
  number: number,
): Promise<void> {
  fieldCache.clear();
  client.getCache().clear();
  await ensureFieldCache(client, fieldCache, owner, number);
}
```

After:
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

**File**: `mcp-server/src/__tests__/project-tools.test.ts`

Add structural test:
```typescript
describe("ensureFieldCacheForNewProject structural", () => {
  it("does NOT call fieldCache.clear()", () => {
    expect(projectToolsSrc).not.toContain("fieldCache.clear()");
  });

  it("uses invalidatePrefix for targeted cache invalidation", () => {
    expect(projectToolsSrc).toContain('invalidatePrefix("query:")');
  });
});
```

## Risks

1. **Stale cache for replaced project**: If `setup_project` is called to create a project with the same number as an existing cached project (shouldn't happen — GitHub assigns unique numbers), stale data could persist. Mitigation: `ensureFieldCache` checks `isPopulated(projectNumber)` — since the new project number is always unique, it won't match any existing cache entry.

2. **SessionCache stale entries**: Using `invalidatePrefix("query:")` instead of `clear()` preserves node ID lookups. If a node ID changes (e.g., issue deleted and recreated), the stale ID would persist. This is the existing behavior and is handled by the TTL mechanism.

## Recommended Next Steps

1. Replace `fieldCache.clear()` with nothing (or a comment) in `ensureFieldCacheForNewProject`
2. Replace `client.getCache().clear()` with `client.getCache().invalidatePrefix("query:")`
3. Add structural test verifying `fieldCache.clear()` is not called
4. Run existing test suite to verify no regressions
