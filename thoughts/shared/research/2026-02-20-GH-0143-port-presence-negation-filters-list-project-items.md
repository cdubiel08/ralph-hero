---
date: 2026-02-20
github_issue: 143
github_url: https://github.com/cdubiel08/ralph-hero/issues/143
status: complete
type: research
---

# GH-143: Port Presence and Negation Filters to `list_project_items`

## Problem Statement

After #141 (presence filters) and #142 (negation filters) add filtering capabilities to `list_issues`, the `list_project_items` tool needs the same capabilities to maintain consistent filtering across both list tools. Agents using `list_project_items` should be able to filter by field presence/absence and exclude specific values.

## Current State Analysis

### `list_project_items` Tool (`project-tools.ts:382-602`)

**Zod schema** (lines 385-431): 8 params — `owner`, `number`, `workflowState`, `estimate`, `priority`, `itemType`, `updatedSince`, `updatedBefore`, `limit`. No `has`, `no`, or `exclude*` params. Notably, no `label`, `query`, or `reason` params either (simpler than `list_issues`).

**GraphQL query** (lines 459-517): Fetches Issue content with labels and assignees:
```graphql
... on Issue {
  number title state url updatedAt
  labels(first: 10) { nodes { name } }
  assignees(first: 5) { nodes { login } }
}
```
Also fetches PullRequest and DraftIssue content fragments. Field values include SingleSelect, Text, and Number types.

**Client-side filter chain** (lines 519-564): Sequential `Array.filter()` calls for `itemType`, `workflowState`, `estimate`, `priority`, `updatedSince`, `updatedBefore`. Same pattern as `list_issues`.

**`getFieldValue` helper** (lines 625-635): Identical to `issue-tools.ts` version — same `RawProjectItem` interface (lines 609-623), same `string | undefined` return type.

**Response mapping** (lines 570-590): Already includes `workflowState`, `estimate`, `priority`, `labels`, `assignees` — all fields needed for presence checks.

### Key Differences from `list_issues`

