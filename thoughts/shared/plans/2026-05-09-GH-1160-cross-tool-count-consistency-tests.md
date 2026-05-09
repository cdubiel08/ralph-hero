---
date: 2026-05-09
status: draft
type: plan
github_issue: 1160
github_issues: [1160]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1160
primary_issue: 1160
parent_plan: thoughts/shared/plans/2026-05-08-group-GH-1153-shorthand-tools-consistency-pass.md
tags: [discovery-tools, consistency, mcp-tools, testing, vitest, ralph-hero]
---

# Cross-tool Count Consistency Tests - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-08-group-GH-1153-shorthand-tools-consistency-pass]] (plan — parent group plan; this is Phase 7)
- builds_on:: [[2026-05-08-shorthand-tools-counts-and-filters]] (research — primary evidence; the audit matrices this test suite encodes)
- builds_on:: [[2026-05-07-GH-1129-list-issues-totalcount-misleading]] (research — defines the `filteredCount` semantics this suite asserts for `list_issues`)

## Overview

Single phase plan for GH-1160 (S, standalone). Adds a vitest integration test that constructs a synthetic `DashboardItem[]` fixture and exercises `next_actions`, `pipeline_dashboard`, `list_issues`, and `project_hygiene` against it. Asserts cross-tool count invariants from the 2026-05-08 audit so a future contributor changing one tool's count semantics sees an immediate failure with a descriptive error.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1160 | Cross-tool count consistency tests | S |

## Shared Constraints

Inherited from parent plan-of-plans (`2026-05-08-group-GH-1153-shorthand-tools-consistency-pass.md`):

- **Module system**: ESM with `"module": "NodeNext"`. All internal imports use `.js` extensions on TypeScript source.
- **Build/typecheck gate**: `npm run build` (`tsc`) is the primary code-quality gate; strict mode enabled.
- **Test runner**: vitest 4. Run from `plugin/ralph-hero/mcp-server/`.
- **Tool response shape**: Use `toolSuccess(...)` / `toolError(...)` from `src/types.ts`.
- **No backwards-compat shims**: deprecated fields/params are removed cleanly when they go.

Phase-specific constraints:

- **No live API calls**: every assertion runs against a single in-process `MockClient` that responds to `projectQuery` and `query` with deterministic fixture data.
- **Mock at the GraphQL boundary**: the test wires the four real registration functions (`registerDirectionsTools`, `registerDashboardTools`, `registerIssueTools`, `registerHygieneTools`) into a fresh `McpServer`. Do not mock at higher levels (no stubbed `runDirections`, no stubbed `buildDashboard`) — the test must exercise the real assembly.
- **Fixture parity across tools**: all four tools must see the same 12-item input — the same nodes returned by the mocked `DASHBOARD_ITEMS_QUERY` so the cross-tool comparison is meaningful.
- **Snapshot stability**: the fixture uses fixed ISO timestamps (no `Date.now()` in node bodies) so re-runs produce identical scoring and bucketing across days.

## Current State Analysis

What already exists, from prior phases of GH-1153 (verified at HEAD):

- **Phase 1** landed: `next_actions(audience="agent")` falls back to Backlog/null-state items when `ACTIONABLE_PHASES` is empty. Source: `plugin/ralph-hero/mcp-server/src/lib/directions.ts:846-867`.
- **Phase 2** landed: `next_actions` fetches open PRs internally via `fetchOpenPRs`; `openPRs` parameter removed from the schema. Source: `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts:540+`.
- **Phase 3** landed: `boardItems` is the unified raw-count field on `next_actions`, `pipeline_dashboard` (`DashboardData.boardItems`), and `project_hygiene` (`HygieneReport.boardItems`). Structural assertions live in `plugin/ralph-hero/mcp-server/src/__tests__/board-items-naming.test.ts`.
- **Phase 4** landed: thresholds centralized in `src/lib/thresholds.ts`; `archiveAgeDays` is the unified parameter name on `pipeline_dashboard` and `project_hygiene`. Tests in `plugin/ralph-hero/mcp-server/src/__tests__/thresholds.test.ts`.
- **Phase 6 has NOT landed**: `pick_actionable_issue` and `hello_directions` are still registered. The cross-tool test must therefore avoid asserting those tools are absent — that is Phase 6's contract, not Phase 7's.

What exists for the test infrastructure:

