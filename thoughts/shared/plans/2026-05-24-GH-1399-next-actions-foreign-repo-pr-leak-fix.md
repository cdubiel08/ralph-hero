---
date: 2026-05-24
status: ready
type: plan
tags: [next-actions, directions, pr-search, multi-repo, mcp-tools]
github_issue: 1399
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1399
primary_issue: 1399
---

# Tighten `next_actions` PR-search radius to open-item repos only

## Prior Work

builds_on:: research [[2026-05-24-GH-1399-next-actions-foreign-repo-pr-leak]] — establishes the root cause in `uniqueRepos()` and recommends Option 1 (radius tightening) over Option 2 (board-linked PR filter).

## Overview

`uniqueRepos()` in `mcp-server/src/tools/directions-tools.ts` expands the PR-search set to every repo represented by *any* project item, including Done/Canceled and GitHub-closed items. A single stale closed cross-repo item is enough to pull every open PR from that foreign repo into the directions ranking. The fix: filter `uniqueRepos()` to items that are still open (no `closedAt`, not Done, not Canceled). One-line semantic change at the tool boundary, ranker untouched.

## Current State Analysis

The PR-search radius is derived purely from project items:

```typescript
// mcp-server/src/tools/directions-tools.ts:253-259
function uniqueRepos(items: DashboardItem[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.repository) seen.add(item.repository);
  }
  return Array.from(seen).sort();
}
```

Called from `runDirections` at `directions-tools.ts:425-426`:

```typescript
const repos = uniqueRepos(allItems);
const rawOpenPRs = await fetchOpenPRs(client, repos);
```

`fetchOpenPRs()` then issues one `is:pr is:open repo:owner/name` GraphQL search per repo. Returned PRs flow through `scorePR()` and surface as `kind: "pr"` directions.

### Key Discoveries

- `DashboardItem` (`mcp-server/src/lib/dashboard.ts:37-57`) carries both `closedAt: string | null` and `workflowState: string | null`. GitHub `closedAt` is the authoritative "closed" signal; workflow state Done/Canceled is a secondary project-side signal.
- `lib/directions.ts:898-903` already drops PRs with no parseable `linkedIssueNumber`, but does NOT verify the linked issue exists on the project board.
- `RALPH_GH_REPO` is consulted only by `helpers.ts` for `get_issue` / `save_issue` defaults, not by `directions-tools.ts`. It cannot fix this leak.
- `__tests__/directions-tools.test.ts` already has the integration harness: mocked `projectQuery` + `query`, route-by-query-shape (`isOpenPRsSearchQuery`), PR fixtures via `openPRs` option.

## Desired End State

