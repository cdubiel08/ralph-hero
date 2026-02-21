---
date: 2026-02-20
status: draft
github_issues: [141, 142, 143]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/141
  - https://github.com/cdubiel08/ralph-hero/issues/142
  - https://github.com/cdubiel08/ralph-hero/issues/143
primary_issue: 141
---

# Presence and Negation Filters for List Tools - Atomic Implementation Plan

## Overview
3 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-141 | Add `has`/`no` presence filters to `list_issues` | S |
| 2 | GH-142 | Add `exclude*` negation filters to `list_issues` | XS |
| 3 | GH-143 | Port presence and negation filters to `list_project_items` | XS |

**Why grouped**: All three issues are children of GH-106 (Add `has`/`no` presence filters and negation support to list tools). Phase 1 introduces the `hasField` helper and presence filter pattern, Phase 2 adds negation filters to the same file, and Phase 3 ports both patterns to `list_project_items`. The patterns build on each other and share test infrastructure.

## Current State Analysis

Both `list_issues` ([issue-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts)) and `list_project_items` ([project-tools.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts)) have:
- Sequential client-side `Array.filter()` chains with `if (args.filterName)` guards
- `getFieldValue(item, "Field Name")` helpers returning `string | undefined` for single-select project fields
- GraphQL queries already fetching labels, assignees, and all field values needed for presence checks
- No presence/absence or negation filter capabilities

## Desired End State
### Verification
- [ ] `list_issues` accepts `has` and `no` array params for field presence/absence filtering
- [ ] `list_issues` accepts `excludeWorkflowStates`, `excludeEstimates`, `excludePriorities`, `excludeLabels` array params for negation filtering
- [ ] `list_project_items` accepts `has`, `no`, `excludeWorkflowStates`, `excludeEstimates`, `excludePriorities` params (no `excludeLabels`)
- [ ] All new filters compose with existing filters using AND logic
- [ ] Items with undefined field values are NOT excluded by negation filters
- [ ] Structural tests pass for all new params and filter blocks
- [ ] `npm run build` succeeds with no type errors
- [ ] `npm test` passes

## What We're NOT Doing
- No GraphQL query changes (existing queries already fetch all needed data)
- No response mapping changes (responses already include all relevant fields)
- No `excludeLabels` on `list_project_items` (it has no positive `label` filter)
- No shared module extraction for `hasField` (duplication is acceptable for a small helper in two independent files)
- No behavioral/integration tests (structural tests follow the established pattern)

## Implementation Approach
Phase 1 introduces the `hasField` helper and `has`/`no` presence filters in `issue-tools.ts`. Phase 2 adds negation (`exclude*`) filters to the same file, reusing the established filter chain pattern. Phase 3 ports both patterns to `project-tools.ts`, duplicating the `hasField` helper and adding the same filter params (minus `excludeLabels`).

---

## Phase 1: GH-141 - Add `has`/`no` Presence Filters to `list_issues`
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/141 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0141-has-no-presence-filters-list-issues.md

### Changes Required

#### 1. Add `hasField` helper function
**File**: [`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts)
**Location**: After the `getFieldValue` function (after line 1664)
**Changes**: Add a `PresenceField` type and `hasField` helper that checks field presence using a switch statement:
- `workflowState`, `estimate`, `priority`: `getFieldValue(item, "...") !== undefined`
- `labels`: `content.labels.nodes.length > 0`
- `assignees`: `content.assignees.nodes.length > 0`

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

#### 2. Add `has` and `no` params to Zod schema
**File**: [`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts)
**Location**: After `reason` param (after line 88), before `updatedSince`
**Changes**: Add two array params with `z.enum()` validation for the five supported field names:

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

#### 3. Add presence filter blocks to filter chain
**File**: [`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts)
**Location**: After the `reason` filter (after line 193), before the `workflowState` filter (line 196)
**Changes**: Two filter blocks using the `hasField` helper with `every()` for AND logic within each array:

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

#### 4. Add structural tests
**File**: [`plugin/ralph-hero/mcp-server/src/__tests__/issue-tools.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/issue-tools.test.ts)
**Location**: After the existing `list_issues structural` describe block (after line 52)
**Changes**: New describe block verifying schema params, filter logic, and `hasField` helper coverage:

```typescript
describe("list_issues has/no presence filters structural", () => {
  it("Zod schema includes has param with enum", () => {
    expect(issueToolsSrc).toContain('"workflowState", "estimate", "priority", "labels", "assignees"');
  });

  it("Zod schema includes both has and no params", () => {
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

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` succeeds
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test -- --run issue-tools` passes
- [ ] Manual: Verify `hasField` helper covers all 5 field types via switch cases

**Creates for next phase**: Established filter chain pattern and `hasField` helper that Phase 2 builds alongside, and Phase 3 ports.

---

## Phase 2: GH-142 - Add `exclude*` Negation Filters to `list_issues`
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/142 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0142-exclude-negation-filters-list-issues.md | **Depends on**: Phase 1

### Changes Required

#### 1. Add `exclude*` params to Zod schema
**File**: [`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts)
**Location**: After the `no` param (added in Phase 1), before `updatedSince`
**Changes**: Four `z.array(z.string()).optional()` params:

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