- **Mock client harness**: `plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts:31-268` already implements `rawIssue()`, `itemsResponse()`, `fieldCacheResponse()`, `createMockClient()`, `getTool()`, `parsePayload()`. Phase 7's new file reuses this exact harness pattern (no shared module — replicate the helpers in the new test file to keep the file self-contained, mirroring how `dashboard.test.ts` and `hygiene.test.ts` build their own item factories).
- **Field cache shape**: existing `fieldCacheResponse()` covers Workflow State, Priority, Estimate. The fixture used by Phase 7 must include all states the audit matrix references: `Backlog`, `Research Needed`, `Research in Progress`, `Ready for Plan`, `Plan in Progress`, `Plan in Review`, `In Progress`, `In Review`, `Done`, `Canceled`, `Human Needed`, plus null. Therefore the field-cache options must include those names too.
- **Tool entry points** (verified):
  - `ralph_hero__next_actions` from `registerDirectionsTools(server, client, fieldCache)` at `directions-tools.ts:474`.
  - `ralph_hero__pipeline_dashboard` from `registerDashboardTools(server, client, fieldCache)` at `dashboard-tools.ts:46`.
  - `ralph_hero__list_issues` from `registerIssueTools(server, client, fieldCache)` at `issue-tools.ts:54`.
  - `ralph_hero__project_hygiene` from `registerHygieneTools(server, client, fieldCache)` at `hygiene-tools.ts:36`.

## Desired End State

- A new test file `plugin/ralph-hero/mcp-server/src/__tests__/cross-tool-consistency.test.ts` that exercises all four tools against a single synthetic fixture and asserts the cross-tool invariants from the audit.
- `npm test src/__tests__/cross-tool-consistency.test.ts` passes locally and in CI across Node 18/20/22 (matrix in `.github/workflows/ci.yml`).
- `npm run build` continues to pass (no source changes — only a new test file).
- A future contributor renaming `boardItems` back to `totalCandidates`/`totalIssues` on any of the four tools, or silently changing one tool's filter rules, sees a failing test with a descriptive `expect(...)` message that names the tool and the invariant violated.

### Verification

- [ ] `npm test src/__tests__/cross-tool-consistency.test.ts` — all `it(...)` blocks pass
- [ ] `npm run build` — no TypeScript errors
- [ ] No live API calls (the test runs offline; no `gh auth token` env var required)
- [ ] Test names match the audit matrix entries from `2026-05-08-shorthand-tools-counts-and-filters.md`

### Key Discoveries

- `DashboardItem.workflowState` typing — `dashboard.ts:243` falls back to `"Unknown"` when `null`; the `DashboardItem` interface uses `string | null`. The fixture must produce items with no Workflow State field-value to land in the "Unknown" bucket (the `rawIssue()` helper already handles `workflowState: null` by skipping that field-value entry).
- `list_issues` queries the same project-board surface (`projectQuery` against `DASHBOARD_ITEMS_QUERY`-shaped data, not the GitHub repo issues API) — so the same mock that serves `next_actions` and `pipeline_dashboard` automatically serves `list_issues` with no extra wiring.
- `project_hygiene.staleItems` includes `null` workflow-state items (per `hygiene.ts:135-147`: the rule is "not in TERMINAL_STATES", and `null` passes that check). The Backlog-with-no-assignee item must be old enough (>14d) to land in `orphanedItems`.
- `next_actions` internal PR fetch (post-Phase-2) calls `client.query` with an `is:pr is:open` search — the mock must handle that path. The existing `directions-tools.test.ts:246-251` pattern (`isOpenPRsSearchQuery` predicate) is the reference.

## What We're NOT Doing

- Not asserting Phase 6's contract (deprecated tool removal). `pick_actionable_issue` and `hello_directions` remain registered until Phase 6 lands; this test does not reference them.
- Not testing `metrics_trends` / `capture_snapshot` / `recent_activity`. These read snapshot/activity surfaces, not the live project board, and the audit explicitly scoped them out of the cross-tool consistency contract.
- Not adding a shared `cross-tool-fixtures.ts` module. The fixture lives inline in the new test file; if a third consumer ever needs the same fixture, then extracting is appropriate. Until then, inline keeps the contract local.
- Not asserting numeric scoring values for individual directions. The test asserts shape and visibility, not score-magnitude correctness — that is `directions.test.ts`'s job.
- Not running the test against a live project in CI. CI matrix already runs unit tests; this slots into the same `npm test` invocation with no new infrastructure.

## Implementation Approach

