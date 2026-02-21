---
date: 2026-02-20
status: draft
github_issue: 143
github_url: https://github.com/cdubiel08/ralph-hero/issues/143
primary_issue: 143
---

# GH-143: Port Presence and Negation Filters to `list_project_items` - Implementation Plan

## Overview

Single issue implementation: GH-143 — Port `has`/`no` presence filters and `exclude*` negation filters from `list_issues` to `list_project_items`.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-143 | Port presence and negation filters to `list_project_items` | XS |

**Prerequisites**: GH-141 (has/no presence filters in list_issues) and GH-142 (exclude* negation filters in list_issues) must be merged first. This issue ports proven patterns from those implementations.

## Current State Analysis

- `list_project_items` (`project-tools.ts:382-602`) accepts 8 filter params via Zod schema; filter chain at lines 519-564
- Tool already has `getFieldValue` helper (lines 625-635) and `RawProjectItem` interface (lines 609-623) — identical to `issue-tools.ts` versions
- GraphQL query already fetches labels and assignees on Issue content, plus all project field values
- DraftIssue and PullRequest content fragments exist but lack labels/assignees arrays
- The `hasFilters` guard at line 453 controls pagination fetch size and must be updated to include new filters
- GH-141 introduces `hasField` helper and `has`/`no` params in `issue-tools.ts`; GH-142 introduces `exclude*` params there
- `excludeLabels` is intentionally omitted — `list_project_items` has no positive `label` filter

## Desired End State

### Verification
- [ ] `has` and `no` array params work on `list_project_items`
- [ ] `excludeWorkflowStates`, `excludeEstimates`, `excludePriorities` work on `list_project_items`
- [ ] All new filters compose with existing filters via AND logic
- [ ] DraftIssues handled correctly (no labels/assignees = treated as absent)
- [ ] Items with no field value are NOT excluded by negation filters
- [ ] All tests pass: `npm test` in `mcp-server/`
- [ ] Build succeeds: `npm run build` in `mcp-server/`

## What We're NOT Doing
- Adding `excludeLabels` (no positive `label` filter exists on this tool)
- Adding `label`, `query`, or `reason` params (these are `list_issues`-specific)
- Extracting `hasField` or `getFieldValue` to a shared module (duplication is acceptable for small helpers)
- Adding presence checks for PR-specific fields (draft, merged, etc.)
- Modifying `list_issues` in any way

## Implementation Approach

Duplicate the `hasField` helper from `list_issues` into `project-tools.ts`. Add 5 new Zod params (`has`, `no`, `excludeWorkflowStates`, `excludeEstimates`, `excludePriorities`). Add 5 filter blocks to the chain. Update the `hasFilters` pagination guard. Add structural tests. Total ~60 lines of new code.

---

## Phase 1: GH-143 — Port presence and negation filters to `list_project_items`
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/143 | **Research**: thoughts/shared/research/2026-02-20-GH-0143-port-presence-negation-filters-list-project-items.md | **Depends on**: GH-141, GH-142

### Changes Required

#### 1. Add `hasField` helper to `project-tools.ts`
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
**Where**: After the existing `getFieldValue` function (after line 635), in the internal helpers section

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

This is a direct copy of the helper from GH-141 in `issue-tools.ts`. Duplication is intentional — both files have independent `RawProjectItem` and `getFieldValue` definitions.

#### 2. Add `has`, `no`, and `exclude*` params to Zod schema
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
**Where**: After the `priority` param (around line 407), before `itemType`

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
```

#### 3. Update `hasFilters` pagination guard
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
**Where**: Line 453, replace existing `hasFilters` assignment

**Before**:
```typescript
const hasFilters = args.updatedSince || args.updatedBefore || args.itemType;
```

**After**:
```typescript
const hasFilters = args.updatedSince || args.updatedBefore || args.itemType
  || (args.has && args.has.length > 0)
  || (args.no && args.no.length > 0)
  || args.excludeWorkflowStates
  || args.excludeEstimates
  || args.excludePriorities;
