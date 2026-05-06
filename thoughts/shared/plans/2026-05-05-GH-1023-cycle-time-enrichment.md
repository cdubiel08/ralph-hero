---
date: 2026-05-05
status: draft
type: plan
tags: [metrics, cycle-time, snapshots, transitions, observability]
github_issue: 1023
github_issues: [1023]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1023
primary_issue: 1023
parent_plan: thoughts/shared/plans/2026-05-05-GH-1019-product-performance-over-time.md
---

# Phase 2: Cycle-Time Enrichment Implementation Plan

## Prior Work

- builds_on:: [[2026-05-05-GH-1019-product-performance-over-time]]
- builds_on:: [[2026-05-05-GH-1022-snapshot-capture-jsonl]]

## Overview

Single-issue plan for GH-1023 — Phase 2 of the product-performance-over-time epic (#1019). Add a cycle-time rollup module that consumes `parseAllTransitions()` output, computes p50/p90 lead-time and per-phase dwell-time, and hydrates `Snapshot.cycleTime` in the capture pipeline introduced by Phase 1 (#1022).

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1023 | Phase 2: Cycle-time enrichment | S |

## Shared Constraints

Inherited from parent plan-of-plans (`2026-05-05-GH-1019-product-performance-over-time.md`):

- **Stack**: TypeScript strict mode, ESM (`"type": "module"`, `NodeNext`). All internal imports require `.js` extensions.
- **Test runner**: vitest. Tests live under `plugin/ralph-hero/mcp-server/src/__tests__/`.
- **Build/quality gates**: `npm run build` (tsc) and `npm test` from `plugin/ralph-hero/mcp-server/`.
- **No new dependencies**: pure TS + node stdlib only. No external time-series, percentile, or stats libraries.
- **Schema versioning**: `Snapshot.schemaVersion = 1` is fixed; new optional fields are additive.
- **Best-effort semantics**: Cycle-time data is only available for issues that already carry `<!-- ralph-transition: ... -->` or audit-format comments. Functions must tolerate empty inputs and partial coverage gracefully (return `null` rather than throw).
- **No mutation of existing public signatures**: `parseAllTransitions()`, `buildDashboard()`, `calculateMetrics()` keep their current contracts. Phase 2 adds new modules and extends `Snapshot` with optional fields only.
- **Multi-project partitioning**: All snapshot-related code is keyed by `(owner, projectNumber)`.
- **Pure-function preference**: `cycle-times.ts` is pure; only `snapshots.ts` performs I/O (file + GraphQL).

Feature-specific constraints:

- **Percentile algorithm**: Use linear-interpolation nearest-rank percentile over a sorted array. With `n < 2` samples, return the single value for both p50 and p90; with `n = 0`, return `null`.
- **Hour granularity**: All cycle-time outputs are `number` of hours (float). Convert ISO timestamps via `Date.parse()` and divide by `3_600_000`. `now` is passed in as a `number` (epoch ms) for testability.
- **Out-of-order tolerance**: A list of `TransitionRecord` may not be sorted by `at`. Always sort by `at` ascending before deriving dwell intervals.
- **Open-ended dwell**: For an issue's terminal state (no subsequent transition), dwell uses `closedAt` if present, else `now`. This is documented in `cycle-times.ts` JSDoc.

## Current State Analysis

Phase 1 (#1022, currently `Plan in Review`) introduces:

- `plugin/ralph-hero/mcp-server/src/lib/snapshots.ts` — `Snapshot` type, `appendSnapshot()`, `readSnapshots()`, `snapshotPath()`, and a `toSnapshot()` factory used by the capture tool.
- `plugin/ralph-hero/mcp-server/src/lib/dashboard-fetch.ts` — `fetchDashboardItems(client, projectNumber?)` shared between `dashboard-tools.ts` and `trends-tools.ts`.
- `plugin/ralph-hero/mcp-server/src/tools/trends-tools.ts` — `ralph_hero__capture_snapshot` MCP tool that calls `fetchDashboardItems`, `buildDashboard()`, `calculateMetrics()`, then `toSnapshot()` + `appendSnapshot()`.

Existing infrastructure Phase 2 builds on:

- `plugin/ralph-hero/mcp-server/src/lib/transition-comments.ts` (`parseAllTransitions(commentBody, commentCreatedAt)`) — returns `TransitionRecord[]` with `{ from, to, command, at }`. Already battle-tested by `transition-comments.test.ts`.
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:626` — example of `comments(last: N)` GraphQL fragment for fetching issue comments via the repository client.
- `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts` — `DashboardItem` exposes `closedAt`, `updatedAt`, and the workflow phase, so a Done-in-window filter is available without extra fetches.

`Snapshot.cycleTime` is declared optional (`CycleTimeRollup | undefined`) in Phase 1's type, but Phase 1 leaves it unset. Phase 2 fills the slot.

### Key Discoveries

- `parseAllTransitions()` already deduplicates HTML and audit formats — Phase 2 does not need to handle that concern.
- `TransitionRecord.at` is ISO 8601; `Date.parse()` returns `NaN` for malformed strings — guard with `Number.isFinite()` before arithmetic.
- The "phase" key in `perPhaseDwellHours` should be the `from` state of each transition: it represents how long the issue sat in that state before moving to the next.
- For lead-time, the canonical definition for this codebase is "first transition's `at` -> last transition's `at`" per issue. If an issue has only one transition, lead-time is undefined for that issue and it is excluded from the percentile sample.
- Comment fetching for Done-in-window items is N additional GraphQL calls. Worst case is small (~10/window) per the parent plan's performance section, so a sequential loop with `await` is acceptable; no need for pagination beyond `comments(last: 100)`.

## Desired End State

After this phase:

- `plugin/ralph-hero/mcp-server/src/lib/cycle-times.ts` exports `TransitionedIssue`, `CycleTimeRollup`, and `rollupCycleTimes(records, now)` — pure, deterministic, fully unit-tested.
- `plugin/ralph-hero/mcp-server/src/__tests__/cycle-times.test.ts` covers: empty input, single-issue with two transitions, multi-issue with mixed phase counts, out-of-order timestamps, malformed `at` strings, single-transition issues (excluded from lead-time), open-ended terminal states.
- `plugin/ralph-hero/mcp-server/src/lib/snapshots.ts` gains `fetchTransitionedIssues(client, doneItems)` — fetches comments for the Done-in-window items, runs `parseAllTransitions()` per comment, returns `TransitionedIssue[]`. Issues without recognizable transitions are silently skipped.
- `plugin/ralph-hero/mcp-server/src/tools/trends-tools.ts` (Phase 1's `capture_snapshot`) calls `fetchTransitionedIssues` then `rollupCycleTimes` and passes the result through `toSnapshot()` so `Snapshot.cycleTime` is hydrated when at least one Done item has transitions; `null` otherwise.
- All existing tests still pass; new tests pass; `npm run build` succeeds with strict mode.

### Verification

- [ ] `npm test -- src/__tests__/cycle-times.test.ts` — all assertions pass (empty, single, multi, out-of-order, malformed, single-transition).
- [ ] `npm test -- src/__tests__/transition-comments.test.ts` — unchanged, still green.
- [ ] `npm test -- src/__tests__/trends-tools.test.ts` — passes including a new assertion that `cycleTime` is populated when a fixture client returns a comment containing a transition.
- [ ] `npm test` — full suite green on the developer machine.
- [ ] `npm run build` — clean.
- [ ] Live capture against project 3: `cycleTime.sampleSize > 0` and `perPhaseDwellHours["In Progress"]` is plausible (positive, < 30 * 24).

## What We're NOT Doing

- Persisting cycle-time data outside the `Snapshot` row — the JSONL line is the only store.
- Backfilling cycle-time for historical Done items beyond what `parseAllTransitions()` recovers from existing comments.
- Adding a new MCP tool — `capture_snapshot` from Phase 1 is the only entry point in this phase.
- Computing throughput, WIP age, or any non-cycle-time metric (covered by Phase 1 + Phase 3).
- Changing `parseAllTransitions()` signature or behavior.
- Fetching all comments per issue for full history — only `comments(last: 100)` per issue, sufficient for transition coverage.

## Implementation Approach

Three tasks executed in dependency order in a single PR:

1. **Task 1 (2.0)**: Pure cycle-time rollup module + test suite — no I/O, fully deterministic.
2. **Task 2 (2.1)**: GraphQL helper in `snapshots.ts` to fetch comments and apply `parseAllTransitions()`.
3. **Task 3 (2.2)**: Wire into `capture_snapshot` so `Snapshot.cycleTime` is populated end-to-end.

Tasks 1 and 2 are independent of each other (1 is pure logic, 2 is pure I/O glue) but both must precede Task 3. The dispatcher may run them in parallel if it chooses; otherwise sequential is fine.

---

## Phase 1: Cycle-time enrichment (GH-1023)
- **depends_on**: [GH-1022]

### Overview

Implement `cycle-times.ts` rollup logic, add a `fetchTransitionedIssues` helper to `snapshots.ts`, and wire the rollup into `capture_snapshot` so `Snapshot.cycleTime` is populated when transition data is available.

### Tasks

#### Task 1.1: Pure cycle-time rollup module
- **files**: `plugin/ralph-hero/mcp-server/src/lib/cycle-times.ts` (create), `plugin/ralph-hero/mcp-server/src/__tests__/cycle-times.test.ts` (create), `plugin/ralph-hero/mcp-server/src/lib/transition-comments.ts` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Exports `TransitionedIssue` interface: `{ issueNumber: number; transitions: TransitionRecord[]; closedAt?: string | null }`.
  - [ ] Exports `CycleTimeRollup` interface: `{ leadTimeP50Hours: number | null; leadTimeP90Hours: number | null; perPhaseDwellHours: Record<string, { p50: number; p90: number; n: number }>; sampleSize: number }`.
  - [ ] Exports `rollupCycleTimes(records: TransitionedIssue[], now: number): CycleTimeRollup`.
  - [ ] Lead-time per issue = `(last transition.at - first transition.at)` in hours; issues with `< 2` transitions are excluded from the lead-time sample (`sampleSize` counts only included issues).
  - [ ] Per-phase dwell = consecutive `(transition[i+1].at - transition[i].at)` keyed by `transition[i].from`. The terminal state's dwell uses `closedAt ?? now` as the upper bound when the issue has not transitioned out; if `closedAt` is missing AND the issue is open, the open-ended terminal dwell is excluded.
  - [ ] Inputs are sorted by `at` ascending defensively before computation; original arrays are not mutated.
  - [ ] Malformed `at` strings (`Number.isFinite(Date.parse(at)) === false`) cause that transition to be skipped without throwing.
  - [ ] Percentile uses linear-interpolation nearest-rank: `p50` = median, `p90` = 90th percentile. With `n = 1`, both equal the single value. With `n = 0`, the field is omitted from `perPhaseDwellHours` entirely (not present), and lead-time fields are `null`.
  - [ ] `sampleSize` is the count of issues contributing at least one valid lead-time interval.
  - [ ] Empty `records` -> `{ leadTimeP50Hours: null, leadTimeP90Hours: null, perPhaseDwellHours: {}, sampleSize: 0 }`.
  - [ ] Test cases (each its own `it()` block):
    - empty input
    - single issue with two transitions (Plan in Progress -> In Progress -> Done)
    - multi-issue with mixed phase counts (3 issues, varying state visits)
    - out-of-order timestamps (verify defensive sort)
    - malformed `at` (one bad row, others valid -> bad row skipped, others counted)
    - single-transition issue (excluded from lead-time, contributes to no dwell)
    - terminal-state dwell with `closedAt` set vs unset
    - percentile correctness against hand-computed expected values

#### Task 1.2: `fetchTransitionedIssues` helper in snapshots.ts
- **files**: `plugin/ralph-hero/mcp-server/src/lib/snapshots.ts` (modify), `plugin/ralph-hero/mcp-server/src/lib/transition-comments.ts` (read), `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` (read for GraphQL pattern)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Exports `async function fetchTransitionedIssues(client: GitHubClient, doneItems: DashboardItem[]): Promise<TransitionedIssue[]>`.
  - [ ] For each Done item, runs a GraphQL query to fetch `comments(last: 100)` with `body`, `createdAt` fields. Uses `client.query()` (repo endpoint, not project).
  - [ ] Calls `parseAllTransitions(comment.body, comment.createdAt)` per comment, flattens results per issue.
  - [ ] Returns `{ issueNumber, transitions, closedAt }` records ONLY for issues with at least one transition. Issues with zero transitions are silently dropped.
  - [ ] Errors fetching a single issue's comments are caught and logged via `console.warn` only — must not throw or abort the whole batch (best-effort).
  - [ ] Concurrency: sequential `await` is acceptable for v1 (Done-in-window count is small per parent plan's perf section). No `Promise.all` parallelization — keeps GraphQL rate-limit predictable.
  - [ ] Test additions in `src/__tests__/snapshots.test.ts` (extend existing file, do not create new):
    - mock client returns comments containing one HTML transition comment -> helper returns one `TransitionedIssue` with one transition.
    - mock client returns comments with no transitions -> helper returns `[]`.
    - mock client throws on one issue, succeeds on another -> helper returns the successful one and logs warning.

#### Task 1.3: Wire cycle-time rollup into capture_snapshot
- **files**: `plugin/ralph-hero/mcp-server/src/tools/trends-tools.ts` (modify), `plugin/ralph-hero/mcp-server/src/lib/snapshots.ts` (modify — extend `toSnapshot()` to accept `cycleTime?: CycleTimeRollup`), `plugin/ralph-hero/mcp-server/src/__tests__/trends-tools.test.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [ ] `capture_snapshot` handler, after building dashboard + metrics, filters `dashboardItems` to Done-in-window (existing `closedAt` within `windowDays`), calls `fetchTransitionedIssues`, then `rollupCycleTimes(records, Date.now())`.
  - [ ] If `rollup.sampleSize === 0` AND `Object.keys(perPhaseDwellHours).length === 0`, omit `cycleTime` (leave undefined). Otherwise pass through `toSnapshot()` so `Snapshot.cycleTime` is set.
  - [ ] `toSnapshot()` updated to accept optional `cycleTime` and place it on the returned `Snapshot` row.
  - [ ] `trends-tools.test.ts` adds a fixture-driven case: mock client returns one Done item whose comments yield two transitions; resulting JSONL row contains `cycleTime.sampleSize === 1`, `leadTimeP50Hours` matches the expected interval.
  - [ ] Existing `trends-tools.test.ts` cases still pass (when no Done items have transitions, `cycleTime` is absent from the row).

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm test` (from `plugin/ralph-hero/mcp-server/`) — all suites green, including new `cycle-times.test.ts` and the extended `snapshots.test.ts` + `trends-tools.test.ts`.
- [ ] `npm run build` — strict TypeScript compilation clean.
- [ ] `transition-comments.test.ts` — unchanged, still passes.

#### Manual Verification:
- [ ] Running `ralph_hero__capture_snapshot` against project 3 writes a JSONL row whose `cycleTime` field contains a non-zero `sampleSize` (assuming at least one recently-Done issue has transition comments).
- [ ] `cycleTime.perPhaseDwellHours["In Progress"]` is plausible (positive, less than `windowDays * 24`).
- [ ] No new warnings in stderr beyond the documented "skipped issue" notices for items without transitions.

**Creates for next phase**: `Snapshot.cycleTime` is now reliably hydrated, so Phase 3 (#1024, `metrics_trends`) can plot `leadTimeP50Hours` as a tracked metric without further fetches.

---

## Integration Testing

- [ ] Unit suites listed in Phase Success Criteria pass on Node 18, 20, 22 (CI matrix).
- [ ] Manual end-to-end: capture a snapshot pre-Phase-2, capture another post-Phase-2 — diff the JSONL rows and confirm only `cycleTime` differs, all other Phase 1 fields are unchanged.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1023
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1019
- Parent plan: [thoughts/shared/plans/2026-05-05-GH-1019-product-performance-over-time.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-05-GH-1019-product-performance-over-time.md) (Phase 2 task table)
- Phase 1 (blocker, currently `Plan in Review`): https://github.com/cdubiel08/ralph-hero/issues/1022
- Existing module: `plugin/ralph-hero/mcp-server/src/lib/transition-comments.ts` (`parseAllTransitions`)
- Comment-fetch GraphQL precedent: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:626`
- Dashboard items shape: `plugin/ralph-hero/mcp-server/src/lib/dashboard.ts`