1. `uniqueRepos()` returns only repos with at least one *open* project item.
2. A project containing only closed items from repo X produces zero `is:pr is:open repo:X/...` GraphQL searches.
3. The 2026-05-24 repro (5 closed ralph-hero items on Project 8 leaking PR #1355) no longer surfaces a ralph-hero PR direction.
4. All existing `directions-tools.test.ts` and `directions.test.ts` tests still pass.

### Verification

- [x] `npx vitest run src/__tests__/directions-tools.test.ts` — passes including new closed-only-foreign-repo test.
- [x] `npx vitest run src/__tests__/directions.test.ts` — passes (no changes expected; pure ranker untouched).
- [x] `npm run build` exits 0 (TypeScript strict mode).
- [x] `npm test` — full suite green (1626 passed, 1 skipped).
- [x] Manual: simulate the GH-1399 repro by mocking 1 open landcrawler-ai item + 1 closed ralph-hero item with an open ralph-hero PR in fixtures; assert PR direction does NOT appear in output. (See new integration test.)

## What We're NOT Doing

- Option 2 from the research doc (filter PR directions by `linkedIssueNumber ∈ board-item-set`). Defer until evidence shows that an open foreign item still leaks unrelated PRs.
- Adding `RALPH_GH_REPO`-based filtering. Radius should derive from project state, not env vars.
- Touching `lib/directions.ts` (pure ranker). The leak is at the tool boundary.
- Changing the `next_actions` tool description or any frontmatter of consumers (`/hello`, `/ralph:caretake`).
- Bumping the MCP server major version. This is a behavior tightening with no API surface change; auto-release will pick the correct bump from the commit message.

## Implementation Approach

Single-phase, S-sized change. Modify `uniqueRepos()` to accept an open-item filter, update the one call site in `runDirections`, add a focused integration test mirroring the GH-1399 repro. Existing tests continue to exercise the old open-only behavior (their fixtures default to open items, so no rewrites needed).

## Phase 1: Tighten `uniqueRepos()` to open items only

depends_on: null

### Overview

Add an open-item filter inside `uniqueRepos()` so the PR-search radius only includes repos with at least one project item that is still open on GitHub AND not in Done/Canceled workflow state. Add a regression test mirroring the GH-1399 repro.

### Changes Required

#### 1. `uniqueRepos()` filter

**File**: `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts`

**Changes**:

- Replace the body of `uniqueRepos()` (currently `tools/directions-tools.ts:253-259`) to skip items where `closedAt !== null` OR `workflowState === "Done"` OR `workflowState === "Canceled"`.
- Keep the function signature and return shape unchanged (sorted `string[]`) so callers and tests stay stable.
- Update the JSDoc above the function to explain that closed items no longer expand the radius and reference GH-1399 for context.

Proposed body:

```typescript
function uniqueRepos(items: DashboardItem[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.repository) continue;
    if (item.closedAt !== null) continue;
    if (item.workflowState === "Done" || item.workflowState === "Canceled") continue;
    seen.add(item.repository);
  }
  return Array.from(seen).sort();
}
```

#### 2. Regression test

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts`

**Changes**:

- Add a new `describe` or `it` block inside the existing `next_actions` integration suite covering: *"closed cross-repo items do not expand the PR-search radius"*.
- Fixture shape: 1 open `owner/repo-a` item in an actionable phase + 1 closed `owner/repo-b` item (with `closedAt` set to a past date and/or `workflowState: "Done"`). The existing `rawIssue` fixture builder hardcodes `repository: { nameWithOwner: "owner/repo", name: "repo" }` — extend it to accept a `repository` override so the test can use distinct repo names. This is a backwards-compatible parameter addition (default preserves existing fixtures).
- Mock `client.query` with the `openPRs` option set so the foreign repo (`owner/repo-b`) has an open PR with `headRefName: "feature/GH-1234"` and `reviewDecision: "REVIEW_REQUIRED"`.
- Assert: the returned `directions` array contains no `kind: "pr"` direction for the foreign repo. Also assert (via `query.mock.calls`) that no GraphQL search query was issued whose `q` variable contains the foreign repo's `nameWithOwner`.

### Success Criteria

#### Automated Verification

- [x] `npx vitest run src/__tests__/directions-tools.test.ts` passes including the new regression test.
- [x] `npx vitest run src/__tests__/directions.test.ts` passes unchanged.
- [x] `npm run build` exits 0 with no TypeScript errors.
- [x] `npm test` full suite green (1626 passed).
- [x] `grep -n "closedAt" plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts` shows the new filter wired into `uniqueRepos`.

#### Manual Verification

- [ ] Re-run the GH-1399 repro path mentally: with a project mix of 363 open landcrawler-ai items + 5 closed ralph-hero items, `uniqueRepos()` returns `["cdubiel08/landcrawler-ai"]` only.
- [ ] No regression for the common single-repo case: open items continue to populate the radius identically to the previous behavior.

## Testing Strategy

### Unit Tests

`uniqueRepos()` is not currently exported. The integration test exercises it end-to-end through `runDirections` — that is the correct level for this fix because the observable contract is "no PR-search for foreign closed-only repos," which is visible only after the GraphQL search is or is not issued. No need to add a pure unit test.

### Integration Tests

One new test in `directions-tools.test.ts` per the Phase 1 spec. Asserts both the absence of the PR direction in the output AND the absence of the foreign-repo GraphQL search call. The second assertion is the load-bearing one — it proves the radius-tightening (not just the output filtering) happened.

### Manual Testing Steps

1. Build the MCP server: `cd plugin/ralph-hero/mcp-server && npm run build`.
2. Inspect git diff for `uniqueRepos()` — verify the filter logic.
3. Run `npm test` — all green.

## Performance Considerations

The change reduces the number of GraphQL searches issued per `next_actions` call (one fewer query per closed-only foreign repo). Strictly a perf improvement for affected projects; no regression for single-repo or all-open multi-repo projects.

## Migration Notes

Zero migration. Behavior tightening with no API change. Existing callers (`/hello`, `/ralph:caretake`, autopilot) consume `directions` unchanged. Consumers that explicitly depended on PR directions from closed-only foreign repos (none known) would silently lose those — that loss is precisely the goal.

## References

- Research: `thoughts/shared/research/2026-05-24-GH-1399-next-actions-foreign-repo-pr-leak.md`
- Issue: https://github.com/cdubiel08/ralph-hero/issues/1399
- Tool source: `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts:253-259` (`uniqueRepos`), `:421-446` (call site).
- Test harness: `plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts`
- Workaround applied to Project 8: 5 `deleteProjectV2Item` mutations removing closed ralph-hero items on 2026-05-24.
