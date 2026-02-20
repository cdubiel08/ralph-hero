---
date: 2026-02-20
github_issue: 107
github_url: https://github.com/cdubiel08/ralph-hero/issues/107
status: complete
type: research
---

# GH-107: Add `reason` Filter to Distinguish Close Types

## Problem Statement

The `list_issues` tool cannot distinguish between issues closed as "completed" vs "not planned". This is critical for velocity metrics (#139) — velocity should count `COMPLETED` closures only, not `NOT_PLANNED` ones. The `get_issue` tool already surfaces `stateReason` in its response, but `list_issues` neither fetches nor filters by it.

## Current State Analysis

### `list_issues` Tool (`issue-tools.ts:52-241`)

**Zod schema** (lines 52-92): 8 params — `owner`, `repo`, `workflowState`, `estimate`, `priority`, `label`, `query`, `state` (OPEN/CLOSED), `orderBy`, `limit`. No `reason` param.

**GraphQL query** (lines 111-147): Fetches `state` but NOT `stateReason` in the Issue fragment:
```graphql
... on Issue {
  number title body state url createdAt updatedAt
  labels(first: 10) { nodes { name } }
  assignees(first: 5) { nodes { login } }
}
```

**Client-side filters** (lines 154-208): Sequential `Array.filter()` calls for `state`, `workflowState`, `estimate`, `priority`, `label`, `query`. No `stateReason` filter.

**Response mapping** (lines 225-241): Returns `number`, `title`, `state`, `url`, `workflowState`, `estimate`, `priority`, `labels`, `assignees`. No `stateReason` in output.

### `get_issue` Tool — Already Has `stateReason`

- **GraphQL query** (line 348): Fetches `stateReason` as a bare field
- **Response mapping** (line 504): `stateReason: issue.stateReason` — passes through directly
- **Type** (`types.ts:207`): `stateReason?: "COMPLETED" | "NOT_PLANNED" | "REOPENED" | null`

### GitHub GraphQL API Capabilities

**`IssueStateReason` enum values:**
- `COMPLETED` — closed as completed
- `NOT_PLANNED` — closed as not planned
- `REOPENED` — was closed, now reopened (appears on currently-open issues)

**Server-side filtering:**
- `repository.issues()` does NOT accept a `stateReason` filter parameter — only `states`, `labels`, `orderBy`
- GitHub `search()` API supports `reason:completed` and `reason:"not planned"` qualifiers
- Since `list_issues` uses `paginateConnection` with the repository issues query, **client-side filtering is the practical approach**

## Implementation Plan

### 1. Add `stateReason` to GraphQL Query

In the `list_issues` GraphQL fragment (line ~125), add `stateReason` after `state`:

```graphql
... on Issue {
  number title body state stateReason url createdAt updatedAt
  labels(first: 10) { nodes { name } }
  assignees(first: 5) { nodes { login } }
}
```

### 2. Add `reason` Param to Zod Schema

Insert after the `state` param (line ~81):

```typescript
reason: z
  .enum(["completed", "not_planned", "reopened"])
  .optional()
  .describe("Filter by close reason: completed, not_planned, reopened"),
```

Use lowercase values in the Zod schema (user-facing), map to uppercase for API comparison.

### 3. Add Client-Side Filter

Insert after the `state` filter block (line ~163), following the same pattern:

```typescript
if (args.reason) {
  const reasonUpper = args.reason.toUpperCase();
  items = items.filter((item) => {
    const content = item.content as Record<string, unknown> | null;
    return content?.stateReason === reasonUpper;
  });
}
```

### 4. Add `stateReason` to Response

In the `formattedItems` map (line ~225), add after `state`:

```typescript
stateReason: content?.stateReason ?? null,
```

### 5. Tests

Add to existing `list_issues` test coverage:
- Filter by `reason: "completed"` returns only COMPLETED-closed issues
- Filter by `reason: "not_planned"` returns only NOT_PLANNED-closed issues
- Filter by `reason: "reopened"` returns only REOPENED issues
- No `reason` param returns all issues (no filter applied)
- Combining `state: "CLOSED"` with `reason: "completed"` narrows correctly

## Edge Cases

1. **Open issues with REOPENED reason**: An open issue that was previously closed has `stateReason: "REOPENED"`. Filtering `reason: "reopened"` with `state: "OPEN"` should return these.
2. **Null stateReason**: Open issues that were never closed have `stateReason: null`. The filter should exclude these when any `reason` value is specified.
3. **State/reason mismatch**: `state: "OPEN"` + `reason: "completed"` returns empty (no open issue is completed). This is valid behavior, not an error.

## File Changes

| File | Change | Effort |
|------|--------|--------|
| `tools/issue-tools.ts` | Add `stateReason` to GraphQL query, Zod schema, filter, response | Primary |
| `__tests__/issue-tools.test.ts` | Add reason filter tests | Secondary |
| No other files affected | | |

## Group Context

Part of the #94 (Intelligent Agent Filtering) group with 8 siblings. #107 is independent — no blocking dependencies on other group members. Can be implemented in parallel with #108 (draft issue filtering).

## Risks

1. **Minimal risk**: This is a straightforward additive change — one new field in query, one new filter, one new response field. No existing behavior changes.
2. **Test coverage**: The existing test file for issue-tools should have integration tests; if not, mock-based unit tests following the dashboard.test.ts factory pattern will suffice.

## Recommended Approach

Follow the exact pattern of existing filters (workflowState, estimate, priority):
1. Add to Zod schema with `.optional()` and `.describe()`
2. Add field to GraphQL query
3. Add `if (args.reason)` client-side filter block
4. Add to response mapping
5. Add tests

Estimated effort: ~30 minutes implementation + tests. Cleanly scoped S issue.