Single phase, single file, single PR. Replicate the mock harness pattern from `directions-tools.test.ts`, build the 12-item fixture, register all four tools against the same mock client, call each tool's handler with default args, and assert invariants in distinct `it(...)` blocks named after the audit matrix entries.

The fixture is the load-bearing piece: it must cover every workflow-state branch mentioned in the audit's Matrix 2 (`State / condition` rows) so each invariant is meaningful rather than vacuously satisfied.

---

## Phase 1: Cross-tool count consistency tests
- **depends_on**: null

### Overview

Add `cross-tool-consistency.test.ts` that exercises `next_actions`, `pipeline_dashboard`, `list_issues`, and `project_hygiene` against a single 12-item fixture and asserts the cross-tool count and visibility invariants from the audit.

### Tasks

#### Task 1.1: Build the synthetic 12-item fixture
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/cross-tool-consistency.test.ts` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File `src/__tests__/cross-tool-consistency.test.ts` exists
  - [ ] Defines `FIXTURE_NOW` as a fixed ISO timestamp constant (e.g., `"2026-05-09T12:00:00Z"`) so test re-runs are deterministic
  - [ ] Defines a `FIXTURE_ITEMS` array containing exactly 12 raw-issue entries via the local `rawIssue()` helper, covering one item per row of the audit's Matrix 2:
    - `Backlog` (assignees=[], updatedAt 30 days before NOW so it qualifies for `orphanedItems`)
    - `Research Needed`
    - `Research in Progress` (updatedAt 1h before NOW — NOT lock-stale)
    - `Ready for Plan`
    - `Plan in Progress` (updatedAt 1h before NOW — NOT lock-stale)
    - `Plan in Review`
    - `In Progress` (updatedAt 1h before NOW — NOT lock-stale)
    - `In Review`
    - `Done` (closedAt 2 days before NOW — within `doneWindowDays=7`)
    - `Canceled` (closedAt 2 days before NOW — within `doneWindowDays=7`)
    - `Human Needed`
    - `null` workflow state (no Workflow State field-value, updatedAt 30 days before NOW so it qualifies for `staleItems`)
  - [ ] Each fixture entry has a unique issue number (e.g., 1001-1012) and a stable title containing its workflow state for debuggability
  - [ ] All non-Done/Canceled items have `assignees: []` to keep the fixture's `orphanedItems` shape predictable

#### Task 1.2: Replicate the mock-client harness
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/cross-tool-consistency.test.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Test file defines local `rawIssue(fix)`, `itemsResponse(nodes)`, `fieldCacheResponse(projectId)`, `isFieldCacheQuery(q)`, `isDashboardItemsQuery(q)`, `isOpenPRsSearchQuery(q)` helpers — same shape as `directions-tools.test.ts:48-183`
  - [ ] `fieldCacheResponse` Workflow State options include all 11 named states the fixture references plus the implicit null path (no field-value entry for null items)
  - [ ] `createMockClient(...)` returns a `GitHubClient`-shaped object with `projectQuery` routed by query-shape detection, `query` routed to return an empty `search.nodes` array for the open-PR fetch (no PR directions in this fixture)
  - [ ] `getTool(server, name)` and `parsePayload(result)` helpers are present (copy from `directions-tools.test.ts:283-306`)

#### Task 1.3: Assert all four tools agree on `boardItems`
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/cross-tool-consistency.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] `it("all four tools report boardItems = 12 against the same fixture")` block
  - [ ] Test registers `registerDirectionsTools`, `registerDashboardTools`, `registerIssueTools`, `registerHygieneTools` against a single `McpServer` + shared mock client + shared `FieldOptionCache`
  - [ ] Calls each tool's handler with default args (`{}` for `next_actions`, `{ format: "json" }` for `pipeline_dashboard`, `{}` for `list_issues`, `{}` for `project_hygiene`)
  - [ ] Asserts `nextActions.boardItems === 12`
  - [ ] Asserts `dashboard.boardItems === 12`
  - [ ] Asserts `hygiene.boardItems === 12`
  - [ ] `list_issues` does not return `boardItems` (only `filteredCount`); the test asserts `listIssues.filteredCount <= 12` to document the per-tool count contract

#### Task 1.4: Assert per-tool filtered counts are bounded by `boardItems`
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/cross-tool-consistency.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] `it("per-tool filtered counts are <= boardItems")` block
  - [ ] Asserts `nextActions.directions.length <= 12` AND `<= 3` (default `limit=3`)
  - [ ] Asserts `dashboard.phases.reduce((s, p) => s + p.count, 0) <= 12` (sum of phase counts <= boardItems; equality holds in this fixture because `doneWindowDays=7` includes the 2-day-old Done/Canceled items)
  - [ ] Asserts `listIssues.filteredCount <= 12`
  - [ ] Asserts `hygiene.summary.staleCount + hygiene.summary.orphanCount + hygiene.summary.archiveCandidateCount <= 12 + 12 + 12` (each category bounded by `boardItems`; categories overlap so summing is loose)

#### Task 1.5: Assert sum of `pipeline_dashboard.phases[].count` equals `boardItems` when window is wide
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/cross-tool-consistency.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] `it("sum of phase counts equals boardItems when doneWindowDays covers all Done/Canceled items")` block
  - [ ] Calls `pipeline_dashboard` with `doneWindowDays: 365` (deliberately large) so the Done/Canceled bucket is not window-clamped
  - [ ] Sums `phase.count` across all returned phases (named phases + the `Unknown` bucket)
  - [ ] Asserts the sum equals `boardItems` (12)
  - [ ] Includes a comment in the test explaining that `boardItems` is the invariant target — the sum-of-counts identity holds only when the window is wide enough

#### Task 1.6: Assert Backlog visibility — `next_actions` audience asymmetry
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/cross-tool-consistency.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] `it("Backlog items are visible to pipeline_dashboard, list_issues, and next_actions(audience=agent), but NOT next_actions(audience=human)")` block
  - [ ] Uses a reduced fixture: only Backlog items present (or filters to a Backlog-only subset by reusing `createMockClient` with a single-item `itemsByProject`) so the agent fallback fires
  - [ ] Asserts `next_actions(audience="agent")` returns at least 1 direction whose `issue.number` matches the Backlog fixture item
  - [ ] Asserts `next_actions(audience="human")` returns 0 directions for the same fixture
  - [ ] Asserts `pipeline_dashboard` reports the Backlog item in `phases[].issues[]`
  - [ ] Asserts `list_issues` returns the Backlog item in its `items[]`

#### Task 1.7: Assert null-workflow-state visibility across tools
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/cross-tool-consistency.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] `it("workflowState=null items are visible to pipeline_dashboard (Unknown bucket), list_issues, and project_hygiene.staleItems, but NOT next_actions(audience=human)")` block
  - [ ] Reuses the 12-item fixture
  - [ ] Asserts `pipeline_dashboard` includes a phase with state `"Unknown"` whose `issues[]` contains the null item
  - [ ] Asserts `list_issues` returns the null item in its `items[]`
  - [ ] Asserts `project_hygiene.staleItems` (when called with default `staleDays=7` and the null item's `updatedAt` is >7d old) contains the null item by issue number
  - [ ] Asserts `next_actions(audience="human")` does NOT return any direction whose `issue.number` matches the null item

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm test src/__tests__/cross-tool-consistency.test.ts` — all 5 `it(...)` blocks pass
- [ ] `npm run build` — no errors
- [ ] `npm test` — full suite still passes (no regression in any existing test file)

