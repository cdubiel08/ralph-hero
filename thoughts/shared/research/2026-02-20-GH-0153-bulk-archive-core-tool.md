---
date: 2026-02-20
github_issue: 153
github_url: https://github.com/cdubiel08/ralph-hero/issues/153
status: complete
type: research
---

# GH-153: Create Core `bulk_archive` MCP Tool

## Problem Statement

The existing `ralph_hero__archive_item` tool archives a single project item at a time. For project hygiene workflows (archiving Done/Canceled items older than N days), this requires N separate MCP calls. A `bulk_archive` tool should filter project items by criteria and archive them in batch using the aliased-mutation pattern established by `batch_update`.

## Current State Analysis

### Single-Item Archive (`project-management-tools.ts:32-100`)

The existing `archive_item` tool uses the `archiveProjectV2Item` mutation:

```graphql
mutation($projectId: ID!, $itemId: ID!) {
  archiveProjectV2Item(input: {
    projectId: $projectId,
    itemId: $itemId
  }) {
    item { id }
  }
}
```

Key details:
- Uses `client.projectMutate()` (project token, auto cache invalidation)
- Resolves item via `resolveProjectItemId(client, fieldCache, owner, repo, number)`
- Returns `{ number, archived: true, projectItemId }`

### Batch Mutation Pattern (`batch-tools.ts:86-126`)

The `buildBatchMutationQuery` function creates aliased GraphQL mutations:
- Takes `projectId` and array of `{ alias, itemId, fieldId, optionId }`
- Generates one `mutation(...)` block with N aliases, each calling `updateProjectV2ItemFieldValue`
- Returns `{ mutationString, variables }` for `client.projectMutate()`
- Chunks at `MUTATION_CHUNK_SIZE = 50` (line 179)

For `bulk_archive`, we need a **similar but simpler** builder — `archiveProjectV2Item` takes only `{ projectId, itemId }` (no fieldId/optionId), so the builder is simpler.

### Project Items Query Pattern (`project-tools.ts:434-493`)

`list_project_items` uses `paginateConnection` to fetch items with field values:

```graphql
query($projectId: ID!, $cursor: String, $first: Int!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: $first, after: $cursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          type
          content {
            ... on Issue { number title state url ... }
          }
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                __typename name optionId field { ...on ProjectV2FieldCommon { name } }
              }
            }
          }
        }
      }
    }
  }
}
```

The `getFieldValue(item, "Workflow State")` helper (lines 572-582) extracts single-select values by matching `field.name` and `__typename`.

### Batch Resolve Pattern (`batch-tools.ts:46-80`)

`buildBatchResolveQuery` resolves N issue numbers to node IDs + project item IDs in one query. **Not needed for bulk_archive** — the query phase already returns project item node IDs directly from `items.nodes[].id`.

## Implementation Plan

### New Builder Function: `buildBatchArchiveMutation`

Create in `batch-tools.ts` (or a new file) — analogous to `buildBatchMutationQuery` but for `archiveProjectV2Item`:

```typescript
export function buildBatchArchiveMutation(
  projectId: string,
  itemIds: string[],
): { mutationString: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = { projectId };
  const varDecls = ["$projectId: ID!"];
  const aliases: string[] = [];

  for (let i = 0; i < itemIds.length; i++) {
    const itemVar = `item_a${i}`;
    varDecls.push(`$${itemVar}: ID!`);
    variables[itemVar] = itemIds[i];

    aliases.push(
      `a${i}: archiveProjectV2Item(input: {
        projectId: $projectId,
        itemId: $${itemVar}
      }) {
        item { id }
      }`,
    );
  }

  const mutationString = `mutation(${varDecls.join(", ")}) {\n  ${aliases.join("\n  ")}\n}`;
  return { mutationString, variables };
}
```

This is simpler than `buildBatchMutationQuery` — only 2 variables per alias (projectId is shared, itemId varies) vs 4 per alias.

### Tool Schema

```typescript
server.tool(
  "ralph_hero__bulk_archive",
  "Archive multiple project items matching filter criteria in batch. Uses aliased GraphQL mutations for efficiency. Returns: archived count, item list, errors. Recovery: partial failures don't abort; check errors array.",
  {
    owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
    repo: z.string().optional().describe("Repository name. Defaults to env var"),
    workflowStates: z
      .array(z.string())
      .min(1)
      .describe('Workflow states to archive (e.g., ["Done", "Canceled"])'),
    maxItems: z
      .number()
      .optional()
      .default(50)
      .describe("Max items to archive (default 50, cap 100)"),
  },
);
```

### Execution Flow

1. `resolveFullConfig()` + `ensureFieldCache()`
2. Query project items via `paginateConnection` with `maxItems` cap
3. Client-side filter: `getFieldValue(item, "Workflow State")` matches `workflowStates` array
4. Extract `item.id` (project item node ID) from matching items
5. Chunk into batches of 50 (`MUTATION_CHUNK_SIZE`)
6. Per chunk: `buildBatchArchiveMutation()` → `client.projectMutate()`
7. Track successes/failures per chunk
8. Return `{ archived: number, items: [...], errors: [...] }`

