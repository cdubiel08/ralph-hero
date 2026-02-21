---
date: 2026-02-20
github_issue: 142
github_url: https://github.com/cdubiel08/ralph-hero/issues/142
status: complete
type: research
---

# GH-142: Add `exclude*` Negation Filters to `list_issues`

## Problem Statement

The `list_issues` tool supports positive matching filters (e.g., `workflowState: "Backlog"`) but cannot exclude items by field value. Agents need to exclude terminal states (`Done`, `Canceled`) or low-priority items (`P3`) without enumerating all other values in a positive filter. For example, an agent triaging the backlog wants all non-Done, non-Canceled items regardless of their specific workflow state.

## Current State Analysis

### `list_issues` Tool (`issue-tools.ts:50-305`)

**Zod schema** (lines 53-111): Current positive-match params include `workflowState` (string), `estimate` (string), `priority` (string), `label` (string). Each accepts a single value. There are no array-based positive filters and no negation filters.

**Client-side filter chain** (lines 174-257): Sequential `Array.filter()` calls, each guarded by `if (args.filterName)`. Pattern:

```typescript
// Filter by workflow state
if (args.workflowState) {
  items = items.filter(
    (item) =>
      getFieldValue(item, "Workflow State") === args.workflowState,
  );
}
```

**`getFieldValue` helper** (lines 1654-1664): Returns `string | undefined` for single-select project fields. Returns `undefined` when a field has no value.

**Label access pattern** (lines 218-226): Labels are accessed via content object cast:

```typescript
const content = item.content as Record<string, unknown> | null;
const labels = (content?.labels as { nodes: Array<{ name: string }> })?.nodes || [];
return labels.some((l) => l.name === args.label);
```

### Key Observations

1. **Existing positive filters are single-value strings.** The `exclude*` params should be arrays since excluding multiple values is the primary use case (e.g., `excludeWorkflowStates: ["Done", "Canceled"]`).
2. **No GraphQL changes needed.** The existing query already fetches all field values needed for exclusion checks.
3. **AND composition.** All existing filters compose with AND logic. Negation filters should follow the same pattern: `excludeWorkflowStates` AND `excludeEstimates` AND `excludePriorities` AND `excludeLabels` AND all existing positive filters.

## Implementation Plan

### 1. Add Negation Params to Zod Schema

Insert after the existing `label` param (around line 76), before `query`:

```typescript
excludeWorkflowStates: z
  .array(z.string())
  .optional()
  .describe(
    "Exclude items matching any of these Workflow State names " +
    "(e.g., [\"Done\", \"Canceled\"])",
  ),
excludeEstimates: z
  .array(z.string())
  .optional()
  .describe(
    "Exclude items matching any of these Estimate values " +
    "(e.g., [\"M\", \"L\", \"XL\"])",
  ),
excludePriorities: z
  .array(z.string())
  .optional()
  .describe(
    "Exclude items matching any of these Priority values " +
    "(e.g., [\"P3\"])",
  ),
excludeLabels: z
  .array(z.string())
  .optional()
  .describe(
    "Exclude items that have ANY of these labels " +
    "(e.g., [\"wontfix\", \"duplicate\"])",
  ),
```

Using `z.array(z.string())` rather than `z.array(z.enum(...))` because workflow states, estimates, priorities, and labels are dynamic project-specific values, not a fixed set. Validation of specific values is best left to the filter returning no matches rather than rejecting unknown strings.

### 2. Add Client-Side Filter Blocks

Insert after the existing positive filter blocks for each field, maintaining the established pattern. The natural placement is after the positive `label` filter (line 226) and before the `query` filter (line 229):

```typescript
// Filter by excluded workflow states
if (args.excludeWorkflowStates && args.excludeWorkflowStates.length > 0) {
  items = items.filter(
    (item) =>
      !args.excludeWorkflowStates!.includes(
        getFieldValue(item, "Workflow State") ?? "",
      ),
  );
}

// Filter by excluded estimates
if (args.excludeEstimates && args.excludeEstimates.length > 0) {
  items = items.filter(
    (item) =>
      !args.excludeEstimates!.includes(
        getFieldValue(item, "Estimate") ?? "",
      ),
  );
}

// Filter by excluded priorities
if (args.excludePriorities && args.excludePriorities.length > 0) {
  items = items.filter(
    (item) =>
      !args.excludePriorities!.includes(
        getFieldValue(item, "Priority") ?? "",
      ),
  );
}

// Filter by excluded labels
if (args.excludeLabels && args.excludeLabels.length > 0) {
  items = items.filter((item) => {
    const content = item.content as Record<string, unknown> | null;
    const labels =
      (content?.labels as { nodes: Array<{ name: string }> })?.nodes || [];
    return !labels.some((l) => args.excludeLabels!.includes(l.name));
  });
}
```

