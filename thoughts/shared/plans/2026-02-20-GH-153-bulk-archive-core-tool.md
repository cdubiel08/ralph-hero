---
date: 2026-02-20
status: complete
github_issue: 153
github_url: https://github.com/cdubiel08/ralph-hero/issues/153
primary_issue: 153
---

# Core `bulk_archive` MCP Tool - Implementation Plan

## Overview

Single issue implementation: GH-153 — Create core `bulk_archive` MCP tool with workflow state filtering and batch archival.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-153 | Create core `bulk_archive` MCP tool with filter and batch archival | S |

## Current State Analysis

- The existing `ralph_hero__archive_item` tool in `project-management-tools.ts` archives a single project item per call using the `archiveProjectV2Item` mutation.
- `batch-tools.ts` provides a `buildBatchMutationQuery` function that constructs aliased GraphQL mutations for `updateProjectV2ItemFieldValue`. The `bulk_archive` tool needs a similar but simpler builder for `archiveProjectV2Item` (only `projectId` + `itemId` per alias, no fieldId/optionId).
- `project-tools.ts` has `list_project_items` which demonstrates the pattern for querying items via `paginateConnection` and filtering with `getFieldValue`.
- `getFieldValue` is defined as a module-private function in three separate files (`project-tools.ts:572`, `issue-tools.ts:1603`, `dashboard-tools.ts:135`). The `bulk_archive` tool will define its own copy in `project-management-tools.ts` following this established pattern.

## Desired End State

### Verification
- [x] `ralph_hero__bulk_archive` tool registered and functional
- [x] Filters project items by workflow state(s)
- [x] Batch archives matching items using aliased mutations (chunked at 50)
- [x] Returns count and list of archived items
- [x] `buildBatchArchiveMutation` builder function exported from `batch-tools.ts`
- [x] Tests pass for builder function and mutation structure
- [x] `npm run build` and `npm test` succeed

## What We're NOT Doing
- No `dryRun` mode (GH-154 scope)
- No `updatedBefore` date filter (GH-157 scope)
- No `confirm` safety parameter (GH-154 scope)
- No `list_status_updates` or unarchive-in-bulk functionality
- No refactoring of existing `getFieldValue` into a shared module

## Implementation Approach

Two files changed: `batch-tools.ts` gets the new builder function, `project-management-tools.ts` gets the new tool. One new test file: `bulk-archive.test.ts`.

---

## Phase 1: GH-153 — Create core `bulk_archive` MCP tool
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/153 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0153-bulk-archive-core-tool.md

### Changes Required

#### 1. Add `buildBatchArchiveMutation` builder function
**File**: `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts`
**Where**: After the existing `buildBatchFieldValueQuery` function (after line ~175), before the `MUTATION_CHUNK_SIZE` constant

**Changes**: Add new exported pure function:

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

This follows the same pattern as `buildBatchMutationQuery` but is simpler — only 2 variables per alias (`projectId` shared, `itemId` varies) vs 4 per alias.

#### 2. Add `ralph_hero__bulk_archive` tool
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts`
**Where**: After the `ralph_hero__delete_status_update` tool block (end of file, before closing `}`)

**New imports needed** (add to existing imports):
```typescript
import { paginateConnection } from "../lib/pagination.js";
import { buildBatchArchiveMutation } from "./batch-tools.js";
```

**Add private `getFieldValue` helper** (before or after the tool registration, inside the function scope):
```typescript
function getFieldValue(
  item: RawBulkArchiveItem,
  fieldName: string,
): string | undefined {
  const fieldValue = item.fieldValues.nodes.find(
    (fv) =>
      fv.field?.name === fieldName &&
      fv.__typename === "ProjectV2ItemFieldSingleSelectValue",
  );
  return fieldValue?.name;
}
```

**Add private `RawBulkArchiveItem` interface** (alongside `getFieldValue`):
```typescript
interface RawBulkArchiveItem {
  id: string;
  type: string;
  content: { number?: number; title?: string } | null;
  fieldValues: {
    nodes: Array<{
      __typename?: string;
      name?: string;
      field?: { name: string };
    }>;
  };
}
```

**Tool registration**:
- Tool name: `ralph_hero__bulk_archive`
- Description: `"Archive multiple project items matching workflow state filter. Uses aliased GraphQL mutations for efficiency (chunked at 50). Archived items are hidden from views but not deleted. Returns: archivedCount, items, errors."`
- Input schema:
  ```typescript
  {
    owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
    repo: z.string().optional().describe("Repository name. Defaults to env var"),
    workflowStates: z.array(z.string()).min(1)
      .describe('Workflow states to archive (e.g., ["Done", "Canceled"])'),
    maxItems: z.number().optional().default(50)
      .describe("Max items to archive per invocation (default 50, cap 200)"),
  }
  ```
- Handler flow:
  1. `resolveFullConfig(client, args)` — resolve config
  2. `ensureFieldCache(client, fieldCache, projectOwner, projectNumber)` — populate project ID
  3. `fieldCache.getProjectId()` — get project node ID (guard)
  4. Cap `maxItems` to 200: `const effectiveMax = Math.min(args.maxItems, 200)`
  5. Query project items via `paginateConnection<RawBulkArchiveItem>()`:
     - Use `client.projectQuery` as executor
     - Query fetches `items(first: $first, after: $cursor)` with `id`, `type`, `content { ... on Issue { number title } ... on PullRequest { number title } }`, and `fieldValues(first: 20)` with `... on ProjectV2ItemFieldSingleSelectValue { __typename name field { ... on ProjectV2FieldCommon { name } } }`
     - Connection path: `"node.items"`
     - `maxItems`: `effectiveMax * 3` (over-fetch to account for filtering losses, cap at 600)
  6. Client-side filter: `items.filter(item => { const ws = getFieldValue(item, "Workflow State"); return ws && args.workflowStates.includes(ws); })` then `.slice(0, effectiveMax)`
  7. If no matches: return `toolSuccess({ archivedCount: 0, items: [], errors: [] })`
  8. Chunk matched item IDs at 50 (`MUTATION_CHUNK_SIZE` — import or inline constant):
     ```typescript
     const ARCHIVE_CHUNK_SIZE = 50;
     const itemIds = matched.map(m => m.id);
     const archived: Array<{ number?: number; title?: string; itemId: string }> = [];
     const errors: string[] = [];
     for (let i = 0; i < itemIds.length; i += ARCHIVE_CHUNK_SIZE) {
       const chunk = itemIds.slice(i, i + ARCHIVE_CHUNK_SIZE);
       const chunkItems = matched.slice(i, i + ARCHIVE_CHUNK_SIZE);
       try {
         const { mutationString, variables } = buildBatchArchiveMutation(projectId, chunk);
         await client.projectMutate(mutationString, variables);
         for (const item of chunkItems) {
           archived.push({
             number: item.content?.number,
             title: item.content?.title,
             itemId: item.id,
           });
         }
       } catch (error: unknown) {
         const msg = error instanceof Error ? error.message : String(error);
         errors.push(`Chunk ${Math.floor(i / ARCHIVE_CHUNK_SIZE) + 1} failed: ${msg}`);
       }
     }
     ```
  9. Return `toolSuccess({ archivedCount: archived.length, items: archived, errors })`
  10. Outer catch: `toolError("Failed to bulk archive: ${message}")`

#### 3. Add tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/bulk-archive.test.ts` (new file)

