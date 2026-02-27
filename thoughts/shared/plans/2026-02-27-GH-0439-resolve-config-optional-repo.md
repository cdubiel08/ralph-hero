---
date: 2026-02-27
status: draft
github_issues: [439]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/439
primary_issue: 439
---

# Add resolveConfigOptionalRepo() for Tools Without Default Repo - Implementation Plan

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-439 | Add resolveConfigOptionalRepo() for tools that work without a default repo | S |

## Current State Analysis

`resolveConfig()` at `helpers.ts:462-477` always requires `repo` — throws if missing. `resolveFullConfig()` at `helpers.ts:483-501` calls `resolveConfig()` internally, inheriting the requirement. `ResolvedConfig` interface at `helpers.ts:30-35` has `repo: string` (non-optional).

All 11 `resolveConfig()` callers genuinely need repo in their queries (they use `repository(owner, name)` or `resolveIssueNodeId()`). However, `list_issues` at `issue-tools.ts:184` calls `resolveFullConfig()` but its primary query is purely project-scoped — the GraphQL query uses only `$projectId`, not `owner`/`repo`. This tool is the primary target for the optional-repo variant.

## Desired End State

### Verification
- [x] `resolveConfigOptionalRepo()` exported from `helpers.ts` — returns `{ owner: string; repo?: string }`
- [x] `resolveFullConfigOptionalRepo()` exported from `helpers.ts` — returns `ResolvedConfigOptionalRepo`
- [x] `list_issues` uses `resolveFullConfigOptionalRepo()` instead of `resolveFullConfig()`
- [x] Multi-repo project can call `list_issues` without `RALPH_GH_REPO` set
- [x] All existing `resolveConfig()` and `resolveFullConfig()` callers unchanged

## What We're NOT Doing

- Not modifying `resolveConfig()` — it stays strict for write/repo-scoped tools
- Not modifying `resolveFullConfig()` — it stays strict for tools that need repo
- Not updating other `resolveFullConfig()` callers (e.g., `update_workflow_state`, `set_estimate`) — deferred for follow-up
- Not modifying any `resolveConfig()` callers (all 11 genuinely need repo)
- Not adding repo-optional paths to `resolveIssueNodeId()` — it needs repo by definition

## Implementation Approach

Three changes in `helpers.ts`, one call site update in `issue-tools.ts`, and tests:
1. Add `ResolvedConfigOptionalRepo` interface
2. Add `resolveConfigOptionalRepo()` function
3. Add `resolveFullConfigOptionalRepo()` function
4. Update `list_issues` to use the optional variant
5. Add unit tests for the new helpers

---

## Phase 1: Add optional-repo config helpers and update list_issues
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/439 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0439-resolve-config-optional-repo.md

### Changes Required

#### 1. Add `ResolvedConfigOptionalRepo` interface
**File**: `plugin/ralph-hero/mcp-server/src/lib/helpers.ts`
**Location**: After `ResolvedConfig` interface (after line 35)
**Change**: Add new interface:

```typescript
export interface ResolvedConfigOptionalRepo {
  owner: string;
  repo?: string;
  projectNumber: number;
  projectOwner: string;
}
```

#### 2. Add `resolveConfigOptionalRepo()` function
**File**: `plugin/ralph-hero/mcp-server/src/lib/helpers.ts`
**Location**: After `resolveConfig()` (after line 477)
**Change**: Add new export:

```typescript
/**
 * Resolve owner (required) and repo (optional) from args or config.
 * Use for tools that work without a default repo (project-scoped reads).
 */
export function resolveConfigOptionalRepo(
  client: GitHubClient,
  args: { owner?: string; repo?: string },
): { owner: string; repo?: string } {
  const owner = args.owner || client.config.owner;
  if (!owner)
    throw new Error(
      "owner is required (set RALPH_GH_OWNER env var or pass explicitly)",
    );
  const repo = args.repo || client.config.repo;
  return { owner, repo };
}
```

#### 3. Add `resolveFullConfigOptionalRepo()` function
**File**: `plugin/ralph-hero/mcp-server/src/lib/helpers.ts`
**Location**: After `resolveFullConfig()` (after line 501)
**Change**: Add new export:

```typescript
/**
 * Full config resolution with optional repo.
 * Use for project-scoped tools that don't need a default repo.
 */
export function resolveFullConfigOptionalRepo(
  client: GitHubClient,
  args: { owner?: string; repo?: string; projectNumber?: number },
): ResolvedConfigOptionalRepo {
  const { owner, repo } = resolveConfigOptionalRepo(client, args);
  const projectNumber = args.projectNumber ?? client.config.projectNumber;
  if (!projectNumber)
    throw new Error(
      "projectNumber is required (set RALPH_GH_PROJECT_NUMBER env var or pass explicitly)",
    );
  const projectOwner = resolveProjectOwner(client.config);
  if (!projectOwner)
    throw new Error(
      "projectOwner is required (set RALPH_GH_PROJECT_OWNER or RALPH_GH_OWNER env var)",
    );
  return { owner, repo, projectNumber, projectOwner };
}
```

