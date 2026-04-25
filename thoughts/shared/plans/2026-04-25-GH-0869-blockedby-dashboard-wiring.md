---
date: 2026-04-25
status: draft
type: plan
github_issue: 869
github_issues: [869]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/869
primary_issue: 869
tags: [dashboard, blockedBy, graphql, mcp-server, health-warnings]
---

# Fix blockedBy hardcoded to [] in toDashboardItems() — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-25-GH-0869-blockedby-dashboard-wiring]]
- builds_on:: [[2026-04-25-GH-0571-status-report-audit]]
- tensions:: None identified.

## Overview

Single-issue plan with one implementation phase wiring real `blockedBy` data into the dashboard.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-869 | Fix blockedBy hardcoded to [] in toDashboardItems() — wire real dependency data | S |

## Shared Constraints

- **Module system**: ESM with `"type": "module"`. All internal imports require `.js` extensions.
- **TypeScript strict mode**: No linter; `tsc` is the primary code quality gate.
- **Test framework**: vitest. Run via `npm test` (alias for `vitest run`) from `plugin/ralph-hero/mcp-server/`.
- **GraphQL field naming**: Use `trackedIssues` (issues this issue tracks = its blockers). The reverse, `trackedInIssues`, is "issues that track this one" (= issues it blocks). Do NOT confuse these.
- **State mapping for blockedBy entries**:
  - GitHub `state === "CLOSED"` → `workflowState: "Done"` (terminal — health check filters it out)
  - GitHub `state === "OPEN"` → `workflowState: null` (non-terminal — health check fires "blocked" warning)
- **Pattern reuse**: Mirror the `trackedIssues` mapping used in `get_issue` at `issue-tools.ts:906-910` and `pick_actionable_issue` at `issue-tools.ts:1805-1810`.
- **No additional API calls**: Inline `trackedIssues` in the existing `DASHBOARD_ITEMS_QUERY`. Zero round-trips added.
- **Limit**: Use `first: 10` for `trackedIssues` in the dashboard query (sufficient for blocker visibility; an issue with >10 blockers is anomalous).
- **Octokit reserved keys**: Never use `query`, `method`, or `url` as GraphQL variable names.

## Current State Analysis

