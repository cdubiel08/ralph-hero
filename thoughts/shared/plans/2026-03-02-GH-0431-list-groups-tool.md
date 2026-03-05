---
date: 2026-03-02
status: draft
github_issues: [431]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/431
primary_issue: 431
---

# Add `list_groups` Tool — Implementation Plan

## Overview

1 issue for implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-431 | Add list_groups tool to discover all parent issues with sub-issue expansion | S |

## Current State Analysis

There is no way to enumerate issue groups (parent issues with sub-issues) across a project. The only path today is calling `get_issue(includeGroup: true)` per issue — N calls for N groups — which is prohibitively expensive.

**Existing infrastructure** (from [research doc](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0431-list-groups-tool.md)):

- [`list_issues`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L59) paginates all project items (up to 500) and filters client-side. Its GraphQL content fragment does **not** include `subIssuesSummary`.
- [`list_sub_issues`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L206) fetches children of a *known* parent via `repository.issue(number)`. Requires knowing the parent first.
- `subIssuesSummary { total completed percentCompleted }` is a native Issue field, confirmed working in `get_issue` and `list_sub_issues`. Adding it to the project items content fragment enables single-pass parent detection.
- Child `workflowState` resolves for free: children are themselves project items in the same pagination result. Build a `number → fieldValues` lookup map, cross-reference at assembly time.

## Desired End State

A new `ralph_hero__list_groups` MCP tool in `relationship-tools.ts` that:

1. Fetches all project items in a single paginated pass (same as `list_issues`)
2. Filters to parent issues (`subIssuesSummary.total > 0`)
3. Applies parent-level filters (state, workflowState, estimate, priority, limit)
4. Optionally expands children with `showChildren: true`, resolving each child's `workflowState` from the item lookup map
5. Returns `{ totalGroups, groups: [{ parent, childCount, completedCount, children? }] }`

### Verification
- [x] `ralph_hero__list_groups` tool is registered and callable via MCP
- [x] Returns only issues with `subIssuesSummary.total > 0`
- [x] Parent-level filters (state, workflowState, estimate, priority) work correctly
- [x] `showChildren: false` (default) omits `children` array, includes `childCount`/`completedCount`
- [x] `showChildren: true` returns children with `number`, `title`, `state`, `workflowState`
- [x] Child `workflowState` resolved from project item lookup map (zero extra API calls)
- [x] `limit` parameter caps output (default 50)
- [x] Tests pass: `npm test` in mcp-server/
- [x] TypeScript compiles: `npm run build` in mcp-server/

## What We're NOT Doing

- Not modifying the existing `list_issues` content fragment (separate concern)
- Not adding child-level filtering (filter by child workflowState, etc.)
- Not handling children with >50 sub-issues (existing codebase limit; add `hasMore` flag)
- Not supporting nested sub-issue expansion (depth > 1 for children)
- Not adding a `percentCompleted` sort option

## Implementation Approach

The tool reuses the `list_issues` pagination pattern (`paginateConnection` over project items) but with an extended content fragment that includes `subIssuesSummary`. After pagination, it builds a lookup map for child workflowState resolution, filters to parents, applies filters, and assembles the response.

---

## Phase 1: Implement `ralph_hero__list_groups` tool

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/431 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0431-list-groups-tool.md

### Changes Required

#### 1. Add `list_groups` tool to `relationship-tools.ts`