### Where to Put the Code

**Option A: Add to `project-management-tools.ts`** (alongside `archive_item`)
- Pro: Keeps archive operations together
- Con: File grows; needs to import pagination and batch patterns

**Option B: Add to `batch-tools.ts`** (alongside `batch_update`)
- Pro: Reuses batch infrastructure (chunk size, builder pattern)
- Con: Mixes field-update batching with archive batching

**Option C: New `bulk-archive-tools.ts`** (dedicated file)
- Pro: Clean separation, clear ownership
- Con: Yet another tool file

**Recommendation: Option A** — `project-management-tools.ts` already owns `archive_item`, and the bulk version is a natural extension. The builder function (`buildBatchArchiveMutation`) should go in `batch-tools.ts` since it follows the builder pattern established there.

### Cache Considerations

- `archiveProjectV2Item` hides the item from default views but does NOT remove it from the project
- The `project-item-id:` cache key should **NOT** be invalidated (item still exists, just hidden)
- `client.projectMutate()` automatically invalidates `query:` prefixed cache entries
- No special cache handling needed beyond what `projectMutate` does

### Tests

Follow `batch-tools.test.ts` pattern — test the builder function as a pure function:

1. `buildBatchArchiveMutation` generates correct aliases and variables
2. Variable names don't collide with `@octokit/graphql` v9 reserved names (`query`, `method`, `url`)
3. Single item produces correct mutation structure
4. Multiple items produce correct aliased mutation

For the tool handler, test the filtering logic:
1. `workflowStates: ["Done"]` matches only Done items
2. `workflowStates: ["Done", "Canceled"]` matches both
3. `maxItems` caps the number of items processed
4. Items without matching workflow state are excluded
5. Non-Issue items (DraftIssue, PullRequest) are handled correctly

## Group Overlap Analysis

The parent #113 has 5 children with **significant overlaps**:

| Issue | Title | Estimate | Overlap |
|-------|-------|----------|---------|
| **#153** | Core `bulk_archive` with filter and batch archival | S | **Core tool — includes `updatedBefore` + `workflowStates`** |
| #154 | Dry-run mode and safety features | XS | **Overlaps #155** — adds `dryRun` + `confirm` params |
| **#155** | Add `dryRun` mode to `bulk_archive` | XS | **Overlaps #154** — adds `dryRun` param only |
| **#156** | Implement `bulk_archive` core tool with workflow state filtering | S | **Overlaps #153** — same scope but `workflowStates` only |
| #157 | Add `updatedBefore` date filter to `bulk_archive` | XS | Extends core with date filtering |

**Recommendation**: Close #156 as duplicate of #153 (identical core scope), and close #155 as duplicate of #154 (same dry-run scope). This leaves a clean 3-issue chain:

1. **#153** (S): Core tool — `workflowStates` filter + batch archive mutations
2. **#157** (XS): Add `updatedBefore` date filter (depends on #153)
3. **#154** (XS): Add `dryRun` + `confirm` safety features (depends on #153)

#157 and #154 can be implemented in parallel after #153.

## Risks

1. **Rate limiting on large archives**: Archiving 100 items = 2 mutation calls (50 per chunk). Each aliased mutation counts as 1 GraphQL call but N mutations internally. Monitor GitHub's rate limit response. The `RateLimiter` only tracks remaining quota from *query* responses (mutations don't inject `rateLimit` fragment), so a rapid sequence of large archives could hit secondary rate limits.

2. **Archived items still exist**: `archiveProjectV2Item` hides items from views but doesn't delete them. Users may be surprised items still count toward project limits. The tool description should clarify this.

3. **No undo in batch**: There's no `bulk_unarchive`. If a batch archive goes wrong, items must be unarchived one-by-one via `archive_item --unarchive`. The dry-run feature (#154) mitigates this risk.

## File Changes

| File | Change | Effort |
|------|--------|--------|
| `tools/project-management-tools.ts` | Add `ralph_hero__bulk_archive` tool registration and handler | Primary |
| `tools/batch-tools.ts` | Add `buildBatchArchiveMutation` exported builder function | Secondary |
| `index.ts` | No change needed — `registerProjectManagementTools` already called | None |
| `__tests__/bulk-archive.test.ts` | New test file for builder + filtering logic | Secondary |

## Recommended Approach

1. Add `buildBatchArchiveMutation()` to `batch-tools.ts` — follows existing builder pattern, simple function (projectId + itemIds → mutation string)
2. Add `ralph_hero__bulk_archive` tool to `project-management-tools.ts` — reuse `paginateConnection` for item fetching, `getFieldValue` for workflow state matching, `buildBatchArchiveMutation` for batch execution
3. Keep `updatedBefore` and `dryRun` out of scope — those are #157 and #154 respectively
4. Test builder as pure function, test filtering logic with mock data