### Design Decisions

**`?? ""` for undefined field values**: When `getFieldValue` returns `undefined` (field not set), the `?? ""` coercion means items without a value are NOT excluded. This is correct: `excludeWorkflowStates: ["Done"]` should not exclude items with no workflow state set.

**`Array.includes()` for matching**: Simple and correct for the small arrays expected (typically 1-5 values). No performance concern.

**Label semantics — ANY match**: `excludeLabels: ["wontfix", "duplicate"]` excludes items that have "wontfix" OR "duplicate" (or both). This mirrors GitHub's label exclusion behavior and is the intuitive interpretation.

### 3. Tests

Add to `__tests__/issue-tools.test.ts`, following the structural test pattern:

```typescript
describe("list_issues exclude negation filters structural", () => {
  it("Zod schema includes excludeWorkflowStates param", () => {
    expect(issueToolsSrc).toContain("excludeWorkflowStates: z.array");
  });

  it("Zod schema includes excludeEstimates param", () => {
    expect(issueToolsSrc).toContain("excludeEstimates: z.array");
  });

  it("Zod schema includes excludePriorities param", () => {
    expect(issueToolsSrc).toContain("excludePriorities: z.array");
  });

  it("Zod schema includes excludeLabels param", () => {
    expect(issueToolsSrc).toContain("excludeLabels: z.array");
  });

  it("negation filters use Array.includes for matching", () => {
    expect(issueToolsSrc).toContain("excludeWorkflowStates!.includes");
    expect(issueToolsSrc).toContain("excludeEstimates!.includes");
    expect(issueToolsSrc).toContain("excludePriorities!.includes");
    expect(issueToolsSrc).toContain("excludeLabels!.includes");
  });

  it("items without field values are not excluded", () => {
    // The ?? "" coercion ensures undefined values don't match exclusion lists
    expect(issueToolsSrc).toContain('?? ""');
  });
});
```

## Edge Cases

1. **Empty exclusion arrays**: `excludeWorkflowStates: []` is a no-op (guard clause checks `.length > 0`). This is correct and consistent with how empty `has`/`no` arrays should behave from GH-141.
2. **Positive + negative on same field**: `workflowState: "Backlog", excludeWorkflowStates: ["Backlog"]` returns empty results (AND logic). This is valid behavior, not an error.
3. **Items with undefined field values**: `excludeWorkflowStates: ["Done"]` does NOT exclude items where Workflow State is not set. The `?? ""` fallback ensures `undefined` maps to `""` which won't match any exclusion value.
4. **Case sensitivity**: Field values are case-sensitive (matching `getFieldValue` behavior and GitHub API). `excludeWorkflowStates: ["done"]` will NOT match `"Done"`. This is consistent with existing positive filters.
5. **Unknown values in exclusion array**: `excludeWorkflowStates: ["NonExistent"]` simply has no effect (nothing matches to be excluded). No error needed.
6. **Interaction with GH-141 `has`/`no` filters**: All filters compose with AND logic. `no: ["estimate"], excludeWorkflowStates: ["Done"]` means items without an estimate AND not in "Done" state. No special interaction handling needed.

## File Changes

| File | Change | Effort |
|------|--------|--------|
| `tools/issue-tools.ts` | Add 4 `exclude*` params to Zod schema, add 4 filter blocks | Primary |
| `__tests__/issue-tools.test.ts` | Add structural tests for negation filters | Secondary |
| No other files affected | | |

## Group Context

Child of #106 (Add `has`/`no` presence filters and negation support to list tools). Sibling of #141 (has/no presence filters) and #143 (port to `list_project_items`). GH-142 is independent of GH-141 — both can be implemented in parallel. GH-143 depends on both #141 and #142 being complete before porting to `list_project_items`.

## Risks

1. **Minimal risk**: Purely additive change — four new array params, four filter blocks. No existing behavior changes. No GraphQL changes.
2. **Schema size growth**: Adding 4 params expands the tool schema from 12 to 16 params. This is still well within MCP tool schema limits and the params are logically grouped (all `exclude*`).
3. **No performance concern**: Each exclusion filter is O(n * m) where n = items and m = exclusion list size. With n <= 500 and m typically 1-5, this is negligible.

## Recommended Approach

Follow the exact pattern of existing positive filters:
1. Add params to Zod schema with `.optional()` and `.describe()`
2. Add `if (args.exclude*)` filter blocks using the inverse logic of positive filters
3. Place negation filters adjacent to their positive counterparts in the filter chain
4. Add structural tests
5. Build and verify

Estimated effort: XS — ~40 lines of new code (4 schema params + 4 filter blocks) plus tests.