**File**: [`plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts)

**Changes**:

**1a. Add import for `paginateConnection`**

At the import block (line ~14), add:

```typescript
import { paginateConnection } from "../lib/pagination.js";
```

The existing `resolveFullConfig` import on line ~31 is already present. Also add `resolveFullConfigOptionalRepo` if not already imported (check — `list_groups` can work without a repo filter since it's project-scoped).

**1b. Add `RawProjectItem` interface**

This interface is currently defined privately in `issue-tools.ts:1735-1749`. For `list_groups`, define a local version in `relationship-tools.ts` (or import if it gets exported — but keeping it local avoids coupling):

```typescript
interface RawProjectItem {
  id: string;
  type: string;
  content: Record<string, unknown> | null;
  fieldValues: {
    nodes: Array<{
      __typename?: string;
      name?: string;
      optionId?: string;
      field?: { name: string };
    }>;
  };
}
```

**1c. Add `getFieldValue` helper**

Same pattern as `issue-tools.ts:1751-1761`, module-private:

```typescript
function getFieldValue(
  item: RawProjectItem,
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

**1d. Register `ralph_hero__list_groups` tool**

Add at the end of `registerRelationshipTools()`, before the closing `}`. Follow the exact pattern of existing tools.

**Zod schema** (matching issue spec parameters):

```typescript
{
  owner: z.string().optional()
    .describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
  repo: z.string().optional()
    .describe("Repository name. Defaults to GITHUB_REPO env var"),
  projectNumber: z.coerce.number().optional()
    .describe("Project number override (defaults to configured project)"),
  state: z.enum(["OPEN", "CLOSED"]).optional().default("OPEN")
    .describe("Filter parent issues by state (default: OPEN)"),
  showChildren: z.boolean().optional().default(false)
    .describe("Expand each group to include child issues with number/title/state/workflowState"),
  workflowState: z.string().optional()
    .describe("Filter parents by workflow state"),
  estimate: z.string().optional()
    .describe("Filter parents by estimate"),
  priority: z.string().optional()
    .describe("Filter parents by priority"),
  limit: z.coerce.number().optional().default(50)
    .describe("Max groups to return (default 50)"),
}
```

**Handler implementation** — the core algorithm:

```
1. Resolve config (owner, projectNumber, projectOwner)
2. ensureFieldCache(client, fieldCache, projectOwner, projectNumber)
3. Get projectId from fieldCache
4. Build GraphQL query:
   - Same project items pagination as list_issues
   - Content fragment extended with:
     - subIssuesSummary { total completed percentCompleted }
     - subIssues(first: 50) { nodes { number title state } } (only when showChildren: true)
   - fieldValues(first: 20) for project field values
5. paginateConnection<RawProjectItem>(..., { maxItems: 500 })
6. Build lookup map: Map<number, { workflowState, estimate, priority }>
   - For each item where type === "ISSUE" && content:
     - map.set(content.number, { workflowState: getFieldValue(item, "Workflow State"), ... })
7. Filter to parents: items where subIssuesSummary.total > 0
8. Apply parent-level filters:
   - state: content.state === args.state
   - workflowState: getFieldValue(item, "Workflow State") === args.workflowState
   - estimate: getFieldValue(item, "Estimate") === args.estimate
   - priority: getFieldValue(item, "Priority") === args.priority
9. Sort by issue number ascending (stable ordering)
10. Slice to args.limit
11. Assemble response:
    For each parent item:
    {
      parent: { number, title, state, workflowState, estimate, priority, url },
      childCount: subIssuesSummary.total,
      completedCount: subIssuesSummary.completed,
      percentCompleted: subIssuesSummary.percentCompleted,
      children: (showChildren ? subIssues.nodes.map(child => ({
        number, title, state,
        workflowState: lookupMap.get(child.number)?.workflowState ?? null,
        estimate: lookupMap.get(child.number)?.estimate ?? null,
      })) : undefined),
      hasMore: (showChildren && content.subIssues?.nodes?.length === 50) ? true : undefined,
    }
12. Return toolSuccess({ totalGroups: groups.length, groups })
```

**GraphQL query** (two variants — with and without children):

Base query (showChildren: false):
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
            ... on Issue {
              number
              title
              state
              url
              subIssuesSummary { total completed percentCompleted }
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
}
```

Extended query (showChildren: true) — adds `subIssues` to the Issue fragment:
```graphql
subIssues(first: 50) {
  nodes { number title state }
}
```

**Implementation note**: Use string interpolation to conditionally include `subIssues` in the GraphQL query based on `args.showChildren`, exactly like `buildSubIssueFragment` does for depth.

#### 2. Add tests for `list_groups`

**File**: [`plugin/ralph-hero/mcp-server/src/__tests__/relationship-tools.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/relationship-tools.test.ts)

**Changes**: Add a new `describe("list_groups")` block. Follow the existing structural + unit test pattern.

**Structural tests** (source-verification):

```typescript
describe("list_groups structural", () => {
  it("registers ralph_hero__list_groups tool", () => {
    expect(relationshipToolsSrc).toContain("ralph_hero__list_groups");
  });

  it("has showChildren parameter in Zod schema", () => {
    expect(relationshipToolsSrc).toContain("showChildren: z.boolean()");
  });

  it("has state parameter with OPEN default", () => {
    expect(relationshipToolsSrc).toMatch(/state:.*z\.enum.*OPEN.*CLOSED/s);
  });

  it("has limit parameter with default 50", () => {
    // Verify the limit param exists — exact syntax may vary
    expect(relationshipToolsSrc).toContain("limit:");
  });

  it("queries subIssuesSummary in project items", () => {
    expect(relationshipToolsSrc).toContain("subIssuesSummary { total completed percentCompleted }");
  });

  it("builds lookup map from project items", () => {
    // Verify the lookup map construction pattern
    expect(relationshipToolsSrc).toContain("Map<number");
  });

  it("filters items to parents (subIssuesSummary.total > 0)", () => {
    expect(relationshipToolsSrc).toContain("subIssuesSummary");
    expect(relationshipToolsSrc).toContain("total");
  });

  it("uses paginateConnection for fetching", () => {
    expect(relationshipToolsSrc).toContain("paginateConnection");
  });

  it("tool description mentions group discovery", () => {
    expect(relationshipToolsSrc).toMatch(
      /list_groups.*parent.*sub-issue|group.*discover/i,
    );
  });
});
```

**Unit test for `getFieldValue`** (if exported, test directly; if private, test via structural verification).

### Success Criteria
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` compiles without errors
- [x] Automated: `cd plugin/ralph-hero/mcp-server && npm test` all tests pass
- [ ] Manual: Call `ralph_hero__list_groups` and verify it returns parent issues with childCount
- [ ] Manual: Call with `showChildren: true` and verify children include `workflowState`
- [ ] Manual: Call with `workflowState: "Backlog"` and verify filtering works

---

## Integration Testing

- [x] `npm run build` compiles successfully
- [x] `npm test` passes all existing + new tests
- [ ] Manual: `list_groups()` returns groups from the project board
- [ ] Manual: `list_groups(showChildren: true)` includes children with resolved `workflowState`
- [ ] Manual: `list_groups(state: "OPEN", workflowState: "Backlog")` filters correctly
- [ ] Manual: `list_groups(limit: 3)` caps output at 3 groups
- [ ] Manual: Children not on the project board return `workflowState: null`

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0431-list-groups-tool.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/431
- Pattern reference: [`list_issues` implementation](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L59-L444)
- Pattern reference: [`list_sub_issues` implementation](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts#L206-L297)
