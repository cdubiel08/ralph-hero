---
date: 2026-05-09
status: draft
type: plan
github_issue: 1171
github_issues: [1171, 1172, 1173, 1174, 1175]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1171
  - https://github.com/cdubiel08/ralph-hero/issues/1172
  - https://github.com/cdubiel08/ralph-hero/issues/1173
  - https://github.com/cdubiel08/ralph-hero/issues/1174
  - https://github.com/cdubiel08/ralph-hero/issues/1175
primary_issue: 1171
tags: [pagination, list-issues, pipeline-dashboard, list-groups, mcp-server, truncation]
---

# Fix project-wide MCP read-path truncation (paginateConnection scan-until-full) - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-09-list-issues-and-dashboard-state-aggregation]] (research — primary evidence: documents the 6 read paths that share the 500-cap, the empirical #1102 walk through page 7, and the cross-path divergences)
- builds_on:: [[2026-05-07-GH-1129-list-issues-totalcount-misleading]] (plan — adjacent prior work on the same `list_issues` query, which fixed `totalCount` semantics but left pagination cap untouched)
- builds_on:: [[2026-05-09-GH-1160-cross-tool-count-consistency-tests]] (plan — adjacent prior work on cross-tool count consistency; explicitly opted out of touching `paginateConnection`)
- tensions:: None identified.

## Overview

5 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1171 | Add scan-until-full pagination option to paginateConnection helper | S |
| 2 | GH-1172 | Fix list_issues 500-item truncation by removing maxItems cap | XS |
| 3 | GH-1173 | Fix fetchDashboardItems 500-item truncation (affects 6 consumer tools) | S |
| 4 | GH-1174 | Fix list_groups 500-item truncation by removing maxItems cap | XS |
| 5 | GH-1175 | Add cross-tool consistency test: list_issues vs pipeline_dashboard see same items | XS |

**Why grouped**: All 5 issues share parent #1168 ("Project-wide MCP read paths silently truncate at 500 items via paginateConnection") and form a natural atomic unit. Phase 1 introduces the new pagination option in the shared helper. Phases 2-4 each switch one of the three downstream call sites to use it. Phase 5 wires a regression test that asserts cross-tool consistency. Splitting these across PRs would either (a) leave the helper unused/deprecated until later phases land or (b) force the 500-cap to remain on some paths while others are fixed — producing temporary inconsistency that the consistency test in Phase 5 would flag as a regression. Single-PR delivery keeps all read paths consistent end-to-end.

## Shared Constraints

These apply to every phase in this group:

1. **Preserve existing public behavior of `paginateConnection`** — callers that today pass only `pageSize` (or nothing) must observe byte-identical output. The `maxItems: Infinity` default is already the documented contract; the new option is purely additive.
2. **No `getFieldValue` normalization across paths** — research §"Detailed Findings" documents that `list_issues` returns `string | undefined`, dashboard returns `string | null`, and `list_groups` returns `string | undefined`. Each Phase 2-4 call site preserves its current local helper signature. Cross-path normalization is explicitly out of scope per the sub-issue bodies.
3. **No `state: "OPEN"` default change on `list_issues` / `list_groups`** — the closed-issue filter at `issue-tools.ts:274-279` and `relationship-tools.ts:1205-1210` is independent of pagination. Sub-issue bodies for #1172 and #1174 explicitly carve this out of scope. Phase 5's cross-tool test must accommodate this asymmetry (test only OPEN issues, or pass `state: "CLOSED"` on Path A).
4. **Tool descriptions must document the new fetch behavior** — every consumer tool whose call site changes (Phases 2, 3, 4) must update its `server.tool(name, "description", ...)` string to describe the post-fix semantics: full project scan, no silent truncation. Truncation warning behavior must be mentioned where applicable.
5. **No changes to `aggregateByPhase` time-window filter** — the 7-day Done/Canceled window at `dashboard.ts:250-263` is intentional and predates this work. Phase 3 must not touch it.
6. **GitHub Projects V2 default ordering is unchanged** — none of the GraphQL queries pass `orderBy`. The "default board order" (creation/position, oldest-first per empirical research) is the order items will be fetched. Newer items remain at the tail of the connection.
7. **Single tracked PR** — all 5 phases land together. Branch naming follows existing convention (`feature/GH-1171` or `feature/group-GH-1171`).
8. **Code style** — follow ESM convention (`.js` extensions on internal imports), TypeScript strict mode is the quality gate, vitest for tests. No new linter or formatter is added.

