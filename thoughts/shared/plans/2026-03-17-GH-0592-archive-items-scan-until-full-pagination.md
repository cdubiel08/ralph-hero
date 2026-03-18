---
date: 2026-03-17
status: draft
type: plan
github_issue: 592
github_issues: [592]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/592
primary_issue: 592
tags: [archive, pagination, bulk-operations, graphql, bug-fix]
---

# GH-592: Replace 3x Over-Fetch with Scan-Until-Full Pagination in archive_items

## Prior Work

- builds_on:: [[2026-03-17-GH-0592-archive-items-bulk-query-pagination-bug]]
- builds_on:: [[2026-02-19-GH-0115-archive-stats-pipeline-dashboard]]
- builds_on:: [[2026-02-20-GH-0153-bulk-archive-core-tool]]
- builds_on:: [[2026-02-21-GH-0113-bulk-archive-remaining-enhancements]]

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-592 | Replace 3x over-fetch with scan-until-full pagination and add `hasMore` response field | S |

## Current State Analysis

The `archive_items` bulk mode in [project-management-tools.ts:696-827](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts#L696-L827) uses a 3x over-fetch heuristic (`effectiveMax * 3`) via the generic `paginateConnection` utility. It fetches `effectiveMax * 3` items, then client-side filters by workflow state and optional `updatedBefore` date.

**The root cause per research**: The 3x heuristic assumes ~33% of project items match the filter. When the actual match ratio is lower, the tool returns fewer items than `maxItems` even when more eligible items exist. This creates the appearance of broken pagination. The original bug report's claim that archived items are re-fetched is incorrect -- the GitHub API already excludes archived items from the `items` connection.

**Secondary issue**: The response lacks a `hasMore` field, so callers cannot distinguish "all eligible items archived" from "more eligible items exist but weren't scanned."

## Desired End State

### Verification
- [x] `archive_items` with `maxItems: 200` returns up to 200 matching items regardless of the match ratio in the project
- [x] Response includes `hasMore: boolean` indicating whether more eligible items exist beyond what was archived
- [x] Response includes `totalScanned: number` showing how many project items were examined
- [x] `dryRun` mode also returns `hasMore` and `totalScanned`
- [x] A hard scan cap (2000 items) prevents runaway pagination on very large projects
- [x] Existing tests pass; new tests cover the scan-until-full behavior and `hasMore` field

## What We're NOT Doing

- Not adding server-side `isArchived` filtering (the API already excludes archived items)
- Not changing the single-item archive mode (only bulk mode is affected)
- Not adding rate limit checking between pagination pages (existing gap, separate concern)
- Not changing the archive chunk size (50) or the `effectiveMax` cap (200)
- Not modifying the `paginateConnection` generic utility -- the scan-until-full logic is specific to archive_items and is better expressed inline

## Implementation Approach

Replace the single `paginateConnection` call with a custom scan loop that fetches pages of 100 items, applies filters on each page, and stops when either `effectiveMax` matches are collected or all items have been scanned (or the 2000-item scan cap is reached). Add `hasMore` and `totalScanned` to both the archive and dry-run response objects.

---

## Phase 1: Replace 3x Over-Fetch with Scan-Until-Full Pagination

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/592 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-17-GH-0592-archive-items-bulk-query-pagination-bug.md

### Changes Required

#### 1. Replace `paginateConnection` call with inline scan-until-full loop

**File**: [`plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts)

**Changes**: Replace lines 696-739 (the `effectiveMax` calculation and `paginateConnection` call) with a custom scan loop:

```typescript
const effectiveMax = Math.min(args.maxItems || 50, 200);
const SCAN_CAP = 2000; // Hard limit to prevent runaway pagination

// Scan-until-full: fetch pages and filter until we have enough matches or exhaust items
const matched: RawBulkArchiveItem[] = [];
let cursor: string | null = null;
let totalScanned = 0;
let hasMorePages = true;

// Validate updatedBefore early (move from current line 742-750)
let updatedBeforeCutoff: number | undefined;
if (args.updatedBefore) {
  updatedBeforeCutoff = new Date(args.updatedBefore).getTime();
  if (isNaN(updatedBeforeCutoff)) {
    return toolError(
      "Invalid updatedBefore date. Use ISO 8601 format (e.g., 2026-02-01T00:00:00Z)",
    );
  }
}

while (matched.length < effectiveMax && hasMorePages && totalScanned < SCAN_CAP) {
  const pageSize = Math.min(100, SCAN_CAP - totalScanned);
  const page = await client.projectQuery(
    `query($projectId: ID!, $cursor: String, $first: Int!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: $first, after: $cursor) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              type
              content {
                ... on Issue {
                  number
                  title
                  updatedAt
                }
                ... on PullRequest {
                  number
                  title
                  updatedAt
                }
              }
              fieldValues(first: 20) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    __typename
                    name
                    field { ... on ProjectV2FieldCommon { name } }
                  }
                }
              }
            }
          }
        }
      }
    }`,
    { projectId, first: pageSize, cursor },
  );

  const connection = (page as Record<string, unknown>).node as Record<string, unknown>;
  const items = (connection as Record<string, unknown>).items as {
    totalCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: RawBulkArchiveItem[];
  };

  totalScanned += items.nodes.length;

  for (const item of items.nodes) {
    if (matched.length >= effectiveMax) break;

    const ws = getBulkArchiveFieldValue(item, "Workflow State");
    if (!ws || !args.workflowStates!.includes(ws)) continue;

    if (updatedBeforeCutoff) {
      if (!item.content?.updatedAt) continue;
      if (new Date(item.content.updatedAt).getTime() >= updatedBeforeCutoff) continue;
    }

    matched.push(item);
  }

  hasMorePages = items.pageInfo.hasNextPage && !!items.pageInfo.endCursor;
  cursor = items.pageInfo.endCursor;
}

// Determine if more eligible items may exist beyond what we collected
const hasMore = matched.length >= effectiveMax && hasMorePages;
```

Key design decisions:
- **SCAN_CAP = 2000**: Prevents scanning the entire project (could be 10K+ items). This is 20 pages of 100, which covers the vast majority of real-world scenarios.
- **`updatedBefore` validation moved earlier**: Currently at line 742, it should be validated before the scan loop begins rather than after fetching items.
- **Filter inside the scan loop**: Each page's items are filtered immediately rather than accumulating all items first. This avoids holding unneeded items in memory.
- **`hasMore` derivation**: True when we hit `effectiveMax` matches AND there are still unscanned pages. This correctly indicates "there are likely more eligible items."
- **Response type narrowing**: The `page` response needs to be typed through the nested `node.items` path. Use record access since the generic query structure makes type inference impractical.

#### 2. Remove the now-unused `paginateConnection` import (if not used elsewhere in file)

**File**: [`plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts)

**Changes**: Check if `paginateConnection` is used anywhere else in this file. If the archive_items bulk query is the only usage, remove the import. (Based on the grep, it is only used once in this file at line 699.)

Remove from line 15:
```typescript
import { paginateConnection } from "../lib/pagination.js";
```

**Note**: The `paginateConnection` utility itself in `pagination.ts` must NOT be modified or removed -- it is used by other tool modules (issue-tools, hygiene-tools, dashboard-tools, relationship-tools).

#### 3. Remove the old filter-then-slice block and integrate `hasMore`/`totalScanned` into responses

**File**: [`plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts)

**Changes**: Remove lines 741-763 (the old `updatedBeforeCutoff` validation and `matched` filter chain -- these are now handled inside the scan loop). Update all three response paths to include `hasMore` and `totalScanned`:

**Empty result (line 765-773)**:
```typescript
if (matched.length === 0) {
  return toolSuccess({
    dryRun: args.dryRun,
    archivedCount: 0,
    wouldArchive: 0,
    items: [],
    errors: [],
    hasMore: false,
    totalScanned,
  });
}
```

**Dry-run response (line 776-787)**:
```typescript
if (args.dryRun) {
  return toolSuccess({
    dryRun: true,
    wouldArchive: matched.length,
    items: matched.map((m) => ({
      number: m.content?.number,
      title: m.content?.title,
      itemId: m.id,
    })),
    errors: [],
    hasMore,
    totalScanned,
  });
}
```

**Archive response (line 822-827)**:
```typescript
return toolSuccess({
  dryRun: false,
  archivedCount: archived.length,
  items: archived,
  errors,
  hasMore,
  totalScanned,
});
```

#### 4. Add tests for scan-until-full pagination and `hasMore` field

**File**: [`plugin/ralph-hero/mcp-server/src/__tests__/bulk-archive.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/bulk-archive.test.ts)

**Changes**: Add new test suites after the existing ones:

1. **`describe("bulk_archive hasMore response field")`** -- Unit tests for the `hasMore` derivation logic:
   - `hasMore` is `true` when `matched.length >= effectiveMax && hasMorePages`
   - `hasMore` is `false` when all pages exhausted (`!hasMorePages`)
   - `hasMore` is `false` when `matched.length < effectiveMax` (fewer matches than requested)

2. **`describe("bulk_archive totalScanned field")`** -- Unit tests for totalScanned:
   - `totalScanned` counts all items examined, not just matches
   - `totalScanned` stops at SCAN_CAP (2000) when project is very large

3. **`describe("bulk_archive scan-until-full logic")`** -- Structural tests verifying the source code no longer uses the 3x over-fetch:
   - Source no longer contains `effectiveMax * 3`
   - Source contains `SCAN_CAP` constant
   - Source contains `hasMore` in response objects
   - Source contains `totalScanned` in response objects

4. **`describe("archive_items response structure (GH-592)")`** -- Structural tests via source code reading (matches the existing pattern in the file):
   - Tool response includes `hasMore` field
   - Tool response includes `totalScanned` field
   - SCAN_CAP is set to 2000

### Success Criteria

- [x] Automated: `npm run build` (from `plugin/ralph-hero/mcp-server/`) passes with no type errors
- [x] Automated: `npm test` (from `plugin/ralph-hero/mcp-server/`) -- all existing tests pass, new tests pass
- [x] Manual: The `effectiveMax * 3` pattern no longer exists in the codebase
- [x] Manual: Response includes `hasMore: boolean` and `totalScanned: number` in all three response paths (empty, dry-run, archive)

## Integration Testing

- [ ] Run `archive_items` with `dryRun: true, workflowStates: ["Done", "Canceled"], maxItems: 5` on a project with Done/Canceled items scattered among many active items -- verify `wouldArchive` is 5 (or the total eligible count if fewer than 5 exist) and `hasMore` is correct
- [ ] Run `archive_items` with `dryRun: true, maxItems: 200` -- verify `totalScanned` is reasonable (not stuck at 600)
- [ ] Run `archive_items` without `dryRun` for a small batch -- verify `hasMore` accurately reflects remaining items
- [ ] Verify single-item archive mode (`number` param) is unchanged

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-17-GH-0592-archive-items-bulk-query-pagination-bug.md
- Prior research on API behavior: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0115-archive-stats-pipeline-dashboard.md
- Original bulk archive implementation: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0153-bulk-archive-core-tool.md
