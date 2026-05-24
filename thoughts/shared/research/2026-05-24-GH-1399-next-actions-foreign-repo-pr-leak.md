---
date: 2026-05-24
status: complete
type: research
tags: [next-actions, directions, pr-search, multi-repo, mcp-tools]
github_issue: 1399
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1399
---

# Research: `next_actions` foreign-repo PR leak when items from that repo sit on the project board

## Question

Why does `ralph_hero__next_actions` surface open PRs from a repo when no items from that repo are actively in scope on the configured project — only stale closed items sit on the board?

## Summary

`uniqueRepos()` in `mcp-server/src/tools/directions-tools.ts:253-259` derives the PR-search radius from every item with a non-empty `repository` field, regardless of whether the item is open or closed (Done / Canceled). A single closed cross-repo item is enough to add that repo to the PR-search set, after which all open PRs in that foreign repo can flow into directions ranking. Tightening the radius to "repos with at least one open item" eliminates the leak from stale-closed-item residue.

## Concrete repro (observed 2026-05-24)

- Project: `cdubiel08/users/cdubiel08/projects/8` ("LandCrawler Workflow")
- Pre-cleanup item mix: 363 `cdubiel08/landcrawler-ai` open items + 5 closed `cdubiel08/ralph-hero` items (#731, #1015, #1016, #1017, #1018) with `updatedAt` from 2026-05-06 / 2026-05-08.
- Call: `next_actions({ audience: "agent", limit: 3 })`
- Result: `cdubiel08/ralph-hero` PR #1355 surfaced as the recommended top direction with `kind: "pr"`. The PR's linked issue (#1301) is not on Project 8 — it lives on ralph-hero's own project board.

Removing the 5 closed ralph-hero items via `deleteProjectV2Item` mutations dropped `boardItems` from 368 → 363, and `next_actions` then returned `landcrawler-ai#904` as the top direction (correct).

## Code path

`tools/directions-tools.ts:421-446` (`runDirections`) calls:

```typescript
const repos = uniqueRepos(allItems);
const rawOpenPRs = await fetchOpenPRs(client, repos);
```

`uniqueRepos()` (`tools/directions-tools.ts:253-259`):

```typescript
function uniqueRepos(items: DashboardItem[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.repository) seen.add(item.repository);
  }
  return Array.from(seen).sort();
}
```

No open/closed filter. Every item with a `repository` field expands the radius.

`fetchOpenPRs()` (`tools/directions-tools.ts:272-334`) then runs one `is:pr is:open repo:owner/name` GraphQL search per repo. Returned PRs flow through `scorePR()` and `rankDirections()` in `lib/directions.ts:884-903`.

Note: `rankDirections` already filters PRs with no `linkedIssueNumber` (`lib/directions.ts:900-903`), but a PR whose head ref matches `feature/GH-NNNN` for an issue *not on the board* still surfaces — the filter only checks that a number parses, not that the corresponding issue is in the project items set.

## Why `RALPH_GH_REPO` doesn't help

`RALPH_GH_REPO` is read by `helpers.ts` for `get_issue` / `save_issue` defaults. It is not consulted by `directions-tools.ts` — the PR-search radius is derived from project items, not env.

## Impact

- Orchestrators (`autopilot`, `Director`, `hero`) dispatch cross-repo without warning when a leaked PR direction wins the top slot.
- A foreign repo with many open PRs (e.g. dependabot churn) can flood `directions` and shadow the project's actual work.
- Closed-item hygiene becomes a load-bearing precondition for autopilot correctness — non-obvious, easy to violate.

## Proposed fixes

Two non-exclusive options:

1. **Tighten PR-search radius (Option 1)**: filter `uniqueRepos()` to repos with at least one open item. Closed-only repos no longer expand the search radius. Cheapest guard. Eliminates the most common failure mode (stale-closed-item residue).
2. **Filter surfaced PRs to board-linked issues (Option 2)**: in `rankDirections`, additionally require that a PR's `linkedIssueNumber` corresponds to an item on the project board. Stronger guarantee — handles a foreign repo that has both open items and unrelated PRs. Requires passing `items` (or a set of board issue numbers) further into `rankDirections`.

Recommendation: ship Option 1 alone. It covers the observed failure mode with a single-line filter and zero ranker surface change. Option 2 can stack on top later if a real-world case demonstrates that an open foreign item still leaks unrelated PRs.

## "Open" definition

For Option 1, treat an item as open when:

- `item.closedAt === null` AND
- `item.workflowState !== "Done"` AND
- `item.workflowState !== "Canceled"`

Belt-and-suspenders: GitHub `closedAt` is the authoritative signal, but project items can carry a Done/Canceled workflow state without `closedAt` being set (e.g. draft items moved through the board). Excluding both keeps the radius tight.

## Test surface

- Existing tests: `__tests__/directions-tools.test.ts` — integration harness covers `runDirections` end-to-end with mocked `projectQuery` + `query`. Routes PR-search responses through `isOpenPRsSearchQuery`.
- Existing tests: `__tests__/directions.test.ts` — pure `rankDirections` tests.
- New test required: integration test in `directions-tools.test.ts` proving that a project with only-closed items from a foreign repo does NOT trigger a PR-search for that repo. Mock should assert `client.query` was called with the project's open-item repo only (not the closed-item repo).

## Files affected by Option 1

- `mcp-server/src/tools/directions-tools.ts` — `uniqueRepos()` body.
- `mcp-server/src/__tests__/directions-tools.test.ts` — new test case + (optionally) a unit test if `uniqueRepos` is exported.

## What we're NOT doing

- Option 2 (board-linked-PR filter). Defer until evidence warrants.
- `RALPH_GH_REPO`-based filtering. The radius should derive from project state, not env vars.
- Touching `lib/directions.ts` (pure ranker). Fix is at the tool boundary.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1399
- Tool: `mcp-server/src/tools/directions-tools.ts`
- Ranker: `mcp-server/src/lib/directions.ts`
- Tests: `mcp-server/src/__tests__/directions-tools.test.ts`
- Workaround applied: 5 closed ralph-hero items removed from Project 8 via `deleteProjectV2Item` mutations (2026-05-24).
