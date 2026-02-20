---
date: 2026-02-20
github_issue: 141
github_url: https://github.com/cdubiel08/ralph-hero/issues/141
status: complete
type: research
---

# GH-141: Add `has`/`no` Presence Filters to `list_issues`

## Problem Statement

The `list_issues` tool can filter by specific field values (e.g., `workflowState: "Backlog"`) but cannot filter by field presence or absence. Agents performing triage need to find items missing estimates (`no:estimate`), items without assignees (`no:assignees`), or items that have a priority set (`has:priority`). Currently this requires fetching all items and inspecting manually, wasting context window and API quota.

## Current State Analysis

### `list_issues` Tool (`issue-tools.ts:50-305`)

**Zod schema** (lines 53-111): 12 params — `owner`, `repo`, `workflowState`, `estimate`, `priority`, `label`, `query`, `state`, `reason`, `updatedSince`, `updatedBefore`, `orderBy`, `limit`. No presence/absence params.

**GraphQL query** (lines 128-167): Fetches all data needed for presence checks:
```graphql
... on Issue {
  number title body state stateReason url createdAt updatedAt
  labels(first: 10) { nodes { name } }
  assignees(first: 5) { nodes { login } }
}
```
Plus `fieldValues` with SingleSelect values for Workflow State, Estimate, Priority.

**Client-side filter chain** (lines 174-257): Sequential `Array.filter()` calls for `state`, `reason`, `workflowState`, `estimate`, `priority`, `label`, `query`, `updatedSince`, `updatedBefore`. Each follows the same pattern:
```typescript
if (args.filterName) {
  items = items.filter((item) => { /* check */ });
}
```

**`getFieldValue` helper** (lines 1654-1664): Returns `string | undefined` — returns `undefined` when a single-select field has no value set, which is the exact signal needed for presence checks.

**Response mapping** (lines 274-293): Already includes all fields needed: `workflowState`, `estimate`, `priority`, `labels`, `assignees`.

### Fields Available for Presence Checks

| Field | Source | Present check | Absent check |
|-------|--------|---------------|--------------|
| `workflowState` | `getFieldValue(item, "Workflow State")` | `!== undefined` | `=== undefined` |
| `estimate` | `getFieldValue(item, "Estimate")` | `!== undefined` | `=== undefined` |
| `priority` | `getFieldValue(item, "Priority")` | `!== undefined` | `=== undefined` |
| `labels` | `content.labels.nodes` | `.length > 0` | `.length === 0` |
| `assignees` | `content.assignees.nodes` | `.length > 0` | `.length === 0` |

### No Additional GraphQL Changes Needed

The existing query already fetches all data required for presence checks. No new fields or fragments are needed.

## Implementation Plan

### 1. Add `has` and `no` Params to Zod Schema

Insert after the existing `state` param (around line 82), following the same pattern:

```typescript
has: z
  .array(z.enum(["workflowState", "estimate", "priority", "labels", "assignees"]))
  .optional()
  .describe(
    "Include only items where these fields are non-empty. " +
    "Valid fields: workflowState, estimate, priority, labels, assignees",
  ),
no: z
  .array(z.enum(["workflowState", "estimate", "priority", "labels", "assignees"]))
  .optional()
  .describe(
    "Include only items where these fields are empty/absent. " +
    "Valid fields: workflowState, estimate, priority, labels, assignees",
  ),
```

Using `z.enum()` provides compile-time validation and helpful error messages for invalid field names. The alternative of `z.array(z.string())` with runtime validation is less safe.

### 2. Add Presence Check Helper

Define a helper function near `getFieldValue` to check field presence on a project item:

```typescript
const PRESENCE_FIELD_NAMES = [
  "workflowState", "estimate", "priority", "labels", "assignees",
] as const;

type PresenceField = typeof PRESENCE_FIELD_NAMES[number];

function hasField(item: RawProjectItem, field: PresenceField): boolean {
  switch (field) {
    case "workflowState":
      return getFieldValue(item, "Workflow State") !== undefined;
    case "estimate":
      return getFieldValue(item, "Estimate") !== undefined;
    case "priority":
      return getFieldValue(item, "Priority") !== undefined;
    case "labels": {
      const content = item.content as Record<string, unknown> | null;
      const labels = (content?.labels as { nodes: Array<{ name: string }> })?.nodes || [];
      return labels.length > 0;
    }
    case "assignees": {
      const content = item.content as Record<string, unknown> | null;
      const assignees = (content?.assignees as { nodes: Array<{ login: string }> })?.nodes || [];
      return assignees.length > 0;
    }
  }
}
```

