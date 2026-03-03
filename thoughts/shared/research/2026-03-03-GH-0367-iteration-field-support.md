---
date: 2026-03-03
github_issue: 367
github_url: https://github.com/cdubiel08/ralph-hero/issues/367
status: complete
type: research
---

# Research: Iteration Field Support for Sprint/Time-Boxed Planning (GH-367)

## Problem Statement

Ralph treats all work as a flat backlog with no concept of time-boxed iterations or sprints. GitHub Projects V2 provides iteration fields with configurable duration, breaks, and `@current`/`@next`/`@previous` keywords, but Ralph has no tooling to create, assign, or filter by iterations.

The issue asks for:
- `setup_project` to create an Iteration field
- A new `assign_to_iteration` tool (or param on existing tools)
- `list_issues` iteration filter (`@current`, `@next`, etc.)
- `pipeline_dashboard` per-iteration breakdown
- Research on whether iteration field CRUD is available via GraphQL API

## Current State Analysis

### Existing Type Support (Strong Foundation)

`types.ts` already defines `ProjectV2ItemFieldIterationValue` at lines ~106-111:

```typescript
interface ProjectV2ItemFieldIterationValue {
  __typename: "ProjectV2ItemFieldIterationValue";
  iteration: { ... };
}
```

This confirms the type layer is partially prepped for iteration support.

### FieldOptionCache — Only Handles Single-Select Options

[`plugin/ralph-hero/mcp-server/src/lib/cache.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts) — `FieldOptionCache.populate()` maps field names to node IDs for ALL field types (via `ProjectV2FieldCommon` fragment), but only populates the options map when `field.options` exists — which is true only for `SINGLE_SELECT` fields. Iteration fields expose `configuration.iterations` (a different shape), so their option IDs are never cached.

### fetchProjectForCache — Missing Iteration Fragment

[`plugin/ralph-hero/mcp-server/src/lib/helpers.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts) lines ~53-74 — The cache-populating GraphQL query only inline-fragments on `ProjectV2SingleSelectField`. An `... on ProjectV2IterationField { id name configuration { iterations { id title startDate duration } } }` fragment is needed to read iteration IDs for assignment.

### Field Value Mutations — Hardcoded to singleSelectOptionId

[`plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts) lines ~86-126 and [`plugin/ralph-hero/mcp-server/src/lib/helpers.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts) lines ~231-271 — Both use `value: { singleSelectOptionId: $optId }`. Iteration field assignment uses `value: { iterationId: $iterationId }` (different value variant).

### list_issues — No Iteration Filter, Missing Fragment

[`plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts) lines ~202-246 — The `fieldValues` query only fetches `ProjectV2ItemFieldSingleSelectValue`. `getFieldValue()` at lines ~1751-1761 only matches `__typename === "ProjectV2ItemFieldSingleSelectValue"`. No iteration filter parameter exists.

### pipeline_dashboard — No Iteration Breakdown

[`plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts) lines ~197-241 — `DASHBOARD_ITEMS_QUERY` only fetches single-select field values. `toDashboardItems()` extracts only Workflow State, Priority, and Estimate. No iteration grouping exists.

### setup_project — SINGLE_SELECT Only

