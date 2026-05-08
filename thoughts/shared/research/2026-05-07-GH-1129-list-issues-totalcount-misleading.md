---
date: 2026-05-07
github_issue: 1129
github_url: https://github.com/cdubiel08/ralph-hero/issues/1129
status: complete
type: research
tags: [list-issues, graphql, pagination, api-response, bug-fix]
---

# GH-1129: list_issues `totalCount` is misleading — reports all-time project items, not filtered open issues

## Prior Work

None identified.

## Problem Statement

`ralph_hero__list_issues` returns a `totalCount` field that appears to communicate "number of issues matching your query" but actually reflects the GitHub Projects V2 `items.totalCount` — the count of **every item ever added to the project board**, including closed issues, merged/closed PRs, and draft issues, regardless of any filter passed to the tool.

A session reproduced: `workflowState="Backlog"` returned `{ totalCount: 699, filteredCount: 1 }`, causing the analyst to spend time investigating "where are the other 698?" — when `gh issue list --state open` showed only 33 open issues total.

## Current State Analysis

### GraphQL query structure

The `ralph_hero__list_issues` handler (registered in `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:62-505`) executes:

```graphql
query($projectId: ID!, $cursor: String, $first: Int!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: $first, after: $cursor) {
        totalCount          # ← the problematic field
        pageInfo { ... }
        nodes { ... }
      }
    }
  }
}
```

The `items(...)` connection on `ProjectV2` is an unfiltered view of all project items. `totalCount` is a property of the **connection** — it counts every item on the board, not the items in the current page or matching any filter.

### Pagination helper propagation

`paginateConnection` in `plugin/ralph-hero/mcp-server/src/lib/pagination.ts:46-100` captures `totalCount` from the first page of results (line 87) and returns it in `PaginatedResponse<T>`. The caller at `issue-tools.ts:215` binds this into `itemsResult`, which is then client-side filtered through ~12 filter stages (state, workflowState, estimate, priority, iteration, label, repo, has, no, excludeWorkflowStates, query, updatedSince/updatedBefore).

### Response shape

```typescript
// issue-tools.ts:495-499
return toolSuccess({
  totalCount: itemsResult.totalCount,  // ← board total, never filtered
  filteredCount: formattedItems.length,
  items: formattedItems,
});
```

`filteredCount` accurately reflects the number of items after all filters. `totalCount` is the pre-filter, pre-client-filter board aggregate that is never meaningful in the context of the filter applied.

### Why the discrepancy is large

The project board accumulates all historic items: closed issues, merged PRs, past drafts. For a project that has been active for months, this number (699 in the reproduction) can be 20x the current open issue count (33). The bigger the project history, the more misleading the field becomes.

### Downstream impact

- No skills, agents, or hooks parse `totalCount` from the `list_issues` response — searching `plugin/ralph-hero/skills/`, `plugin/ralph-hero/agents/`, and `plugin/ralph-hero/hooks/` returns zero hits.
- No test assertions check the value of `totalCount` in the list_issues response context; all `totalCount` references in tests are in GraphQL mock objects for the connection shape.
- `filteredCount` already provides the accurate count callers need.

## Potential Approaches

### Option 1: Drop `totalCount` from the response (recommended)

Remove `totalCount: itemsResult.totalCount` from the `toolSuccess` call at `issue-tools.ts:496`.

**Pros:**
- Zero ambiguity — there is no misleading field at all
- `filteredCount` still present for callers that need a count
- Smallest diff, zero regression risk
- No downstream callers consume `totalCount` from this tool

**Cons:**
- Breaking change for any external callers that parse `totalCount` (none identified in this repo, but external consumers of the npm package could theoretically rely on it)

### Option 2: Rename to `boardItemsTotal` with updated description

Keep the field but rename it and update the tool description to clarify semantics.

**Pros:**
- No data is lost; callers that want board total can still access it
- Semantically unambiguous name

**Cons:**
- Still adds clutter to the response that is rarely useful
- Slightly larger change (rename + description update)
- Field is nearly never useful in practice — knowledge of board total is not actionable given the filter context

### Option 3: Compute a true filtered total

Run the same query without `limit` to get a true count of items matching the filters.

**Pros:**
- Would match user expectation of what `totalCount` means
- Consistent with GitHub Search API pagination conventions

**Cons:**
- Requires a second API call or full result set fetch (expensive)
- Current architecture fetches up to `maxItems: 500` client-side; a true total would require fetching all pages before filtering, or maintaining a separate count query
- Overkill for the use case — `filteredCount` is already accurate

## Risks

- **Breaking change (low risk):** Option 1 is technically a breaking schema change. However, no internal callers consume `totalCount` from `list_issues`, and the field is misleading enough that its removal is a net improvement. The tool's description doesn't mention `totalCount` in the Returns clause, so external callers have weak expectation.
- **Test coverage:** No existing tests assert the value of `totalCount` in list_issues responses, so no test changes are required for option 1 beyond adding a structural test that confirms the field is absent (optional but recommended for regression prevention).

## Recommended Next Steps

1. **Implement Option 1**: Remove `totalCount: itemsResult.totalCount` from `toolSuccess` at `issue-tools.ts:496`.
2. **Update tool description** (line 64): The tool description currently doesn't mention `totalCount` in its Returns clause, so no description change is required. Verify the Returns clause is accurate post-change.
3. **Add structural test** in `issue-tools.test.ts`: Assert that the source does not contain `totalCount: itemsResult.totalCount` to prevent regression.
4. **Consider removing `totalCount` from the GraphQL query** (line 221): Since it is no longer returned in the response, the `totalCount` field in the GraphQL query becomes unused. Remove it to reduce response payload, though this is cosmetic.

The `pagination.ts` helper can remain unchanged — `PaginatedResponse<T>` still includes `totalCount` for other callers (e.g., `project-tools.ts:468` uses `totalRepos: project.repositories.totalCount`).

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` - Remove `totalCount: itemsResult.totalCount` from toolSuccess response (line 496); optionally remove `totalCount` from GraphQL query (line 221)
- `plugin/ralph-hero/mcp-server/src/__tests__/issue-tools.test.ts` - Add structural regression test asserting `totalCount: itemsResult.totalCount` is absent from source

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/lib/pagination.ts` - `PaginatedResponse<T>` type; `paginateConnection` return shape — no changes needed
- `plugin/ralph-hero/mcp-server/src/types.ts` - `toolSuccess` signature — no changes needed