This centralizes the presence check logic, making it reusable for both `has` and `no` and also for the sibling port to `list_project_items` (#143).

### 3. Add Client-Side Filters

Insert after the existing `reason` filter (around line 193), before the `workflowState` filter:

```typescript
// Filter by field presence (has)
if (args.has && args.has.length > 0) {
  items = items.filter((item) =>
    args.has!.every((field) => hasField(item, field as PresenceField)),
  );
}

// Filter by field absence (no)
if (args.no && args.no.length > 0) {
  items = items.filter((item) =>
    args.no!.every((field) => !hasField(item, field as PresenceField)),
  );
}
```

Key design choices:
- **AND logic within `has`**: `has: ["estimate", "priority"]` means the item must have BOTH estimate AND priority set. This matches the existing AND-composition pattern of all other filters.
- **AND logic within `no`**: `no: ["estimate", "assignees"]` means the item must lack BOTH estimate AND assignees.
- **AND between `has` and `no`**: `has: ["priority"], no: ["estimate"]` means items that have a priority but lack an estimate. This is composable with all other filters.
- **Empty arrays are no-ops**: `has: []` or `no: []` skip the filter entirely (guard clause).

### 4. No Response Mapping Changes

The response already includes all presence-checkable fields. No changes needed.

### 5. Tests

Add to `__tests__/issue-tools.test.ts`, following the existing structural test pattern:

```typescript
describe("list_issues has/no presence filters structural", () => {
  it("Zod schema includes has param", () => {
    expect(issueToolsSrc).toContain('"workflowState", "estimate", "priority", "labels", "assignees"');
  });

  it("Zod schema includes no param", () => {
    // Both has and no use the same enum, verify both are present
    expect(issueToolsSrc).toMatch(/has:\s*z\s*\.array/);
    expect(issueToolsSrc).toMatch(/no:\s*z\s*\.array/);
  });

  it("has filter applies every() check", () => {
    expect(issueToolsSrc).toContain("args.has!.every");
  });

  it("no filter applies every() with negation", () => {
    expect(issueToolsSrc).toContain("!hasField(item, field");
  });

  it("hasField helper handles all five field types", () => {
    expect(issueToolsSrc).toContain('case "workflowState"');
    expect(issueToolsSrc).toContain('case "estimate"');
    expect(issueToolsSrc).toContain('case "priority"');
    expect(issueToolsSrc).toContain('case "labels"');
    expect(issueToolsSrc).toContain('case "assignees"');
  });
});
```

## Edge Cases

1. **`has` and `no` with same field**: `has: ["estimate"], no: ["estimate"]` is logically contradictory and returns empty results. This is valid behavior, not an error — AND logic naturally produces an empty set.
2. **DraftIssues**: `list_issues` already filters to `type === "ISSUE"` (line 174), so DraftIssues are excluded. No special handling needed.
3. **Items not in project**: Items without project field values have `getFieldValue() === undefined`. The `no` filter will include these, `has` will exclude them. This is correct behavior.
4. **Empty `labels`/`assignees` arrays vs missing**: The GraphQL query returns empty arrays (`{ nodes: [] }`) for issues with no labels/assignees, not `null`. The `.length > 0` check handles both cases.

## File Changes

| File | Change | Effort |
|------|--------|--------|
| `tools/issue-tools.ts` | Add `has`/`no` to Zod schema, add `hasField` helper, add two filter blocks | Primary |
| `__tests__/issue-tools.test.ts` | Add structural tests for presence filters | Secondary |
| No other files affected | | |

## Group Context

Child of #106 (Add `has`/`no` presence filters and negation support to list tools), which is part of the #94 (Intelligent Agent Filtering) epic. #141 has no blocking dependencies. Sibling #142 (negation filters) and #143 (port to `list_project_items`) can proceed in parallel. The `hasField` helper defined here will be reused by #143.

## Risks

1. **Minimal risk**: This is a straightforward additive change — two new array params, one helper function, two filter blocks. No existing behavior changes.
2. **Zod enum vs string**: Using `z.enum()` for field names is stricter but means adding a new presence-checkable field requires a schema change. This is acceptable since new fields are rare and the type safety benefit is significant.
3. **Performance**: Presence checks are O(n) per item with small constant factors (field lookup in a ~20-element array). No performance concern for the 500-item fetch limit.

## Recommended Approach

1. Add `hasField` helper near `getFieldValue` (bottom of file, internal helpers section)
2. Add `has` and `no` params to Zod schema
3. Add two filter blocks in the filter chain (after `reason`, before `workflowState`)
4. Add structural tests
5. Build and verify

Estimated effort: ~20 minutes implementation + tests. Cleanly scoped S issue.