## Current State Analysis

Per the research at `thoughts/shared/research/2026-05-09-list-issues-and-dashboard-state-aggregation.md`:

- The shared `paginateConnection<T>` helper at `plugin/ralph-hero/mcp-server/src/lib/pagination.ts:46-100` accepts `{ pageSize, maxItems }`. When `allNodes.length === maxItems` AND `connection.pageInfo.hasNextPage === true`, the loop exits silently with no warning, no `truncated` return field, and no `console.warn`. The only observable signal is `nodes.length < totalCount`, which callers do not check today.
- Three project-wide call sites all pass `{ maxItems: 500 }`:
  - `issue-tools.ts:264-266` (`list_issues`)
  - `dashboard-fetch.ts:280-282` (`fetchDashboardItems`, consumed by 6 tools: `pipeline_dashboard`, `project_hygiene`, `next_actions`, `pick_actionable_issue`, `hello_directions`, `capture_snapshot`)
  - `relationship-tools.ts:1170` (`list_groups`)
- Empirically on project #3 (734 items, 2026-05-09): the first 5 items are `492, 607, 606, 605, 591, ...` (oldest-board-position first). Item #1102 sits at page 7 (positions 601-700) and is silently invisible to all three call sites.
- Precedent for scan-until-full pagination exists: `archive_items` uses an inline scan loop with `SCAN_CAP = 2000`, returning `hasMore` and `totalScanned` in its response (per research and `bulk-archive.test.ts:241-294`). The `archive_items` precedent does NOT use `paginateConnection`; it inlines the loop. This plan moves that pattern into the shared helper so all callers benefit.
- No `pagination.test.ts` file exists yet. The helper is exercised indirectly through `relationship-tools.test.ts:229-230` (just an import-string check) and `bulk-archive.test.ts:333-334` (assertion that `paginateConnection` is NOT used in `project-management-tools.ts`).

## Desired End State

After all 5 phases land:

### Verification

- [ ] `paginateConnection` exposes a new option (predicate or `scanUntilExhausted: true` flag) that fetches every node in the connection without a silent cap.
- [ ] When `maxItems` is hit AND `hasNextPage` is true, the helper surfaces a truncation signal (return-shape flag and/or `console.warn`) so silent data loss becomes visible.
- [ ] `list_issues(workflowState="Plan in Review")` on project #3 returns issue #1102 (positioned at #640 in the 734-item connection).
- [ ] `pipeline_dashboard()` on project #3 returns a non-zero `Plan in Review` count when #1102 (or any item beyond position 500) is in that state.
- [ ] All 6 dashboard consumers (`pipeline_dashboard`, `project_hygiene`, `next_actions`, `pick_actionable_issue`, `hello_directions`, `capture_snapshot`) surface items beyond position 500.
- [ ] `list_groups()` returns parent issues that sit beyond position 500 in default ordering.
- [ ] The cross-tool consistency test asserts `list_issues(workflowState=X, state="OPEN")` and `pipeline_dashboard()` (filtered to the X bucket, OPEN-only) return the same set of issue numbers when run against a mocked > 500-item project.
- [ ] All existing tests in `plugin/ralph-hero/mcp-server/src/__tests__/` still pass.

## What We're NOT Doing