`toDashboardItems()` at [`dashboard-tools.ts:195`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts#L195) hardcodes `blockedBy: []` with the comment "blockedBy requires separate queries; omit for now". This causes the "blocked" health warning in [`dashboard.ts:397-407`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L397-L407) to never fire — the iteration over `issue.blockedBy` is correct but always operates on an empty array.

The `DASHBOARD_ITEMS_QUERY` already contains a partial scaffold: `RawDashboardItem.content.trackedInIssues` is declared at [`dashboard-tools.ts:133`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts#L133), but (a) the field is never selected in the GraphQL query, and (b) it is the WRONG direction — `trackedInIssues` represents issues that this issue blocks (= "blocking"), not its blockers. The correct field for blockers is `trackedIssues`.

The `get_issue` tool already maps `trackedIssues.nodes` → `blockedBy` at [`issue-tools.ts:906-910`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L906-L910). This plan replicates that pattern inline in the dashboard query.

The health check filter at [`dashboard.ts:397-399`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts#L397-L399) considers a blocker "open" when its `workflowState !== "Done"` AND `workflowState !== "Canceled"`. Mapping `state === "OPEN"` → `workflowState: null` correctly preserves "open" semantics; mapping `state === "CLOSED"` → `workflowState: "Done"` correctly excludes terminal blockers from the warning.

## Desired End State

### Verification
- [ ] `DashboardItem.blockedBy` returns the actual blocking issue numbers (sourced from `trackedIssues`) for issues that have blockers, not always `[]`.
- [ ] The "blocked" health warning fires when an issue has at least one open blocker.
- [ ] At least one new unit test in `dashboard.test.ts` asserts the `toDashboardItems()` mapping from `trackedIssues.nodes` to `blockedBy`.
- [ ] All existing tests still pass (no regressions in 1280+ existing assertions).
- [ ] `tsc` build succeeds with no new errors.
- [ ] No additional GraphQL round-trips per dashboard load.

## What We're NOT Doing

- **Wiring `trackedInIssues` to a `blocking` field**: The reverse direction (issues blocked by this one) is out of scope. Could be a follow-up.
- **Switching to native `blockedBy` GraphQL field**: That would require post-processing per-issue queries. Not needed unless trackedIssues proves insufficient (see Risk #1).
- **Changing the health-check logic in `dashboard.ts`**: The existing logic at lines 397-407 is correct and tested.
- **Adding new health warning types**: Only the existing "blocked" warning needs to start firing.
- **Modifying `RawDashboardItem.content.trackedInIssues`**: Leaving the existing scaffold field in place to avoid scope creep; it was never wired and the new code uses `trackedIssues` instead.
- **Performance/payload-size benchmarking**: Adding `first: 10` per item is a small payload increase; no regression test needed unless one is requested.
- **Updates to formatters (`formatMarkdown`, `formatAscii`)**: They already render the existing `blockedBy` correctly via the health warning section.

## Implementation Approach

Single-phase atomic change touching three regions of `dashboard-tools.ts` and one new test in `dashboard.test.ts`:

1. Extend the GraphQL `DASHBOARD_ITEMS_QUERY` Issue fragment to select `trackedIssues(first: 10) { nodes { number state } }`.
2. Extend the `RawDashboardItem.content` TypeScript type to include the optional `trackedIssues` field.
3. Replace the hardcoded `blockedBy: []` line in `toDashboardItems()` with a mapping over `r.content.trackedIssues?.nodes`.
4. Add a unit test in the existing `describe("toDashboardItems", ...)` block that asserts the mapping (CLOSED → Done, OPEN → null).

After implementation, validate by running `npm run build` and `npm test` from `plugin/ralph-hero/mcp-server/`.

---

## Phase 1: GH-869 — Wire trackedIssues to blockedBy in toDashboardItems

- **depends_on**: null

### Overview

Replace the hardcoded `blockedBy: []` in `toDashboardItems()` with real data sourced from the `trackedIssues` GraphQL field. This makes the "blocked" health warning in `pipeline_dashboard` actually fire.

### Tasks

#### Task 1.1: Add trackedIssues to DASHBOARD_ITEMS_QUERY Issue fragment
- **files**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] In the `... on Issue` fragment of `DASHBOARD_ITEMS_QUERY` (currently lines 225-235 of `dashboard-tools.ts`), add the field selection `trackedIssues(first: 10) { nodes { number state } }` after the existing `subIssues { totalCount }` line.
  - [ ] The added field uses `first: 10` (not 20 — dashboard purpose differs from `get_issue`).
  - [ ] No other lines in the GraphQL query string are changed.
  - [ ] `tsc` build succeeds (the GraphQL string is type-checked only via `RawDashboardItem`).

#### Task 1.2: Extend RawDashboardItem.content type with trackedIssues field
- **files**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] In the `RawDashboardItem` interface (line 122-148), inside `content`, add a new optional field: `trackedIssues?: { nodes: Array<{ number: number; state: string }> };`.
  - [ ] Place the new field directly above or below the existing `trackedInIssues` field (line 133) for visual proximity. Either ordering is acceptable.
  - [ ] Do NOT remove the existing `trackedInIssues` field — it is unused but in scope-out for this change.
  - [ ] `tsc` build succeeds with no new errors.

#### Task 1.3: Replace hardcoded blockedBy with trackedIssues mapping
- **files**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] In `toDashboardItems()` at line 195, replace the line `blockedBy: [], // blockedBy requires separate queries; omit for now` with a mapping that converts `r.content.trackedIssues?.nodes` to the `blockedBy` shape.
  - [ ] The mapping logic is exactly:
    ```typescript
    blockedBy: r.content.trackedIssues?.nodes?.map((n) => ({
      number: n.number,
      workflowState: n.state === "CLOSED" ? "Done" : null,
    })) ?? [],
    ```
  - [ ] When `trackedIssues` is undefined/missing on the raw item, the resulting `blockedBy` is `[]` (preserves backward compatibility for existing tests that don't supply the field).
  - [ ] When `trackedIssues.nodes` is empty, `blockedBy` is `[]`.
  - [ ] `tsc` build succeeds.
  - [ ] Existing dashboard tests still pass (the `makeRawItem` helper does not supply `trackedIssues`, so all current tests continue to receive `blockedBy: []`).

#### Task 1.4: Add unit test asserting trackedIssues → blockedBy mapping
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] In the existing `describe("toDashboardItems", () => { ... })` block (around line 1315), add at least one new `it()` test case named to clearly describe the mapping (e.g., `"maps trackedIssues nodes to blockedBy with state-to-workflowState conversion"`).
  - [ ] The test constructs a `RawDashboardItem` via `makeRawItem({ content: { ...makeRawItem().content, trackedIssues: { nodes: [{ number: 42, state: "OPEN" }, { number: 99, state: "CLOSED" }] } } })`.
  - [ ] After calling `toDashboardItems(raw)`, assert:
    - [ ] `items[0].blockedBy` has length 2.
    - [ ] `items[0].blockedBy[0]` equals `{ number: 42, workflowState: null }`.
    - [ ] `items[0].blockedBy[1]` equals `{ number: 99, workflowState: "Done" }`.
  - [ ] Add a second `it()` test asserting that when `trackedIssues` is omitted from the raw item, `blockedBy` is `[]` (backward compatibility).
  - [ ] Run `npx vitest run src/__tests__/dashboard.test.ts` — all tests in the file pass, including the new ones.

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` (from `plugin/ralph-hero/mcp-server/`) — no TypeScript errors.
- [ ] `npm test` (from `plugin/ralph-hero/mcp-server/`) — entire vitest suite passes including the new test cases in `dashboard.test.ts`.
- [ ] `npx vitest run src/__tests__/dashboard.test.ts` passes specifically.

#### Manual Verification:
- [ ] Diff review confirms `dashboard-tools.ts` has exactly three touch points (query string, type, mapping line) and no incidental changes.
- [ ] Diff review confirms `dashboard.test.ts` adds two new test cases inside the `toDashboardItems` describe block and changes nothing else.
- [ ] (Optional, if a live MCP environment is convenient) Invoke `ralph_hero__pipeline_dashboard` against the configured project. If any active issue has `add_dependency`-set blockers visible via `trackedIssues`, the response's `health.warnings` array now contains at least one `type: "blocked"` entry referencing it.

**Creates for next phase**: N/A (final phase).

---

## Integration Testing

- [ ] After implementation, the "blocked" health warning path in `dashboard.ts:400-407` is exercised end-to-end via at least one unit-test data flow (existing tests at `dashboard.test.ts:429-489` already cover the consumer side; this phase ensures the producer side now emits real data).
- [ ] No regression in existing 1280+ assertions in `dashboard.test.ts` and `dashboard-group-by.test.ts`.

## References

- Research: [thoughts/shared/research/2026-04-25-GH-0869-blockedby-dashboard-wiring.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-25-GH-0869-blockedby-dashboard-wiring.md)
- Issue: https://github.com/cdubiel08/ralph-hero/issues/869
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/847
- Source PR: https://github.com/cdubiel08/ralph-hero/pull/844
- Related (sibling, closed): https://github.com/cdubiel08/ralph-hero/issues/868
- Related (sibling, open): https://github.com/cdubiel08/ralph-hero/issues/870
- Pattern reference (`trackedIssues` mapping in `get_issue`): [plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:622-624](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L622-L624) and [issue-tools.ts:906-910](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L906-L910)

## Risk Notes

1. **Risk: `trackedIssues` may not include native `blockedBy` (dependency-graph) relationships set via `add_dependency`.** Source: research doc lines 161, 187. Mitigation: during/after implementation, sanity-check on a real project that an issue with a known `blockedBy` dependency surfaces in the dashboard's "blocked" warning. If it does NOT, the fallback is a post-processing pass using batched GraphQL aliases over active issues only — this would be a follow-up plan, not an in-scope addition here.
2. **Risk: GraphQL response payload size increases.** Adding `first: 10` per item across up to 500 items adds at most 5000 nested node references to the response. Acceptable; no known timeout concerns. No added round-trips.
3. **Risk: `state === "CLOSED"` collapses Done and Canceled to "Done".** Both are filtered identically by the health check (`b.workflowState !== "Done" && b.workflowState !== "Canceled"`), so the simplification is functionally correct for this use case.
