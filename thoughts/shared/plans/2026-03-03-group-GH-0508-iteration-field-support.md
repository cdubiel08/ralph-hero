---
date: 2026-03-03
status: draft
type: plan
github_issues: [508, 509, 510, 511, 512]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/508
  - https://github.com/cdubiel08/ralph-hero/issues/509
  - https://github.com/cdubiel08/ralph-hero/issues/510
  - https://github.com/cdubiel08/ralph-hero/issues/511
  - https://github.com/cdubiel08/ralph-hero/issues/512
primary_issue: 508
---

# Iteration Field Support — Atomic Implementation Plan

## Overview

5 sub-issues implementing iteration/sprint field support in the Ralph MCP server, split from #367. All are sub-issues of the #367 umbrella epic.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | #508 | Iteration Field Cache & GraphQL Fragment Support | S |
| 2a | #509 | save_issue Iteration Param — assign and clear iteration | S |
| 2b | #510 | list_issues Iteration Filter — @current/@next/@previous | S |
| 2c (∥) | #511 | setup_project Iteration Field Creation | XS |
| 3 | #512 | pipeline_dashboard Per-Iteration Breakdown | S |

**Why grouped**: All 5 issues implement facets of a single feature (iteration field support). Phase 1 (#508) creates the shared cache/fragment infrastructure that phases 2a, 2b, and 3 depend on. Phase 2c (#511) is independent and can be implemented in any order but is naturally grouped with the rest for a single cohesive PR.

**Approach**: Read + Assign only for v1. Sprint lifecycle management (create/edit/delete iterations) is explicitly out of scope due to a critical API limitation: `updateProjectV2Field` replaces the entire iteration list and regenerates all IDs, breaking existing issue-to-iteration assignments.

## Current State Analysis

- `types.ts` already has a partial `ProjectV2ItemFieldIterationValue` type — needs fleshing out
- `FieldOptionCache` handles single-select fields only (`field.options`); iteration fields expose `configuration.iterations` (different shape)
- `fetchProjectForCache` query in `helpers.ts` only fragments on `ProjectV2SingleSelectField`
- `buildBatchMutationQuery` hardcodes `value: { singleSelectOptionId }` — needs `iterationId` variant
- `list_issues` fieldValues query fetches only `ProjectV2ItemFieldSingleSelectValue` fragments
- `pipeline_dashboard` extracts only Workflow State, Priority, Estimate from field values
- `setup_project` creates fields via `createSingleSelectField()` — no `ITERATION` dataType path

## Desired End State

### Verification
- [ ] Automated: `FieldOptionCache.populate()` stores iteration IDs for projects with an iteration field
- [ ] Automated: `resolveIterationId("Sprint", "@current")` returns correct short ID via date math
- [ ] Automated: `save_issue({ number: N, iteration: "Sprint 1" })` sets iteration field via `value: { iterationId }`
- [ ] Automated: `save_issue({ number: N, iteration: null })` clears iteration via `clearProjectV2ItemFieldValue`
- [ ] Automated: `list_issues({ iteration: "@current" })` returns only issues in the active sprint
- [ ] Automated: `setup_project({ createIterationField: true })` creates a "Sprint" iteration field
- [ ] Automated: `pipeline_dashboard` includes per-iteration phase breakdown when iteration assignments exist
- [ ] Automated: Projects without iteration fields produce identical `pipeline_dashboard` output (no regression)
- [ ] Manual: Setting `iteration: "@next"` on an issue via `save_issue` appears in the correct sprint on the GitHub board

## What We're NOT Doing

- Sprint lifecycle management (create new sprint, extend sprint, rename sprint) — replace-all mutation regenerates all IDs and breaks existing assignments
- `sprint_report` tool — separate future issue if needed
- Server-side iteration filtering — GitHub GraphQL `projectItems` has no filter parameter; `@current`/`@next`/`@previous` are UI-only
- `@previous` token in `list_issues` — the `@previous` keyword has a known off-by-one bug when no `@next` iteration is defined; skip for v1

## Implementation Approach

Phase 1 (#508) establishes the shared infrastructure: GraphQL fragments to discover iteration configurations, FieldOptionCache extension to store iteration IDs by title, and a `resolveIterationId()` helper for token resolution. Phases 2a/2b/3 all call into this infrastructure. Phase 2c (#511) is independent (only uses the `createProjectV2Field` mutation, no cache read path).

---

## Phase 1: #508 — Iteration Field Cache & GraphQL Fragment Support

> **Issue**: [#508](https://github.com/cdubiel08/ralph-hero/issues/508) | **Research**: [GH-367 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-03-GH-0367-iteration-field-support.md) | **Depends on**: nothing

### Changes Required

#### 1. Flesh out `ProjectV2ItemFieldIterationValue` type
**File**: `plugin/ralph-hero/mcp-server/src/types.ts`
**Changes**: Replace existing partial type with:
```typescript
interface ProjectV2ItemFieldIterationValue {
  __typename: "ProjectV2ItemFieldIterationValue";
  iterationId: string;       // short string ID (e.g., "cfc16e4d")
  title: string;
  startDate: string;         // ISO date string
  duration: number;          // days
  field: { __typename: string; name?: string };
}
```

#### 2. Add iteration field fragment to `fetchProjectForCache`
**File**: `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` (lines ~53-74)
**Changes**: Add inline fragment after the existing `ProjectV2SingleSelectField` fragment:
```graphql
... on ProjectV2IterationField {
  id
  name
  configuration {
    iterations { id title startDate duration }
    completedIterations { id title startDate duration }
  }
}
```

#### 3. Extend `FieldOptionCache.populate()` to store iteration IDs
**File**: `plugin/ralph-hero/mcp-server/src/lib/cache.ts`
**Changes**: After the existing `if (field.options)` branch (line ~133), add:
```typescript
if ('configuration' in field && field.configuration?.iterations) {
  const iterMap = new Map<string, string>();
  for (const iter of field.configuration.iterations) {
    iterMap.set(iter.title, iter.id);
    // Store full iteration metadata for @current/@next resolution
    iterMap.set(`__meta__${iter.title}`, JSON.stringify({
      id: iter.id, startDate: iter.startDate, duration: iter.duration
    }));
  }
  this.fields.get(projectNumber)!.set(field.name, iterMap);
}
```
Also store the full `configuration.iterations` array on the `ProjectCacheData` for token resolution.

#### 4. Add `resolveIterationId()` helper
**File**: `plugin/ralph-hero/mcp-server/src/lib/helpers.ts`
**Changes**: New exported function:
```typescript
export function resolveIterationId(
  fieldCache: FieldOptionCache,
  projectNumber: number,
  fieldName: string,
  titleOrToken: string
): string | null {
  const today = new Date();
  const iterations = fieldCache.getIterations(projectNumber, fieldName); // new accessor
  if (!iterations) return null;

  if (titleOrToken === "@current") {
    return iterations.find(it => {
      const start = new Date(it.startDate);
      const end = new Date(start.getTime() + it.duration * 86400000);
      return start <= today && today < end;
    })?.id ?? null;
  }
  if (titleOrToken === "@next") {
    const sorted = iterations.filter(it => new Date(it.startDate) > today)
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    return sorted[0]?.id ?? null;
  }
  // Title lookup
  return iterations.find(it => it.title === titleOrToken)?.id ?? null;
}
```

#### 5. Add `getIterations()` accessor to `FieldOptionCache`
**File**: `plugin/ralph-hero/mcp-server/src/lib/cache.ts`
**Changes**: New method returning `Array<{id, title, startDate, duration}>` for a given project + field name.

### Success Criteria
- [ ] Automated: `FieldOptionCache.populate()` stores iteration title→ID mappings for a project with an iteration field — new test in `cache.test.ts`
- [ ] Automated: `resolveIterationId(cache, project, "Sprint", "@current")` returns the correct short ID using mocked date
- [ ] Manual: `get_project` includes iteration field with available iterations in the response

**Creates for next phase**: `resolveIterationId()` and `FieldOptionCache.getIterations()` used by phases 2a (#509), 2b (#510), and 3 (#512). The `ProjectV2ItemFieldIterationValue` type used by phases 2b and 3.

---

## Phase 2a: #509 — save_issue Iteration Param

> **Issue**: [#509](https://github.com/cdubiel08/ralph-hero/issues/509) | **Research**: [GH-367 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-03-GH-0367-iteration-field-support.md) | **Depends on**: #508

### Changes Required

#### 1. Add `iterationId` value variant to `buildBatchMutationQuery`
**File**: `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts` (lines ~86-126)
**Changes**: Extend the mutation builder to accept a `valueType: "singleSelectOptionId" | "iterationId"` discriminator. When `valueType === "iterationId"`, emit `value: { iterationId: $optId }` instead of `value: { singleSelectOptionId: $optId }`.

#### 2. Add `iteration` parameter to `save_issue`
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**:
- Add `iteration?: string | null` to the `save_issue` input schema (description: "Iteration title, @current, @next, or null to clear")
- When `iteration` is a non-null string: call `resolveIterationId()` from Phase 1, then append `{ fieldId, optionId: iterationId, valueType: "iterationId" }` to the batch mutation list
- When `iteration === null`: call `clearProjectV2ItemFieldValue` for the iteration field (reuse existing clear mutation pattern at lines ~1404-1417)
- When `iteration` is undefined: no-op (preserve existing behavior)

### Success Criteria
- [x] Automated: `save_issue({ number: N, iteration: "Sprint 1" })` sets the iteration field using `value: { iterationId }` — new test in `save-issue.test.ts`
- [x] Automated: `save_issue({ number: N, iteration: "@current" })` resolves to active iteration via date math
- [x] Automated: `save_issue({ number: N, iteration: null })` clears the iteration via `clearProjectV2ItemFieldValue`
- [x] Automated: `save_issue({ number: N, workflowState: "In Progress" })` (no `iteration` param) unchanged — regression test

**Creates for next phase**: No direct output consumed by later phases.

---

## Phase 2b: #510 — list_issues Iteration Filter

> **Issue**: [#510](https://github.com/cdubiel08/ralph-hero/issues/510) | **Research**: [GH-367 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-03-GH-0367-iteration-field-support.md) | **Depends on**: #508

### Changes Required

#### 1. Add `ProjectV2ItemFieldIterationValue` fragment to `list_issues` query
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` (lines ~228-237)
**Changes**: In the `fieldValues(first: 20)` nodes block, add after the existing `ProjectV2ItemFieldSingleSelectValue` fragment:
```graphql
... on ProjectV2ItemFieldIterationValue {
  iterationId
  title
  startDate
  duration
  field { ... on ProjectV2FieldCommon { name } }
}
```

#### 2. Extend `getFieldValue()` to extract iteration data
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` (lines ~1751-1761)
**Changes**: When `__typename === "ProjectV2ItemFieldIterationValue"` and the field name matches, return `{ iterationId, title, startDate, duration }`.

#### 3. Add `iteration` filter parameter
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**:
- Add `iteration?: string` to `list_issues` input schema (accepts title, `@current`, `@next`, `@previous`)
- After existing filter chain, add iteration filter: call `resolveIterationId()` from Phase 1 to get target `iterationId`, then filter items where `item.iterationId === targetId`
- `@previous`: find the most recently completed iteration before today using `completedIterations` from cache

### Success Criteria
- [x] Automated: `list_issues({ iteration: "@current" })` returns only issues in the active sprint — new test
- [x] Automated: `list_issues({ iteration: "Sprint 1" })` returns issues assigned to that named iteration
- [x] Automated: `list_issues({ workflowState: "In Progress" })` (no `iteration`) unchanged — regression test
- [ ] Manual: `list_issues({ iteration: "@next" })` returns issues in upcoming sprint

**Creates for next phase**: No direct output consumed by later phases.

---

## Phase 2c (parallel): #511 — setup_project Iteration Field Creation

> **Issue**: [#511](https://github.com/cdubiel08/ralph-hero/issues/511) | **Research**: [GH-367 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-03-GH-0367-iteration-field-support.md) | **Depends on**: nothing (independent)

### Changes Required

#### 1. Add `createIterationField()` function
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
**Changes**: New function analogous to `createSingleSelectField()`:
```typescript
async function createIterationField(
  client: GitHubClient,
  projectId: string,
  name: string = "Sprint",
  durationDays: number = 14,
  startDate: string  // ISO date, e.g. next Monday
): Promise<string> {
  // Execute createProjectV2Field with dataType: ITERATION
  // and iterationConfiguration: { duration, startDate, iterations: [{ title: "Sprint 1", startDate, duration }] }
  // Return the new field's node ID
}
```

#### 2. Add `createIterationField` param to `setup_project`
**File**: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`
**Changes**:
- Add `createIterationField?: boolean` (default `false`) to `setup_project` input schema
- When `true`: after creating the 3 existing fields, call `createIterationField()` with `name: "Sprint"`, `durationDays: 14`, `startDate: <next Monday>`
- Compute "next Monday" relative to the current date at call time
- Invalidate field cache after creation (same pattern as existing field creation)

### Success Criteria
- [ ] Automated: `setup_project({ createIterationField: true })` creates a "Sprint" field — new test in `setup-project-template.test.ts`
- [ ] Automated: `setup_project()` without flag creates only the 3 existing fields — backward compat regression test
- [ ] Manual: After `setup_project({ createIterationField: true })`, the GitHub project UI shows a "Sprint" iteration field

**Creates for next phase**: No direct output consumed by later phases.

---

## Phase 3: #512 — pipeline_dashboard Per-Iteration Breakdown

> **Issue**: [#512](https://github.com/cdubiel08/ralph-hero/issues/512) | **Research**: [GH-367 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-03-GH-0367-iteration-field-support.md) | **Depends on**: #508

### Changes Required

#### 1. Add iteration fragment to `DASHBOARD_ITEMS_QUERY`
**File**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` (lines ~197-241)
**Changes**: In `fieldValues(first: 20)` nodes block, add:
```graphql
... on ProjectV2ItemFieldIterationValue {
  iterationId title startDate duration
  field { ... on ProjectV2FieldCommon { name } }
}
```

#### 2. Extend `toDashboardItems()` to extract iteration data
**File**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` (lines ~161-191)
**Changes**: In the field value extraction loop, detect `__typename === "ProjectV2ItemFieldIterationValue"` and extract `iterationId` and `iterationTitle` onto the `DashboardItem` (add these optional fields to the `DashboardItem` type in `types.ts`).

#### 3. Add per-iteration breakdown to dashboard output
**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
**Changes**:
- Add `buildIterationSection()` function: group items by `iterationTitle`, then for each unique iteration call `aggregateByPhase()` on that subset
- Output format:
  ```
  ## Sprint 1 (2026-03-10 → 2026-03-24, 14 days)
  In Progress: 3 | Ready for Plan: 2 | Done: 1
  ```
- Guard: only emit section when `items.some(i => i.iterationId)` — skip entirely if no iteration assignments
- Call `buildIterationSection()` from `buildDashboard()` and append to output

### Success Criteria
- [x] Automated: Dashboard output includes `## Sprint 1` section with phase counts when items have iteration assignments — new test
- [x] Automated: Projects without iteration field produce identical output (no regression)
- [ ] Manual: `pipeline_dashboard` shows per-sprint breakdown when issues are assigned to sprints

---

## Integration Testing

- [ ] End-to-end: `setup_project({ createIterationField: true })` → `save_issue({ iteration: "@current" })` → `list_issues({ iteration: "@current" })` → `pipeline_dashboard` shows the assigned issue in the sprint breakdown
- [ ] Regression: All existing `save_issue`, `list_issues`, and `pipeline_dashboard` tests continue to pass unchanged

## References

- Research: [GH-367 iteration field support findings](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-03-GH-0367-iteration-field-support.md)
- Parent epic: [#367](https://github.com/cdubiel08/ralph-hero/issues/367)
- GitHub GraphQL docs: [Using the API to manage Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- Community discussion on replace-all limitation: [#157957](https://github.com/orgs/community/discussions/157957)
- Official GitHub MCP server gap: [github-mcp-server #1854](https://github.com/github/github-mcp-server/issues/1854)