#### Manual Verification:
- [ ] Read each `it(...)` name aloud — they map 1:1 to acceptance-criteria entries from issue #1160's "Cross-tool Invariants" section
- [ ] Open the test file in an editor and confirm the fixture comment header references the audit document by relative path
- [ ] Confirm no `await client.query(...)` for the open-PR search returns non-empty (would imply a real fetch attempt — guard against the mock leaking)

**Creates for next phase**: not applicable (single-phase plan).

---

## Integration Testing

This entire phase IS the integration test layer for the GH-1153 group. No additional integration testing is required for the standalone phase. The test file itself enforces the cross-tool contract that the four discovery tools share.

## References

- Parent group plan: [thoughts/shared/plans/2026-05-08-group-GH-1153-shorthand-tools-consistency-pass.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-08-group-GH-1153-shorthand-tools-consistency-pass.md)
- Audit research: [thoughts/shared/research/2026-05-08-shorthand-tools-counts-and-filters.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-05-08-shorthand-tools-counts-and-filters.md)
- Issue: [#1160](https://github.com/cdubiel08/ralph-hero/issues/1160)
- Mock harness reference: [plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts)
- Existing structural assertions: [plugin/ralph-hero/mcp-server/src/__tests__/board-items-naming.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/board-items-naming.test.ts)
