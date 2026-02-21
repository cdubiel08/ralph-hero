---
date: 2026-02-20
status: draft
github_issues: [142]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/142
primary_issue: 142
---

# Add `exclude*` Negation Filters to `list_issues` - Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-142 | Add `exclude*` negation filters to `list_issues` | XS |

## Current State Analysis

The `list_issues` tool (`issue-tools.ts:50-305`) supports positive-match filters for `workflowState`, `estimate`, `priority`, and `label` but has no way to exclude items by field value. The client-side filter chain (lines 174-257) uses sequential `Array.filter()` calls with guard clauses. The `getFieldValue` helper (lines 1654-1664) returns `string | undefined` for single-select project fields.

All data needed for negation filters is already fetched by the existing GraphQL query. No API changes are required.

## Desired End State

Agents can exclude items by workflow state, estimate, priority, and labels using array parameters. For example: `excludeWorkflowStates: ["Done", "Canceled"]` to see all non-terminal items, or `excludeLabels: ["wontfix"]` to skip triaged-out items.

### Verification
- [ ] `npm run build` succeeds with no type errors
- [ ] `npm test` passes all existing and new structural tests
- [ ] Four new `exclude*` params appear in the `list_issues` tool schema
- [ ] Negation filters compose with existing positive filters via AND logic

## What We're NOT Doing
- No changes to `list_project_items` (that's GH-143)
- No `has`/`no` presence filters (that's GH-141)
- No GraphQL query changes
- No changes to response format
- No multi-value positive filters (existing positive filters remain single-value strings)

## Implementation Approach

Four Zod schema params + four filter blocks, following the existing filter chain pattern exactly. Negation filters placed after their positive counterparts in the chain.

---

## Phase 1: GH-142 — Add `exclude*` Negation Filters
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/142 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0142-exclude-negation-filters-list-issues.md

### Changes Required

#### 1. Add four `exclude*` params to Zod schema
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Location**: After the `label` param (line 76), before `query` (line 77)

Add these four params:
```typescript
excludeWorkflowStates: z
  .array(z.string())
  .optional()
  .describe(
    "Exclude items matching any of these Workflow State names " +
    '(e.g., ["Done", "Canceled"])',
  ),
excludeEstimates: z
  .array(z.string())
  .optional()
  .describe(
    "Exclude items matching any of these Estimate values " +
    '(e.g., ["M", "L", "XL"])',
  ),
excludePriorities: z
  .array(z.string())
  .optional()
  .describe(
    "Exclude items matching any of these Priority values " +
    '(e.g., ["P3"])',
  ),
excludeLabels: z
  .array(z.string())
  .optional()
  .describe(
    "Exclude items that have ANY of these labels " +
    '(e.g., ["wontfix", "duplicate"])',
  ),
```

**Why `z.array(z.string())` not `z.array(z.enum(...))`**: Workflow states, estimates, priorities, and labels are project-specific dynamic values. Using `z.string()` allows agents to pass any value; unknown values simply have no effect.

#### 2. Add four negation filter blocks to the filter chain
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Location**: After the positive `label` filter block (line 226), before the `query` filter (line 228)

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

**Key design decisions**:
- **`?? ""`**: When `getFieldValue` returns `undefined` (field not set), the item is NOT excluded. `excludeWorkflowStates: ["Done"]` should not remove items with no workflow state.
- **Label ANY-match**: `excludeLabels: ["wontfix", "duplicate"]` excludes items that have "wontfix" OR "duplicate" (or both). This mirrors GitHub's label exclusion semantics.
- **Guard clause**: `&& args.exclude*.length > 0` ensures empty arrays are no-ops.

#### 3. Add structural tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/issue-tools.test.ts`
**Location**: Append a new `describe` block after the existing structural tests

```typescript
describe("list_issues exclude negation filters structural", () => {
  it("Zod schema includes excludeWorkflowStates param", () => {
    expect(issueToolsSrc).toContain("excludeWorkflowStates");
  });

  it("Zod schema includes excludeEstimates param", () => {
    expect(issueToolsSrc).toContain("excludeEstimates");
  });

  it("Zod schema includes excludePriorities param", () => {
    expect(issueToolsSrc).toContain("excludePriorities");
  });

  it("Zod schema includes excludeLabels param", () => {
    expect(issueToolsSrc).toContain("excludeLabels");
  });

  it("negation filters use Array.includes for matching", () => {
    expect(issueToolsSrc).toContain("excludeWorkflowStates!.includes");
    expect(issueToolsSrc).toContain("excludeEstimates!.includes");
    expect(issueToolsSrc).toContain("excludePriorities!.includes");
    expect(issueToolsSrc).toContain("excludeLabels!.includes");
  });

  it("items without field values are not excluded (null coercion)", () => {
    // The ?? "" coercion ensures undefined values don't match exclusion lists
    const matches = issueToolsSrc.match(/\?\? ""/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3); // workflowState, estimate, priority
  });
});
```

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build && npm test`
- [ ] Manual: Verify four `exclude*` params appear in the tool schema output
- [ ] Manual: Confirm negation filter blocks are placed between `label` and `query` filters in the chain

---

## Integration Testing
- [ ] `npm run build` succeeds with zero TypeScript errors
- [ ] `npm test` passes all tests (existing + new structural tests)
- [ ] Verify `exclude*` params use `z.array(z.string()).optional()` pattern
- [ ] Verify filter chain order: positive filters -> negation filters -> query -> date filters

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0142-exclude-negation-filters-list-issues.md
- Parent: https://github.com/cdubiel08/ralph-hero/issues/106
- Sibling (presence filters): https://github.com/cdubiel08/ralph-hero/issues/141
- Sibling (port to list_project_items): https://github.com/cdubiel08/ralph-hero/issues/143
