---
date: 2026-03-17
github_issue: 592
github_url: https://github.com/cdubiel08/ralph-hero/issues/592
status: complete
type: research
tags: [archive, bulk-operations, pagination, graphql, project-management]
---

# GH-592: archive_items bulk query doesn't exclude already-archived items

## Prior Work

- builds_on:: [[2026-02-19-GH-0115-archive-stats-pipeline-dashboard]]
- builds_on:: [[2026-02-20-GH-0153-bulk-archive-core-tool]]
- builds_on:: [[2026-02-21-GH-0113-bulk-archive-remaining-enhancements]]

## Problem Statement

The bug report claims that calling `archive_items` with `maxItems: 200` against a project with >200 eligible items (e.g., 261 Done/Canceled) causes subsequent calls to return the same 200 already-archived items, silently re-archiving them instead of progressing to the remaining ~61.

## Current State Analysis

### The Reported Root Cause Is Incorrect

The issue states: "the GraphQL query used to find eligible items does not filter on `isArchived: false`."

**Prior research (GH-0115) experimentally confirmed that the `items(first: N)` connection on `ProjectV2` already excludes archived items by default.** From [2026-02-19-GH-0115-archive-stats-pipeline-dashboard.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0115-archive-stats-pipeline-dashboard.md):

> "Testing confirms that the `items(first: N)` connection on `ProjectV2` does **not** return archived items. All 144 items in the current project returned `isArchived: false`."

Furthermore:
- The `items` connection has no `includeArchived: Boolean` argument
- There is no separate `archivedItems` connection on `ProjectV2`
- The `totalCount` on the connection only counts non-archived items

**Therefore, the scenario described in the bug -- "returns the same 200 items (now already archived)" -- cannot happen.** Once items are archived by the first call, they disappear from the `items` connection. A second call would return a fresh set of unarchived items.

Adding `isArchived: false` filtering is not the correct fix because: (a) the API already excludes archived items, and (b) there is no server-side filter argument for `isArchived` on the `items` connection anyway.

### The Real Bug: Under-Fetching Due to 3x Over-Fetch Cap

The actual pagination issue lies in the interaction between the over-fetch multiplier and client-side filtering.

At [project-management-tools.ts:738](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L738):

```typescript
const effectiveMax = Math.min(args.maxItems || 50, 200);

const itemsResult = await paginateConnection<RawBulkArchiveItem>(
  (q, v) => client.projectQuery(q, v),
  queryString,
  { projectId, first: 100 },
  "node.items",
  { maxItems: effectiveMax * 3 },  // <-- the 3x over-fetch
);
```

The tool fetches `effectiveMax * 3` total items from the API, then applies client-side workflow state filtering. The 3x multiplier is a heuristic assuming roughly 1/3 of project items will match the filter.

**When the ratio of matching items is lower than 1/3, the tool under-fetches:**

- Project has 1000 active items, 261 are Done/Canceled
- `maxItems: 200`, so `effectiveMax = 200`, fetch cap = 600
- First 600 items may only contain ~157 Done/Canceled items (if uniformly distributed)
- Tool archives 157, reports `archivedCount: 157`
- Caller expects 200, calls again
- Second call fetches 600 items from the remaining 843, finds ~104 Done/Canceled items
- Archives 104, done

This is functional but suboptimal -- it requires multiple calls to archive all eligible items, and the `archivedCount` can be lower than `maxItems` even when more eligible items exist. This could appear as if pagination "isn't working" from the caller's perspective.

**When the ratio of matching items is higher than 1/3, the 3x multiplier is sufficient** and the tool archives exactly `maxItems` items in one call.

### Secondary Issue: No "More Items Available" Signal

The tool's response does not indicate whether more eligible items exist beyond what was archived. The response includes `archivedCount` and `items` but no `hasMore` or `totalEligible` field. Callers have no way to know if a follow-up call is needed except by comparing `archivedCount < maxItems` (which is an unreliable heuristic given the under-fetch problem).

### Code Flow Walkthrough

1. **Lines 696-739**: Query phase -- fetches `effectiveMax * 3` items via `paginateConnection`
2. **Lines 753-763**: Filter phase -- client-side filter by `workflowStates` array + optional `updatedBefore` date, then `.slice(0, effectiveMax)`
3. **Lines 776-787**: Dry-run branch -- returns matched items without archiving
4. **Lines 789-820**: Archive phase -- chunks matched items into batches of 50, executes `buildBatchArchiveMutation` per chunk
5. **Lines 822-827**: Response -- returns `{ dryRun: false, archivedCount, items, errors }`

