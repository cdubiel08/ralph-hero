---
date: 2026-02-16
github_issue: 22
github_url: https://github.com/cdubiel08/ralph-hero/issues/22
status: complete
type: research
---

# GH-22: PR Lifecycle Management - MCP Tools for Pull Request Creation and Tracking

## Problem Statement

The ralph-hero workflow currently creates pull requests by shelling out to `gh pr create` via bash (in [ralph-impl SKILL.md:209](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-impl/SKILL.md#L209) and [ralph-team SKILL.md Section 4.5](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md)). This approach has several problems:

1. **Token isolation** - `gh` CLI uses its own ambient auth, bypassing the MCP server's managed token system
2. **No project board integration** - PRs created via `gh` CLI are not tracked on the GitHub Projects V2 board
3. **No workflow state coupling** - PR state changes (merge, review requests) don't automatically update issue workflow states
4. **No traceability** - No programmatic link between PR status and pipeline metrics

## Current State Analysis

### Existing MCP Server Architecture

The ralph-hero MCP server ([mcp-server/src/index.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts)) registers tools in 4 modules:

| Module | File | Lines | Tools |
|--------|------|-------|-------|
| Project | [project-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts) | 744 | `setup_project`, `get_project`, `list_project_items` |
| Views | [view-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/view-tools.ts) | 345 | `list_views`, `update_field_options` |
| Issues | [issue-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts) | 2027 | `get_issue`, `create_issue`, `update_issue`, `list_issues`, `create_comment`, `update_workflow_state`, `update_estimate`, `update_priority`, `pick_actionable_issue` |
| Relationships | [relationship-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts) | 984 | `add_sub_issue`, `list_sub_issues`, `add_dependency`, `remove_dependency`, `list_dependencies`, `detect_group`, `advance_children` |

**Total**: ~4,100 lines, 20 tools. No PR-related tools exist.

### GitHub Client Infrastructure

The [github-client.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/github-client.ts) provides:
- **4 execution methods**: `query` (repo read), `mutate` (repo write), `projectQuery` (project read), `projectMutate` (project write)
- **Token management**: Separate repo and project tokens via `RALPH_GH_REPO_TOKEN` / `RALPH_GH_PROJECT_TOKEN`
- **Rate limiting**: Auto-injects `rateLimit` fragment into queries, proactive tracking via [rate-limiter.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/rate-limiter.ts)
- **Caching**: [SessionCache](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts) with TTL for queries; `FieldOptionCache` for project fields
- **Pagination**: [pagination.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pagination.ts) handles cursor-based GraphQL pagination

PR operations would use `client.mutate()` (repo token) since PRs are repository-level, not project-level.

### Existing Type Support

[types.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts) already includes:
- `PullRequest` interface (line 138): `number`, `title`, `url`, `state` (OPEN/CLOSED/MERGED)
- `ProjectV2Item.type` includes `"PULL_REQUEST"` (line 126)
- `ProjectV2Item.content` union includes `PullRequest` (line 128)

These types are minimal and would need expansion for full PR lifecycle support.

### Current PR Workflow in Skills

**ralph-impl** (implementer creates PR):
- Step 9.3 ([SKILL.md:209](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-impl/SKILL.md#L209)): Uses `gh pr create` with body template including `Closes #NNN`
- Step 9.5: PR Gate - pauses for review
- Step 10: Moves issues to "In Review" via `update_workflow_state`

**ralph-team** (lead creates PR):
- Section 4.5: Lead pushes and creates PR via `gh pr create` after implementation completes
- Moves issues to "In Review" via `advance_children`
- "Done" state is terminal - only reachable via external PR merge event

### Workflow State Machine

[workflow-states.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts) defines the pipeline:
```
Backlog → Research Needed → Research in Progress → Ready for Plan →
Plan in Progress → Plan in Review → In Progress → In Review → Done
```

PR lifecycle maps to the final stages:
- `In Progress` → PR created (draft possible)
- `In Review` → PR marked ready, reviewers requested
- `Done` → PR merged (currently manual/external)

### External PR Tools Already Available

The GitHub MCP plugin (already loaded as a Claude Code plugin) provides PR tools:
- `mcp__plugin_github_github__create_pull_request`
- `mcp__plugin_github_github__pull_request_read`
- `mcp__plugin_github_github__pull_request_review_write`
- `mcp__plugin_github_github__merge_pull_request`
- `mcp__plugin_github_github__update_pull_request`
- `mcp__plugin_github_github__update_pull_request_branch`
- `mcp__plugin_github_github__list_pull_requests`

These use the GitHub plugin's own auth, separate from ralph-hero's managed tokens.

## Key Discoveries

### 1. GitHub GraphQL API PR Surface

The GitHub GraphQL API provides comprehensive PR mutations:
- `createPullRequest` - Create PR with base/head branches, title, body, draft status
- `mergePullRequest` - Merge with strategy (MERGE, SQUASH, REBASE)
- `updatePullRequest` - Update title, body, state, base branch
- `markPullRequestReadyForReview` - Convert draft to ready
- `convertPullRequestToDraft` - Convert ready to draft
- `requestReviews` - Request reviews from users/teams
- `addPullRequestReview` - Submit a review (APPROVE, REQUEST_CHANGES, COMMENT)

All of these can be called via `client.mutate()` using the existing repo token.

### 2. PR-to-Project Board Linking

GitHub Projects V2 automatically adds PRs that close issues in the project. When a PR body contains `Closes #NNN` and issue #NNN is on the project board, the PR also appears as a `ProjectV2Item` with `type: "PULL_REQUEST"`. This means:
- PRs created with `Closes #NNN` auto-appear on the board
- No manual `addProjectV2ItemById` mutation needed for linked PRs
- PR field values (workflow state) can be read/updated via existing project tools

### 3. Webhook Gap for Auto-State Transitions

The MCP server runs as a stdio process - it has no HTTP endpoint for GitHub webhooks. Auto-transitioning issue state on PR merge would require either:
- **Polling**: Periodic `gh pr status` or GraphQL query (wasteful, latency)
- **GitHub Actions**: A workflow triggered on `pull_request.merged` that calls the MCP or directly updates the project board
- **Skill-level check**: When ralph-team or ralph-impl starts, check for merged PRs and transition issues

### 4. `@octokit/graphql` v9 Variable Name Restrictions

Per CLAUDE.md: `@octokit/graphql` v9 reserves `query`, `method`, and `url` as option keys. GraphQL variable names must avoid these. For PR tools, use names like `repositoryId`, `baseRefName`, `headRefName` instead of any reserved words.

### 5. Tool Registration Pattern

All tool modules follow the same pattern ([issue-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts)):
```typescript
export function registerPrTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  server.tool("ralph_hero__tool_name", "description", { ...zodSchema }, async (args) => {
    try {
      const { owner, repo } = resolveConfig(client, args);
      // ... implementation
      return toolSuccess(result);
    } catch (error) {
      return toolError(`Failed: ${message}`);
    }
  });
}
```

## Potential Approaches

### Approach A: Full Custom PR Tools in Ralph-Hero MCP Server

Build a new `pr-tools.ts` module with 4 tools matching the issue spec.

**Pros:**
- Full control over token management, caching, rate limiting
- Consistent API surface with existing ralph-hero tools
- Can integrate workflow state transitions directly (e.g., auto-move to "In Review" on PR creation)
- PR status visible via project board queries

**Cons:**
- Significant implementation effort (~800-1200 lines estimated)
- Partially duplicates GitHub MCP plugin functionality
- Maintenance burden for GitHub API changes
- PR operations are repo-level, not project-level (the core value-add of ralph-hero)

### Approach B: Skill-Level Integration Using GitHub MCP Plugin

Update ralph-impl and ralph-team skills to use the existing GitHub MCP plugin tools instead of `gh` CLI.

**Pros:**
- Minimal code changes (skill markdown updates only)
- Leverages maintained GitHub MCP plugin
- No new MCP server code to maintain

**Cons:**
- Different token management (GitHub plugin auth vs ralph-hero tokens)
- No project board integration for PRs
- No workflow state coupling
- Doesn't fulfill the acceptance criteria for new MCP tools

### Approach C: Thin Wrapper Tools with Workflow Integration (Recommended)

Build lightweight PR tools in ralph-hero that handle the unique value-add (workflow state coupling, project board integration) while keeping the GraphQL surface minimal.

**Proposed tools:**

1. **`ralph_hero__create_pull_request`** (~200 lines)
   - GraphQL `createPullRequest` mutation
   - Auto-add `Closes #NNN` to body for linked issues
   - Set draft status based on current workflow state
   - Move linked issues to "In Review" automatically
   - Return PR number, URL, state

2. **`ralph_hero__get_pull_request`** (~150 lines)
   - GraphQL query for PR details: state, reviews, check runs, merge conflicts
   - Resolve linked issues from PR body (`Closes #NNN` parsing)
   - Include check suite status summary

3. **`ralph_hero__update_pull_request_state`** (~200 lines)
   - `markPullRequestReadyForReview` / `convertPullRequestToDraft`
   - `requestReviews` for reviewer assignment
   - `mergePullRequest` with strategy selection
   - Auto-transition linked issues on merge (→ Done)

4. **`ralph_hero__list_pull_requests`** (~150 lines)
   - List PRs filtered by issue link, state, author
   - CI/review status summary per PR

**Pros:**
- Focused on ralph-hero's unique value (workflow integration)
- Uses existing infrastructure (client, cache, rate limiting)
- Moderate implementation effort (~700 lines)
- State machine integration built-in

**Cons:**
- Still some overlap with GitHub MCP plugin
- Need to extend `PullRequest` types

### Approach D: Hybrid - MCP Tools + GitHub Action for Merge Events

Combine Approach C with a GitHub Action for the "PR merged → Done" transition.

**Additional component:**
```yaml
# .github/workflows/pr-merged.yml
on:
  pull_request:
    types: [closed]
jobs:
  update-project:
    if: github.event.pull_request.merged
    # Parse "Closes #NNN" from body, update project field values
```

**Pros:**
- Solves the webhook gap for auto-state transitions
- No polling needed
- Clean separation of concerns

**Cons:**
- Additional infrastructure to maintain
- GitHub Action needs project token access
- Adds complexity outside the MCP server

## Risks and Considerations

1. **Scope creep** - The issue is estimated L (Large). Building all 4 tools plus workflow integration is substantial. Consider splitting into sub-issues: (a) create/get PR tools, (b) state management tools, (c) merge automation.

2. **Token scopes** - PR operations require `repo` scope on the token. The existing `RALPH_HERO_GITHUB_TOKEN` likely already has this, but should be verified. Merge operations may need additional permissions.

3. **Rate limiting** - PR queries can be expensive (reviews, check suites involve nested connections). The rateLimit auto-injection will help, but complex PR status queries should use caching.

4. **Duplicate functionality** - The GitHub MCP plugin already provides PR tools. Need to clearly differentiate ralph-hero's PR tools (workflow integration) from the plugin's (raw GitHub operations).

5. **State machine updates** - Adding PR-related commands to [state-resolution.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts) requires careful design. A new `ralph_pr` command might need entries in `SEMANTIC_INTENTS` and `COMMAND_ALLOWED_STATES`.

6. **Testing** - PR creation is a side-effectful mutation. Tests will need mocking of the GraphQL client. Existing test patterns in [__tests__/](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/) should be followed.

## Recommended Next Steps

1. **Split this L-size issue** into 3-4 XS/S sub-issues:
   - XS: `create_pull_request` tool with auto-linking
   - S: `get_pull_request` and `list_pull_requests` tools
   - S: `update_pull_request_state` tool with merge + workflow transitions
   - XS: Update ralph-impl and ralph-team skills to use new MCP tools

2. **Follow Approach C** (Thin Wrapper with Workflow Integration) for initial implementation

3. **Defer Approach D** (GitHub Action for merge events) to a future issue - the skill-level check for merged PRs is sufficient for MVP

4. **Extend types.ts** with full `PullRequest` interface including reviews, checks, merge status

5. **Add `pr-tools.ts`** as a new tool module, registered in `index.ts` as "Phase 5"