**Tests for `buildBatchArchiveMutation`** (import from `../tools/batch-tools.js`):

```typescript
import { describe, it, expect } from "vitest";
import { buildBatchArchiveMutation } from "../tools/batch-tools.js";

describe("buildBatchArchiveMutation", () => {
  it("generates correct aliases for multiple items", () => {
    const { mutationString, variables } = buildBatchArchiveMutation(
      "proj-123",
      ["item-a", "item-b", "item-c"],
    );
    expect(mutationString).toContain("a0:");
    expect(mutationString).toContain("a1:");
    expect(mutationString).toContain("a2:");
    expect(variables.projectId).toBe("proj-123");
    expect(variables.item_a0).toBe("item-a");
    expect(variables.item_a1).toBe("item-b");
    expect(variables.item_a2).toBe("item-c");
  });

  it("starts with mutation keyword", () => {
    const { mutationString } = buildBatchArchiveMutation("proj-1", ["item-1"]);
    expect(mutationString.trimStart()).toMatch(/^mutation\(/);
  });

  it("uses archiveProjectV2Item mutation", () => {
    const { mutationString } = buildBatchArchiveMutation("proj-1", ["item-1"]);
    expect(mutationString).toContain("archiveProjectV2Item");
  });

  it("handles single item correctly", () => {
    const { mutationString, variables } = buildBatchArchiveMutation(
      "proj-1",
      ["single-item"],
    );
    expect(mutationString).toContain("a0:");
    expect(mutationString).not.toContain("a1:");
    expect(variables.item_a0).toBe("single-item");
  });

  it("does not use reserved @octokit/graphql variable names", () => {
    const reserved = ["query", "method", "url"];
    const { variables } = buildBatchArchiveMutation("proj-1", ["item-1", "item-2"]);
    for (const key of Object.keys(variables)) {
      expect(reserved).not.toContain(key);
    }
  });
});

describe("bulk_archive mutation structure", () => {
  it("archiveProjectV2Item mutation has required input fields", () => {
    const mutation = `mutation($projectId: ID!, $item_a0: ID!) {
      a0: archiveProjectV2Item(input: {
        projectId: $projectId,
        itemId: $item_a0
      }) {
        item { id }
      }
    }`;
    expect(mutation).toContain("archiveProjectV2Item");
    expect(mutation).toContain("projectId");
    expect(mutation).toContain("item_a0");
  });
});
```

### Success Criteria
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` succeeds
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes
- [x] Manual: `ralph_hero__bulk_archive` tool appears in MCP tool listing
- [x] Manual: Tool correctly filters by workflow state and archives matching items

---

## Integration Testing
- [ ] Build succeeds: `cd plugin/ralph-hero/mcp-server && npm run build`
- [ ] All tests pass: `cd plugin/ralph-hero/mcp-server && npm test`
- [ ] No type errors in new code
- [ ] `buildBatchArchiveMutation` builder tests pass
- [ ] Variable naming safety (no `query`, `method`, `url` collisions)

## References
- Research GH-153: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0153-bulk-archive-core-tool.md
- Existing archive tool: `plugin/ralph-hero/mcp-server/src/tools/project-management-tools.ts:40-108`
- Batch builder pattern: `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts:86-126`
- Pagination: `plugin/ralph-hero/mcp-server/src/lib/pagination.ts:65-118`
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/96
- Parent tracking: https://github.com/cdubiel08/ralph-hero/issues/113
