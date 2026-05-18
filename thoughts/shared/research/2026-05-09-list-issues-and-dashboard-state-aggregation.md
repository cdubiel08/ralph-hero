---
date: 2026-05-09
git_commit: 95edf2ca446dd67bba6fc44d32faf1f65865eb78
branch: main
topic: "list_issues, pipeline_dashboard, and similar code paths that filter or aggregate by Workflow State"
tags: [research, list-issues, pipeline-dashboard, workflow-state, pagination, cache, github-actions, projects-v2]
status: complete
type: research
github_issue: 1168
github_issues: [1168, 1169]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1168
  - https://github.com/cdubiel08/ralph-hero/issues/1169
primary_issue: 1168
---

# Research: list_issues, pipeline_dashboard, and similar code paths that filter or aggregate by Workflow State

## Prior Work

- builds_on:: [[2026-05-07-GH-1129-list-issues-totalcount-misleading]] (research — primary evidence: documents the same `list_issues` query path and notes the `totalCount` field reflects board-wide items, not filtered results)
- builds_on:: [[2026-02-16-GH-0026-workflow-visualization-pipeline-dashboard]] (research — primary evidence: foundational design of pipeline_dashboard)
- builds_on:: [[2026-02-19-GH-0115-archive-stats-pipeline-dashboard]] (research — primary evidence: archive-eligible computation in dashboard)
- builds_on:: [[2026-02-22-GH-0330-per-stream-dashboard-status]] (research — primary evidence: per-stream dashboard expansion of the same fetch path)
- builds_on:: [[2026-02-27-GH-0441-repo-breakdowns-pipeline-dashboard]] (research — primary evidence: repo-grouped dashboard variant of the same fetch path)
- builds_on:: [[2026-04-25-GH-0869-blockedby-dashboard-wiring]] (research — primary evidence: blockedBy wiring through dashboard items)
- builds_on:: [[2026-03-04-GH-0520-dashboard-oversized-subissue-guard]] (research — primary evidence: aggregateByPhase health-warning logic)
- builds_on:: [[2026-02-20-GH-0242-field-cache-poisoning]] (research — primary evidence: documents FieldOptionCache invalidation behavior)
- builds_on:: [[2026-02-21-GH-0146-cross-project-aggregation-health]] (research — primary evidence: multi-project dashboard aggregation)
- builds_on:: [[2026-03-14-hygiene-pipeline-multi-repo-aggregation]] (research — primary evidence: hygiene-pipeline shared fetch path)
- builds_on:: [[2026-02-20-GH-0107-reason-filter-list-issues]] (research — primary evidence: list_issues filter additions)
- builds_on:: [[2026-02-20-GH-0142-exclude-negation-filters-list-issues]] (research — primary evidence: excludeWorkflowStates filter origin)
- builds_on:: [[2026-04-05-filter-sort-cross-reference-matrix]] (research — primary evidence: cross-tool filter behavior matrix)
- builds_on:: [[2026-05-08-shorthand-tools-counts-and-filters]] (research — primary evidence: very recent observations on shorthand-tool count semantics)
- builds_on:: [[2026-02-20-GH-0144-multi-project-config-cache]] (research — primary evidence: multi-project field cache extension)

## Research Question

Map every code path in the ralph-hero MCP server, the GitHub Actions workflows, and adjacent helpers that read, filter, or aggregate GitHub Projects V2 issues by their **Workflow State** field. Document the mechanics of each path side-by-side: the GraphQL it uses, how it extracts the field value, how it paginates, what it caches, and how observable behaviors can diverge across paths. Document, do not propose fixes.

The investigation was prompted by an observation that issue **#1102** ("Decouple /status board health from delivery status vocabulary") is correctly tagged `Workflow State = "Plan in Review"` in the GitHub Projects V2 board (verified via raw GraphQL), but is invisible to `list_issues(workflowState="Plan in Review")` and to `pipeline_dashboard()` (both return zero items in that phase).

## Summary

There are **six distinct code paths** that read Workflow State for issue items, plus **five GitHub Actions workflows** that read or write the same field. The six paths fall into three architectural categories:

| Category | Paths | GraphQL root | Pagination |
|---|---|---|---|
| Project-wide fetch (capped at 500 items) | A. `list_issues`<br>B. dashboard family (`fetchDashboardItems`)<br>E. `list_groups` | `node(projectId).items` | `paginateConnection({ maxItems: 500 })` |
| Single-issue / per-item fetch | D. `get_issue` (inline)<br>F. `batch_update` (aliased per-item, conditional) | `repository.issue(number)` / `node(projectItemId)` | none |
| Caller-supplied items | C. `detect_stream_positions` | n/a | n/a |

The dashboard family (Path B) is consumed by **six MCP tools**: `pipeline_dashboard`, `project_hygiene`, `next_actions`, `pick_actionable_issue` (deprecated), `hello_directions` (deprecated), and `capture_snapshot`. They share `fetchDashboardItems()` and inherit the same 500-item cap.

