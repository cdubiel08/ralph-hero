---
date: 2026-02-27
status: draft
github_issues: [438]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/438
primary_issue: 438
---

# Change resolveRepoFromProject() 2+ Repos Branch from Error to Warning - Implementation Plan

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-438 | Change resolveRepoFromProject() 2+ repos branch from error to warning | XS |

## Current State Analysis

`resolveRepoFromProject()` at `helpers.ts:420` has return type `Promise<string>` and throws at lines 451-455 when 2+ repos are linked. The throw is caught by a non-fatal try/catch in `index.ts:300-312` which logs "Repo inference skipped: {message}". `GitHubClientConfig.repo` is already typed as `repo?: string` (optional at `types.ts:267`). All runtime consumers of `client.config.repo` already guard against undefined (debug-tools, routing-tools, project-tools, resolveConfig). Existing test at `repo-inference.test.ts:121-142` expects a throw.

## Desired End State

### Verification
- [ ] `resolveRepoFromProject()` returns `undefined` (not throws) when 2+ repos linked
- [ ] A warning is logged listing the linked repos
- [ ] Function return type is `Promise<string | undefined>`
- [ ] Startup completes without error for multi-repo projects
- [ ] Existing test updated to verify warning + undefined return

## What We're NOT Doing

- Not modifying `resolveConfig()` — it stays strict for write tools (sibling issue #439)
- Not modifying `index.ts` startup sequence — existing `if (client.config.repo)` guard handles undefined correctly
- Not modifying any tool implementations — they already guard against undefined repo
- Not changing the 0-repos or 1-repo branches — only the 2+ repos branch changes

## Implementation Approach

Two files: change the throw to a warning + return undefined in `helpers.ts`, update the corresponding test in `repo-inference.test.ts`.

---

## Phase 1: Change 2+ repos branch from error to warning
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/438 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0438-resolve-repo-from-project-warning.md

### Changes Required

#### 1. Update function return type
**File**: `plugin/ralph-hero/mcp-server/src/lib/helpers.ts`
**Line**: 420
**Change**: Update return type annotation:

Replace:
```typescript
export async function resolveRepoFromProject(client: GitHubClient): Promise<string> {
```

With:
```typescript
export async function resolveRepoFromProject(client: GitHubClient): Promise<string | undefined> {
```

#### 2. Replace throw with warning + return undefined
**File**: `plugin/ralph-hero/mcp-server/src/lib/helpers.ts`
**Lines**: 451-455
**Change**: Replace the throw block:

Replace:
```typescript
  const repoList = result.repos.map(r => r.nameWithOwner).join(", ");
  throw new Error(
    `Multiple repos linked to project: ${repoList}. ` +
    "Set RALPH_GH_REPO to select which repo to use as default."
  );
```

With:
```typescript
  const repoList = result.repos.map(r => r.nameWithOwner).join(", ");
  console.error(
    `[ralph-hero] Multiple repos linked to project: ${repoList}. ` +
    `Set RALPH_GH_REPO to select the default repo. ` +
    `Read-only tools will work; write tools require an explicit repo param.`
  );
  return undefined;
```

#### 3. Update test for 2+ repos case
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/repo-inference.test.ts`
**Lines**: 121-142 (test "throws when multiple repos are linked without tiebreaker")
**Change**: Replace throw expectation with undefined return + console.error verification:

Replace:
```typescript
  it("throws when multiple repos are linked without tiebreaker", async () => {
    // ...mock setup...
    await expect(resolveRepoFromProject(mockClient)).rejects.toThrow(
      "Multiple repos linked to project: owner/repo-a, owner/repo-b",
    );
  });
```

With:
```typescript
  it("warns and returns undefined when multiple repos are linked", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    (mockClient.projectQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      user: {
        projectV2: {
          id: "proj-id",
          repositories: {
            totalCount: 2,
            nodes: [
              { owner: { login: "owner" }, name: "repo-a", nameWithOwner: "owner/repo-a" },
              { owner: { login: "owner" }, name: "repo-b", nameWithOwner: "owner/repo-b" },
            ],
          },
        },
      },
    });

    const { resolveRepoFromProject } = await import(helpersPath);
    const result = await resolveRepoFromProject(mockClient);

    expect(result).toBeUndefined();
    expect(mockClient.config.repo).toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Multiple repos linked to project: owner/repo-a, owner/repo-b"),
    );

    consoleSpy.mockRestore();
  });
```

### File Ownership Summary

| File | Action |
|------|--------|
| `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` | MODIFY (line 420: return type; lines 451-455: throw → warning + return undefined) |
| `plugin/ralph-hero/mcp-server/src/__tests__/repo-inference.test.ts` | MODIFY (lines 121-142: update test expectation) |

### Success Criteria

- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes
- [ ] Automated: `grep -q "return undefined" plugin/ralph-hero/mcp-server/src/lib/helpers.ts` exits 0
- [ ] Automated: `grep -q "Promise<string | undefined>" plugin/ralph-hero/mcp-server/src/lib/helpers.ts` exits 0
- [ ] Automated: `grep -q "warns and returns undefined" plugin/ralph-hero/mcp-server/src/__tests__/repo-inference.test.ts` exits 0
- [ ] Manual: The 0-repos and 1-repo branches are unchanged
- [ ] Manual: No changes to `index.ts`, `resolveConfig()`, or any tool files
- [ ] Manual: Console warning includes the repo list and guidance about RALPH_GH_REPO

## Integration Testing

- [ ] Run full test suite: `cd plugin/ralph-hero/mcp-server && npm test`
- [ ] Verify existing tests for 0-repos and 1-repo branches still pass unchanged
- [ ] Verify the new test correctly checks both the return value and the console.error call

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0438-resolve-repo-from-project-warning.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/438
- Parent: https://github.com/cdubiel08/ralph-hero/issues/429
- Sibling: https://github.com/cdubiel08/ralph-hero/issues/439 (depends on this issue)