- **Not touching the `getFieldValue` discrepancy** between paths (`string | undefined` vs `string | null`). Documented in research, deferred to a future ticket.
- **Not changing the `state: "OPEN"` default** on `list_issues` or `list_groups`. Closed-issue filter behavior remains as today; sub-issue bodies #1172 and #1174 explicitly carve this out.
- **Not removing the `aggregateByPhase` 7-day Done/Canceled time-window filter** at `dashboard.ts:250-263`.
- **Not adding `orderBy` to any `items()` connection query** — default board order remains.
- **Not refactoring `list_groups` to share `fetchDashboardItems`** (per #1174 out-of-scope).
- **Not refactoring deprecated tools (`pick_actionable_issue`, `hello_directions`)** — they continue to register and use the shared `fetchDashboardItems` post-fix.
- **Not migrating `archive_items` from its inline scan loop to the new helper option.** The `archive_items` precedent informs the design but `archive_items` itself remains as-is. `bulk-archive.test.ts:333-334` asserts `paginateConnection` is NOT imported there; that assertion remains valid.
- **Not changing GitHub Actions workflows** that read or write Workflow State.
- **Not adding `list_groups` ↔ `pipeline_dashboard` consistency assertions** to Phase 5 (per #1175 out-of-scope; their shapes differ).
- **Not fixing the `Workflow State` field-name rename failure mode** (research Open Question #5).

## Implementation Approach

The phases form a 5-step DAG: Phase 1 produces the new pagination option; Phases 2, 3, 4 each consume it independently at one call site; Phase 5 verifies cross-tool consistency once Phases 2 and 3 have landed.

Within a single PR, phases land in numeric order. Phase 1 must come first because Phases 2-4 depend on its API. Phase 5 is the regression-test guard and goes last.

API decision (Phase 1): expose **both** behaviors — `scanUntilExhausted: boolean` and an optional `until?: (node: T, pageNodes: T[], allNodes: T[]) => boolean` predicate. Both are additive options on `PaginateOptions`. Returning `truncated: boolean` on `PaginatedResponse<T>` makes the cap-without-exhaustion case observable to all callers regardless of which mode they use.

Decision rationale:
- Phases 2, 3, 4 use `scanUntilExhausted: true` (simpler, no per-item logic). Bounded by total project size (734 today, growing slowly).
- The `until` predicate is exposed but not consumed by Phases 2-4. It satisfies the sub-issue acceptance criterion ("predicate-based early stop"), preserves the `archive_items` precedent design space, and allows future call sites (e.g., a hypothetical "find first item matching X without scanning the whole project") without re-touching the helper.
- `truncated: boolean` is set when `maxItems !== Infinity && allNodes.length === maxItems && lastConnection.pageInfo.hasNextPage === true`. Default-cap callers (which currently exist as a single category — none — because all known callers either pass `maxItems: 500` or `maxItems: Infinity`) get a clean signal. A `console.warn` also fires on truncation so callers that ignore the return field still surface the issue.

Phase dependency annotations:
- Phase 1: foundation, no dependencies
- Phases 2, 3, 4: each depends on Phase 1; independent of each other
- Phase 5: depends on Phases 1, 2, 3 (does not require Phase 4 — `list_groups` is not exercised by the cross-tool test per #1175 scope)

---

## Phase 1: GH-1171 — Add scan-until-full pagination option to paginateConnection helper

- **depends_on**: null

### Overview

Extend `PaginateOptions` and `paginateConnection<T>` with a `scanUntilExhausted` flag, an optional `until` predicate, and a `truncated` return field plus `console.warn`. Add a new test file `pagination.test.ts` covering the new behaviors and the existing one.

### Tasks

#### Task 1.1: Extend PaginateOptions and PaginatedResponse types

- **files**: `plugin/ralph-hero/mcp-server/src/lib/pagination.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `PaginateOptions` extended with `scanUntilExhausted?: boolean` (default `false`) and `until?: (node: T, pageNodes: readonly T[], allNodes: readonly T[]) => boolean`
  - [ ] `PaginateOptions` becomes `PaginateOptions<T>` (generic) so `until` is typed against the node type — confirm callers compile after this signature change
  - [ ] `PaginatedResponse<T>` extended with `truncated: boolean` (always present on return; `false` when caller passed only `pageSize` or `scanUntilExhausted: true` with full exhaustion)
  - [ ] JSDoc updated to describe the new options and the `truncated` semantics (cap-without-exhaustion warning)

#### Task 1.2: Implement scan-until-full and predicate-based pagination in paginateConnection

- **files**: `plugin/ralph-hero/mcp-server/src/lib/pagination.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] When `scanUntilExhausted: true`, `maxItems` is effectively ignored — the loop runs until `connection.pageInfo.hasNextPage === false`. If the caller passes both `scanUntilExhausted: true` and `maxItems: N`, `scanUntilExhausted` wins (loop exhausts, `maxItems` is treated as advisory; no error)
  - [ ] When `until` is provided, after each page is fetched the loop iterates through `connection.nodes` and calls `until(node, pageNodes, allNodes)` for each node; the first node where `until` returns `false` triggers the loop to stop AFTER that page completes (not mid-page). Subsequent nodes from the same page are still appended to `allNodes`. Document this batching behavior in JSDoc.
  - [ ] Truncation detection: when `maxItems !== Infinity` AND `!options.scanUntilExhausted` AND `allNodes.length === maxItems` AND the just-fetched page had `pageInfo.hasNextPage === true`, the return shape sets `truncated: true` and the helper calls `console.warn` with a message that includes the connection path, `maxItems`, and the `totalCount` if available
  - [ ] When `scanUntilExhausted` is false and the connection exhausts naturally before hitting `maxItems`, `truncated: false` and no warning fires
  - [ ] When `scanUntilExhausted: true`, `truncated` is always `false` on return (full exhaustion is the contract)
  - [ ] When the `until` predicate returns `false` early, `truncated: false` (early-stop-by-predicate is not truncation, it's caller intent)
  - [ ] All existing call-site behavior preserved when callers pass only `{ first, maxItems: N }` without the new options — pages stop at `maxItems` exactly as today, but now with `truncated: true` if the connection had more

#### Task 1.3: Create pagination.test.ts with comprehensive coverage

- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/pagination.test.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] Test file imports `paginateConnection` and `PaginateOptions` from `../lib/pagination.js`
  - [ ] Helper `makeMockConnectionResponse(pages)` builds a vi.fn that returns successive pages, each shaped as `{ node: { items: { totalCount, pageInfo: { hasNextPage, endCursor }, nodes } } }`
  - [ ] Test "default behavior: paginates until exhaustion when no maxItems" — 3 pages of 100 + 1 page of 50, returns all 350 nodes, `truncated: false`, no `console.warn`
  - [ ] Test "respects pageSize" — caller passes `{ pageSize: 50 }`, helper requests `first: 50` per page (assert via `vi.fn().mock.calls[i][1].first === 50`)
  - [ ] Test "stops at maxItems and sets truncated: true when more pages exist" — pages = [100, 100, 100], call with `{ maxItems: 200 }`, asserts `nodes.length === 200`, `truncated: true`, `console.warn` was called once with a message containing the connection path
  - [ ] Test "stops at maxItems and sets truncated: false when connection exhausts at the cap" — pages = [100, 100], `hasNextPage: false` on the second page, call with `{ maxItems: 200 }`, asserts `nodes.length === 200`, `truncated: false`, no `console.warn`
  - [ ] Test "scanUntilExhausted: true ignores maxItems" — pages = [100, 100, 100, 100, 50], call with `{ maxItems: 200, scanUntilExhausted: true }`, asserts `nodes.length === 450`, `truncated: false`
  - [ ] Test "until predicate stops early after the page that triggered it" — pages = [{nodes: 1..100}, {nodes: 101..200}, {nodes: 201..300}], `until = (node) => node < 150`, asserts `nodes.length === 200` (page 1 + page 2 fully appended; page 3 not fetched), `truncated: false`
  - [ ] Test "until predicate that never returns false runs to exhaustion" — pages = [{nodes: 1..50}], `hasNextPage: false`, `until = () => true`, asserts `nodes.length === 50`, `truncated: false`
  - [ ] Test "totalCount is captured from first page and preserved" — page 1 returns `totalCount: 734`, subsequent pages omit `totalCount`, asserts response `totalCount === 734`
  - [ ] Test "throws when connectionPath is missing in response" — query returns `{}`, asserts thrown error message contains the path
  - [ ] Uses `vi.spyOn(console, 'warn').mockImplementation(() => {})` in `beforeEach` and restores in `afterEach` so the warning assertion is clean and doesn't pollute test output

#### Task 1.4: Update bulk-archive test assertion to remain valid

- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/bulk-archive.test.ts` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] Confirm the existing assertion at `bulk-archive.test.ts:333-334` (`expect(pmToolsSrc).not.toContain("paginateConnection")`) remains true after Phase 1 — Phase 1 only modifies `pagination.ts`, not `project-management-tools.ts`
  - [ ] No code change required; this is a verification-only task to ensure the precedent assertion survives

### Phase Success Criteria

#### Automated Verification:

- [ ] `npm run build` (from `plugin/ralph-hero/mcp-server/`) — no TypeScript errors
- [ ] `npx vitest run src/__tests__/pagination.test.ts` — all new tests pass
- [ ] `npx vitest run src/__tests__/bulk-archive.test.ts` — existing precedent assertions still pass
- [ ] `npm test` — full suite passes

#### Manual Verification:

- [ ] Read the JSDoc on `paginateConnection`; the new options and `truncated` field are documented clearly enough that a fresh caller can adopt either mode without reading the implementation.

**Creates for next phase**: New `PaginateOptions<T>` shape with `scanUntilExhausted` and `until`; new `PaginatedResponse<T>.truncated` field. Phases 2, 3, 4 will adopt `scanUntilExhausted: true` at their call sites.

---

## Phase 2: GH-1172 — Fix list_issues 500-item truncation by removing maxItems cap

- **depends_on**: [phase-1]

### Overview

Switch `list_issues` from `{ maxItems: 500 }` to `{ scanUntilExhausted: true }` so it sees every project item. Update tool description. Add a regression test.

### Tasks

#### Task 2.1: Switch list_issues to scanUntilExhausted

- **files**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] At `issue-tools.ts:264-266`, replace `{ maxItems: 500 }` with `{ scanUntilExhausted: true }`
  - [ ] Remove or update the inline comment "Fetch up to 500 then filter client-side" to reflect the new behavior (e.g., "Fetch all project items then filter client-side; full project scan")
  - [ ] No other lines in the function change — filter chain at lines 274-392 untouched

#### Task 2.2: Update list_issues tool description

- **files**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] The `server.tool("ralph_hero__list_issues", "...", ...)` description string includes a sentence stating that all project items are fetched (no silent cap) and that filters are applied client-side
  - [ ] Description still fits in a reasonable single block (≤ 5 lines of prose), readable by an LLM consumer without burying other filter docs

#### Task 2.3: Add regression test for items beyond position 500

- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/issue-tools.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] New test "list_issues surfaces items beyond position 500 (regression for GH-1172)" — mocks a `client.projectQuery` that returns 6 pages of 100 + 1 page of 34 (734 total items), with one item at position 640 having `Workflow State = "Plan in Review"`
  - [ ] Test calls `list_issues({ workflowState: "Plan in Review" })` and asserts the position-640 item appears in the returned items
  - [ ] Test asserts that the GraphQL execute function was called at least 7 times (proving exhaustion)
  - [ ] Test does NOT assert on `truncated` — Phase 2 uses `scanUntilExhausted: true`, so `truncated` is always `false`
  - [ ] Existing `list_issues` tests in this file all still pass

### Phase Success Criteria

#### Automated Verification:

- [ ] `npm run build` — no TypeScript errors
- [ ] `npx vitest run src/__tests__/issue-tools.test.ts` — all tests pass including the new regression
- [ ] `npm test` — full suite passes

#### Manual Verification:

- [ ] Against a real project with > 500 items (e.g., live project #3), `list_issues(workflowState="Plan in Review")` returns #1102 — verify with `npx vitest`-style integration if a live test rig exists, or by manual MCP tool invocation post-merge

**Creates for next phase**: None — Phase 3 is independent of this phase's changes.

---

## Phase 3: GH-1173 — Fix fetchDashboardItems 500-item truncation (affects 6 consumer tools)

- **depends_on**: [phase-1]

### Overview

Switch `fetchDashboardItems` from `{ maxItems: 500 }` to `{ scanUntilExhausted: true }`. Update tool descriptions on the 6 consumer tools. Add a regression test that exercises the dashboard path.

### Tasks

#### Task 3.1: Switch fetchDashboardItems to scanUntilExhausted

- **files**: `plugin/ralph-hero/mcp-server/src/lib/dashboard-fetch.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] At `dashboard-fetch.ts:280-282`, replace `{ maxItems: 500 }` with `{ scanUntilExhausted: true }`
  - [ ] No other lines in `fetchDashboardItems` change — multi-project loop at line 245, type filter at line 88, `toDashboardItems` at lines 79-126 all untouched
  - [ ] `aggregateByPhase` time-window filter at `dashboard.ts:250-263` is NOT touched (per shared constraint #5)

#### Task 3.2: Patch directions-tools.ts inline paginateConnection call

- **files**: `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] At `directions-tools.ts:389-395`, replace `{ maxItems: 500 }` with `{ scanUntilExhausted: true }` (this is a second project-wide pagination call that uses the dashboard query directly without going through `fetchDashboardItems` — captured here to keep the dashboard-family fix complete)
  - [ ] Confirm that the only `paginateConnection` calls in the codebase that still pass `{ maxItems: 500 }` are in `relationship-tools.ts:1170` (handled in Phase 4)

#### Task 3.3: Update tool descriptions on all 6 dashboard consumers

- **files**:
  - `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` (modify) — `pipeline_dashboard`
  - `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts` (modify) — `project_hygiene`
  - `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts` (modify) — `next_actions`, `pick_actionable_issue`, `hello_directions`
  - `plugin/ralph-hero/mcp-server/src/tools/trends-tools.ts` (modify) — `capture_snapshot`
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] Each `server.tool(...)` description for the 6 consumers includes a sentence stating that all project items are fetched (no silent cap)
  - [ ] Deprecated tools (`pick_actionable_issue`, `hello_directions`) keep their existing deprecation language and add the fetch-behavior note
  - [ ] Description bodies remain reasonably short (≤ 5 lines of prose each)

#### Task 3.4: Add regression test for dashboard items beyond position 500

- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts` (modify) OR a new `dashboard-fetch.test.ts`
- **tdd**: true
- **complexity**: medium
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] New test "fetchDashboardItems surfaces items beyond position 500 (regression for GH-1173)" — mocks a `client.projectQuery` returning 7+ pages where an issue at position 640 has `Workflow State = "Plan in Review"`
  - [ ] Test calls `fetchDashboardItems` (or `pipeline_dashboard` if simpler) and asserts the position-640 item appears in the `Plan in Review` bucket via `aggregateByPhase`
  - [ ] Test asserts the GraphQL mock was invoked enough times to exhaust the connection
  - [ ] Existing `dashboard.test.ts` tests still pass — including any test that mocks the 500-cap implicitly. Update those mocks to explicitly set `hasNextPage: false` on the last returned page so they do not regress on the truncation warning.

### Phase Success Criteria

#### Automated Verification:

- [ ] `npm run build` — no TypeScript errors
- [ ] `npx vitest run src/__tests__/dashboard.test.ts` — passes
- [ ] `npx vitest run src/__tests__/hygiene.test.ts` — passes (uses `fetchDashboardItems` indirectly)
- [ ] `npx vitest run src/__tests__/directions-tools.test.ts` — passes
- [ ] `npx vitest run src/__tests__/snapshots.test.ts` — passes (`capture_snapshot` consumer)
- [ ] `npm test` — full suite passes

#### Manual Verification:

- [ ] On a live project with > 500 items, `pipeline_dashboard()` returns a non-zero `Plan in Review` count when at least one item beyond position 500 is in that state.

**Creates for next phase**: None — Phase 4 is independent of this phase.

---

## Phase 4: GH-1174 — Fix list_groups 500-item truncation by removing maxItems cap

- **depends_on**: [phase-1]

### Overview

Switch `list_groups` from `{ maxItems: 500 }` to `{ scanUntilExhausted: true }`. Update tool description. Add regression test for parent issues beyond position 500.

### Tasks

#### Task 4.1: Switch list_groups to scanUntilExhausted

- **files**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] At `relationship-tools.ts:1170`, replace `{ maxItems: 500 }` with `{ scanUntilExhausted: true }`
  - [ ] No changes to the `lookupMap` builder at lines 1173-1191; it now naturally covers all items because the upstream fetch is exhaustive
  - [ ] Filter chain at lines 1205-1217 (state default `OPEN`, workflowState match) is untouched

#### Task 4.2: Update list_groups tool description

- **files**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] The `server.tool("ralph_hero__list_groups", "...", ...)` description includes a sentence stating that all project items are fetched (no silent cap) and that the internal lookupMap covers all items
  - [ ] Description body remains reasonably short (≤ 5 lines of prose)

