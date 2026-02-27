---
date: 2026-02-27
github_issue: 438
github_url: https://github.com/cdubiel08/ralph-hero/issues/438
status: complete
type: research
---

# GH-438: Change resolveRepoFromProject() 2+ Repos Branch from Error to Warning

## Problem Statement

`resolveRepoFromProject()` at `helpers.ts:451-455` throws an error when a project has 2+ linked repositories. Enterprise projects almost always span multiple repos, so this error fires at every startup for multi-repo users. Since `client.config.repo` is typed as `repo?: string` (already optional) and startup is already wrapped in a non-fatal try/catch, the function simply needs to return `undefined` instead of throwing — and log a warning to inform the user.

## Current State Analysis

### Function Signature (`helpers.ts:420`)

```typescript
export async function resolveRepoFromProject(client: GitHubClient): Promise<string>
```

Return type is `Promise<string>` — the function must resolve to a string or throw. The 2+ repos branch at lines 451-455 currently always throws:

```typescript
const repoList = result.repos.map(r => r.nameWithOwner).join(", ");
throw new Error(
  `Multiple repos linked to project: ${repoList}. ` +
  "Set RALPH_GH_REPO to select which repo to use as default."
);
```

### `GitHubClientConfig.repo` is Already Optional (`types.ts:264-273`)

```typescript
export interface GitHubClientConfig {
  owner?: string;
  repo?: string;   // ← already optional; undefined is a valid runtime state
  projectNumber?: number;
  // ...
}
```

The type system already supports `repo` being undefined. The only issue is the return type annotation on `resolveRepoFromProject` which forces `Promise<string>`.

### Startup is Already Non-Fatal (`index.ts:300-312`)

```typescript
try {
  await resolveRepoFromProject(client);
  if (client.config.repo) {           // ← already guards with undefined check
    console.error(`[ralph-hero] Repo: ${...}`);
  }
} catch (e) {
  console.error(`[ralph-hero] Repo inference skipped: ${...}`);
}
```

When the function returns `undefined` (instead of throwing), `client.config.repo` will be undefined. The existing `if (client.config.repo)` guard at line 303 already handles this correctly — it simply won't log the repo line. However, there will be no user-visible message explaining why no default repo was set. A dedicated log for the multi-repo case is needed.

### Existing Test Coverage (`repo-inference.test.ts:121-142`)

Test at line 121 expects a throw for the 2+ repos case:
```typescript
await expect(resolveRepoFromProject(mockClient)).rejects.toThrow(
  "Multiple repos linked to project: owner/repo-a, owner/repo-b",
);
```
This test must be updated to expect `undefined` return + console.error warning instead.

### Runtime Consumers of `client.config.repo`

All callers already handle the undefined case:
- `debug-tools.ts:305` — guards with `if (!owner || !repo)` before use
- `routing-tools.ts:192` — guards with `if (!owner || !repo)` before use
- `project-tools.ts:381` — guards with `if (configOwner && configRepo)` (best-effort)
- `index.ts:150` — guards with `if (client.config.owner && client.config.repo)`
- `index.ts:272` — uses `|| "(not set)"` fallback for display
- `resolveConfig()` at `helpers.ts:462-477` — throws with helpful message if `repo` is needed by a specific tool call

No consumer will break when `client.config.repo` is undefined — they all have guards.

## Key Discoveries

### `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:420`
Return type annotation `Promise<string>` must change to `Promise<string | undefined>`.

### `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:451-455`
The throw is the only change needed to the function logic — replace with `console.error` + `return undefined`.

### `plugin/ralph-hero/mcp-server/src/index.ts:300-312`
The try/catch already handles success (undefined return) gracefully via `if (client.config.repo)` guard. However, the multi-repo warning needs to be surfaced to the user. Two options:
- Option A: Log the warning inside `resolveRepoFromProject()` itself (before returning undefined)
- Option B: Add a new conditional in `index.ts` after the call to check if `repo` is still undefined and log a message

Option A is simpler — the context (which repos are linked) is already present inside the function.

### `plugin/ralph-hero/mcp-server/src/__tests__/repo-inference.test.ts:121-142`
Must update test expectation from `rejects.toThrow()` to `resolves.toBeUndefined()` + verify `console.error` was called.

## Potential Approaches

### Option A: Warn Inside Function, Return undefined (Recommended)

Replace the throw at `helpers.ts:451-455` with a `console.error` warning and `return undefined`:

```typescript
const repoList = result.repos.map(r => r.nameWithOwner).join(", ");
console.error(
  `[ralph-hero] Multiple repos linked to project: ${repoList}. ` +
  `Set RALPH_GH_REPO to select the default repo. ` +
  `Read-only tools will work; write tools require an explicit repo param.`
);
return undefined;
```

Update return type: `Promise<string | undefined>`.

**Pros:**
- Warning message has full context (repo list) because it's inside the function
- Minimal change: 5 lines replaced, 1 type updated, 1 test updated
- `index.ts` try/catch and `if (client.config.repo)` guard unchanged
- All runtime consumers already handle `undefined` repo

**Cons:**
- Warning fires every time `resolveRepoFromProject()` is called when 2+ repos linked (only once at startup, so acceptable)

### Option B: Throw + Catch + Log in index.ts

Keep the throw, but catch it in `index.ts` and emit a warning log instead of the current "inference skipped" message.

**Pros:** Function signature stays `Promise<string>`
**Cons:** Error message at throw site is now misleading (looks like an error, is treated as a warning); callers that call `resolveRepoFromProject` directly would still get an error. More fragile.

## Recommendation

**Option A** — Change the 2+ repos branch to log a warning and return `undefined`. This is a minimal, clean fix:
1. 5 lines changed in `helpers.ts` (throw → console.error + return undefined)
2. Return type updated from `Promise<string>` to `Promise<string | undefined>`
3. 1 test updated in `repo-inference.test.ts`
4. No changes to `index.ts` (existing guards handle the case)

## Risks

- **`resolveConfig()` still strict**: When a tool actually needs `repo`, `resolveConfig()` will still throw with a helpful message ("repo is required..."). This is correct behavior — the warning at startup informs the user, and per-tool errors guide them when they try a write operation without setting `RALPH_GH_REPO`.
- **No consumers break**: All callers of `client.config.repo` already guard against undefined.
- **Test update required**: The existing test at `repo-inference.test.ts:121` must change from throw expectation to undefined + warning expectation.

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` - Change 2+ repos branch from throw to console.error + return undefined; update return type to `Promise<string | undefined>`
- `plugin/ralph-hero/mcp-server/src/__tests__/repo-inference.test.ts` - Update test at line 121 to expect undefined + console.error instead of throw

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/index.ts` - Startup call site (lines 300-312); existing guard already handles undefined
- `plugin/ralph-hero/mcp-server/src/types.ts` - GitHubClientConfig.repo type (already optional)
