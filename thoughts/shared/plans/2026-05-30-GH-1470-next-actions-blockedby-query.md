---
date: 2026-05-30
status: draft
type: plan
tags: [next-actions, dependencies, dashboard, picker, autonomy]
github_issue: 1470
github_issues: [1470]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1470
primary_issue: 1470
estimate: S
---

# GH-1470 — Fetch the real `blockedBy` dependency connection in `DASHBOARD_ITEMS_QUERY`

## Prior Work

- builds_on:: [[thoughts/shared/research/2026-05-30-ralph-triage-autonomy-gaps.md]] — Gap A (P0), the verified root-cause analysis this plan implements verbatim. Line refs in that doc are current as of git_commit `ec9c8f2d`.
- tensions:: none. This is the data-plane half of the dependency-edge track (A → D → C); Gap B (GH issue, `issue-tools.ts`) ships in parallel and does not touch these files.

## Overview

The autonomous picker (`next_actions` / directions) is blind to `add_dependency` (blockedBy) edges. `DASHBOARD_ITEMS_QUERY` populates `DashboardItem.blockedBy` from the **`trackedIssues`** task-list connection — not the **`blockedBy`** dependency connection that `add_dependency`/`addBlockedBy` actually writes to. As a result `hasOpenBlockers()` always sees `blockedBy === []`, the agent Backlog-fallback pushes dependency-blocked items as rank-1 directions, and humans must park them in Human Needed to stop the churn (observed: landcrawler-ai #512/#515 flip-flopped Backlog↔Human Needed across six caretaker passes).

This plan switches the data source: the GraphQL Issue fragment will additionally select the real `blockedBy(first: 20)` connection, the raw→`DashboardItem` mapper will read from it instead of `trackedIssues`, and the agent Backlog-fallback loop gains a defensive `hasOpenBlockers` skip so a blocked item never enters the scored set. `hasOpenBlockers()` itself is unchanged — it simply now receives real edges. The `DashboardItem.blockedBy` field shape (`Array<{ number; workflowState: string | null }>`) is preserved, so no downstream consumer changes.

## Current State Analysis

The fetch path lives in `mcp-server/src/lib/dashboard-fetch.ts`:

- `RawDashboardItem.content` (`:33-48`) declares `trackedIssues?: { nodes: Array<{ number; state }> }` but no `blockedBy` field.
- `toDashboardItems` (`:107-110`) maps `DashboardItem.blockedBy` from `r.content.trackedIssues?.nodes`, collapsing `state` to `n.state === "CLOSED" ? "Done" : null`.
- `DASHBOARD_ITEMS_QUERY` (`:152`) selects `trackedIssues(first: 10) { nodes { number state } }` inside the `... on Issue` fragment, and `trackedInIssues(first: 3)` at `:153` (for `parentNumber`/`parentState`).

The picker lives in `mcp-server/src/lib/directions.ts`:

- `hasOpenBlockers(item)` (`:309-313`) returns true when any `blockedBy` entry has `workflowState !== "Done" && !== "Canceled"`. Correct logic; starved of data today.
- Agent Backlog-fallback loop (`:853-867`) runs only when `config.audience === "agent" && scored.length === 0`; it pushes every Backlog / null-state item into `scored` with **no blocker check**.
- Step-2 filter (`:869-880`) drops blocked items via `hasOpenBlockers` unless that would empty the set, in which case it surfaces blocked candidates anyway (`:874-877`) — the "surface blocked anyway" fallthrough.

`DashboardItem.blockedBy` is typed in `mcp-server/src/lib/dashboard.ts` as `Array<{ number: number; workflowState: string | null }>` — unchanged by this plan.

`list_dependencies` (`mcp-server/src/tools/relationship-tools.ts:574`) already reads the real `blockedBy(first:50)` connection — proof the field exists and is distinct from `trackedIssues`.

### Key Discoveries

- `dashboard-fetch.ts:107-110` — `blockedBy` is mapped from `trackedIssues`, the wrong connection.
- `dashboard-fetch.ts:152` — query selects only `trackedIssues(first: 10)` inside `... on Issue`.
- `dashboard-fetch.ts:153` — `trackedInIssues(first: 3)` feeds `parentNumber`/`parentState`; must stay untouched.
- `directions.ts:309-313` — `hasOpenBlockers` treats both `Done` and `Canceled` as non-blocking; the `CLOSED → "Done"` collapse keeps it correct (a Canceled blocker is also CLOSED on GitHub, so it maps to `"Done"` and is correctly non-blocking).
- `directions.ts:853-867` — the agent Backlog-fallback pushes items with no blocker filter.
- `directions.ts:869-880` — step-2 filter cannot drop what the data plane never populated.
- `dashboard.ts` — `DashboardItem.blockedBy` shape is `Array<{ number; workflowState: string | null }>`; no type change needed.
- `relationship-tools.ts:574` — `list_dependencies` uses the same `blockedBy` connection we're adding.
- `directions.test.ts` has a `makeItem(overrides)` factory that defaults `blockedBy: []`; new tests pass a `blockedBy` override.

## Desired End State

1. `DASHBOARD_ITEMS_QUERY` selects the issue `blockedBy(first: 20) { nodes { number state } }` dependency connection (same one `list_dependencies` reads), in addition to `trackedIssues`.
2. `RawDashboardItem.content` declares `blockedBy?: { nodes: Array<{ number: number; state: string }> }`.
3. `toDashboardItems` maps `DashboardItem.blockedBy` from `r.content.blockedBy?.nodes` (not `trackedIssues`), keeping `state === "CLOSED" ? "Done" : null`.
4. `parentNumber`/`parentState` continue to derive from `trackedInIssues` — unaffected.
5. The agent Backlog-fallback loop `continue`s on `hasOpenBlockers(item)`, so a Backlog issue dependency-blocked by an OPEN issue never enters `scored`; when it is the sole candidate the picker returns `[]`.
6. Unit tests cover: a real `blockedBy` edge mapping into `DashboardItem.blockedBy`; the agent fallback excluding a blocked-by-OPEN item (`toHaveLength(0)`) and surfacing it once the blocker is Done; a CLOSED blocker not suppressing the item.

### Verification

- `npx vitest run src/__tests__/directions.test.ts` — new fallback exclusion + surface-once-Done tests pass.
- `npx vitest run src/__tests__/dashboard-fetch.test.ts` — new mapper test asserts `toDashboardItems` reads `content.blockedBy` into `DashboardItem.blockedBy`.
- `npm test` — full suite green (no fixture relied on `trackedIssues` populating `blockedBy`; verify and update any that do).
- `npm run build` — TypeScript strict mode passes with the new `RawDashboardItem.blockedBy` field.
- Manual: against a project where issue X is `add_dependency`-blocked by an OPEN issue Y, `next_actions` (agent audience) does not surface X; closing Y surfaces X on the next call.

## What We're NOT Doing

- Not changing `hasOpenBlockers()` logic (`directions.ts:309-313`) — it is correct; it was only starved of data.
- Not removing or repurposing the `trackedIssues` selection — `parentNumber`/`parentState` derive from `trackedInIssues`, a different connection, and `trackedIssues` may still be consumed elsewhere; leave it in the query.
- Not touching `DashboardItem.blockedBy`'s TypeScript shape — it already matches.
- Not implementing Gap B (`save_issue` close → terminal column), Gap D (triage.md rules), or Gap C (`watch-blockers` mode). Those are separate issues on the same research doc.
- Not adding a Canceled-specific `workflowState` value — both Done and Canceled are CLOSED on GitHub and both are non-blocking, so `CLOSED → "Done"` is sufficient.

## Implementation Approach

Two phases, two files, no cross-phase file overlap. Phase 1 is the data-plane fix in `dashboard-fetch.ts` (query + raw shape + mapper) plus its mapper test. Phase 2 is the defense-in-depth picker fallback skip in `directions.ts` plus its picker tests. Phase 2 depends on Phase 1 only conceptually (it relies on real `blockedBy` data to be meaningful at runtime); the code change in `directions.ts` is independent of the `dashboard-fetch.ts` change and the tests for each are self-contained. Ship both together in one PR.

## Phase 1: Fetch and map the real `blockedBy` connection

depends_on: null

### Overview

Add the `blockedBy(first: 20)` selection to the Issue fragment, declare it on `RawDashboardItem`, and switch the `toDashboardItems` mapper to read from it. Add a focused mapper test.

### Changes Required

#### 1. GraphQL query + raw shape + mapper
**File**: `mcp-server/src/lib/dashboard-fetch.ts`
**Changes**:
- In `DASHBOARD_ITEMS_QUERY` `... on Issue` fragment (near `:152`), add `blockedBy(first: 20) { nodes { number state } }` alongside the existing `trackedIssues(first: 10)` selection. Leave `trackedInIssues(first: 3)` (`:153`) untouched.
- In `RawDashboardItem.content` (`:33-48`), add `blockedBy?: { nodes: Array<{ number: number; state: string }> };`.
- In `toDashboardItems` (`:107-110`), change the `blockedBy` mapping to read `r.content.blockedBy?.nodes?.map((n) => ({ number: n.number, workflowState: n.state === "CLOSED" ? "Done" : null })) ?? []`. Leave `parentNumber`/`parentState` (`:111-112`, from `trackedInIssues`) unchanged.

#### 2. Mapper unit test
**File**: `mcp-server/src/__tests__/dashboard-fetch.test.ts` (create if absent)
**Changes**:
- Construct a `RawDashboardItem[]` with one Issue whose `content.blockedBy.nodes` contains an OPEN blocker (`state: "OPEN"`) and a CLOSED blocker (`state: "CLOSED"`); assert `toDashboardItems(...)[0].blockedBy` equals `[{ number, workflowState: null }, { number, workflowState: "Done" }]`.
- Assert an item with `content.blockedBy` absent yields `blockedBy: []`.
- Assert `parentNumber`/`parentState` still derive from `trackedInIssues` (a separate raw item with `trackedInIssues` set, no `blockedBy`).

### Success Criteria

#### Automated Verification
- [ ] `npx vitest run src/__tests__/dashboard-fetch.test.ts` passes from `mcp-server/`.
- [ ] `npm run build` exits 0 (new `RawDashboardItem.blockedBy` field type-checks).
- [ ] `grep -n "blockedBy(first" mcp-server/src/lib/dashboard-fetch.ts` shows the new query selection.
- [ ] `grep -n "content.blockedBy" mcp-server/src/lib/dashboard-fetch.ts` shows the mapper reads the new connection.

#### Manual Verification
- [ ] Against a live project: an issue `add_dependency`-blocked by an OPEN issue returns a non-empty `blockedBy` with a `workflowState: null` entry from `pipeline_dashboard` / `capture_snapshot`.

## Phase 2: Defense-in-depth — skip blocked items in the agent Backlog-fallback

depends_on: [phase-1]

### Overview

In the agent Backlog-fallback loop, `continue` when `hasOpenBlockers(item)` is true so a dependency-blocked Backlog item never enters `scored`. With Phase 1 supplying real edges, this makes the picker return `[]` rather than surfacing a blocked sole candidate. Add picker tests.

### Changes Required

#### 1. Fallback loop skip
**File**: `mcp-server/src/lib/directions.ts`
**Changes**:
- In the agent Backlog-fallback loop (`:853-867`), after the existing `workflowState` guard and before scoring, add `if (hasOpenBlockers(item)) continue;`. This keeps blocked Backlog items out of `scored`; the step-2 "surface blocked anyway" fallthrough (`:874-877`) then cannot re-surface them, and the picker returns `[]` when a blocked item is the sole candidate. Do not change `hasOpenBlockers` (`:309-313`) or the step-2 filter logic.

#### 2. Picker unit tests
**File**: `mcp-server/src/__tests__/directions.test.ts`
**Changes**:
- Test: agent audience, a single Backlog item with `blockedBy: [{ number: 904, workflowState: null }]` (OPEN blocker), no actionable-phase items → result `toHaveLength(0)`.
- Test: same item but `blockedBy: [{ number: 904, workflowState: "Done" }]` → the item IS surfaced (length 1).
- Test: agent audience, Backlog item with a CLOSED blocker (`workflowState: "Done"`) is not suppressed (regression guard for the `CLOSED → "Done"` mapping).

### Success Criteria

#### Automated Verification
- [ ] `npx vitest run src/__tests__/directions.test.ts` passes, including the three new tests.
- [ ] `npx vitest run -t "blocked"` matches the new fallback tests and they pass.
- [ ] `npm test` — full suite green from `mcp-server/`.
- [ ] `npm run build` exits 0.
- [ ] `grep -n "hasOpenBlockers(item)) continue" mcp-server/src/lib/directions.ts` shows the new guard inside the fallback loop.

#### Manual Verification
- [ ] Against a live project (agent audience): a Backlog issue blocked by an OPEN dependency is NOT the rank-1 direction; closing the blocker makes it eligible again on the next `next_actions` call.

## Testing Strategy

### Unit Tests
- `dashboard-fetch.test.ts` (Phase 1): mapper reads `content.blockedBy`, collapses CLOSED→"Done"/OPEN→null, handles absent connection, preserves `parentNumber`/`parentState` from `trackedInIssues`.
- `directions.test.ts` (Phase 2): agent fallback excludes blocked-by-OPEN (`toHaveLength(0)`), surfaces once blocker Done, CLOSED blocker non-suppressing.

### Integration Tests
- `npm test` full suite acts as the integration gate; confirm no existing fixture depended on `trackedIssues` populating `blockedBy` (search and update if any).

### Manual Testing Steps
1. On a test project, `add_dependency` to block issue X by OPEN issue Y.
2. Call `next_actions` (agent audience) — X must not be surfaced as rank-1; if X is the sole candidate, the result is empty.
3. Close Y. Call `next_actions` again — X is now eligible.
4. Confirm `pipeline_dashboard` and `capture_snapshot` show X's real `blockedBy`.

## Migration Notes

No schema migration. The change is additive at the GraphQL layer (one extra connection selection) and swaps the in-memory mapping source. Existing snapshot JSONL rows are unaffected — `DashboardItem.blockedBy`'s shape is unchanged, only its population source. No env vars, no config, no rollback flag needed; revert is a clean git revert of the two files.

## References

- Research: `thoughts/shared/research/2026-05-30-ralph-triage-autonomy-gaps.md` § Gap A (P0)
- `mcp-server/src/lib/dashboard-fetch.ts` — query, raw shape, mapper
- `mcp-server/src/lib/directions.ts` — `hasOpenBlockers`, agent Backlog-fallback, step-2 filter
- `mcp-server/src/lib/dashboard.ts` — `DashboardItem.blockedBy` type
- `mcp-server/src/tools/relationship-tools.ts:574` — `list_dependencies` reads the same `blockedBy` connection
- `mcp-server/src/__tests__/directions.test.ts` — `makeItem` factory
