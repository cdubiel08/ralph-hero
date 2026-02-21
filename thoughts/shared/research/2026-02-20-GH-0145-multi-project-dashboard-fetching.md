---
date: 2026-02-20
github_issue: 145
github_url: https://github.com/cdubiel08/ralph-hero/issues/145
status: complete
type: research
---

# GH-145: Add Multi-Project Data Fetching to `pipeline_dashboard`

## Problem Statement

The `pipeline_dashboard` tool currently fetches items from a single GitHub Projects V2 project. To support cross-project dashboards (parent #102), it needs a `projectNumbers` parameter that accepts an array of project numbers, fetches items from each, tags them with source project context, and merges them into a single `DashboardItem[]` for the existing `buildDashboard()` pipeline.

## Current State Analysis

### `pipeline_dashboard` — Single-Project Architecture

[`dashboard-tools.ts:233-346`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts#L233):

**Zod schema** (lines 236-272): `{ owner?, format, includeHealth, stuckThresholdHours, wipLimits, doneWindowDays, issuesPerPhase }`. No `projectNumbers` parameter.

**Handler flow**:
1. `resolveProjectOwner(client.config)` → single `owner` (line 275)
2. `client.config.projectNumber` → single `projectNumber` (line 276)
3. `ensureFieldCache(client, fieldCache, owner, projectNumber)` → populate cache for one project (line 286)
4. `fieldCache.getProjectId()` → single `projectId` (line 288)
5. `paginateConnection(...)` with `DASHBOARD_ITEMS_QUERY` → fetch items from one project (lines 294-300)
6. `toDashboardItems(result.nodes)` → convert to `DashboardItem[]` (line 303)
7. `buildDashboard(dashboardItems, healthConfig)` → aggregate + detect health (line 315)
8. Format and return (lines 318-340)

### `DashboardItem` — No Project Context

[`dashboard.ts:20-30`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L20):

```typescript
export interface DashboardItem {
  number: number;
  title: string;
  updatedAt: string;
  closedAt: string | null;
  workflowState: string | null;
  priority: string | null;
  estimate: string | null;
  assignees: string[];
  blockedBy: Array<{ number: number; workflowState: string | null }>;
}
```

No `projectNumber` or `projectTitle` field. Items from different projects with the same issue number would be indistinguishable.

### `toDashboardItems` — Filters to Issues Only

[`dashboard-tools.ts:150-173`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts#L150):

Filters `content.__typename === "Issue"` (line 155), drops PRs and drafts. Extracts workflow state, priority, estimate via `getFieldValue()` helper (lines 135-145) which searches `fieldValues.nodes` for matching `ProjectV2ItemFieldSingleSelectValue`.

### `FieldOptionCache` — Single-Project Only

[`cache.ts:100-189`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts#L100):

- Stores one `projectId`, one `fields` map, one `fieldIds` map
- `populate()` calls `this.fields.clear()` before writing — calling it for a second project overwrites the first
- `isPopulated()` returns `true` once any project is loaded — no project identity check
- `ensureFieldCache()` at [`helpers.ts:91-113`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/helpers.ts#L91) has an early-exit guard: `if (fieldCache.isPopulated()) return` — so calling it for project B after project A is a no-op

**This is the core blocker**: GH-144 must refactor `FieldOptionCache` to support per-project keying before GH-145 can iterate over multiple projects.

### `paginateConnection` — Project-Agnostic

[`pagination.ts:65-119`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pagination.ts#L65):

Accepts a generic `executeQuery` callback, a GraphQL query string, and a `connectionPath`. It loops over pages accumulating nodes. The function is project-agnostic — it can be called multiple times with different `projectId` variables. No refactoring needed.

### `buildDashboard` — Pure Function, Project-Agnostic

[`dashboard.ts:353-370`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L353):

Pure orchestrator: `aggregateByPhase(items) → detectHealthIssues(phases) → return DashboardData`. It operates on a flat `DashboardItem[]` with no project awareness. Adding `projectNumber` to `DashboardItem` would flow through transparently — `buildDashboard` doesn't inspect or filter by project.

### Existing Test Suite — 44 Tests, No Multi-Project

[`__tests__/dashboard.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts) (964 lines, 44 tests):

- Uses `makeItem(overrides)` factory returning `DashboardItem` with defaults
- Tests `aggregateByPhase`, `detectHealthIssues`, `formatMarkdown`, `formatAscii`, `buildDashboard`
- No multi-project test scenarios

[`__tests__/hygiene.test.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/hygiene.test.ts) (379 lines, 24 tests):

- Same `makeItem()` factory pattern and fixed `NOW` constant
- Tests hygiene-related pure functions

## Key Discoveries

### 1. GH-144 API Surface — What GH-145 Depends On

The GH-144 research ([`2026-02-20-GH-0144-multi-project-config-cache.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0144-multi-project-config-cache.md)) defines the API surface GH-145 needs:

| API | Current | After GH-144 |
|-----|---------|-------------|
| `resolveProjectNumbers(config)` | Does not exist | Returns `number[]` of all configured projects |
| `ensureFieldCache(client, fieldCache, owner, projectNumber)` | No-ops after first call | Project-aware; loads per-project data |
| `fieldCache.isPopulated(projectNumber?)` | Boolean, no project identity | Per-project check |
| `fieldCache.populate(projectNumber, projectId, fields)` | Overwrites previous data | Stores per-project |
| `fieldCache.getProjectId(projectNumber?)` | Returns single ID | Returns per-project ID |
| `RALPH_GH_PROJECT_NUMBERS` env var | Not parsed | Comma-separated integers |

Until GH-144 ships, `pipeline_dashboard` cannot iterate over multiple projects without corrupting the field cache.

### 2. Multi-Project Fetch Loop Pattern

The handler needs to iterate over project numbers, fetching and converting items from each:

```typescript
const projectNumbers = args.projectNumbers ?? resolveProjectNumbers(client.config);

const allItems: DashboardItem[] = [];
for (const pn of projectNumbers) {
  const pOwner = resolveProjectOwner(client.config);
  await ensureFieldCache(client, fieldCache, pOwner, pn);
  const projectId = fieldCache.getProjectId(pn);
  if (!projectId) {
    // Graceful skip — project not found or missing custom fields
    warnings.push(`Project #${pn}: could not resolve project ID, skipping`);
    continue;
  }

  const result = await paginateConnection<RawDashboardItem>(
    (q, v) => client.projectQuery(q, v),
    DASHBOARD_ITEMS_QUERY,
    { projectId, first: 100 },
    "node.items",
    { maxItems: 500 },
  );

  const items = toDashboardItems(result.nodes, pn);
  allItems.push(...items);
}

const dashboard = buildDashboard(allItems, healthConfig);
```

Key design decisions:
- **Sequential, not parallel**: Fetch one project at a time to respect rate limits and keep `ensureFieldCache` state predictable
- **Per-project pagination cap**: Each project gets up to `maxItems: 500` — total merged items can exceed 500
- **Graceful skip**: Missing projects or projects without custom fields produce a warning, not an error

### 3. `DashboardItem` Extension — Minimal

Add two optional fields to `DashboardItem`:

```typescript
export interface DashboardItem {
  // ... existing fields ...
  projectNumber?: number;   // Source project number (undefined for single-project compat)
  projectTitle?: string;    // Human-readable project title (from ProjectV2.title)
}
```

Making them optional preserves backward compatibility — existing single-project callers and all 44 existing tests continue to work without changes.

### 4. `toDashboardItems` Signature Change

Currently: `toDashboardItems(raw: RawDashboardItem[]): DashboardItem[]`

After: `toDashboardItems(raw: RawDashboardItem[], projectNumber?: number): DashboardItem[]`

The `projectNumber` is passed from the fetch loop and set on each output item. When called without `projectNumber` (single-project mode), the field is `undefined`.

### 5. Project Title Resolution

The `DASHBOARD_ITEMS_QUERY` currently queries `node(id: $projectId) { ... on ProjectV2 { items { ... } } }`. To get the project title, add `title` to the ProjectV2 fragment:

```graphql
node(id: $projectId) {
  ... on ProjectV2 {
    title
    items(first: $first, after: $cursor) { ... }
  }
}
```

This adds one field to the existing query — minimal cost. The title can be extracted from the first page response and passed to `toDashboardItems`.

### 6. Formatting Impact

The `formatMarkdown` and `formatAscii` functions in `dashboard.ts` operate on `PhaseSnapshot[]` and `HealthWarning[]` — they don't directly reference `DashboardItem`. However, the issue lists within each `PhaseSnapshot` contain `DashboardItem` references (via `phase.issues`). To show project context in the formatted output, the formatting functions need to display `projectNumber` alongside issue numbers when multiple projects are present.

This is a formatting concern that belongs to GH-146 (cross-project aggregation and health indicators), not GH-145. GH-145's scope is data fetching and merging — the downstream `buildDashboard` and formatting pipeline processes the merged items unchanged.

### 7. Graceful Field Mismatch Handling

Different projects may have different custom fields (e.g., project A has Workflow State but project B doesn't). The `getFieldValue()` helper already handles missing fields gracefully — it returns `null` when no matching `fieldValues.nodes` entry exists. No special error handling needed.

However, `ensureFieldCache` will fail if a project doesn't exist or returns no fields. The fetch loop should catch errors from `ensureFieldCache` per-project and skip with a warning.

### 8. Group Context — Dependency Chain

```
GH-144 (config + cache foundation) — research complete, not yet planned
  └── GH-145 (multi-project fetching) — this issue
        └── GH-146 (cross-project aggregation + health)

Parallel:
GH-150 (resolveFullConfig extension) — research complete, not yet planned
  └── GH-151 (projectNumber override for all tools)
        └── GH-152 (documentation)
```

GH-145 is blocked by GH-144. GH-146 is blocked by GH-145. The GH-150/151/152 chain is independent but shares the same `types.ts` and `index.ts` changes.

## Recommended Approach

### Changes

1. **Modify: `lib/dashboard.ts`** — Add `projectNumber?: number` and `projectTitle?: string` to `DashboardItem`
2. **Modify: `tools/dashboard-tools.ts`**:
   - Add `projectNumbers?: z.array(z.number()).optional()` to Zod schema
   - Add multi-project fetch loop with graceful skip
   - Update `toDashboardItems` to accept and set `projectNumber`
   - Add `title` to `DASHBOARD_ITEMS_QUERY` ProjectV2 fragment
3. **Modify: `__tests__/dashboard.test.ts`** — Add tests for multi-project item merging

### Test Strategy

**Pure function tests** (extends existing `makeItem()` pattern):
- `toDashboardItems` with `projectNumber` parameter — verify items tagged correctly
- `buildDashboard` with items from multiple projects — verify aggregation works across projects
- `makeItem({ projectNumber: 3 })` and `makeItem({ projectNumber: 5 })` — verify items with different project numbers aggregate correctly into the same phases

**Structural tests** (source-string pattern):
- Verify `projectNumbers` param exists in Zod schema
- Verify `projectNumber` field exists in `DashboardItem` interface

## Risks

1. **GH-144 not implemented**: `FieldOptionCache` cannot handle multiple projects simultaneously. GH-145 is strictly blocked by GH-144. If GH-144 is delayed, GH-145 cannot proceed.

2. **Rate limiting**: Fetching 500 items from N projects = N * 5 pages = N * 5 API calls minimum. For 3 projects, that's 15 API calls. The existing `RateLimiter` handles this, but large N could be slow.

3. **Cross-project issue dedup**: The same issue can appear in multiple projects (GitHub allows this). Items with the same `number` but different `projectNumber` values are distinct dashboard items. This is correct behavior — but could look confusing if the same issue appears in multiple phases with different workflow states across projects.

4. **Formatting changes deferred**: GH-145 adds `projectNumber` to `DashboardItem` but doesn't change how items are displayed. The markdown/ASCII formatters won't show project context until GH-146. This means multi-project output will merge items from different projects without visual distinction in the formatted output.

5. **`ensureFieldCache` error handling**: If a project number doesn't resolve to a real project, `fetchProjectForCache` throws. The fetch loop must catch per-project errors to avoid failing the entire dashboard for one bad project number.

## Recommended Next Steps

1. Implement GH-144 first (config + cache foundation)
2. Add `projectNumber?` and `projectTitle?` to `DashboardItem`
3. Add `projectNumbers` Zod param with default `[config.projectNumber]`
4. Implement sequential fetch loop with per-project error handling
5. Update `toDashboardItems` to accept and set project context
6. Add `title` to `DASHBOARD_ITEMS_QUERY` ProjectV2 fragment
7. Add pure function tests for multi-project item merging
8. Defer formatting changes to GH-146