#### Task 4.3: Add regression test for parents beyond position 500

- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/relationship-tools.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] New test "list_groups surfaces parents beyond position 500 (regression for GH-1174)" — mocks a `client.projectQuery` returning 7+ pages where a parent issue at position 640 has `subIssuesSummary.total > 0`
  - [ ] Test calls `list_groups()` and asserts the position-640 parent appears in the returned groups list
  - [ ] Test asserts the GraphQL mock was invoked enough times to exhaust the connection
  - [ ] Existing assertion at `relationship-tools.test.ts:229-230` (`expect(relationshipToolsSrc).toContain("paginateConnection")`) still passes
  - [ ] Existing `list_groups` tests still pass

### Phase Success Criteria

#### Automated Verification:

- [ ] `npm run build` — no TypeScript errors
- [ ] `npx vitest run src/__tests__/relationship-tools.test.ts` — all tests pass including the new regression
- [ ] `npm test` — full suite passes

#### Manual Verification:

- [ ] On a live project with > 500 items, `list_groups()` returns parent issues that sit beyond position 500.

**Creates for next phase**: Combined with Phase 2 and Phase 3, all three project-wide read paths now exhaust the connection. Phase 5 can verify cross-tool consistency.

---

## Phase 5: GH-1175 — Add cross-tool consistency test: list_issues vs pipeline_dashboard see same items