| Aspect | `list_issues` | `list_project_items` |
|--------|---------------|---------------------|
| `label` filter | Yes | No |
| `query` filter | Yes | No |
| `reason` filter | Yes | No |
| `state` (OPEN/CLOSED) | Yes | No (includes all states) |
| `itemType` filter | No | Yes (ISSUE, PR, DRAFT_ISSUE) |
| Content types | Issue only | Issue, PR, DraftIssue |
| `excludeLabels` | Applicable (sibling #142) | **Not applicable** (no label filter) |

### DraftIssue Consideration

`list_project_items` returns DraftIssues which have no labels, assignees, or linked issue fields. For presence checks:
- DraftIssues have `content: { title, body }` — no `labels` or `assignees` arrays
- `getFieldValue` works on DraftIssues (they have `fieldValues`)
- `has: ["labels"]` would exclude DraftIssues (no labels array)
- `no: ["assignees"]` would include DraftIssues (no assignees array, treated as absent)

This is correct and expected behavior.

## Implementation Plan

### 1. Reuse `hasField` Helper Pattern from #141

The `hasField` helper introduced in `issue-tools.ts` by #141 should be duplicated in `project-tools.ts` (each file has its own private helpers). The logic is identical:

```typescript
type PresenceField = "workflowState" | "estimate" | "priority" | "labels" | "assignees";

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

Note: Extracting to a shared module is tempting but would create a cross-file dependency for a small helper. Duplication is acceptable here — both files already have independent `RawProjectItem` and `getFieldValue` definitions.

### 2. Add `has` and `no` Params to Zod Schema

Insert after the `priority` param (around line 407):

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

### 3. Add `exclude*` Negation Params to Zod Schema

Insert after `has`/`no`:

```typescript
excludeWorkflowStates: z
  .array(z.string())
  .optional()
  .describe("Exclude items with these workflow states"),
excludeEstimates: z
  .array(z.string())
  .optional()
  .describe("Exclude items with these estimates"),
excludePriorities: z
  .array(z.string())
  .optional()
  .describe("Exclude items with these priorities"),
```

Note: `excludeLabels` is NOT included. The `list_project_items` tool does not have a `label` filter, and adding `excludeLabels` without a positive `label` filter would be inconsistent. Labels are available in the response for informational purposes only.

### 4. Add Filters to Chain

Insert after the `priority` filter (around line 544), before `updatedSince`:

```typescript
// Presence filters (has)
if (args.has && args.has.length > 0) {
  items = items.filter((item) =>
    args.has!.every((field) => hasField(item, field as PresenceField)),
  );
}

// Absence filters (no)
if (args.no && args.no.length > 0) {
  items = items.filter((item) =>
    args.no!.every((field) => !hasField(item, field as PresenceField)),
  );
}

// Negation filters
if (args.excludeWorkflowStates && args.excludeWorkflowStates.length > 0) {
  items = items.filter((item) => {
    const ws = getFieldValue(item, "Workflow State");
    return !ws || !args.excludeWorkflowStates!.includes(ws);
  });
}

if (args.excludeEstimates && args.excludeEstimates.length > 0) {
  items = items.filter((item) => {
    const est = getFieldValue(item, "Estimate");
    return !est || !args.excludeEstimates!.includes(est);
  });
}

if (args.excludePriorities && args.excludePriorities.length > 0) {
  items = items.filter((item) => {
    const pri = getFieldValue(item, "Priority");
    return !pri || !args.excludePriorities!.includes(pri);
  });
}
```

### 5. Update `hasFilters` Guard for Pagination

The existing `hasFilters` variable (line 453) controls pagination fetch size. Update it to include the new filters:

```typescript
const hasFilters = args.updatedSince || args.updatedBefore || args.itemType
  || (args.has && args.has.length > 0)
  || (args.no && args.no.length > 0)
  || args.excludeWorkflowStates
  || args.excludeEstimates
  || args.excludePriorities;
```

### 6. Tests

Add to `__tests__/project-tools.test.ts`:

```typescript
describe("list_project_items presence and negation filters structural", () => {
  it("Zod schema includes has param", () => {
    expect(projectToolsSrc).toMatch(/has:\s*z\s*\.array/);
  });

  it("Zod schema includes no param", () => {
    expect(projectToolsSrc).toMatch(/no:\s*z\s*\.array/);
  });

  it("has excludeWorkflowStates param", () => {
    expect(projectToolsSrc).toContain("excludeWorkflowStates");
  });

  it("has excludeEstimates param", () => {
    expect(projectToolsSrc).toContain("excludeEstimates");
  });

  it("has excludePriorities param", () => {
    expect(projectToolsSrc).toContain("excludePriorities");
  });

  it("does NOT have excludeLabels (not applicable)", () => {
    expect(projectToolsSrc).not.toContain("excludeLabels");
  });

  it("hasField helper handles all five field types", () => {
    expect(projectToolsSrc).toContain('case "workflowState"');
    expect(projectToolsSrc).toContain('case "estimate"');
    expect(projectToolsSrc).toContain('case "priority"');
    expect(projectToolsSrc).toContain('case "labels"');
    expect(projectToolsSrc).toContain('case "assignees"');
  });
});
```

## Edge Cases

1. **DraftIssues with `has: ["labels"]`**: DraftIssues have no `labels` property in content. The `?.nodes || []` pattern returns empty array, so `has: ["labels"]` correctly excludes DraftIssues.
2. **PullRequests with `has: ["assignees"]`**: The PR fragment does not fetch assignees. `has: ["assignees"]` would exclude PRs. This is a known limitation — the GraphQL query would need to add assignees to the PR fragment to support this. Document this as a known limitation, not a bug.
3. **Items with no field values**: Items not configured in the project have empty `fieldValues.nodes`. `no: ["estimate"]` correctly includes them (no estimate = absent).
4. **Negation on items with no value**: `excludeWorkflowStates: ["Done"]` should NOT exclude items with no workflow state set. The `!ws || !excludeArray.includes(ws)` pattern handles this — if `ws` is undefined, the `!ws` short-circuit returns `true` (keep item).

## File Changes

| File | Change | Effort |
|------|--------|--------|
| `tools/project-tools.ts` | Add `has`, `no`, `exclude*` to Zod schema, add `hasField` helper, add 5 filter blocks, update `hasFilters` | Primary |
| `__tests__/project-tools.test.ts` | Add structural tests for presence and negation filters | Secondary |
| No other files affected | | |

## Dependencies

- **Blocked by #141**: The `hasField` helper pattern is defined in #141. While the code is duplicated (not shared), the pattern should be proven in #141 first.
- **Blocked by #142**: The `exclude*` negation pattern is defined in #142. Same reasoning — pattern should be proven first.
- Both #141 and #142 can be implemented in parallel, then #143 ports the proven patterns.

## Risks

1. **Minimal risk**: Purely additive — ports proven patterns from `list_issues`. No existing behavior changes.
2. **DraftIssue/PR edge cases**: Labels and assignees are only available on Issue content fragments. Presence checks on these fields silently exclude non-Issue items. This is acceptable and documented.
3. **No `excludeLabels`**: Intentionally omitted since `list_project_items` has no positive `label` filter. If needed later, it can be added independently.

## Recommended Approach

1. Wait for #141 and #142 to merge (patterns are proven)
2. Copy `hasField` helper to `project-tools.ts`
3. Add `has`, `no`, `excludeWorkflowStates`, `excludeEstimates`, `excludePriorities` to Zod schema
4. Add filter blocks to chain
5. Update `hasFilters` pagination guard
6. Add structural tests
7. Build and verify

Estimated effort: ~15 minutes implementation + tests (straightforward port of proven patterns).