[`plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts) lines ~585-633 — `createSingleSelectField()` always uses `dataType: "SINGLE_SELECT"`. Required fields array (`index.ts` line ~227) only lists `["Workflow State", "Priority", "Estimate"]`. No iteration field creation path exists.

## Key Discoveries

### 1. GraphQL API Fully Supports Iteration Field Creation and Assignment

**Creating an iteration field** (fully supported):
```graphql
mutation {
  createProjectV2Field(input: {
    projectId: $projectId
    dataType: ITERATION
    name: "Sprint"
    iterationConfiguration: {
      duration: 14
      startDate: "2026-03-10"
      iterations: [
        { title: "Sprint 1", startDate: "2026-03-10", duration: 14 }
      ]
    }
  }) {
    projectV2Field {
      ... on ProjectV2IterationField { id name }
    }
  }
}
```

**Assigning an issue to an iteration** (fully supported):
```graphql
mutation {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId
    itemId: $itemId
    fieldId: $fieldId
    value: { iterationId: "cfc16e4d" }  # short string ID from configuration
  }) { projectV2Item { id } }
}
```

Note: `iterationId` is a short string ID (e.g., `"cfc16e4d"`) from `configuration.iterations[].id`, NOT a global node ID.

**Clearing an iteration assignment** (use existing `clearProjectV2ItemFieldValue`):
```graphql
mutation { clearProjectV2ItemFieldValue(input: { projectId, itemId, fieldId }) { ... } }
```

**Reading iteration values on items** — add inline fragment to existing queries:
```graphql
... on ProjectV2ItemFieldIterationValue {
  iterationId title startDate duration
  field { ... on ProjectV2FieldCommon { name } }
}
```

### 2. Critical Limitation: No Atomic Sprint Add/Edit

`updateProjectV2Field` with `iterationConfiguration` **replaces the entire iteration list**. Every call regenerates new iteration IDs for all iterations (including unchanged ones), which **breaks all existing issue-to-iteration assignments**. Completed iterations are also wiped.

This makes programmatic sprint management (create next sprint, extend existing sprint, rename sprint) extremely fragile. Community workaround requires: fetch all current iterations, append new one, call update with full combined list, then re-query for new IDs, then re-assign all issues — all in one transaction.

**Recommendation**: Do NOT implement a "manage sprints" mutation tool. Focus only on READ + ASSIGN operations for v1.

### 3. `@current`/`@next`/`@previous` Are UI-Only

These keywords work in the Projects UI filter bar but are NOT GraphQL parameters. The `projectItems` connection has no filter parameter. All iteration filtering must be done client-side by:
1. Fetching the iteration field's `configuration.iterations` to find which iteration ID corresponds to `@current` (by comparing today's date against `startDate + duration`)
2. Comparing items' `iterationId` values against the resolved ID

The `@current` resolution logic: find the iteration where `startDate <= today < startDate + duration`.

### 4. Iteration Field Response Schema

```
ProjectV2IterationField:
  id           — global node ID (PVTIF_...) — used as fieldId in mutations
  name         — display name (e.g., "Sprint")
  configuration:
    duration         — default duration (days)
    startDate        — earliest start date
    iterations[]:    — ACTIVE/UPCOMING
      id         — short ID (e.g., "cfc16e4d") — used as iterationId in value mutations
      title      — display name
      startDate  — ISO date string
      duration   — days
    completedIterations[]  — same shape as iterations

ProjectV2ItemFieldIterationValue (on an item):
  iterationId  — short ID matching configuration.iterations[].id
  title        — display name
  startDate    — ISO date
  duration     — days
  field        — reference to field definition
