---
date: 2026-02-27
github_issue: 439
github_url: https://github.com/cdubiel08/ralph-hero/issues/439
status: complete
type: research
---

# GH-439: Add resolveConfigOptionalRepo() for Tools That Work Without a Default Repo

## Problem Statement

After #438 makes `resolveRepoFromProject()` return `undefined` instead of throwing for multi-repo projects, some tools will still fail when `client.config.repo` is undefined — specifically those that call `resolveConfig()` or `resolveFullConfig()`, both of which throw if `repo` is missing. Tools whose GraphQL queries are purely project-scoped (e.g., `list_issues`) don't actually need `repo` in their queries. This issue adds optional-repo variants so those tools can work in multi-repo environments.

## Current State Analysis

### `resolveConfig()` — Always Requires Repo (`helpers.ts:462-477`)

```typescript
export function resolveConfig(
  client: GitHubClient,
  args: { owner?: string; repo?: string },
): { owner: string; repo: string } {
  const owner = args.owner || client.config.owner;
  const repo = args.repo || client.config.repo;
  if (!owner) throw new Error("owner is required...");
  if (!repo) throw new Error("repo is required...");
  return { owner, repo };
}
```

`repo` is always required — no way to get a result without it.

### `resolveFullConfig()` — Builds on resolveConfig (`helpers.ts:483-501`)

```typescript
export function resolveFullConfig(
  client: GitHubClient,
  args: { owner?: string; repo?: string; projectNumber?: number },
): ResolvedConfig {  // { owner, repo, projectNumber, projectOwner }
  const { owner, repo } = resolveConfig(client, args);  // ← throws if no repo
  // ... validates projectNumber + projectOwner
  return { owner, repo, projectNumber, projectOwner };
}
```

Requires `repo` via `resolveConfig()`. Any `resolveFullConfig()` caller inherits this requirement.

### `ResolvedConfig` Interface (`helpers.ts:30-35`)

```typescript
export interface ResolvedConfig {
  owner: string;
  repo: string;          // ← non-optional, must be string
  projectNumber: number;
  projectOwner: string;
}
```

### Tools Calling `resolveConfig()` — All Genuinely Need Repo

11 call sites across 3 files. **All 11 use repo in their queries or for `resolveIssueNodeId()`:**

| Tool | File:Line | Uses repo for |
|------|-----------|---------------|
| `get_issue` | `issue-tools.ts:476` | `repository(owner, name)` GraphQL query |
| `get_issue` (group detection) | `issue-tools.ts:662` | `detectGroup(client, owner, repo, num)` |
| `update_issue` | `issue-tools.ts:994` | `resolveIssueNodeId()` + labels query |
| `create_comment` | `issue-tools.ts:1311` | `resolveIssueNodeId()` |
| `add_sub_issue` | `relationship-tools.ts:155` | `resolveIssueNodeId()` for both issues |
| `list_sub_issues` | `relationship-tools.ts:234` | `repository(owner, name)` GraphQL query |
| `add_dependency` | `relationship-tools.ts:330` | `resolveIssueNodeId()` for both issues |
| `remove_dependency` | `relationship-tools.ts:402` | `resolveIssueNodeId()` for both issues |
| `list_dependencies` | `relationship-tools.ts:473` | `repository(owner, name)` GraphQL query |
| `detect_group` | `relationship-tools.ts:580` | `detectGroup(client, owner, repo, num)` |
| `sync_across_projects` | `sync-tools.ts:233` | `resolveIssueNodeId()` then project query |

**None of these should switch to optional-repo** — they legitimately require a repo.

### `list_issues` — Calls `resolveFullConfig()` But Doesn't Use Repo in Query

`list_issues` at `issue-tools.ts:184` calls `resolveFullConfig()`:

```typescript
const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(client, args);
```

Its primary GraphQL query uses **only `$projectId`**:

```typescript
`query($projectId: ID!, $cursor: String, $first: Int!) {
  node(id: $projectId) {    // ← project-scoped, no repo variable
    ... on ProjectV2 { items { ... } }
  }
}`
```

`owner` and `repo` are extracted but **not passed to the primary query**. This is the primary candidate for switching to an optional-repo variant.

## Key Discoveries

### `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:462-477`
`resolveConfig()` — always strict, no optional-repo path. New `resolveConfigOptionalRepo()` needed alongside it.

### `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:483-501`
`resolveFullConfig()` — calls `resolveConfig()` internally. New `resolveFullConfigOptionalRepo()` needed alongside it.

