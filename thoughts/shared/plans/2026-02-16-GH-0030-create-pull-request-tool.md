---
date: 2026-02-16
status: draft
github_issue: 30
github_url: https://github.com/cdubiel08/ralph-hero/issues/30
---

# create_pull_request MCP Tool with Auto-Linking to Issues

## Overview

Add a `ralph_hero__create_pull_request` MCP tool that creates GitHub pull requests via GraphQL, with optional auto-linking to issues via `Closes #N` keywords in the body. This establishes the `pr-tools.ts` module and extends the `PullRequest` type — both foundational for sibling issues #31, #32, #33 under parent #22.

## Current State Analysis

### No PR Tools Exist

The ralph-hero MCP server has no PR creation tools. The implementation skill shells out to `gh pr create` via bash ([ralph-impl SKILL.md:209](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-impl/SKILL.md#L209)), bypassing the MCP server's managed token system.

### Existing PullRequest Type Is Minimal

[types.ts:138-144](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L138-L144) has only `number`, `title`, `url`, `state`. Used by `ProjectV2Item.content` for project board display. All new fields must be optional for backward compatibility.

### `create_issue` Is the Reference Pattern

[issue-tools.ts:884-1050](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L884-L1050) shows the exact flow: `resolveConfig()` → fetch `repositoryId` (cached) → `client.mutate()` → cache node ID → return `toolSuccess()`. The PR tool follows this pattern but is simpler — no project field setup needed since PRs auto-appear on project boards via closing references.

### Tool Registration Pattern

All modules follow `registerXTools(server, client, fieldCache)` registered in [index.ts:286-294](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L286-L294).

## Desired End State

1. `ralph_hero__create_pull_request` tool creates PRs via GraphQL `createPullRequest` mutation
2. `linkedIssueNumbers` parameter auto-prepends `Closes #N` lines to PR body
3. `PullRequest` type extended with optional `body`, `isDraft`, `headRefName`, `baseRefName`, `createdAt`, `author` fields
4. `pr-tools.ts` module created and registered in `index.ts`
5. Supports draft PR creation via `draft` parameter

### Verification
- [ ] `npm run build` compiles with no type errors
- [ ] `npm test` passes with new pr-tools tests
- [ ] Calling `create_pull_request` with valid branches creates a PR and returns number, url, state
- [ ] Calling `create_pull_request` with `linkedIssueNumbers: [30]` creates a PR body containing `Closes #30`
- [ ] Calling `create_pull_request` with `draft: true` creates a draft PR
- [ ] Existing `list_project_items` still works with the extended `PullRequest` type

## What We're NOT Doing

- Not implementing PR querying/listing tools (sibling #31)
- Not implementing PR state transitions or merge (sibling #32)
- Not updating skills to use the new tool (sibling #33)
- Not auto-transitioning issues to "In Review" on PR creation (state management is skill responsibility)
- Not extracting `resolveConfig()` to a shared module (existing tech debt, consistent pattern)
- Not adding `addProjectV2ItemById` for the PR (GitHub auto-adds via closing references)

## Implementation Approach

Single phase — this is XS. Create `pr-tools.ts` following the `create_issue` pattern, extend `PullRequest` type, register in `index.ts`, add tests.

---

## Phase 1: PR Tools Module, Type Extension, and Registration

### Overview

Create the complete `create_pull_request` tool: new module, type extension, registration, and tests.

### Changes Required

#### 1. Extend PullRequest type
**File**: `plugin/ralph-hero/mcp-server/src/types.ts`

**Changes**: At [types.ts:138-144](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L138-L144), add optional fields to the existing interface:

```typescript
export interface PullRequest {
  __typename: "PullRequest";
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  // Extended fields (all optional for backward compatibility):
  body?: string;
  isDraft?: boolean;
  headRefName?: string;
  baseRefName?: string;
  createdAt?: string;
  author?: { login: string };
}
```

All new fields are optional — existing usage in `project-tools.ts` (`list_project_items`) is unaffected since it only reads `number`, `title`, `url`, `state`.

#### 2. Create PR tools module
**File**: `plugin/ralph-hero/mcp-server/src/tools/pr-tools.ts` (new)

**Contents** (~120 lines):

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { toolSuccess, toolError } from "../types.js";
```

**Private `resolveConfig` helper**: Same 15-line pattern as [issue-tools.ts:329-344](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L329-L344) — resolves `owner` and `repo` from args or client config. This is the 3rd copy (consistent with existing pattern).

**`registerPrTools(server, client, fieldCache)` function** containing:

**`ralph_hero__create_pull_request` tool**:

Tool description: `"Create a pull request with optional auto-linking to issues via Closes #N. Returns: number, url, state, isDraft, headBranch, baseBranch. Recovery: if branch not found, verify the head branch exists on the remote and has been pushed."`

Input schema:
```typescript
{
  owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
  repo: z.string().optional().describe("Repository name. Defaults to env var"),
  title: z.string().describe("PR title"),
  body: z.string().optional().describe("PR body (Markdown)"),
  baseBranch: z.string().describe("Target branch (e.g., 'main')"),
  headBranch: z.string().describe("Source branch (e.g., 'feature/GH-30')"),
  draft: z.boolean().optional().default(false).describe("Create as draft PR (default: false)"),
  linkedIssueNumbers: z.array(z.number()).optional().describe("Issue numbers to auto-link via 'Closes #N' in body"),
}
```

Handler implementation:

1. **Resolve config**: `resolveConfig(client, args)` → `{ owner, repo }`

2. **Fetch repository ID** (cached, 1-hour TTL):
   ```graphql
   query($owner: String!, $repo: String!) {
     repository(owner: $owner, name: $repo) { id }
   }
   ```

3. **Build PR body with issue links**: If `linkedIssueNumbers` provided and non-empty:
   ```typescript
   let finalBody = args.body || "";
   if (args.linkedIssueNumbers?.length) {
     const closingRefs = args.linkedIssueNumbers
       .map((n) => `Closes #${n}`)
       .join("\n");
     finalBody = finalBody
       ? `${closingRefs}\n\n${finalBody}`
       : closingRefs;
   }
   ```

4. **Create PR via mutation**:
   ```graphql
   mutation($repoId: ID!, $title: String!, $body: String, $baseRefName: String!, $headRefName: String!, $draft: Boolean) {
     createPullRequest(input: {
       repositoryId: $repoId,
       title: $title,
       body: $body,
       baseRefName: $baseRefName,
       headRefName: $headRefName,
       draft: $draft
     }) {
       pullRequest {
         id
         number
         title
         url
         state
         isDraft
         headRefName
         baseRefName
         createdAt
       }
     }
   }
   ```
   Variables: `{ repoId, title: args.title, body: finalBody || null, baseRefName: args.baseBranch, headRefName: args.headBranch, draft: args.draft || false }`

5. **Return result**:
   ```typescript
   toolSuccess({
     number: pr.number,
     url: pr.url,
     state: pr.state,
     isDraft: pr.isDraft,
     headBranch: pr.headRefName,
     baseBranch: pr.baseRefName,
     linkedIssues: args.linkedIssueNumbers || [],
   })
   ```

**Note**: No `addProjectV2ItemById` needed — PRs auto-appear on the project board when their body contains `Closes #N` for issues already on the board.

#### 3. Register PR tools in index.ts
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`

**Changes**:
- Add import at [~line 19](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L19):
  ```typescript
  import { registerPrTools } from "./tools/pr-tools.js";
  ```
- Add registration after relationship tools at [~line 294](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L294):
  ```typescript
  // Phase 5: Pull request tools
  registerPrTools(server, client, fieldCache);
  ```

#### 4. Add tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/pr-tools.test.ts` (new)

**Tests**:

Body building logic (pure function, no mocking needed):
- `linkedIssueNumbers: [10, 20]` with body "My PR" → body is `"Closes #10\nCloses #20\n\nMy PR"`
- `linkedIssueNumbers: [10]` with no body → body is `"Closes #10"`
- No `linkedIssueNumbers` with body "My PR" → body is `"My PR"`
- Empty `linkedIssueNumbers` array → body unchanged

Type compatibility:
- Extended `PullRequest` type is assignable from minimal response (only required fields)
- Extended `PullRequest` type accepts all new optional fields

### Success Criteria

#### Automated Verification
- [ ] `npm run build` — no type errors
- [ ] `npm test` — all tests pass (existing + new)
- [ ] `npx vitest run src/__tests__/pr-tools.test.ts` — focused test pass

#### Manual Verification
- [ ] Call `create_pull_request` on a test branch → PR created with correct title, body, branches
- [ ] Call with `linkedIssueNumbers: [30]` → PR body contains `Closes #30`
- [ ] Call with `draft: true` → PR created as draft
- [ ] Verify existing `list_project_items` still works (no type regression)

---

## Testing Strategy

Extract the body-building logic into a pure `buildPrBody(userBody, linkedIssueNumbers)` function exported from `pr-tools.ts` for easy unit testing. The mutation itself is tested manually since mocking the full GraphQL client is disproportionate for an XS issue.

## Integration Testing

After phase complete:
- [ ] `npm run build` — clean compile
- [ ] `npm test` — all tests pass
- [ ] `create_pull_request` creates PR via GraphQL (not `gh` CLI)
- [ ] PR with `Closes #N` auto-appears on project board when issue #N is on the board
- [ ] Existing tools (`list_project_items`, `get_issue`) unaffected by `PullRequest` type changes

## Group Context

This is issue 1 of 4 under parent #22 (PR Lifecycle Management):
- **#30** (this) → Creates `pr-tools.ts` + extends `PullRequest` type
- #31 → Adds `get_pull_request` + `list_pull_requests` read tools (builds on `pr-tools.ts`)
- #32 → Adds `update_pull_request_state` with merge support (builds on `pr-tools.ts`)
- #33 → Updates skills to use PR MCP tools instead of `gh` CLI (depends on #30-#32)

## References

- [Issue #30](https://github.com/cdubiel08/ralph-hero/issues/30)
- [Parent Issue #22](https://github.com/cdubiel08/ralph-hero/issues/22)
- [Research: GH-30](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-16-GH-0030-create-pull-request-tool.md)
- [issue-tools.ts — create_issue pattern](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L884-L1050)
- [types.ts — PullRequest interface](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L138-L144)
- [index.ts — tool registration](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L286-L294)