```

#### 4. Add filter blocks to chain
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
**Where**: After the existing `priority` filter block (around line 544), before `updatedSince` filter

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

// Negation: exclude workflow states
if (args.excludeWorkflowStates && args.excludeWorkflowStates.length > 0) {
  items = items.filter(
    (item) =>
      !args.excludeWorkflowStates!.includes(
        getFieldValue(item, "Workflow State") ?? "",
      ),
  );
}

// Negation: exclude estimates
if (args.excludeEstimates && args.excludeEstimates.length > 0) {
  items = items.filter(
    (item) =>
      !args.excludeEstimates!.includes(
        getFieldValue(item, "Estimate") ?? "",
      ),
  );
}

// Negation: exclude priorities
if (args.excludePriorities && args.excludePriorities.length > 0) {
  items = items.filter(
    (item) =>
      !args.excludePriorities!.includes(
        getFieldValue(item, "Priority") ?? "",
      ),
  );
}
```

**Note on `?? ""`**: When `getFieldValue` returns `undefined` (field not set), the `?? ""` coercion ensures items without a value are NOT excluded. This matches the GH-142 pattern for `list_issues`.

#### 5. Add structural tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/project-tools.test.ts`
**Where**: After the existing `list_project_items structural` describe block (after line 45)

```typescript
describe("list_project_items presence and negation filters", () => {
  it("Zod schema includes has param with enum", () => {
    expect(projectToolsSrc).toMatch(/has:\s*z\s*\.array/);
  });

  it("Zod schema includes no param with enum", () => {
    expect(projectToolsSrc).toMatch(/no:\s*z\s*\.array/);
  });

  it("has excludeWorkflowStates array param", () => {
    expect(projectToolsSrc).toContain("excludeWorkflowStates: z.array");
  });

  it("has excludeEstimates array param", () => {
    expect(projectToolsSrc).toContain("excludeEstimates: z.array");
  });

  it("has excludePriorities array param", () => {
    expect(projectToolsSrc).toContain("excludePriorities: z.array");
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

  it("negation filters use ?? fallback for undefined values", () => {
    expect(projectToolsSrc).toContain('?? ""');
  });
});
```

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npx vitest run src/__tests__/project-tools.test.ts`
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build`
- [ ] Manual: `list_project_items(has=["estimate"])` returns only items with an estimate set
- [ ] Manual: `list_project_items(no=["priority"])` returns items without a priority
- [ ] Manual: `list_project_items(excludeWorkflowStates=["Done","Canceled"])` excludes terminal states
- [ ] Manual: `list_project_items(workflowState="Backlog", excludePriorities=["P3"])` combines positive + negation

---

## File Ownership Summary

| File | Action | Lines Changed |
|------|--------|---------------|
| `src/tools/project-tools.ts` | Add `hasField` helper + 5 Zod params + 5 filter blocks + update `hasFilters` | ~60 |
| `src/__tests__/project-tools.test.ts` | Add structural test describe block | ~30 |

## Integration Testing
- [ ] `npm run build` succeeds (TypeScript compiles without errors)
- [ ] `npm test` passes all existing and new tests
- [ ] Filter behavior matches `list_issues` for equivalent queries
- [ ] DraftIssues are correctly handled (no labels/assignees = treated as absent)
- [ ] Items with no field values are not excluded by negation filters

## Known Limitations
- **DraftIssue/PullRequest labels/assignees**: The GraphQL fragments for DraftIssue and PullRequest do not include labels or assignees. `has: ["labels"]` and `has: ["assignees"]` will always exclude DraftIssues and PRs. This is expected and documented.
- **No `excludeLabels`**: Intentionally omitted since `list_project_items` has no positive `label` filter. Can be added independently if needed later.

## References
- Research: thoughts/shared/research/2026-02-20-GH-0143-port-presence-negation-filters-list-project-items.md
- Research GH-141: thoughts/shared/research/2026-02-20-GH-0141-has-no-presence-filters-list-issues.md
- Research GH-142: thoughts/shared/research/2026-02-20-GH-0142-exclude-negation-filters-list-issues.md
- Parent: https://github.com/cdubiel08/ralph-hero/issues/106
- Dependencies: https://github.com/cdubiel08/ralph-hero/issues/141, https://github.com/cdubiel08/ralph-hero/issues/142
