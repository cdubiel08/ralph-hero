---
date: 2026-02-16
status: draft
github_issues: [31, 32]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/31
  - https://github.com/cdubiel08/ralph-hero/issues/32
parent_issue: 22
---

# PR Read Tools + State Management (Unified Plan for #31 & #32)

## Overview

Add three MCP tools to the existing `pr-tools.ts` module:
1. `ralph_hero__get_pull_request` — detailed PR inspection (reviews, CI, merge status, linked issues)
2. `ralph_hero__list_pull_requests` — filtered PR listing with compact summaries
3. `ralph_hero__update_pull_request_state` — draft/ready transitions, reviewer assignment, merge with auto-Done for linked issues

Both issues modify `pr-tools.ts` (created by #30 in GH-22 worktree). This plan unifies them into 3 sequential phases to avoid merge conflicts.

## Current State Analysis

### Existing PR Infrastructure (from #30, GH-22 worktree)

`pr-tools.ts` provides:
- `registerPrTools(server, client, _fieldCache)` — tool registration function
- `resolveConfig(client, args)` — local config resolver (duplicates `helpers.ts`, should be replaced)
- `buildPrBody(userBody, linkedIssueNumbers)` — pure helper (exported for testing)
- `ralph_hero__create_pull_request` — single tool using `client.mutate()`

### State Resolution Gap for merge → Done

Per `state-resolution.ts`, neither `ralph_impl` nor `ralph_hero` can produce "Done" state. The `__CLOSE__` wildcard intent resolves to "Done" for any command, but the `COMMAND_ALLOWED_STATES` validation gate rejects "Done" for all commands except `ralph_triage`.

**Solution**: Add a `ralph_pr` command to `state-resolution.ts` with allowed states `["In Review", "Done", "Human Needed"]`. This keeps PR operations as a distinct domain from implementation.

### update_workflow_state vs handoff_ticket (#19)

The #32 issue spec references `update_workflow_state` for Done transitions. Issue #19 introduced `handoff_ticket` as a replacement, but #19 is **not yet merged to main**. The current main branch (and this worktree) still has `update_workflow_state`.

**Decision**: Use `update_workflow_state` with `state: "__CLOSE__"` and `command: "ralph_pr"` for the initial implementation. The merge handler calls the existing tool's internal pattern (resolveState + updateProjectItemField) directly rather than going through MCP tool dispatch. Add `// TODO: Replace with handoff_ticket after #19 merges` comment.

## Desired End State

1. `ralph_hero__get_pull_request` returns full PR details including reviews, CI status, mergeability, linked issues
2. `ralph_hero__list_pull_requests` returns filtered PR lists with compact summaries
3. `ralph_hero__update_pull_request_state` handles draft/ready, reviewer assignment, and merge with auto-Done
4. `ralph_pr` command added to `state-resolution.ts` for merge → Done transitions
5. All pure helper functions exported and unit-tested
6. Existing `create_pull_request` tool unaffected

### Verification
- [ ] `npm run build` compiles with no type errors
- [ ] `npm test` passes with all new tests
- [ ] `get_pull_request` returns reviews, CI status, mergeability, linked issues
- [ ] `list_pull_requests` supports state/author/baseBranch filters
- [ ] `update_pull_request_state` merge action transitions linked issues to "Done"
- [ ] `ralph_pr` command resolves `__CLOSE__` → "Done" in state-resolution

## What We're NOT Doing

- Not implementing `handoff_ticket` integration (waiting for #19 to merge)
- Not auto-transitioning issues on PR creation (that's skill responsibility, not tool responsibility)
- Not adding GitHub search API for author filtering (client-side filter is sufficient for < 100 PRs)
- Not implementing webhook-based PR event handling
- Not updating skills to use new tools (that's #33)
- Not adding pagination to `get_pull_request` review/check lists (50-item limit is sufficient)

## Implementation Approach

Three phases, executed sequentially. Phase 1 adds pure helpers + read tools, Phase 2 adds the state management tool, Phase 3 adds tests for all new code.

---

## Phase 1: Pure Helpers + Read Tools (`get_pull_request`, `list_pull_requests`)

### Overview

Add shared pure helper functions and two read-only tools to `pr-tools.ts`. Replace the local `resolveConfig` with the shared import. Register tools.

### Changes Required

#### 1. Replace local resolveConfig with shared import
**File**: `plugin/ralph-hero/mcp-server/src/tools/pr-tools.ts`

Remove the local `resolveConfig` function (lines 18-33 in GH-22 version) and import from helpers:

```typescript
import { resolveConfig } from "../lib/helpers.js";
```

Also add new imports needed for read tools:

```typescript
import { paginateConnection } from "../lib/pagination.js";
```

#### 2. Add pure helper functions
**File**: `plugin/ralph-hero/mcp-server/src/tools/pr-tools.ts`

Add these exported pure functions after `buildPrBody`:

**`parseLinkedIssues(body: string | null): number[]`** — Extract issue numbers from `Closes #N`, `Fixes #N`, `Resolves #N` patterns:
```typescript
const CLOSING_PATTERN = /(?:closes?|fixes?|resolves?)\s+#(\d+)/gi;

export function parseLinkedIssues(body: string | null): number[] {
  if (!body) return [];
  const matches = [...body.matchAll(CLOSING_PATTERN)];
  return [...new Set(matches.map(m => parseInt(m[1], 10)))];
}
```

**`summarizeReviews(reviews)`** — De-duplicate reviews by author (keep latest per author), return counts:
```typescript
export interface ReviewSummary {
  approved: number;
  changesRequested: number;
  pending: number;
  total: number;
  details: Array<{ login: string; state: string }>;
}

export function summarizeReviews(
  reviews: Array<{ state: string; author: { login: string } | null }>,
): ReviewSummary {
  const byAuthor = new Map<string, string>();
  for (const r of reviews) {
    const login = r.author?.login || "unknown";
    byAuthor.set(login, r.state);
  }

  let approved = 0, changesRequested = 0, pending = 0;
  for (const state of byAuthor.values()) {
    if (state === "APPROVED") approved++;
    else if (state === "CHANGES_REQUESTED") changesRequested++;
    else pending++;
  }

  const details = [...byAuthor.entries()].map(([login, state]) => ({ login, state }));
  return { approved, changesRequested, pending, total: byAuthor.size, details };
}
```

**`summarizeChecks(contexts)`** — Categorize check runs and status contexts:
```typescript
export interface CheckSummary {
  overall: string | null;
  success: number;
  failure: number;
  pending: number;
  total: number;
}

export function summarizeChecks(
  overallState: string | null,
  contexts: Array<{ name?: string; status?: string; conclusion?: string | null; context?: string; state?: string }>,
): CheckSummary {
  let success = 0, failure = 0, pending = 0;
  for (const ctx of contexts) {
    if ("conclusion" in ctx && ctx.conclusion !== undefined) {
      if (ctx.conclusion === "SUCCESS" || ctx.conclusion === "NEUTRAL" || ctx.conclusion === "SKIPPED") success++;
      else if (ctx.conclusion === "FAILURE" || ctx.conclusion === "TIMED_OUT" || ctx.conclusion === "CANCELLED") failure++;
      else pending++;
    } else if ("state" in ctx) {
      if (ctx.state === "SUCCESS") success++;
      else if (ctx.state === "FAILURE" || ctx.state === "ERROR") failure++;
      else pending++;
    }
  }
  return { overall: overallState, success, failure, pending, total: success + failure + pending };
}
```

#### 3. Add `ralph_hero__get_pull_request` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/pr-tools.ts`

Add inside `registerPrTools` after the existing `create_pull_request` tool.

Tool description: `"Get detailed pull request info: reviews, CI status, merge readiness, linked issues. The mergeable field may return UNKNOWN on first request (GitHub computes lazily) — retry after a few seconds. Returns: number, title, body, url, state, isDraft, author, headBranch, baseBranch, mergeable, reviews, checks, linkedIssues, reviewRequests."`

Input schema:
```typescript
{
  owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
  repo: z.string().optional().describe("Repository name. Defaults to env var"),
  prNumber: z.number().describe("Pull request number"),
}
```

GraphQL query (single PR with nested reviews, checks, review requests):
```graphql
query($owner: String!, $repo: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      id number title body url state isDraft
      author { login }
      headRefName baseRefName
      mergeable
      createdAt updatedAt mergedAt closedAt
      reviews(last: 50) {
        nodes { state author { login } }
      }
      reviewRequests(first: 10) {
        nodes {
          requestedReviewer {
            ... on User { login }
            ... on Team { slug name }
          }
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 50) {
                nodes {
                  ... on CheckRun { name status conclusion }
                  ... on StatusContext { context state }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

Use `client.query()` with `{ cache: true, cacheTtlMs: 60_000 }`.

Response shape:
```typescript
{
  number, title, body, url, state, isDraft,
  author: pr.author?.login || null,
  headBranch: pr.headRefName,
  baseBranch: pr.baseRefName,
  mergeable: pr.mergeable,  // "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
  createdAt, updatedAt, mergedAt, closedAt,
  reviews: summarizeReviews(pr.reviews.nodes),
  checks: summarizeChecks(rollup?.state, rollup?.contexts?.nodes || []),
  linkedIssues: parseLinkedIssues(pr.body),
  reviewRequests: [/* extracted logins/slugs */],
}
```

#### 4. Add `ralph_hero__list_pull_requests` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/pr-tools.ts`

Tool description: `"List pull requests with optional filters. Returns compact summaries with CI and review status. Use get_pull_request for full details on a specific PR."`

Input schema:
```typescript
{
  owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
  repo: z.string().optional().describe("Repository name. Defaults to env var"),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]).optional().describe("Filter by PR state (default: OPEN)"),
  author: z.string().optional().describe("Filter by author login (client-side filter)"),
  baseBranch: z.string().optional().describe("Filter by target branch (e.g., 'main')"),
  limit: z.number().optional().default(25).describe("Max results (default: 25)"),
}
```

GraphQL query:
```graphql
query($owner: String!, $repo: String!, $states: [PullRequestState!], $baseRefName: String, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: $states, baseRefName: $baseRefName, first: $first, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number title state isDraft url
        author { login }
        headRefName baseRefName
        createdAt updatedAt
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup { state }
            }
          }
        }
        reviews(last: 20) {
          nodes { state author { login } }
        }
      }
    }
  }
}
```

Use `paginateConnection<>()` from `lib/pagination.ts` with `connectionPath: "repository.pullRequests"` and `maxItems: args.limit`.

Client-side filtering: If `author` provided, filter `nodes` by `pr.author?.login === args.author` after pagination.

Response shape:
```typescript
{
  totalCount: result.totalCount,
  filteredCount: filtered.length,
  pullRequests: filtered.map(pr => ({
    number, title, state, isDraft, url,
    author: pr.author?.login || null,
    headBranch: pr.headRefName,
    baseBranch: pr.baseRefName,
    createdAt, updatedAt,
    checks: { overall: rollup?.state || null },
    reviews: summarizeReviews(pr.reviews.nodes),
  })),
}
```

### Success Criteria
- [ ] `npm run build` — no type errors
- [ ] Existing `create_pull_request` still works (resolveConfig import change is compatible)
- [ ] `get_pull_request` returns detailed PR with reviews, checks, linked issues
- [ ] `list_pull_requests` returns filtered list with compact summaries

---

## Phase 2: `update_pull_request_state` Tool + State Resolution

### Overview

Add the `update_pull_request_state` tool with four actions (ready_for_review, convert_to_draft, request_reviewers, merge) and add `ralph_pr` command to `state-resolution.ts`.

### Changes Required

#### 1. Add `ralph_pr` command to state-resolution.ts
**File**: `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts`

Add to `COMMAND_ALLOWED_STATES`:
```typescript
ralph_pr: ["In Review", "Done", "Human Needed"],
```

Add to `SEMANTIC_INTENTS.__COMPLETE__`:
```typescript
ralph_pr: "Done",
```

No changes to `__LOCK__` (PR operations don't lock issues).

#### 2. Add PR node ID resolver
**File**: `plugin/ralph-hero/mcp-server/src/tools/pr-tools.ts`

Add a private helper `resolvePrNodeId`:
```typescript
async function resolvePrNodeId(
  client: GitHubClient, owner: string, repo: string, prNumber: number,
): Promise<string> {
  const cacheKey = `pr-node-id:${owner}/${repo}#${prNumber}`;
  const cached = client.getCache().get<string>(cacheKey);
  if (cached) return cached;

  const result = await client.query<{
    repository: { pullRequest: { id: string } | null } | null;
  }>(
    `query($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) { id }
      }
    }`,
    { owner, repo, prNumber },
  );

  const nodeId = result.repository?.pullRequest?.id;
  if (!nodeId) throw new Error(`PR #${prNumber} not found in ${owner}/${repo}`);
  client.getCache().set(cacheKey, nodeId, 30 * 60 * 1000);
  return nodeId;
}
```

#### 3. Add user node ID resolver (for request_reviewers)
**File**: `plugin/ralph-hero/mcp-server/src/tools/pr-tools.ts`

```typescript
async function resolveUserNodeId(
  client: GitHubClient, login: string,
): Promise<string> {
  const cacheKey = `user-node-id:${login}`;
  const cached = client.getCache().get<string>(cacheKey);
  if (cached) return cached;

  const result = await client.query<{ user: { id: string } | null }>(
    `query($login: String!) { user(login: $login) { id } }`,
    { login },
  );

  const nodeId = result.user?.id;
  if (!nodeId) throw new Error(`GitHub user "${login}" not found`);
  client.getCache().set(cacheKey, nodeId, 60 * 60 * 1000);
  return nodeId;
}
```

#### 4. Add `ralph_hero__update_pull_request_state` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/pr-tools.ts`

Add new imports at top:
```typescript
import { resolveFullConfig, ensureFieldCache, resolveProjectItemId, updateProjectItemField, getCurrentFieldValue } from "../lib/helpers.js";
import { resolveState } from "../lib/state-resolution.js";
```

Tool description: `"Update PR lifecycle state: mark ready/draft, request reviewers, or merge. Merge action auto-transitions linked issues to Done. Returns: prNumber, action, result details. Recovery: for merge failures, use get_pull_request to check CI/review/conflict status."`

Input schema:
```typescript
{
  owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
  repo: z.string().optional().describe("Repository name. Defaults to env var"),
  prNumber: z.number().describe("Pull request number"),
  action: z.enum(["ready_for_review", "convert_to_draft", "request_reviewers", "merge"]).describe("Action to perform"),
  mergeStrategy: z.enum(["MERGE", "SQUASH", "REBASE"]).optional().default("SQUASH").describe("Merge strategy (default: SQUASH)"),
  reviewers: z.array(z.string()).optional().describe("GitHub usernames for request_reviewers action"),
  teamReviewers: z.array(z.string()).optional().describe("Team slugs for request_reviewers action (requires org context)"),
}
```

**Action: `ready_for_review`**
1. Resolve PR node ID
2. Call `markPullRequestReadyForReview` mutation
3. Return `{ prNumber, action: "ready_for_review", isDraft: false }`

**Action: `convert_to_draft`**
1. Resolve PR node ID
2. Call `convertPullRequestToDraft` mutation
3. Return `{ prNumber, action: "convert_to_draft", isDraft: true }`

**Action: `request_reviewers`**
1. Validate at least one reviewer or team reviewer provided
2. Resolve PR node ID
3. Resolve each reviewer login → user node ID via `resolveUserNodeId`
4. Call `requestReviews` mutation with `userIds` (skip `teamIds` if no org context)
5. Return `{ prNumber, action: "request_reviewers", reviewersRequested: [...] }`

**Action: `merge`**
1. Resolve PR node ID
2. **Pre-merge check**: Query PR for `mergeable`, review status, CI status
3. If `mergeable === "CONFLICTING"` → return error: `"Cannot merge: PR has merge conflicts. Update the branch first."`
4. If CI failing → return warning but allow (repo branch protection will enforce if needed)
5. Call `mergePullRequest` mutation with strategy
6. **Post-merge: transition linked issues to Done**:
   a. Parse linked issues from PR body via `parseLinkedIssues`
   b. For each linked issue number:
      - Resolve state via `resolveState("__CLOSE__", "ralph_pr")` → "Done"
      - Call `ensureFieldCache`, `resolveProjectItemId`, `updateProjectItemField` to set "Workflow State" to "Done"
      - Wrap in try/catch — if one fails, continue with rest
   c. Add `// TODO: Replace with handoff_ticket after #19 merges` comment
7. Return `{ prNumber, action: "merge", merged: true, mergeStrategy, linkedIssuesTransitioned: [...], linkedIssuesFailed: [...] }`

**Error handling for merge**:
- `mergeable === "CONFLICTING"` → `toolError("Cannot merge: PR has merge conflicts...")`
- GitHub API error from `mergePullRequest` → pass through the error message (branch protection failures, etc.)
- Linked issue transition failures → report in `linkedIssuesFailed` array but don't fail the overall response (merge already succeeded)

### Success Criteria
- [ ] `npm run build` — no type errors
- [ ] `ralph_pr` command accepted by `resolveState`
- [ ] `resolveState("__CLOSE__", "ralph_pr")` returns "Done"
- [ ] `resolveState("__COMPLETE__", "ralph_pr")` returns "Done"
- [ ] merge action transitions linked issues to "Done" via project field update

---

## Phase 3: Tests

### Overview

Add unit tests for all pure functions and state-resolution additions. Follow existing patterns in `batch-tools.test.ts` (test pure functions, not GraphQL execution) and `state-resolution.test.ts`.

### Changes Required

#### 1. PR tools tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/pr-tools.test.ts` (new)

**`parseLinkedIssues` tests**:
- `"Closes #10"` → `[10]`
- `"Fixes #10\nCloses #20"` → `[10, 20]`
- `"Resolves #10 and also Closes #10"` → `[10]` (de-duplication)
- `"CLOSES #5"` → `[5]` (case insensitive)
- `"close #7"` → `[7]` (singular form)
- `null` → `[]`
- `""` → `[]`
- `"No issues linked here"` → `[]`

**`summarizeReviews` tests**:
- Empty array → `{ approved: 0, changesRequested: 0, pending: 0, total: 0 }`
- Two reviews from same author (COMMENTED then APPROVED) → `{ approved: 1, total: 1 }` (de-dup keeps latest)
- Mixed: 1 APPROVED, 1 CHANGES_REQUESTED, 1 COMMENTED → `{ approved: 1, changesRequested: 1, pending: 1, total: 3 }`
- Null author → uses "unknown" login

**`summarizeChecks` tests**:
- Empty contexts → `{ success: 0, failure: 0, pending: 0, total: 0 }`
- CheckRun with `conclusion: "SUCCESS"` → success++
- CheckRun with `conclusion: "FAILURE"` → failure++
- CheckRun with `conclusion: null` (in progress) → pending++
- StatusContext with `state: "SUCCESS"` → success++
- StatusContext with `state: "ERROR"` → failure++
- Mixed contexts → correct categorization
- Overall state passed through

**`buildPrBody` tests** (existing, ensure not regressed):
- Body + issues → prepends `Closes #N`
- No issues → body unchanged

#### 2. State resolution tests for `ralph_pr`
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/state-resolution.test.ts`

Add to existing test suites:

In "resolveState - semantic intents":
- `resolveState("__CLOSE__", "ralph_pr")` → `"Done"`
- `resolveState("__COMPLETE__", "ralph_pr")` → `"Done"`
- `resolveState("__ESCALATE__", "ralph_pr")` → `"Human Needed"`
- `resolveState("__CANCEL__", "ralph_pr")` → `"Canceled"`
- `resolveState("__LOCK__", "ralph_pr")` → throws (no lock state for PR ops)

In "resolveState - direct state names":
- `resolveState("Done", "ralph_pr")` → `"Done"` (valid)
- `resolveState("In Review", "ralph_pr")` → `"In Review"` (valid)
- `resolveState("In Progress", "ralph_pr")` → throws (not in allowed states)

In "resolveState - command validation":
- `resolveState("__CLOSE__", "pr")` → `"Done"` (bare name normalization)

Note: The "data consistency with state machine JSON" test reads from `ralph-state-machine.json`. The JSON does not have a `ralph_pr` command, so the existing sync test will NOT fail (it only checks commands present in JSON). No changes needed for the sync test, but add a comment documenting that `ralph_pr` is an MCP-only command not in the workflow JSON.

### Success Criteria
- [ ] `npm test` — all tests pass
- [ ] `npx vitest run src/__tests__/pr-tools.test.ts` — focused test pass
- [ ] `npx vitest run src/__tests__/state-resolution.test.ts` — focused test pass

---

## Testing Strategy

All new pure functions (`parseLinkedIssues`, `summarizeReviews`, `summarizeChecks`) are exported and tested without mocking. GraphQL execution is tested manually. State-resolution tests extend the existing test suite.

## Integration Testing

After all phases complete:
- [ ] `npm run build` — clean compile
- [ ] `npm test` — all tests pass
- [ ] `get_pull_request` returns full PR details with reviews/CI/mergeability
- [ ] `list_pull_requests` filters by state, author, baseBranch
- [ ] `update_pull_request_state` merge transitions linked issues to "Done"
- [ ] Existing tools (`create_pull_request`, `list_project_items`, `update_workflow_state`) unaffected

## Estimated Size

- Phase 1: ~250 lines (helpers + 2 read tools)
- Phase 2: ~250 lines (state tool + node ID resolvers + state-resolution changes)
- Phase 3: ~200 lines (tests)
- **Total**: ~700 lines across 4 files

## Group Context

This covers issues 2 and 3 of 4 under parent #22 (PR Lifecycle Management):
- #30 (done) → Created `pr-tools.ts` + `create_pull_request`
- **#31** (this plan) → `get_pull_request` + `list_pull_requests` read tools
- **#32** (this plan) → `update_pull_request_state` with merge and Done transitions
- #33 (next) → Update skills to use PR MCP tools instead of `gh` CLI

## References

- [Issue #31](https://github.com/cdubiel08/ralph-hero/issues/31)
- [Issue #32](https://github.com/cdubiel08/ralph-hero/issues/32)
- [Parent Issue #22](https://github.com/cdubiel08/ralph-hero/issues/22)
- [Research: GH-31](thoughts/shared/research/2026-02-16-GH-0031-pr-read-tools.md)
- [Research: GH-32](thoughts/shared/research/2026-02-16-GH-0032-update-pr-state-tool.md)
- [pr-tools.ts (GH-22 worktree)](../../../worktrees/GH-22/plugin/ralph-hero/mcp-server/src/tools/pr-tools.ts) — existing create_pull_request
- [state-resolution.ts](plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts) — command/state validation
- [helpers.ts](plugin/ralph-hero/mcp-server/src/lib/helpers.ts) — shared resolveConfig, updateProjectItemField
- [pagination.ts](plugin/ralph-hero/mcp-server/src/lib/pagination.ts) — paginateConnection utility
