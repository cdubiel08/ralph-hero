---
date: 2026-02-20
status: draft
github_issues: [224]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/224
primary_issue: 224
---

# Wire Repo Inference into Config Resolution - Implementation Plan

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-224 | Wire repo inference into config resolution | S |

**Depends on**: GH-223 (`list_project_repos` tool / `queryProjectRepositories()` helper) — must be merged before implementation.

## Current State Analysis

### Config Resolution Today

`resolveConfig()` (`helpers.ts:324-339`) synchronously resolves `owner`/`repo` from `args` → `client.config` → throws error. It is a pure synchronous function called by every tool. `resolveFullConfig()` (`helpers.ts:345-363`) extends it with `projectNumber` and `projectOwner`.

The `client.config.repo` value is set at startup in `index.ts:69` from `RALPH_GH_REPO` env var. If unset, it remains `undefined` and `resolveConfig()` throws: `"repo is required (set RALPH_GH_REPO env var or pass explicitly)"`.

### What GH-223 Will Provide

`queryProjectRepositories()` — an async helper in `helpers.ts` that:
- Queries `ProjectV2.repositories(first: 100)` via `projectQuery`
- Returns `{ projectId, repos: [{ owner, repo, nameWithOwner }], totalRepos }`
- Uses the `user`/`organization` fallback pattern from `fetchProjectForCache()`
- Caches results in SessionCache with 10-minute TTL

### The Gap

No mechanism exists to lazily infer `repo` from the project when `RALPH_GH_REPO` is unset. The inference logic described in GH-224 needs to bridge `queryProjectRepositories()` → `resolveConfig()`.

## Desired End State

### Verification
- [ ] `RALPH_GH_REPO` is optional when exactly one repo is linked to the project
- [ ] Multiple linked repos with `RALPH_GH_REPO` set uses it as tiebreaker
- [ ] Multiple linked repos without `RALPH_GH_REPO` throws clear error listing repos
- [ ] Zero linked repos throws clear error with bootstrap instructions
- [ ] Inferred repo cached in `client.config.repo` (no repeated API calls)
- [ ] No breaking changes for existing setups with `RALPH_GH_REPO` set
- [ ] Unit tests cover all inference branches
- [ ] `npm run build` passes
- [ ] `npm test` passes

## What We're NOT Doing

- Implementing `list_project_repos` tool or `queryProjectRepositories()` helper (GH-223)
- Enriching `list_project_items` with repo info (GH-225)
- Cross-repo group detection
- Skill artifact path changes
- Multi-repo support in skills or scripts

## Implementation Approach

The key challenge is that `resolveConfig()` is **synchronous** but repo inference requires an **async** API call. Two options:

**Option A: Make `resolveConfig()` async** — Would require changing every call site (50+ locations). Too invasive.

**Option B: Lazy-init at startup, keep `resolveConfig()` sync** — Perform inference once during server initialization before any tools are called, then cache the result in `client.config.repo`. This is the right approach.

The MCP server has a natural initialization window: after `createGitHubClient()` returns but before tools are called. We add a `resolveRepoFromProject()` async function that runs during init. Once resolved, `client.config.repo` is populated and `resolveConfig()` works unchanged.

---

## Phase 1: GH-224 — Wire Repo Inference into Config Resolution

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/224 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-16-GH-0023-multi-repo-support.md | **Depends on**: GH-223

### Changes Required

#### 1. Add `resolveRepoFromProject()` helper
**File**: `plugin/ralph-hero/mcp-server/src/lib/helpers.ts`
**Changes**:

Add a new exported async function after `resolveConfig()` (~line 339):

```typescript
/**
 * Infer repo from the project's linked repositories when RALPH_GH_REPO is not set.
 *
 * Rules:
 * - If client.config.repo is already set → return it (env var takes precedence)
 * - If exactly 1 repo linked → use it, cache in client.config.repo
 * - If 0 repos linked → throw with bootstrap instructions
 * - If 2+ repos linked → throw with list of repos and hint to set RALPH_GH_REPO
 *
 * Requires: queryProjectRepositories() from GH-223
 */
export async function resolveRepoFromProject(client: GitHubClient): Promise<string> {
  // Already resolved (env var or previous inference)
  if (client.config.repo) return client.config.repo;

  // Need projectNumber and projectOwner for the query
  const projectNumber = client.config.projectNumber;
  const projectOwner = resolveProjectOwner(client.config);

  if (!projectNumber || !projectOwner) {
    throw new Error(
      "Cannot infer repo: RALPH_GH_PROJECT_NUMBER and RALPH_GH_OWNER (or RALPH_GH_PROJECT_OWNER) are required.\n" +
      "Set RALPH_GH_REPO explicitly, or configure project settings first."
    );
  }

  const result = await queryProjectRepositories(client, projectOwner, projectNumber);

  if (result.totalRepos === 0) {
    throw new Error(
      "No repositories linked to project. Cannot infer repo.\n" +
      "Bootstrap: run link_repository to link a repo to your project, then restart."
    );
  }

  if (result.totalRepos === 1) {
    const inferred = result.repos[0];
    // Cache in config for all subsequent resolveConfig() calls
    client.config.repo = inferred.repo;
    if (!client.config.owner) {
      client.config.owner = inferred.owner;
    }
    return inferred.repo;
  }

  // Multiple repos linked — need RALPH_GH_REPO as tiebreaker
  const repoList = result.repos.map(r => r.nameWithOwner).join(", ");
  throw new Error(
    `Multiple repos linked to project: ${repoList}.\n` +
    "Set RALPH_GH_REPO to select which repo to use as default."
  );
}
```