```

### 5. Official GitHub MCP Server Gap Confirmed

As of March 2026, [github/github-mcp-server issue #1854](https://github.com/github/github-mcp-server/issues/1854) confirms that the official GitHub MCP server does not implement iteration field management — validating that this is an active ecosystem gap and a meaningful differentiator for ralph-hero.

### 6. Prior Research Exists (Partially Relevant)

- `thoughts/ideas/2026-02-18-github-projects-v2-docs-deep-dive.md` — Idea #1 already proposed `assign_to_iteration`, iteration filter params, per-iteration `pipeline_dashboard`, and a new `sprint_report` tool
- `thoughts/shared/research/2026-02-18-GH-0066-github-projects-v2-docs-guidance.md` — Mentions iteration filter syntax but doesn't detail API
- Closed issues #160/#161 (golden project setup/views) — Sprint Board view configured without iteration field (uses Status columns instead); confirms iteration was deferred

## Potential Approaches

### Approach A: Full Sprint Management Suite (v1 → v5)
Implement creation, assignment, filtering, dashboard breakdown, and sprint reports.

**Pros**: Complete feature; differentiator vs. official GitHub MCP server
**Cons**: Sprint lifecycle management (add/edit iterations) is fragile due to replace-all mutation; high scope risk

### Approach B: Read + Assign Only (Recommended for v1)
Implement iteration field caching, `assign_to_iteration`, `list_issues` iteration filter, and dashboard breakdown. Skip sprint creation/management (too fragile).

**Pros**: Delivers immediate value; avoids the dangerous replace-all mutation; safe incremental path
**Cons**: Users must create sprints manually in the UI; no `sprint_report` tool in v1

### Approach C: Stub Only — `setup_project` Creates Field, No Other Changes
Just create the iteration field in `setup_project` with a default 2-week Sprint definition.

**Pros**: Minimal scope; enables manual sprint management in UI
**Cons**: No programmatic assign/filter; doesn't deliver the core acceptance criteria

**Recommended**: Approach B — Read + Assign Only for v1. The replace-all limitation makes sprint lifecycle management a v2 concern.

## Implementation Breakdown (5 Sub-issues)

This M issue should be split into 5 focused pieces (each S or XS):

**Sub-issue A — Iteration Field Cache Support (S)**
- Extend `fetchProjectForCache` query in `helpers.ts` with `... on ProjectV2IterationField { configuration { iterations { id title startDate duration } } }` fragment
- Extend `FieldOptionCache.populate()` to store iteration IDs (keyed by title) alongside single-select options
- Extend `fieldValueByName`-style resolution to return `iterationId` for iteration fields

**Sub-issue B — `save_issue` Iteration Param (S)**
- Add optional `iteration` parameter to `save_issue` (accepts iteration title string or special tokens `@current`, `@next`)
- Resolve token to `iterationId` by comparing dates against cached `configuration.iterations`
- Call `updateProjectV2ItemFieldValue(value: { iterationId })` instead of `singleSelectOptionId`
- Support `iteration: null` → `clearProjectV2ItemFieldValue`

**Sub-issue C — `list_issues` Iteration Filter (S)**
- Add `... on ProjectV2ItemFieldIterationValue { iterationId title startDate }` to `list_issues` fieldValues query
- Extend `getFieldValue()` to extract iteration data
- Add `iteration` filter param accepting title string or `@current`/`@next`/`@previous`; resolve client-side

**Sub-issue D — `setup_project` Iteration Field Creation (XS)**
- Add `createIterationField()` analog to `project-tools.ts` using `dataType: ITERATION`
- Create "Sprint" field with configurable initial duration (default 14 days) as optional step in `setup_project`
- Add `"Sprint"` to required fields if iteration is enabled

**Sub-issue E — `pipeline_dashboard` Per-Iteration Breakdown (S)**
- Add `... on ProjectV2ItemFieldIterationValue` fragment to `DASHBOARD_ITEMS_QUERY`
- Extend `toDashboardItems()` to extract `iterationId` and `iterationTitle`
- Add per-iteration section to dashboard output (issue counts by workflow state phase within each active iteration)

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| replace-all mutation breaks iteration assignments | HIGH | Do not expose sprint creation/edit in v1; document limitation |
| `@current` resolution requires date math | LOW | Straightforward comparison: `startDate <= today < startDate + duration` |
| Iteration IDs are short strings, not stable node IDs | MEDIUM | Do not cache by iteration ID across sessions; always re-fetch from configuration |
| No server-side iteration filter → all-items fetch | LOW | Already the pattern for all list_issues filters; no new N+1 concern |
| ID regeneration on `updateProjectV2Field` | HIGH | Only affects sprint management tools (not in scope for v1) |

## Recommended Next Steps

1. **Split #367 into 5 sub-issues** (A through E above)
2. **Implement in order**: A (cache) → B (assign) → C (filter) → D (setup) → E (dashboard)
   - Sub-issue A blocks B and C (both need iteration IDs from cache)
   - D and E can be parallelized with B/C
3. **Skip sprint lifecycle management** for v1 — document the replace-all limitation in the tool description

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/lib/cache.ts` — Extend FieldOptionCache to handle iteration field `configuration.iterations` shape
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts` — Add `... on ProjectV2IterationField` fragment to `fetchProjectForCache`; add `iterationId` value variant support
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` — Add `iteration` filter param and `ProjectV2ItemFieldIterationValue` fragment; add `iteration` param to `save_issue`
- `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts` — Add `iterationId` value variant to `buildBatchMutationQuery`
- `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts` — Add `createIterationField()` function; update `setup_project` to optionally create Sprint field
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` — Add iteration fragment to `DASHBOARD_ITEMS_QUERY`; extend `toDashboardItems()` for iteration grouping
- `plugin/ralph-hero/mcp-server/src/types.ts` — Flesh out `ProjectV2ItemFieldIterationValue` interface with all fields from API schema

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts` — Status sync pattern to follow for iteration sync
- `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts` — Resolution pattern for `@current`/`@next` tokens (analogous to semantic intent resolution)
- `plugin/ralph-hero/mcp-server/src/__tests__/cache.test.ts` — Existing test patterns for FieldOptionCache
- `plugin/ralph-hero/mcp-server/src/__tests__/save-issue.test.ts` — Existing test patterns for field value mutations
- `thoughts/ideas/2026-02-18-github-projects-v2-docs-deep-dive.md` — Prior iteration tooling proposals