- **depends_on**: [phase-2, phase-3]

### Overview

Add a regression test that asserts `list_issues` and `pipeline_dashboard` return the same set of issue numbers per workflow state on a mocked > 500-item project. This is the regression guard requested in #1168's acceptance criteria.

### Tasks

#### Task 5.1: Create cross-tool consistency test file with shared mock fixture

- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/cross-tool-consistency.test.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [2.1, 3.1]
- **acceptance**:
  - [ ] New test file imports test fixtures it needs — including the `list_issues` tool registration helper and the `fetchDashboardItems`/`pipeline_dashboard` registration helper used by sibling tests
  - [ ] Defines a shared `MOCK_PROJECT_FIXTURE` constant: a 7-page response set (6 × 100 + 1 × 34 = 734 items) with items deliberately placed at positions 1, 100, 499, 500, 501, 600, 640, 700, 733 — with `Workflow State` values distributed across "Backlog", "Plan in Review", "In Progress", "Done", and a few items with no Workflow State (`null`/missing) to exercise the asymmetry
  - [ ] All fixture items have `state: "OPEN"` to sidestep the Path A vs Path B closed-issue asymmetry (per shared constraint #3 and #1175 research notes); the asymmetry is documented via a comment in the fixture but not asserted in this PR
  - [ ] At least one item with `Workflow State = "Plan in Review"` placed at position 640 (matches research evidence for #1102)

#### Task 5.2: Implement same-set assertion test

- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/cross-tool-consistency.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [5.1]
- **acceptance**:
  - [ ] Test "list_issues and pipeline_dashboard return the same OPEN-issue set per workflow state (post GH-1171/1172/1173)" iterates through the workflow states present in the fixture
  - [ ] For each workflow state X, gathers `setA = numbers from list_issues(workflowState=X, state="OPEN")` and `setB = numbers from pipeline_dashboard()` filtered to bucket X (and OPEN-only — skip items where `state !== "OPEN"`)
  - [ ] Asserts `setA` and `setB` are equal as Sets (using `expect(new Set(setA)).toEqual(new Set(setB))` or sorted-array comparison)
  - [ ] Boundary assertion: explicitly asserts that the position-640 item with `Workflow State = "Plan in Review"` is present in BOTH sets (this is the smoke signal that the truncation fix is wired end-to-end)

#### Task 5.3: Document the test's role in the test file header

- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/cross-tool-consistency.test.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [5.2]
- **acceptance**:
  - [ ] Top-of-file JSDoc block explains: the test is the regression guard for GH-1168/1171–1175; it would have failed before the fix; future drift between Path A and Path B will fail this test
  - [ ] Block notes the explicit out-of-scope items: `list_groups` consistency and closed-issue asymmetry

### Phase Success Criteria

#### Automated Verification:

- [ ] `npm run build` — no TypeScript errors
- [ ] `npx vitest run src/__tests__/cross-tool-consistency.test.ts` — all tests pass
- [ ] `npm test` — full suite passes
- [ ] Manual sanity: temporarily revert Phase 2 and Phase 3 changes locally and rerun this test — it should fail (the position-640 item disappears from one or both sets), confirming the test is a meaningful regression guard. Restore the Phase 2/3 changes before committing.

#### Manual Verification:

- [ ] Read the test file's JSDoc; a future maintainer can understand what the test is guarding without re-reading this plan.

**Creates for next phase**: None — final phase. The PR is complete.

---

## Integration Testing

- [ ] After all 5 phases land, run the full `npm test` suite from `plugin/ralph-hero/mcp-server/` and confirm zero failures
- [ ] Manual smoke test: invoke `ralph_hero__list_issues({ workflowState: "Plan in Review" })` and `ralph_hero__pipeline_dashboard()` against live project #3 and verify #1102 appears in both — `list_issues` items array and `pipeline_dashboard` Plan-in-Review bucket
- [ ] Manual smoke test: invoke `ralph_hero__list_groups()` against live project #3 and verify it returns groups whose primary issue sits at position > 500 in default ordering
- [ ] Spot-check `ralph_hero__capture_snapshot` writes a snapshot whose phase counts reflect the un-truncated project (sum of `wipByPhase` values should be closer to total OPEN issues than the pre-fix 292)
- [ ] Confirm `console.warn` truncation message is NOT emitted during normal operation post-fix (since all callers now use `scanUntilExhausted: true` or `Infinity`); verify by capturing stderr during `npm test`

## References

- Research: thoughts/shared/research/2026-05-09-list-issues-and-dashboard-state-aggregation.md
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1168
- Issues:
  - https://github.com/cdubiel08/ralph-hero/issues/1171
  - https://github.com/cdubiel08/ralph-hero/issues/1172
  - https://github.com/cdubiel08/ralph-hero/issues/1173
  - https://github.com/cdubiel08/ralph-hero/issues/1174
  - https://github.com/cdubiel08/ralph-hero/issues/1175
- Adjacent prior plans:
  - thoughts/shared/plans/2026-05-07-GH-1129-list-issues-totalcount-misleading.md
  - thoughts/shared/plans/2026-05-09-GH-1160-cross-tool-count-consistency-tests.md
- Precedent: `plugin/ralph-hero/mcp-server/src/__tests__/bulk-archive.test.ts:241-294` (archive_items scan-until-full pattern, GH-592)
- Code paths under change:
  - `plugin/ralph-hero/mcp-server/src/lib/pagination.ts:46-100`
  - `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:264-266`
  - `plugin/ralph-hero/mcp-server/src/lib/dashboard-fetch.ts:280-282`
  - `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts:389-395`
  - `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts:1170`