#### 4. Update `list_issues` to use optional-repo variant
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Line**: 184
**Change**: Switch from `resolveFullConfig` to `resolveFullConfigOptionalRepo`:

Update import (top of file) to add `resolveFullConfigOptionalRepo`:
```typescript
import { resolveFullConfig, resolveFullConfigOptionalRepo, ... } from "../lib/helpers.js";
```

Replace line 184:
```typescript
// Before:
const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(client, args);
// After:
const { owner, repo, projectNumber, projectOwner } = resolveFullConfigOptionalRepo(client, args);
```

#### 5. Add unit tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/repo-inference.test.ts` (or new file `helpers-optional-repo.test.ts`)
**Change**: Add test cases for both new helpers:

```typescript
describe("resolveConfigOptionalRepo", () => {
  it("returns owner and repo when both available", () => {
    mockConfig.owner = "test-owner";
    mockConfig.repo = "test-repo";
    const { resolveConfigOptionalRepo } = await import(helpersPath);
    const result = resolveConfigOptionalRepo(mockClient, {});
    expect(result).toEqual({ owner: "test-owner", repo: "test-repo" });
  });

  it("returns owner with undefined repo when repo not set", () => {
    mockConfig.owner = "test-owner";
    mockConfig.repo = undefined;
    const { resolveConfigOptionalRepo } = await import(helpersPath);
    const result = resolveConfigOptionalRepo(mockClient, {});
    expect(result).toEqual({ owner: "test-owner", repo: undefined });
  });

  it("prefers args over config", () => {
    mockConfig.owner = "config-owner";
    mockConfig.repo = "config-repo";
    const { resolveConfigOptionalRepo } = await import(helpersPath);
    const result = resolveConfigOptionalRepo(mockClient, { owner: "arg-owner", repo: "arg-repo" });
    expect(result).toEqual({ owner: "arg-owner", repo: "arg-repo" });
  });

  it("throws when owner is missing", () => {
    mockConfig.owner = undefined;
    const { resolveConfigOptionalRepo } = await import(helpersPath);
    expect(() => resolveConfigOptionalRepo(mockClient, {})).toThrow("owner is required");
  });
});

describe("resolveFullConfigOptionalRepo", () => {
  it("returns full config with optional repo undefined", () => {
    mockConfig.owner = "test-owner";
    mockConfig.repo = undefined;
    mockConfig.projectNumber = 3;
    const { resolveFullConfigOptionalRepo } = await import(helpersPath);
    const result = resolveFullConfigOptionalRepo(mockClient, {});
    expect(result.owner).toBe("test-owner");
    expect(result.repo).toBeUndefined();
    expect(result.projectNumber).toBe(3);
    expect(result.projectOwner).toBeDefined();
  });

  it("throws when projectNumber is missing", () => {
    mockConfig.owner = "test-owner";
    mockConfig.projectNumber = undefined;
    const { resolveFullConfigOptionalRepo } = await import(helpersPath);
    expect(() => resolveFullConfigOptionalRepo(mockClient, {})).toThrow("projectNumber is required");
  });
});
```

### File Ownership Summary

| File | Action |
|------|--------|
| `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` | MODIFY (add interface after line 35; add 2 functions after lines 477 and 501) |
| `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` | MODIFY (line 184: switch to resolveFullConfigOptionalRepo; update import) |
| `plugin/ralph-hero/mcp-server/src/__tests__/repo-inference.test.ts` | MODIFY (add test cases for both new helpers) |

### Success Criteria

- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes
- [x] Automated: `grep -q "resolveConfigOptionalRepo" plugin/ralph-hero/mcp-server/src/lib/helpers.ts` exits 0
- [x] Automated: `grep -q "resolveFullConfigOptionalRepo" plugin/ralph-hero/mcp-server/src/lib/helpers.ts` exits 0
- [x] Automated: `grep -q "resolveFullConfigOptionalRepo" plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` exits 0
- [x] Automated: `grep -q "ResolvedConfigOptionalRepo" plugin/ralph-hero/mcp-server/src/lib/helpers.ts` exits 0
- [x] Manual: `resolveConfig()` and `resolveFullConfig()` are unchanged (no modifications to existing functions)
- [x] Manual: All 11 `resolveConfig()` call sites unchanged (still strict)
- [x] Manual: `list_issues` is the only tool updated to use the optional variant

## Integration Testing

- [x] Run full test suite: `cd plugin/ralph-hero/mcp-server && npm test`
- [x] Verify `list_issues` tests still pass (existing tests won't break because the function still returns repo when config has it)
- [x] Verify new tests cover: owner+repo defined, owner-only (repo undefined), args override config, missing owner throws, missing projectNumber throws

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-27-GH-0439-resolve-config-optional-repo.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/439
- Parent: https://github.com/cdubiel08/ralph-hero/issues/429
- Depends on: https://github.com/cdubiel08/ralph-hero/issues/438 (resolveRepoFromProject returns undefined)
- Pattern reference: `resolveConfig()` at `helpers.ts:462-477`, `resolveFullConfig()` at `helpers.ts:483-501`
