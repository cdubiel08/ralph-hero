---
date: 2026-02-16
github_issue: 30
github_url: https://github.com/cdubiel08/ralph-hero/issues/30
status: complete
type: research
---

# Research: GH-30 - create_pull_request MCP Tool with Auto-Linking to Issues

## Problem Statement

The ralph-hero workflow creates PRs by shelling out to `gh pr create` via bash ([ralph-impl SKILL.md:209](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-impl/SKILL.md#L209)). This bypasses the MCP server's managed token system, doesn't integrate with the GitHub Projects V2 board, and provides no programmatic traceability. Issue #30 is the foundational tool that creates `pr-tools.ts` and the extended `PullRequest` type, which sibling issues #31, #32, #33 depend on.

## Current State Analysis

### Existing PullRequest Type

[types.ts:138-144](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L138-L144) — minimal interface:
```typescript
export interface PullRequest {
  __typename: "PullRequest";
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
}
```

Used by `ProjectV2Item.content` ([types.ts:128](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L128)) and `list_project_items` ([project-tools.ts:454](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L454)) for project board display.

### Tool Registration Pattern

All modules follow the same pattern ([index.ts:16-19](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L16-L19), [286-294](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L286-L294)):

```typescript
import { registerPrTools } from "./tools/pr-tools.js";
// ...
registerPrTools(server, client, fieldCache);
```

Function signature ([issue-tools.ts:370-374](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L370-L374)):
```typescript
export function registerPrTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void { /* ... */ }
```

### Repo-Level Mutations

PR operations use `client.mutate()` ([github-client.ts:217-225](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/github-client.ts#L217-L225)) — repo token, not project token. This matches the existing `create_comment` pattern ([issue-tools.ts:1408-1465](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1408-L1465)).

### Config Resolution Helpers

`resolveConfig()` is a private function duplicated in both [issue-tools.ts:329-344](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L329-L344) and [relationship-tools.ts:61](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L61). A third copy will be needed in `pr-tools.ts`. This is an existing tech debt pattern — not ideal but consistent.

### Parent Research

[GH-22 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-16-GH-0022-pr-lifecycle-management.md) recommends "Approach C: Thin Wrapper Tools with Workflow Integration" — lightweight PR tools focused on workflow state coupling and project board integration.

## Key Discoveries

### 1. GraphQL `createPullRequest` Mutation Is Straightforward

**Input fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `repositoryId` | `ID!` | Yes | Node ID of target repo |
| `baseRefName` | `String!` | Yes | Target branch (e.g., `"main"`) |
| `headRefName` | `String!` | Yes | Source branch (e.g., `"feature/GH-30"`) |
| `title` | `String!` | Yes | PR title |
| `body` | `String` | No | PR description (Markdown) |
| `draft` | `Boolean` | No | Create as draft PR |
| `maintainerCanModify` | `Boolean` | No | Allow maintainer pushes |

**Return fields:**
```graphql
createPullRequest(input: { ... }) {
  pullRequest {
    id number title url state isDraft
    headRefName baseRefName createdAt
    permalink
  }
}
```

The mutation uses `client.mutate()` (repo token). The `repositoryId` can be fetched via the same cached query pattern used by `create_issue` ([issue-tools.ts:925](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L925)):
```graphql
query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) { id }
}
```

### 2. Issue Auto-Linking Is Text-Based Only

There is no `linkedIssueNumbers` API parameter. GitHub parses the PR body for closing keywords:
- `Closes #NNN`, `Fixes #NNN`, `Resolves #NNN` (case-insensitive)
- When merged into the default branch, referenced issues are auto-closed

The `PullRequest` object has a read-only `closingIssuesReferences` connection to query linked issues:
```graphql
closingIssuesReferences(first: 10) {
  nodes { number title state }
}
```

**Implementation**: The tool should accept a `linkedIssueNumbers` parameter (array of numbers), then prepend `Closes #N` lines to the user-provided body before calling the mutation.

### 3. `@octokit/graphql` v9 Variable Restrictions Are Already Handled

Reserved names: `query`, `method`, `url`. These cannot be used as GraphQL variable names.

The `createPullRequest` mutation uses `repositoryId`, `title`, `body`, `baseRefName`, `headRefName`, `draft` — none conflict. The existing codebase already avoids these names throughout.

### 4. Existing `create_issue` Is the Closest Pattern to Follow

[issue-tools.ts:884-1050](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L884-L1050) shows the pattern:

1. `resolveConfig()` for owner/repo
2. Fetch repo ID via cached query (1 hour TTL)
3. Call `client.mutate()` with the creation mutation
4. Cache the new node ID
5. Return structured result via `toolSuccess()`

The `create_pull_request` tool follows the same flow, minus the project field setup (PRs auto-appear on project boards when they close linked issues).

### 5. PRs Auto-Appear on Project Board via Closing References

When a PR body contains `Closes #NNN` and issue #NNN is on the project board, GitHub automatically adds the PR as a `ProjectV2Item` with `type: "PULL_REQUEST"`. No manual `addProjectV2ItemById` call needed.

### 6. Hook Script Will Need Updating

[impl-verify-pr.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/impl-verify-pr.sh) checks for `gh pr create` in tool output. When the MCP tool replaces the CLI command, this hook will need to check for the MCP tool instead. This is out of scope for #30 but should be tracked (part of #33).

## Implementation Plan

### New File: `pr-tools.ts`

```
plugin/ralph-hero/mcp-server/src/tools/pr-tools.ts
```

Structure (~120-150 lines for just `create_pull_request`):

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitHubClient } from "../github-client.js";
import { FieldOptionCache } from "../lib/cache.js";
import { toolSuccess, toolError } from "../types.js";

// Private resolveConfig helper (same pattern as issue-tools.ts:329-344)

export function registerPrTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  server.tool(
    "ralph_hero__create_pull_request",
    "Create a pull request with optional auto-linking to issues. ...",
    { /* Zod schema */ },
    async (args) => { /* handler */ },
  );
}
```

### Tool Parameters (Zod Schema)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `owner` | `z.string().optional()` | No | Defaults to env var |
| `repo` | `z.string().optional()` | No | Defaults to env var |
| `title` | `z.string()` | Yes | PR title |
| `body` | `z.string().optional()` | No | PR body (Markdown) |
| `baseBranch` | `z.string()` | Yes | Target branch |
| `headBranch` | `z.string()` | Yes | Source branch |
| `draft` | `z.boolean().optional()` | No | Create as draft (default: false) |
| `linkedIssueNumbers` | `z.array(z.number()).optional()` | No | Issue numbers to auto-link via `Closes #N` |

### Handler Flow

1. `resolveConfig(client, args)` — get owner/repo
2. Fetch `repositoryId` via cached query (reuse pattern from `create_issue`)
3. Build body: if `linkedIssueNumbers` provided, prepend `Closes #N` lines to user body
4. Call `createPullRequest` mutation via `client.mutate()`
5. Return `toolSuccess({ number, url, state, isDraft, headBranch, baseBranch })`

### Type Extension in `types.ts`

Extend `PullRequest` interface at [types.ts:138-144](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L138-L144):

```typescript
export interface PullRequest {
  __typename: "PullRequest";
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  // New fields for #30:
  body?: string;
  isDraft?: boolean;
  headRefName?: string;
  baseRefName?: string;
  createdAt?: string;
  author?: { login: string };
  // Fields for #31 (sibling, not needed yet):
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
}
```

All new fields are optional to maintain backward compatibility with existing usage in `project-tools.ts`.

### Registration in `index.ts`

Add at [index.ts:19](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L19):
```typescript
import { registerPrTools } from "./tools/pr-tools.js";
```

Add after [index.ts:294](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L294):
```typescript
// Phase 5: Pull request tools
registerPrTools(server, client, fieldCache);
```

## Risks and Considerations

1. **Repo ID resolution adds 1 query**: The `repositoryId` needs fetching before mutation. Using the same cached pattern as `create_issue` (1-hour TTL), this is a one-time cost per session. Negligible impact.

2. **`resolveConfig()` duplication**: This is the 3rd copy of a 15-line helper. Not ideal but consistent with existing patterns. Could be extracted to a shared module in a future cleanup (see also #21 batch operations research which identified the same tech debt).

3. **Body manipulation for issue linking**: Prepending `Closes #N` lines must handle edge cases:
   - User provides no body → body is just the closing references
   - User provides body → prepend closing references with blank line separator
   - Empty `linkedIssueNumbers` array → no modification

4. **Branch existence not validated**: The mutation will fail if the head branch doesn't exist on the remote. The error message from GitHub is clear enough — no pre-validation needed.

5. **Draft PR default**: The issue says `draft` is optional. Default should be `false` (non-draft) to match `gh pr create` behavior and GitHub API default.

6. **No workflow state transition on create**: The issue spec does not include auto-moving issues to "In Review" on PR creation. That's appropriate — PR creation happens during "In Progress" phase. The state transition to "In Review" is handled by the skill after PR is ready for review.

## Group Context

This issue is part of a 4-issue group under parent #22:

| Order | Issue | Title | Estimate | State |
|-------|-------|-------|----------|-------|
| 1 | **#30** | create_pull_request MCP tool (this issue) | XS | Research in Progress |
| 2 | #31 | get/list_pull_requests read tools | S | Backlog |
| 3 | #32 | update_pull_request_state with merge | S | Backlog |
| 4 | #33 | Update skills to use PR MCP tools | XS | Backlog |

#30 is the foundation — it creates `pr-tools.ts` and extends `PullRequest` type. #31, #32, #33 all build on #30.

## Recommended Next Steps

1. **Implement `pr-tools.ts`** with `create_pull_request` following the `create_issue` pattern
2. **Extend `PullRequest` type** in `types.ts` with new optional fields
3. **Register in `index.ts`** as Phase 5
4. **Add unit tests** mocking the GraphQL client (follow `github-client.test.ts` patterns)
5. **Move siblings #31, #32, #33 to Research Needed** once #30 is implemented — they build on the module created here