**Key design decisions**:
- Mutates `client.config.repo` — this is intentional. Once inferred, it behaves identically to an env var for the rest of the session.
- Also sets `client.config.owner` if unset — the inferred repo's owner is the most sensible default.
- Import `queryProjectRepositories` from the same file (it will be added by GH-223).

#### 2. Call `resolveRepoFromProject()` during server init
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`
**Changes**:

The MCP server's `main()` function (at the bottom of `index.ts`) currently calls `initGitHubClient()` synchronously then immediately registers tools. Modify the flow:

1. Import `resolveRepoFromProject` from `./lib/helpers.js`
2. After `initGitHubClient()` returns the client, call `await resolveRepoFromProject(client)` in a try/catch
3. On success: log the inferred repo. On failure: log a warning (non-fatal — tools that need repo will still throw from `resolveConfig()`)

In the `main()` function (around line 240+), after the client is created:

```typescript
// Attempt lazy repo inference from project (non-fatal)
try {
  await resolveRepoFromProject(client);
  if (client.config.repo) {
    console.error(`[ralph-hero] Repo: ${client.config.owner}/${client.config.repo}${resolveEnv("RALPH_GH_REPO") ? "" : " (inferred from project)"}`);
  }
} catch (e) {
  console.error(`[ralph-hero] Repo inference skipped: ${e instanceof Error ? e.message : String(e)}`);
}
```

Also remove or adjust the existing warning at `index.ts:75-79` that warns when `RALPH_GH_REPO` is not set — since it may now be inferred.

Change the warning to only fire when both env var is missing AND inference fails:
```typescript
if (!owner) {
  console.error(
    "[ralph-hero] Warning: RALPH_GH_OWNER not set.\n" +
    "Most tools require this. Set in your environment or .claude/ralph-hero.local.md",
  );
}
// Repo warning deferred — will attempt inference from project during init
```

#### 3. Update `resolveConfig()` error message
**File**: `plugin/ralph-hero/mcp-server/src/lib/helpers.ts`
**Changes**:

Update the repo error message in `resolveConfig()` (line 335-336) to mention project inference:

```typescript
if (!repo)
  throw new Error(
    "repo is required. Set RALPH_GH_REPO env var, pass repo explicitly, or link exactly one repo to your project."
  );
```

#### 4. Add unit tests for repo inference
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/repo-inference.test.ts` (new file)
**Changes**:

Create a test file covering all inference branches. Mock `queryProjectRepositories` to return controlled data:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Test cases:
// 1. client.config.repo already set → returns it immediately, no API call
// 2. Exactly 1 repo linked → sets client.config.repo and returns it
// 3. Exactly 1 repo linked, owner unset → also sets client.config.owner
// 4. Zero repos linked → throws with bootstrap message
// 5. Multiple repos linked → throws with repo list
// 6. No projectNumber → throws with config hint
// 7. No projectOwner → throws with config hint
```

The tests use a mock `GitHubClient` with a mutable `config` object — following the pattern from `init-config.test.ts` which tests config resolution logic in isolation.

#### 5. Update `index.ts` existing warning and startup log
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`
**Changes**:

Currently lines 75-79 warn about missing `RALPH_GH_OWNER` and/or `RALPH_GH_REPO`. Split this into:
- Owner-only warning (keep as-is but just for owner)
- Repo warning removed (inference handles it)

Add after inference succeeds: a startup log line showing the resolved repo and whether it was from env var or inferred.

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` — no TypeScript errors
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` — all tests pass including new repo-inference tests
- [ ] Manual: Start MCP server without `RALPH_GH_REPO` set, with one repo linked to project → server starts, logs inferred repo
- [ ] Manual: Start MCP server without `RALPH_GH_REPO` set, with zero repos linked → server starts with warning, tools that need repo throw clear error
- [ ] Manual: Start MCP server with `RALPH_GH_REPO` set → existing behavior unchanged

## Integration Testing

- [ ] `npm run build` compiles cleanly
- [ ] `npm test` passes all existing + new tests
- [ ] MCP server starts successfully in both inferred and explicit repo modes
- [ ] Existing tools work identically when `RALPH_GH_REPO` is set (no regression)
- [ ] Tools throw clear errors when repo cannot be resolved (no env var, no project link)

## File Ownership Summary

| File | Action | Description |
|------|--------|-------------|
| `mcp-server/src/lib/helpers.ts` | Modify | Add `resolveRepoFromProject()`, update error message |
| `mcp-server/src/index.ts` | Modify | Call inference during init, adjust warnings |
| `mcp-server/src/__tests__/repo-inference.test.ts` | Create | Unit tests for all inference branches |

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-16-GH-0023-multi-repo-support.md
- GH-224: https://github.com/cdubiel08/ralph-hero/issues/224
- GH-223 (dependency): https://github.com/cdubiel08/ralph-hero/issues/223
- GH-23 (parent): https://github.com/cdubiel08/ralph-hero/issues/23
- `resolveConfig()`: https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L324-L339
- `resolveFullConfig()`: https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L345-L363
- `initGitHubClient()`: https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L37-L109