The matching mechanics ("which option name does this item have on the Workflow State field?") are mechanically equivalent across Paths A, B, D, E — all use a `find()` on `fieldValues.nodes` that requires `field?.name === "Workflow State"` AND `__typename === "ProjectV2ItemFieldSingleSelectValue"`, returning the option's `name` string verbatim. There is no normalization (case-sensitive, no trimming).

Where observable behaviors diverge: (1) Paths A/B/E silently truncate at 500 fetched items; Path D bypasses pagination entirely. (2) Path A defaults `state: "OPEN"` and excludes closed issues unless caller passes `state: "CLOSED"`; Path B has no such filter and retains closed issues with non-Done/Canceled workflow states. (3) Path A's `getFieldValue` returns `string | undefined` on miss; Path B's returns `string | null`. (4) The `excludeWorkflowStates` filter on Path A coalesces missing values to `""`, so it retains items without a Workflow State unless the caller includes `""` in the exclude list.

Empirical evidence on the live `Ralph Workflow` project (#3) on 2026-05-09: the project's `items` connection has **`totalCount: 734`**. The first page of 100 items in default ordering returns issue numbers `492, 607, 606, 605, 591, ...` — older items appear first, newer items are paginated to later pages. Issue **#1102** sits on **page 7** (positions 601–700). With `paginateConnection({ maxItems: 500 })`, `list_issues` and the dashboard family stop fetching after page 5 (item 500), leaving items 501–734 (including #1102) outside their visible window.

Five GitHub Actions workflows read or write Workflow State using a separate token (`ROUTING_PAT` secret) from the MCP server (`RALPH_HERO_GITHUB_TOKEN` or `gh auth token`). They use the same `updateProjectV2ItemFieldValue` mutation against the same field. No coordination mechanism between workflows and the MCP server is documented in either source.

## Detailed Findings

### Path A: `list_issues` (own implementation)

**Tool registration**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:60-505`

**GraphQL query**: inline string at `issue-tools.ts:217-263`. Queries `node(projectId).items()` from the project node. Fetches per-item: `id`, `type`, `content` (Issue inline fragment with `number`, `title`, `body`, `state`, `stateReason`, `url`, `createdAt`, `updatedAt`, `labels(first: 10)`, `assignees(first: 5)`, `repository`), and `fieldValues(first: 20)` with two inline fragments (`ProjectV2ItemFieldSingleSelectValue` and `ProjectV2ItemFieldIterationValue`).

**Pagination**: `paginateConnection()` invoked at line 215 with `{ projectId, first: 100 }` and `{ maxItems: 500 }`.

**Field value extraction**: `getFieldValue()` at `issue-tools.ts:1899-1909`:

```typescript
function getFieldValue(item: RawProjectItem, fieldName: string): string | undefined {
  const fieldValue = item.fieldValues.nodes.find(
    (fv) =>
      fv.field?.name === fieldName &&
      fv.__typename === "ProjectV2ItemFieldSingleSelectValue",
  );
  return fieldValue?.name;
}
```

Returns `string | undefined`. Case-sensitive, no normalization.

**Filters**:
- `state` (default `"OPEN"`): client-side filter at lines 274-279. Closed issues are excluded unless the caller explicitly passes `state: "CLOSED"`.
- `workflowState`: positive filter at lines 292-297. Compares `getFieldValue(...) === args.workflowState`. Items without a Workflow State value (where `getFieldValue` returns `undefined`) are excluded.
- `excludeWorkflowStates`: negative filter at lines 385-392. Coalesces a missing value to `""` via `?? ""`. Items without a Workflow State pass through unless the caller includes `""` in their exclude list.
- Other filters (estimate, priority, iteration, label, repoFilter, etc.) follow the same client-side pattern.

**Response**: `toolSuccess({ totalCount: itemsResult.totalCount, filteredCount: formattedItems.length, items: formattedItems })` at line 495. The `totalCount` is the project's full `items.totalCount` from GraphQL (documented in [[2026-05-07-GH-1129-list-issues-totalcount-misleading]] as the board-wide count, not the filter-matching count).

### Path B: dashboard family (`fetchDashboardItems`)

**Helper**: `plugin/ralph-hero/mcp-server/src/lib/dashboard-fetch.ts:225-289`

**Consumer tools**:
- `pipeline_dashboard` — `tools/dashboard-tools.ts:175-189`
- `project_hygiene` — `tools/hygiene-tools.ts:42-189`
- `next_actions` — `tools/directions-tools.ts:472-559`
- `pick_actionable_issue` (deprecated wrapper) — `tools/directions-tools.ts:561-575`
- `hello_directions` (deprecated wrapper) — `tools/directions-tools.ts:383-470`
- `capture_snapshot` — `tools/trends-tools.ts:37-118`

**GraphQL query**: `DASHBOARD_ITEMS_QUERY` at `dashboard-fetch.ts:132-187`. Same project-node entrypoint as Path A. Fetches per-item: `id`, `type`, `content` (Issue, PullRequest, DraftIssue inline fragments — only `Issue` is retained downstream), and `fieldValues(first: 20)` with the same `ProjectV2ItemFieldSingleSelectValue` and `ProjectV2ItemFieldIterationValue` inline fragments. The `Issue` fragment requests fewer fields than Path A (no `body`, no `stateReason`, no `url`, no `createdAt`, no `labels`); it adds `subIssues { totalCount }`, `trackedIssues(first: 10)`, `trackedInIssues(first: 3)`.

**Pagination**: `paginateConnection()` at `dashboard-fetch.ts:277-283` with the same `{ projectId, first: 100 }` and `{ maxItems: 500 }`.

**Type filter**: `if (!r.content || r.content.__typename !== "Issue") continue;` at `dashboard-fetch.ts:88`. PRs and DraftIssues are dropped at this point.

**Field value extraction**: `getFieldValue()` at `dashboard-fetch.ts:62-72`:

```typescript
function getFieldValue(item: RawDashboardItem, fieldName: string): string | null {
  const fv = item.fieldValues.nodes.find(
    (n) =>
      n.field?.name === fieldName &&
      n.__typename === "ProjectV2ItemFieldSingleSelectValue",
  );
  return fv?.name ?? null;
}
```

Returns `string | null` (Path A returns `string | undefined`). Otherwise mechanically identical to Path A.

**Conversion to `DashboardItem`**: `toDashboardItems()` at `dashboard-fetch.ts:79-126`. Populates `workflowState`, `priority`, `estimate`, `assignees`, `subIssueCount`, `blockedBy`, `parentNumber`, `parentState`, optional repository / project metadata, and an iteration block when present. No `state` field is attached to `DashboardItem` — issue open/closed state is not propagated.

**Multi-project loop**: `fetchDashboardItems()` iterates `resolveProjectNumbers(client.config)` (line 245). For each project number it calls `ensureFieldCache`, fetches the project title, and runs `paginateConnection`. Per-project failures (missing project, field-cache failure) are recorded as warnings and the loop continues — a single failed project does not abort the whole fetch.

### Aggregation: `aggregateByPhase` and `buildPhaseOrder`

**File**: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:228-284`

**Phase order**: `buildPhaseOrder()` at line 208 spreads `STATE_ORDER` (9 states from `lib/workflow-states.ts:12-22`: Backlog through Done) and appends "Human Needed" and "Canceled" if not already in the array. Result: 11 ordered states.

**Bucket initialization**: at lines 237-239 the code pre-initializes a `Map<string, DashboardItem[]>` with an empty array for every state in `phaseOrder`.

**Item routing** at lines 242-248:

```typescript
for (const item of items) {
  const state = item.workflowState ?? "Unknown";
  if (!buckets.has(state)) {
    buckets.set(state, []);
  }
  buckets.get(state)!.push(item);
}
```

- `null` → `"Unknown"` bucket (created on demand)
- non-null matching one of the 11 states → that state's bucket
- non-null not matching any state → a new bucket with that string as key

**Done/Canceled time-window filter** at lines 250-263: replaces both buckets with a filtered subset where `now - new Date(closedAt ?? updatedAt).getTime() <= windowMs`. `windowMs` defaults to 7 days. Items outside the window are dropped, not relocated.

**Snapshot ordering** at lines 266-281: emits one `PhaseSnapshot` per state in `phaseOrder` first, then iterates remaining buckets (typically only `"Unknown"` if items lacked workflowState). The `"Unknown"` bucket appears as a trailing snapshot when present, suppressed when empty.

### Path C: `detect_stream_positions`

**Tool registration**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:259-369`

This tool does not run a GraphQL query of its own. It accepts a pre-built `issues[]` array (each with `number` and `workflowState`) from the caller and uses `lib/pipeline-detection.ts` to map the state strings to coarse pipeline phases (SPLIT, TRIAGE, RESEARCH, PLAN, etc.).

**Phase mapping**: `detectPipelinePosition()` at `pipeline-detection.ts:96-250` checks specific Workflow State string values to determine which pipeline phase the issue is in. Per-stream variant: `detectStreamPipelinePositions()` at lines 366-409.

The tool's output quality is bounded by what the caller's items already contain — if a caller passed items fetched via Path A or B, any 500-cap truncation upstream propagates here.

### Path D: `get_issue`

**Tool registration**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:509-710`

**GraphQL query**: at `issue-tools.ts:599-651`. Queries `repository(owner, name).issue(number)` — the **repository node**, not the project node. This is the structural difference from Paths A, B, E.

```graphql
repository(owner, repo) {
  issue(number: N) {
    id, number, title, body, state, stateReason, url, ...
    projectItems(first: 10) {
      nodes {
        id
        project { id number }
        fieldValues(first: 20) { nodes { ... ProjectV2ItemFieldSingleSelectValue ... } }
      }
    }
  }
}
```

**Project-item selection** at lines 676-680: walks `projectItems.nodes` and selects the item where `pi.project.number === projectNumber`. Falls back to `nodes[0]` if `projectNumber` is unconfigured.

**Workflow State extraction** at lines 692-709: inline loop over `projectItem.fieldValues.nodes` switching on `fv.field.name`. Same `__typename` and case-sensitive name match as Paths A/B.

**No pagination cap**: `get_issue` is bounded by `projectItems(first: 10)` — an issue can be a member of up to 10 projects without truncation. There is no 500-cap because there is no project-wide fetch.

**No issue-state filter**: `get_issue` returns the issue regardless of open/closed state. An issue with `state: "CLOSED"` and `Workflow State: "Plan in Review"` is fully visible.

### Path E: `list_groups`

**Tool registration**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts:1060-1291`

**GraphQL query**: at `relationship-tools.ts:1133-1171`. Same project-node entrypoint as Paths A and B. Same `fieldValues(first: 20)` with the `ProjectV2ItemFieldSingleSelectValue` inline fragment.

**Pagination**: `paginateConnection({ maxItems: 500 })` — same cap.

**Local `getFieldValue`**: at `relationship-tools.ts:134-144`, mechanically identical to Path A's helper, returns `string | undefined`.

**Filters**:
- `args.state` (default `"OPEN"`) — same client-side issue-state filter as Path A (relationship-tools.ts:1205-1210)
- `args.workflowState` — applied via `getFieldValue(item, "Workflow State") === args.workflowState` at lines 1212-1217
- Parent filter: `subIssuesSummary.total > 0` to find candidate parents

**Child workflow state lookup**: when `showChildren: true`, child states come from a pre-built `lookupMap` populated from the same item scan (lines 1173-1191), keyed by issue number. No second API call.

### Path F: `batch_update`

**Tool registration**: `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts:223-end`

This is primarily a **write** tool. It reads Workflow State only when `skipIfAtOrPast: true` is passed AND the operation includes a `workflow_state` field update.

**Initial resolve query** (`buildBatchResolveQuery`, `batch-tools.ts:46-80`): does NOT fetch field values. Reads only `issue.id` and `issue.projectItems.nodes[].id` to resolve node IDs. No Workflow State read.

**Field-value query** (`buildBatchFieldValueQuery`, `batch-tools.ts:134-164`): fires conditionally when `skipIfAtOrPast: true`. Queries each project item directly via `node(id: projectItemId) { ... on ProjectV2Item { fieldValues(first: 20) { ... } } }`. Uses GraphQL aliases (`m0:`, `m1:`, ...) to batch multiple items in one request.

**Field matching**: `fv.field?.name === "Workflow State"` at lines 414-418. Same `__typename` check as the other paths.

When `skipIfAtOrPast: false` (the default), no Workflow State read happens. The tool goes directly to `updateProjectV2ItemFieldValue` mutation.

### Tools that do NOT read Workflow State

- **`recent_activity`** (`activity-tools.ts`): reads from local flat-file activity log at `~/.ralph-hero/activity/` via `readActivity()` from `lib/activity.ts`. No GraphQL, no project field involvement.
- **`sync_plan_graph`** (`plan-graph-tools.ts:78-277`): reads only `blockedBy` edges via `repository.issue(number).blockedBy(first: 50)`. Does not read or write Workflow State.
- **`list_sub_issues`** (`relationship-tools.ts:236-329`): GraphQL fetches `id number title state` per child node with recursive `subIssues(first: 50)` nesting up to depth 3. The `state` field is GitHub issue open/closed state — not the project Workflow State.
- **`list_dependencies`** (`relationship-tools.ts:511-625`): same — `state` is issue open/closed; no project field values are queried.
- **`add_dependency`**, **`remove_dependency`**, **`add_sub_issue`**: relationship mutations; no Workflow State read.
- **`advance_issue`**: reads via `get_issue` (Path D) and writes via `save_issue`; doesn't have its own read path.

### Pagination mechanics

**File**: `plugin/ralph-hero/mcp-server/src/lib/pagination.ts`

**`paginateConnection<T>()`** at lines 56-99:
- Default `pageSize: 100`, default `maxItems: Infinity`
- `while (allNodes.length < maxItems)`: each iteration sets `first = Math.min(pageSize, maxItems - allNodes.length)`
- Records `totalCount` from the first page that includes it; preserved across pages
- Breaks early when `!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor`
- Truncation at `maxItems` is silent — no warning, no `console.warn`, no return-shape signal beyond `nodes.length < totalCount`

**`orderBy` argument**: absent in all `items()` connection queries — `DASHBOARD_ITEMS_QUERY` (`dashboard-fetch.ts:135`), the inline `list_issues` query (`issue-tools.ts:220`), and the `list_groups` query (`relationship-tools.ts:1138`). GitHub Projects V2 returns items in the project board's default order (creation/position), oldest-first as observed empirically.

**Caller settings**:
- Path A (`list_issues`): `{ first: 100, maxItems: 500 }` at `issue-tools.ts:264-266`
- Path B (`fetchDashboardItems`): `{ first: 100, maxItems: 500 }` at `dashboard-fetch.ts:280-282`
- Path E (`list_groups`): `{ first: 100, maxItems: 500 }` at `relationship-tools.ts:1170`

### Cache layers

**`FieldOptionCache`** at `plugin/ralph-hero/mcp-server/src/lib/cache.ts:118-278`:
- Internal: `Map<number, ProjectCacheData>` keyed by project number
- Per-project data: `projectId`, `fields: Map<string, Map<string, string>>` (field name → option name → option ID), `fieldIds: Map<string, string>`, `iterations: Map<string, IterationData[]>`
- `populate()` (lines 127-182) runs once per project from `fetchProjectForCache()`'s output
- **No TTL, no invalidation triggered by mutations.** Only explicit `clear()` empties the cache; persists for the lifetime of the MCP server process. Documented historical bug in [[2026-02-20-GH-0242-field-cache-poisoning]].

**`SessionCache`** at `cache.ts:14-88`:
- `Map<string, CacheEntry<unknown>>` with default `defaultTtlMs: 5 minutes`
- `queryKey()` static method (lines 82-88) builds keys of form `query:<normalized-query>:<json-sorted-vars>`
- **Only `fetchProjectForCache()` opts into caching** (`helpers.ts:101`, with explicit `cacheTtlMs: 10 * 60 * 1000`)
- `list_issues` and `fetchDashboardItems` GraphQL responses are **never cached** — both call `client.projectQuery(q, v)` without an options object
- `mutate()` and `projectMutate()` invoke `cache.invalidatePrefix("query:")` before executing (`github-client.ts:252-256`, `261-264`), clearing all `query:`-prefixed entries. Stable `issue-node-id:*` and `project-item-id:*` lookups are unaffected.

**`fetchProjectForCache`** at `helpers.ts:57-110`:
- GraphQL query at lines 62-92 fetches `projectV2(number: $number) { fields(first: 50) { ... ProjectV2FieldCommon, ProjectV2SingleSelectField, ProjectV2IterationField ... } }`
- `fields(first: 50)` is hardcoded — projects with more than 50 fields get truncated silently
- Owner-type fallback at lines 94-108: tries `user`, then `organization`; the first non-null `result[ownerType]?.projectV2` wins

**`ensureFieldCache`** at `helpers.ts:115-140`:
- Returns immediately if `fieldCache.isPopulated(projectNumber)` is `true`
- Otherwise calls `fetchProjectForCache()` then `fieldCache.populate()`
- Throws `Error("Project #${projectNumber} not found for owner \"${owner}\"")` at line 127 when the project doesn't resolve. `fetchDashboardItems` catches and converts to per-project warning; `list_issues` propagates via `toolError`.

### GitHub Actions workflows that touch Workflow State

Five workflows in `.github/workflows/` read or write the Workflow State field. All use `secrets.ROUTING_PAT` — separate from the MCP server's `RALPH_HERO_GITHUB_TOKEN` / `gh auth token`.

**1. `route-issues.yml`**:
- Triggers: `issues: [opened, labeled]`, `pull_request: [opened, ready_for_review]`, `workflow_call`
- Read: doesn't read Workflow State; reads issue/PR labels and `.ralph-routing.yml` rules
- Write: conditionally calls `updateProjectV2ItemFieldValue` for Workflow State if a matched rule has `action.workflowState` (typically `"Backlog"` for new issues)
- Implementation: `scripts/routing/route.js` via `@octokit/graphql`

**2. `sync-issue-state.yml`**:
- Triggers: `issues: [closed, reopened]`, `workflow_dispatch`
- Read: reads current Workflow State as idempotency check (lines 215-227); reads field/option IDs via `projectV2.fields(first: 50)` (lines 89-128)
- Write: maps `state_reason` to target state via `updateProjectV2ItemFieldValue` (lines 73-82, 238-250)
  - `completed` → `Done`
  - `reopened` → `Backlog`
  - other (`not_planned`, `duplicate`, unknown) → `Canceled`

**3. `sync-pr-merge.yml`**:
- Triggers: `pull_request: [closed]` with `if: github.event.pull_request.merged == true` job-level guard; `workflow_dispatch`
- Read: resolves linked issues via `closingIssuesReferences(first: 25)` with regex fallback on PR body (lines 65-91); reads each linked issue's current state via `fieldValueByName(name: "Workflow State")` (lines 222-235)
- Write: conditional advance — `In Progress → In Review`, `In Review → Done`, others skipped (lines 242-255)
- **Notable**: writes Workflow State to `Done` without closing the GitHub issue. The two fields can diverge: Workflow State = `Done`, issue state = `OPEN`.

**4. `sync-project-state.yml`**:
- Triggers: `workflow_dispatch` (with `content_node_id`, `workflow_state`, `originating_project_number` inputs); `repository_dispatch` event type `project-item-workflow-state-changed`
- Read: walks `node.projectItems(first: 20)` to find all projects the issue belongs to (`sync-project-state.js:122-146`)
- Write: writes the incoming Workflow State to every other project the issue belongs to (skips originating project, applies `SYNC_PROJECT_FILTER`, skips when already at target). Posts `<!-- cross-project-sync-audit -->` comment.
- Designed for cross-project sync via external webhook; no internal automation in this repo emits the `repository_dispatch`.

**5. `advance-parent.yml`**:
- Triggers: `issues: [closed]`, `workflow_dispatch`
- Read: `issue.parent.number`, `issue.subIssues(first: 50)` with state and stateReason
- Write: when ALL siblings are closed completed, sets parent's Workflow State to `Done` (lines 276-291), then runs `gh issue close <parent> --reason completed` (line 318)
- **Cascade chain**: closing the parent re-fires `sync-issue-state.yml`, which sets the grandparent's state and continues climbing. The deliberate cascade is named in the comment at line 317.

**State transitions across workflows**:

| Trigger | Resulting Workflow State |
|---|---|
| Issue opened/labeled (rule matches) | Rule-defined (typically `Backlog`) |
| Issue closed `state_reason=completed` | `Done` |
| Issue closed any other reason | `Canceled` |
| Issue reopened | `Backlog` |
| PR merged, linked issue at `In Progress` | `In Review` |
| PR merged, linked issue at `In Review` | `Done` |
| All children closed completed | Parent → `Done`, then cascade |

**Coordination with the MCP server**: workflows and `save_issue` both write the same field via the same `updateProjectV2ItemFieldValue` mutation, using different tokens. No coordination mechanism is documented. `sync-issue-state.yml` and `advance-parent.yml` perform read-then-write idempotency skips, which detect concurrent state on read but do not prevent concurrent writes.

**What workflows do not do**:
- No workflow fires when a project field is changed directly in the GitHub Projects UI (the `repository_dispatch` route exists but no internal automation emits the event)
- No workflow fires when an issue body or title is edited
- No workflow fires on `issues: [transferred]` or `issues: [deleted]`
- `sync-pr-merge.yml` does not handle PR closed without merge

### Empirical trace: #1102 through the live project

Conducted 2026-05-09 against project `Ralph Workflow` (project #3, node ID `PVT_kwHOBBH8E84BPSPe`).

**Live `items` connection size**:
- `totalCount: 734`

**Default ordering**: `items(first: 100)` returns `492, 607, 606, 605, 591, ...` as the first five items by issue number (older-first based on board position; no `orderBy` was passed in the query).

**Pagination walk** (100/page, no `maxItems` cap, until `hasNextPage: false`):

| Page | Items fetched | Total | hasNextPage | Contains #1102 |
|---|---|---|---|---|
| 1 | 100 | 100 | true | no |
| 2 | 100 | 200 | true | no |
| 3 | 100 | 300 | true | no |
| 4 | 100 | 400 | true | no |
| 5 | 100 | 500 | true | no |
| 6 | 100 | 600 | true | no |
| **7** | **100** | **700** | **true** | **yes** |
| 8 | 34 | 734 | false | no |

**Verdict**: #1102 sits at page 7 (positions 601-700). With `paginateConnection({ maxItems: 500 })`, Paths A/B/E stop after page 5 (item 500). Items 501-734 are silently truncated; #1102 is in that zone.

**Why `pipeline_dashboard.totalIssues = 292` ≠ 734**: the dashboard fetches 500 items, then `toDashboardItems` filters via `if (!r.content || r.content.__typename !== "Issue") continue;` (`dashboard-fetch.ts:88`). Of the 500 truncated items, 292 are `Issue` content (the rest are PRs and DraftIssues, dropped by the type filter).

**Field value present in GraphQL response for #1102** (verified at the start of this session via raw GraphQL):
- `field.name = "Workflow State"`, `name = "Plan in Review"`, `optionId = "f7883b5c"`
- `field.name = "Estimate"`, `name = "S"`

The matching code on Paths A/B/E would return `"Plan in Review"` correctly if the item reached it. The truncation happens upstream of the matching code.

**Effect on consumers** when an item is in the truncated zone:
- `list_issues(workflowState="Plan in Review")` returns no match
- `pipeline_dashboard()` shows `Plan in Review: count: 0`
- `next_actions()` does not surface the issue as a candidate
- `project_hygiene()` does not flag it as stale or stuck
- `capture_snapshot()` records 0 in the Plan in Review phase
- `list_groups()` does not include it as a parent or child
- `get_issue(number=1102)` returns the issue with `workflowState: "Plan in Review"` correctly (Path D bypasses pagination)
- `batch_update` with `skipIfAtOrPast: true` would read the per-item field correctly (Path F bypasses pagination)
- Direct `gh api graphql` from outside the MCP server returns the item correctly (no cap)

### Secondary asymmetry: `list_issues` defaults `state: "OPEN"`

Independent of pagination, `list_issues` defaults `state: "OPEN"` (line 274) and excludes closed issues at lines 274-279. Path B (dashboard family) has no such filter; closed issues with non-Done/Canceled workflow states still appear in the Plan in Review / In Review / In Progress buckets. Path D (`get_issue`) has no such filter either.

For a CLOSED issue with `Workflow State = "Plan in Review"` (a divergence pattern that workflows can produce — see `sync-pr-merge.yml` writing Done without closing, or manual edits):
- `list_issues` excludes it unless caller passes `state: "CLOSED"`
- Dashboard family includes it in the Plan in Review bucket
- `get_issue` returns it with `workflowState: "Plan in Review"`

## Code References

- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:60-505` — list_issues registration
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:217-263` — list_issues GraphQL
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:274-279` — state filter (OPEN default)
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:292-297` — workflowState positive filter
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:385-392` — excludeWorkflowStates filter
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:509-710` — get_issue
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:599-651` — get_issue GraphQL (repository.issue root)
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:692-709` — get_issue Workflow State extraction
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1899-1909` — issue-tools getFieldValue
- `plugin/ralph-hero/mcp-server/src/lib/dashboard-fetch.ts:62-72` — dashboard getFieldValue
- `plugin/ralph-hero/mcp-server/src/lib/dashboard-fetch.ts:79-126` — toDashboardItems
- `plugin/ralph-hero/mcp-server/src/lib/dashboard-fetch.ts:88` — Issue content-type filter
- `plugin/ralph-hero/mcp-server/src/lib/dashboard-fetch.ts:132-187` — DASHBOARD_ITEMS_QUERY
- `plugin/ralph-hero/mcp-server/src/lib/dashboard-fetch.ts:225-289` — fetchDashboardItems orchestration
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:228-284` — aggregateByPhase
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:243` — workflowState ?? "Unknown" routing
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts:250-263` — Done/Canceled time-window filter
- `plugin/ralph-hero/mcp-server/src/lib/pagination.ts:56-99` — paginateConnection mechanics
- `plugin/ralph-hero/mcp-server/src/lib/cache.ts:14-88` — SessionCache
- `plugin/ralph-hero/mcp-server/src/lib/cache.ts:118-278` — FieldOptionCache
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:57-110` — fetchProjectForCache
- `plugin/ralph-hero/mcp-server/src/lib/helpers.ts:115-140` — ensureFieldCache
- `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts:12-22` — STATE_ORDER
- `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts` — TERMINAL_STATES, LOCK_STATES, HUMAN_STATES, PARENT_GATE_STATES, WORKFLOW_STATE_TO_STATUS
- `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:96-250` — detectPipelinePosition (Path C consumer)
- `plugin/ralph-hero/mcp-server/src/lib/filter-profiles.ts:32-72` — filter profiles wrapping workflow states
- `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts:134-144` — list_groups getFieldValue
- `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts:1060-1291` — list_groups
- `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts:259-369` — detect_stream_positions
- `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts:283-575` — runDirections / next_actions / hello_directions / pick_actionable_issue
- `plugin/ralph-hero/mcp-server/src/tools/trends-tools.ts:37-118` — capture_snapshot
- `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts:42-189` — project_hygiene
- `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts:46-80` — batch_update resolve query (no field read)
- `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts:134-164` — batch_update field-value query (skipIfAtOrPast path)
- `plugin/ralph-hero/mcp-server/src/tools/batch-tools.ts:414-418` — batch_update field name match
- `plugin/ralph-hero/mcp-server/src/github-client.ts:223-244` — projectQuery cache option handling
- `plugin/ralph-hero/mcp-server/src/github-client.ts:252-264` — mutate / projectMutate cache invalidation
- `.github/workflows/route-issues.yml` — issue routing on open/label
- `.github/workflows/sync-issue-state.yml` — close/reopen → workflow state
- `.github/workflows/sync-pr-merge.yml` — PR merge → linked issue advance
- `.github/workflows/sync-project-state.yml` — cross-project sync
- `.github/workflows/advance-parent.yml` — child-completion cascade
- `scripts/routing/route.js` — route-issues implementation
- `.github/scripts/sync/sync-project-state.js` — cross-project sync implementation

## Architecture Documentation

**Two-write-surface model**: Workflow State is written by both the MCP server (via `save_issue` and `batch_update`) and the GitHub Actions workflows (`route-issues`, `sync-issue-state`, `sync-pr-merge`, `sync-project-state`, `advance-parent`). Both surfaces use `updateProjectV2ItemFieldValue` against the same field. The split is by trigger source: agent-driven mutations flow through the MCP server; event-driven mutations (issue close, PR merge, child completion) flow through workflows.

**Three read-architectures coexist** in the MCP server:
1. Project-wide page-walk with cap (Paths A/B/E)
2. Single-issue / per-item lookup (Paths D/F)
3. Caller-supplied items (Path C)

**The capped-fetch architecture** has the structural property that a project board with more than 500 items splits into a "visible window" (the first 500 in default order) and an "outside window" (items 501+). Default order is determined by GitHub Projects V2's internal item ordering — empirically this is creation/position-based and oldest-first. Recent items accumulate at the end of the connection.

**The state machine in `lib/workflow-states.ts`** defines:
- `STATE_ORDER`: 9 states (Backlog through Done) used as the canonical phase order
- `TERMINAL_STATES`: Done, Canceled — used for archive eligibility, lifetime filtering, and parent-completion gates
- `LOCK_STATES`: Research in Progress, Plan in Progress, In Progress — used for exclusive-claim guards in `save_issue`'s server-side lock check
- `PARENT_GATE_STATES`: Ready for Plan, Plan in Review, In Review, Done — when all children reach one of these, parent auto-advances
- `WORKFLOW_STATE_TO_STATUS`: maps Workflow State values to the standard `Todo / In Progress / Done` Status field; `save_issue` syncs Status as a side effect

**The `setup_project` field config** at `tools/project-tools.ts:38-75` defines the canonical 11 Workflow State options when a new project is created. The option `name` strings here are the source of truth that runtime extractors compare against.

**The filter-profile registry** at `lib/filter-profiles.ts:32-72` defines named filter sets that wrap Workflow State filters: `analyst-triage` (Backlog), `analyst-research` (Research Needed), `builder-active` (In Progress), `builder-planned` (Plan in Review), `integrator-merge` (In Review), `analyst-unblock` (Human Needed). These are applied as defaults; explicit caller-passed filters override profile defaults. Profiles eventually flow into Path A's filter pipeline.

## Historical Context (from thoughts/)

- [[2026-02-16-GH-0026-workflow-visualization-pipeline-dashboard]] — original design of `pipeline_dashboard`, predates per-stream and repo-grouped variants
- [[2026-02-19-GH-0115-archive-stats-pipeline-dashboard]] — adds `archive` block to dashboard output
- [[2026-02-22-GH-0330-per-stream-dashboard-status]] — extends dashboard with stream-aware aggregation
- [[2026-02-27-GH-0440-stamp-repository-dashboarditem]] — adds repository metadata to `DashboardItem`
- [[2026-02-27-GH-0441-repo-breakdowns-pipeline-dashboard]] — `groupBy: "repo"` variant
- [[2026-04-25-GH-0869-blockedby-dashboard-wiring]] — wires `blockedBy` through `DashboardItem`
- [[2026-03-04-GH-0520-dashboard-oversized-subissue-guard]] — health-warning suppression for oversized parent issues
- [[2026-02-20-GH-0145-multi-project-dashboard-fetching]] — adds multi-project loop to dashboard
- [[2026-02-21-GH-0146-cross-project-aggregation-health]] — health-aggregation for multi-project dashboards
- [[2026-03-14-hygiene-pipeline-multi-repo-aggregation]] — extends hygiene to share `fetchDashboardItems`
- [[2026-02-20-GH-0107-reason-filter-list-issues]] — adds `reason` filter
- [[2026-02-20-GH-0141-has-no-presence-filters-list-issues]] — adds `has` / `no` presence filters
- [[2026-02-20-GH-0142-exclude-negation-filters-list-issues]] — adds `excludeWorkflowStates` etc.
- [[2026-02-27-GH-0428-repo-filter-list-issues]] — adds `repoFilter` to list_issues
- [[2026-04-05-filter-sort-cross-reference-matrix]] — cross-tool filter behavior matrix
- [[2026-04-06-GH-0435-post-sprint-filter-sort-audit]] — quality audit for filter/sort
- [[2026-05-08-shorthand-tools-counts-and-filters]] — recent observation on shorthand-tool count semantics
- [[2026-05-07-GH-1129-list-issues-totalcount-misleading]] — most direct prior research, documents the same `list_issues` query and the meaning of its `totalCount` response field
- [[2026-02-20-GH-0242-field-cache-poisoning]] — documents `FieldOptionCache` invalidation behavior with no TTL
- [[2026-02-21-GH-0278-update-project-ignores-project-number]] — documents `fieldCache` calls historically ignoring `projectNumber` override
- [[2026-02-20-GH-0144-multi-project-config-cache]] — multi-project field cache extension
- [[2026-04-07-GH-0015-caching-strategy]] — broader caching research
- [[2026-02-20-GH-0175-actions-close-reopen-state-sync]] — design of `sync-issue-state.yml`
- [[2026-02-20-GH-0180-sync-across-projects-mcp-tool]] — design of `sync-project-state.yml`
- [[2026-02-20-GH-0181-cross-project-sync-webhook-handler]] — webhook design for `repository_dispatch` route
- [[2026-02-20-GH-0199-cross-project-sync-audit-trail]] — audit-trail pattern for cross-project sync
- [[2026-02-20-GH-0160-golden-project-template]] — origin of the 11 Workflow State option names
- [[2026-02-20-GH-0147-filter-profile-registry]] — design of `lib/filter-profiles.ts`

## Related Research

See `## Historical Context` above. Most directly comparable: GH-1129 (list_issues totalCount semantics) shares the same query path documented here. The cache series (GH-0242, GH-0144, GH-0278) documents adjacent behavior but does not cover the 500-item read cap.

## Open Questions

These are observations the documentation doesn't fully answer; they are recorded for future investigation, not for fixing here:

1. **Why is GitHub's default `items()` ordering oldest-first?** The empirical sequence (`492, 607, 606, 605, 591, ...`) is not pure issue-number-ascending. It appears to reflect the order in which items were added to the project board, which approximates creation order but is not strictly equal to it. No documentation in this repo describes the exact ordering contract.
2. **Are there cases where the GitHub Projects V2 `items()` connection paginates ordering inconsistently?** Not investigated. The empirical run was a single point-in-time snapshot.
3. **Does `archive_items` (in `project-management-tools.ts`) read Workflow State?** Not analyzed in this round; it appears in the project-management module but its read path was not documented here.
4. **Does the cross-repo dashboard variant (`groupBy: "repo"` from GH-0441) inherit the same 500-cap per-project, or aggregate differently?** Not analyzed in this round.
5. **What happens if the `Workflow State` field is renamed in the GitHub Projects UI?** All matching code uses the literal string `"Workflow State"`. A rename would silently cause `getFieldValue` to return undefined/null for every item across all paths.
6. **Is there test coverage for the 500-cap edge case?** Not analyzed in this round; existing tests in `mcp-server/src/__tests__/` were not enumerated.