### `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:30-35`
`ResolvedConfig` interface has `repo: string` (non-optional). New interface `ResolvedConfigOptionalRepo` needed with `repo?: string`.

### `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:184`
`list_issues` — only `resolveFullConfig()` caller whose primary query doesn't use repo. Update to `resolveFullConfigOptionalRepo()`.

## Potential Approaches

### Option A: Add Two New Helpers + Update list_issues (Recommended)

**New helpers in `helpers.ts`:**

```typescript
// New interface
export interface ResolvedConfigOptionalRepo {
  owner: string;
  repo?: string;
  projectNumber: number;
  projectOwner: string;
}

// Helper 1: optional-repo config (no project context needed)
export function resolveConfigOptionalRepo(
  client: GitHubClient,
  args: { owner?: string; repo?: string },
): { owner: string; repo?: string } {
  const owner = args.owner || client.config.owner;
  if (!owner) throw new Error("owner is required (set RALPH_GH_OWNER env var or pass explicitly)");
  const repo = args.repo || client.config.repo;  // undefined is OK
  return { owner, repo };
}

// Helper 2: full config with optional repo
export function resolveFullConfigOptionalRepo(
  client: GitHubClient,
  args: { owner?: string; repo?: string; projectNumber?: number },
): ResolvedConfigOptionalRepo {
  const { owner, repo } = resolveConfigOptionalRepo(client, args);
  const projectNumber = args.projectNumber ?? client.config.projectNumber;
  if (!projectNumber) throw new Error("projectNumber is required...");
  const projectOwner = resolveProjectOwner(client.config);
  if (!projectOwner) throw new Error("projectOwner is required...");
  return { owner, repo, projectNumber, projectOwner };
}
```

**Update `list_issues` at `issue-tools.ts:184`:**
```typescript
// Before:
const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(client, args);
// After:
const { owner, repo, projectNumber, projectOwner } = resolveFullConfigOptionalRepo(client, args);
```

**Pros:**
- Minimal surface area: 2 new helpers + 1 call site change
- `resolveConfig()` and `resolveFullConfig()` unchanged (all existing callers unaffected)
- Follows existing naming and structure patterns exactly
- `list_issues` is the highest-value target (most commonly called read-only tool)

**Cons:**
- Only fixes `list_issues` initially — other `resolveFullConfig()` callers that may also not need repo (e.g., `update_workflow_state`) are deferred

### Option B: Add Optional Flag to Existing Helpers

Add a `requireRepo?: boolean` parameter to `resolveConfig()` and `resolveFullConfig()`.

**Pros:** Fewer new exports
**Cons:** Breaks the clean throw-or-return contract; callers must pass flags; more complex type handling (conditional return type narrowing is tricky in TypeScript)

### Option C: Update All `resolveFullConfig()` Callers That Don't Use Repo

Audit all `resolveFullConfig()` callers to find those whose queries don't use repo, and switch them all.

**Pros:** More comprehensive fix
**Cons:** Large change surface for an S estimate; higher risk; deferred for future issue

## Recommendation

**Option A** — Add `resolveConfigOptionalRepo()` + `resolveFullConfigOptionalRepo()` + update `list_issues`. This is the correct foundation: the two new helpers are reusable by any future caller, `resolveConfig()` stays strict for write tools, and `list_issues` (the most impactful read-only tool) immediately benefits.

## Risks

- **`resolveFullConfigOptionalRepo()` callers must handle `repo?: string`**: The return type has `repo` as optional. Any caller must destructure carefully and only pass `repo` to downstream functions when it's defined.
- **`list_issues` doesn't use repo currently**: Switching it is safe — it will get `repo?: string` back and the value (whether defined or undefined) is unused in the primary query.
- **Other tools not updated**: `update_workflow_state`, `set_estimate`, `set_priority` and similar project-field tools also call `resolveFullConfig()` but may not need repo. These are out of scope for this issue — they can be updated in a follow-up.

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` - Add `ResolvedConfigOptionalRepo` interface, `resolveConfigOptionalRepo()`, and `resolveFullConfigOptionalRepo()` functions
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` - Update `list_issues` at line 184 to use `resolveFullConfigOptionalRepo()`
- `plugin/ralph-hero/mcp-server/src/__tests__/` - Add unit tests for both new helpers

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` - Existing `resolveConfig()`, `resolveFullConfig()`, `resolveProjectOwner()` patterns to follow
- `plugin/ralph-hero/mcp-server/src/types.ts` - `GitHubClientConfig` type (repo field is already `string | undefined`)