The `paginateConnection` function ([pagination.ts:65-119](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pagination.ts#L65-L119)) handles cursor-based pagination correctly, fetching pages of 100 until `maxItems` is reached or no more pages exist.

## Key Discoveries

### 1. GitHub API Already Excludes Archived Items

The `items` connection on `ProjectV2` excludes archived items by default. No code change is needed to filter archived items -- they simply don't appear. This finding directly contradicts the bug report's root cause analysis.

### 2. The 3x Over-Fetch Heuristic Is Fragile

The `maxItems: effectiveMax * 3` heuristic works when ~33% of project items match the filter. For projects where Done/Canceled items are a smaller fraction, the tool silently returns fewer items than requested. For projects where the fraction is larger, the tool over-fetches wastefully.

### 3. Response Lacks Pagination Metadata

The tool's response does not include information about remaining eligible items, making it difficult for callers to implement proper pagination loops. The `dryRun` mode also lacks this information.

### 4. DraftIssue Items Are Silently Skipped

The `RawBulkArchiveItem.content` type allows `null` content, which occurs for DraftIssue items (they don't have `number` or `title`). The workflow state filter works correctly for these (they have field values), but the `content?.number` and `content?.title` in the response will be `undefined`. Draft issues with matching workflow states are archivable but their identification in the response is poor.

## Potential Approaches

### Approach A: Increase Over-Fetch Multiplier (Quick Fix)

Change `effectiveMax * 3` to `effectiveMax * 10` or use the full project `totalCount`.

**Pros**: Minimal code change, fixes most real-world scenarios.
**Cons**: Wasteful API usage for large projects. 200 * 10 = 2000 items fetched just to archive 200. Doesn't solve the fundamental problem.

### Approach B: Paginate Until Enough Matches Found (Recommended)

Replace the fixed over-fetch with a custom pagination loop that continues fetching pages until either `effectiveMax` matching items are found OR all project items have been scanned.

```typescript
const matched: RawBulkArchiveItem[] = [];
let cursor: string | null = null;
let totalCount: number | undefined;

while (matched.length < effectiveMax) {
  const page = await client.projectQuery(query, { projectId, first: 100, cursor });
  const connection = page.node.items;
  totalCount = connection.totalCount;

  for (const item of connection.nodes) {
    if (matchesFilter(item, args)) {
      matched.push(item);
      if (matched.length >= effectiveMax) break;
    }
  }

  if (!connection.pageInfo.hasNextPage) break;
  cursor = connection.pageInfo.endCursor;
}
```

**Pros**: Fetches exactly enough items. Works regardless of the matching ratio. Natural stopping point.
**Cons**: More code changes. Could fetch many pages for projects with few matching items at the end.

### Approach C: Add `totalEligible` / `hasMore` Response Fields

Extend the response to include a `hasMore: boolean` field computed from whether the pagination exhausted all items. This helps callers implement proper retry loops even with Approach A.

**Pros**: Better caller UX. Low implementation effort.
**Cons**: Does not fix the under-fetch; only improves caller visibility.

### Recommended: Approach B + C Combined

Replace the 3x over-fetch heuristic with proper scan-until-full pagination, AND add `hasMore` / `totalScanned` to the response. This fully fixes the under-fetch problem and gives callers proper pagination signals.

## Risks

1. **API cost increase**: Approach B may require scanning many pages for projects with few eligible items scattered among many non-eligible items. Mitigate by keeping the 100-per-page size and adding a hard cap (e.g., scan at most 2000 items total).

2. **Rate limiting**: Large scans consume GraphQL rate limit. The `paginateConnection` function does not currently check rate limits between pages. This is an existing gap, not introduced by this change.

3. **Regression in `dryRun` behavior**: The `dryRun` mode uses the same query phase. Changes to the query logic automatically apply to dry-run, which is correct behavior but should be tested.

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts` - Replace 3x over-fetch with scan-until-full pagination; add `hasMore` response field
- `plugin/ralph-hero/mcp-server/src/__tests__/bulk-archive.test.ts` - Add tests for pagination behavior and `hasMore` field

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/lib/pagination.ts` - Existing pagination utility (may reuse or bypass)
- `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts` - `buildBatchArchiveMutation` (no changes needed)
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` - Config resolution helpers (no changes needed)
