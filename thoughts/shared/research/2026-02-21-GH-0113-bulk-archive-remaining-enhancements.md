---
date: 2026-02-21
github_issue: 113
github_url: https://github.com/cdubiel08/ralph-hero/issues/113
status: complete
type: research
---

# GH-113: bulk_archive Remaining Enhancements (dryRun + updatedBefore)

## Problem Statement

The core `bulk_archive` MCP tool is implemented (PR #191, #153). Two remaining sub-issues add incremental features:
- **#155** (XS): `dryRun` boolean parameter — preview what would be archived without executing mutations
- **#157** (XS): `updatedBefore` ISO date filter — archive only items not updated since a given date

## Current Implementation Analysis

### Tool Location & Schema (`project-management-tools.ts:1157-1293`)

The `ralph_hero__bulk_archive` tool accepts:
- `workflowStates: string[]` (required) — filter by workflow state
- `maxItems: number` (optional, default 50, cap 200) — limit items per invocation
- `owner`, `repo`, `projectNumber` — standard config params

### Execution Flow

1. Query project items via `paginateConnection` with a GraphQL query that fetches `id`, `type`, `content { number, title }`, and `fieldValues` (for workflow state extraction)
2. Client-side filter: `getBulkArchiveFieldValue(item, "Workflow State")` matches `workflowStates` array
3. Slice to `effectiveMax`
4. Chunk into batches of 50, execute `buildBatchArchiveMutation()` per chunk via `client.projectMutate()`
5. Return `{ archivedCount, items, errors }`

### GraphQL Query (`project-management-tools.ts:1196-1228`)

The current query does **NOT** fetch `updatedAt`:

```graphql
content {
  ... on Issue { number, title }
  ... on PullRequest { number, title }
}
```

For #157, the query must add `updatedAt` to the Issue and PullRequest fragments.

### Internal Type (`project-management-tools.ts:1393-1404`)

```typescript
interface RawBulkArchiveItem {
  id: string;
  type: string;
  content: { number?: number; title?: string } | null;
  fieldValues: { nodes: Array<{...}> };
}
```

For #157, `content` must be extended with `updatedAt?: string`.

## Research Findings

### #155: dryRun Mode

**Existing pattern**: `sync_across_projects` in `sync-tools.ts:220-224` already implements `dryRun`:

```typescript
dryRun: z.boolean().optional().default(false)
  .describe("If true, return affected projects without mutating (default: false)"),
```

When `dryRun` is true, the tool skips the mutation phase and includes `dryRun: true` in each result item (lines 279-286).

**Implementation approach for bulk_archive**:

1. Add `dryRun: z.boolean().optional().default(false)` to the tool schema
2. After the filter phase (line 1240), if `args.dryRun` is true:
   - Return the matched items list without executing mutations
   - Return shape: `{ dryRun: true, wouldArchive: matched.length, items: [...], errors: [] }`
3. When `dryRun` is false (default): existing behavior unchanged

**Key design decision**: #154 proposed `dryRun` defaulting to `true` with a separate `confirm` param. #155 proposes `dryRun` defaulting to `false`. The `sync_across_projects` precedent uses `default(false)`. Recommend following the established pattern: `dryRun` defaults to `false`, no separate `confirm` param. The tool description should note the dry-run option.

**Effort**: Minimal. One new schema param, one conditional check before the mutation loop. Add 2-3 test cases (dryRun returns items without archiving, dryRun flag in response, no mutations executed).

### #157: updatedBefore Date Filter

**Existing date comparison patterns**:

1. `hygiene.ts:88-95` — `ageDays(ts, now) > archiveDays` using `closedAt ?? updatedAt`
2. `dashboard.ts:175-178` — `doneWindowDays * 24 * 60 * 60 * 1000` for window-based filtering
3. `dashboard.ts:393-395` — `now - new Date(ts).getTime()` for age calculation

**Implementation approach for bulk_archive**:

1. Add `updatedBefore: z.string().optional()` to tool schema with ISO 8601 date description
2. Extend the GraphQL content fragment to include `updatedAt`:
   ```graphql
   content {
     ... on Issue { number, title, updatedAt }
     ... on PullRequest { number, title, updatedAt }
   }
   ```
3. Extend `RawBulkArchiveItem.content` type to include `updatedAt?: string`
4. Add date filter in the `.filter()` chain (line 1235-1239):
   ```typescript
   if (args.updatedBefore) {
     const cutoff = new Date(args.updatedBefore).getTime();
     if (isNaN(cutoff)) return toolError("Invalid updatedBefore date");
     // filter: item.content?.updatedAt must be before cutoff
   }
   ```
5. Compose with `workflowStates` via AND logic

**Date validation**: Use `new Date(iso).getTime()` and check for `NaN`. Return a descriptive error for invalid dates.

**Note on #105**: GH-105 proposes `@today-Nd` date-math syntax. That issue is separate and unrelated to the core ISO date filtering here. If #105 is implemented later, `updatedBefore` could optionally accept date-math strings, but ISO dates are sufficient for now.

**Effort**: Small. Extend GraphQL query, extend type, add date comparison in filter, validate input. Add 3-4 test cases (date filter only, combined with workflowStates, invalid date error, boundary test).

## Implementation Recommendations

### Order of Implementation

**#155 (dryRun) first**, then **#157 (updatedBefore)**. Rationale:
- dryRun is simpler (no GraphQL query changes) and provides immediate safety value
- dryRun tests can verify the filter-only path works correctly
- updatedBefore changes the GraphQL query and type — easier to verify correctness with dryRun available

### Shared Considerations

- Both changes modify `project-management-tools.ts` at the same tool registration (lines 1157-1293)
- Both add to `__tests__/bulk-archive.test.ts`
- Neither requires changes to `batch-tools.ts` or `buildBatchArchiveMutation`
- Both are backward-compatible (new optional params with defaults preserving existing behavior)

## File Changes

### #155 (dryRun)

| File | Change |
|------|--------|
| `tools/project-management-tools.ts` | Add `dryRun` param to schema, add conditional before mutation loop |
| `__tests__/bulk-archive.test.ts` | Add dryRun test cases |

### #157 (updatedBefore)

| File | Change |
|------|--------|
| `tools/project-management-tools.ts` | Add `updatedBefore` param, extend GraphQL query + type, add date filter |
| `__tests__/bulk-archive.test.ts` | Add date filter test cases |

## Risks

1. **GraphQL query change for #157**: Adding `updatedAt` to the content fragment is safe — it's a standard Issue/PullRequest field. But `DraftIssue` type does NOT have `updatedAt`, so the fragment must remain on `... on Issue` and `... on PullRequest` only. Items with `null` content (DraftIssues) should be excluded from date filtering (already excluded since `content` is null).

2. **Date timezone handling**: `updatedAt` from GitHub is always UTC ISO 8601. The `updatedBefore` param should also be interpreted as UTC. Document this in the param description.

3. **No undo for non-dryRun**: Same risk as before — no `bulk_unarchive` exists. The dryRun feature (#155) mitigates this.