Note: Using `z.string()` (not `z.enum()`) because workflow states, estimates, priorities, and labels are dynamic project-specific values.

#### 2. Add negation filter blocks to filter chain
**File**: [`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts)
**Location**: After the `label` filter (after line 226), before the `query` filter (line 229). This places negation filters adjacent to their positive counterparts.
**Changes**: Four filter blocks using inverse logic with `?? ""` for undefined value coercion:

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

Key design: `?? ""` coercion ensures items with `undefined` field values (no value set) are NOT excluded. This is correct: `excludeWorkflowStates: ["Done"]` should not exclude items with no workflow state.

#### 3. Add structural tests
**File**: [`plugin/ralph-hero/mcp-server/src/__tests__/issue-tools.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/issue-tools.test.ts)
**Location**: After the Phase 1 describe block
**Changes**: New describe block verifying all four negation params and filter logic:

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

  it("items without field values are not excluded via ?? coercion", () => {
    expect(issueToolsSrc).toContain('?? ""');
  });
});
```

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` succeeds
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test -- --run issue-tools` passes
- [ ] Manual: Verify `?? ""` coercion is present in all three single-select negation filters

**Creates for next phase**: Proven negation filter pattern that Phase 3 ports to `project-tools.ts`.

---

## Phase 3: GH-143 - Port Presence and Negation Filters to `list_project_items`
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/143 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0143-port-presence-negation-filters-list-project-items.md | **Depends on**: Phase 1, Phase 2

### Changes Required

#### 1. Add `hasField` helper function
**File**: [`plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts)
**Location**: After the `getFieldValue` function (after line 635)
**Changes**: Duplicate the `PresenceField` type and `hasField` helper from `issue-tools.ts` (identical logic, independent `RawProjectItem` type):

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

#### 2. Add `has`, `no`, and `exclude*` params to Zod schema
**File**: [`plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts)
**Location**: After the `priority` param (after line 407), before `itemType`
**Changes**: Add 5 params (`has`, `no`, `excludeWorkflowStates`, `excludeEstimates`, `excludePriorities`). Note: NO `excludeLabels` since `list_project_items` has no positive `label` filter.

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
  .describe("Exclude items matching any of these Workflow State names"),
excludeEstimates: z
  .array(z.string())
  .optional()
  .describe("Exclude items matching any of these Estimate values"),
excludePriorities: z
  .array(z.string())
  .optional()
  .describe("Exclude items matching any of these Priority values"),
```

#### 3. Add filter blocks to filter chain
**File**: [`plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts)
**Location**: After the `priority` filter (after line 544), before `updatedSince` (line 547)
**Changes**: Five filter blocks -- two presence, three negation:

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
```

#### 4. Update `hasFilters` pagination guard
**File**: [`plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L453)
**Location**: Line 453
**Changes**: Expand `hasFilters` to include the new filter params so pagination fetches enough items:

```typescript
const hasFilters = args.updatedSince || args.updatedBefore || args.itemType
  || (args.has && args.has.length > 0)
  || (args.no && args.no.length > 0)
  || args.excludeWorkflowStates
  || args.excludeEstimates
  || args.excludePriorities;
```

#### 5. Add structural tests
**File**: [`plugin/ralph-hero/mcp-server/src/__tests__/project-tools.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/project-tools.test.ts)
**Location**: After the existing `list_project_items structural` describe block (after line 45)
**Changes**: New describe block verifying all ported params and helpers:

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

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` succeeds
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes (all test files)
- [ ] Manual: Verify `excludeLabels` is NOT present in `project-tools.ts`
- [ ] Manual: Verify `hasFilters` guard includes the new filter params

---

## Integration Testing
- [ ] `npm run build` succeeds with no type errors across both tool files
- [ ] `npm test` passes all structural tests in both `issue-tools.test.ts` and `project-tools.test.ts`
- [ ] Filter behavior is consistent: same `has`/`no`/`exclude*` params produce equivalent results on both `list_issues` and `list_project_items` for Issue-type items

## References
- Research GH-141: [thoughts/shared/research/2026-02-20-GH-0141-has-no-presence-filters-list-issues.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0141-has-no-presence-filters-list-issues.md)
- Research GH-142: [thoughts/shared/research/2026-02-20-GH-0142-exclude-negation-filters-list-issues.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0142-exclude-negation-filters-list-issues.md)
- Research GH-143: [thoughts/shared/research/2026-02-20-GH-0143-port-presence-negation-filters-list-project-items.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0143-port-presence-negation-filters-list-project-items.md)
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/106
