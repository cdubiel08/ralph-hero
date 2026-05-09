---
date: 2026-05-09
status: draft
type: plan
github_issue: 1121
github_issues: [1121]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1121
primary_issue: 1121
parent_plan: thoughts/shared/plans/2026-05-07-GH-1118-test-coverage-hardening-epic.md
tags: [testing, coverage, mcp-server, vitest]
---

# GH-1121 — Direct Unit Tests for Untested mcp-server Lib Modules

## Prior Work

- builds_on:: [[2026-05-07-GH-1118-test-coverage-hardening-epic]]

## Overview

Single-issue plan for GH-1121 (Phase 3 of the test coverage hardening epic). Adds three vitest files covering `lib/rate-limiter.ts`, `lib/group-detection.ts`, and `lib/dashboard-fetch.ts` — three mcp-server lib modules with no direct vitest coverage today.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1121 | Direct unit tests for untested mcp-server lib modules | S |

## Shared Constraints

Inherited from parent epic (GH-1118):

- **No refactors** of code under test. Tests must assert *current* behavior. If a bug surfaces, file a follow-up — do not change source.
- **vitest 4.x only** — no new test framework, no nyc/c8.
- **Pattern**: inline fixtures + `vi.mock` for external deps. Match the shape of `cache.test.ts` and `github-client.test.ts:5-12`.
- **ESM imports**: all internal imports require the `.js` suffix (e.g., `import { RateLimiter } from "../lib/rate-limiter.js"`).
- **Coverage target**: each of the three modules ≥ 80% lines (measurable once Phase 2 / GH-1120 has landed `@vitest/coverage-v8` — already done per parent group: GH-1120 is CLOSED).

## Current State Analysis

Files to test exist at:

- `plugin/ralph-hero/mcp-server/src/lib/rate-limiter.ts` — 89 LOC. Single class `RateLimiter` with `update()`, `checkBeforeRequest()`, `getStatus()`. Defaults: warningThreshold=100, blockThreshold=50. `checkBeforeRequest` calls `console.error` for both warn and block paths and may `await sleep(min(msUntilReset, 60_000))` when in the block zone with positive msUntilReset.
- `plugin/ralph-hero/mcp-server/src/lib/group-detection.ts` — 650 LOC. Public exports: `GroupIssue`, `GroupDetectionResult`, `detectGroup(client, owner, repo, number)`. Internally fans out via `SEED_QUERY` against parent + subIssues + blocking/blockedBy connections, then runs transitive closure + topological sort.
- `plugin/ralph-hero/mcp-server/src/lib/dashboard-fetch.ts` — 289 LOC. Public exports: `RawDashboardItem`, `toDashboardItems(raw, projectNumber?, projectTitle?)`, `DASHBOARD_ITEMS_QUERY`, `FetchDashboardItemsResult`, `fetchDashboardItems(client, fieldCache, projectNumber?)`. Resolves project numbers from arg → `client.config.projectNumbers` → `client.config.projectNumber`. Per-project failures are non-fatal (warnings).

Existing test patterns to mirror:

- `plugin/ralph-hero/mcp-server/src/__tests__/cache.test.ts:1-50` — inline fixture arrays, no mocking, pure-function assertions.
- `plugin/ralph-hero/mcp-server/src/__tests__/github-client.test.ts:5-12` — `vi.mock("@octokit/graphql", ...)` to intercept network.
- `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts` — issues fixture array pattern (good template for `group-detection.test.ts` and `dashboard-fetch.test.ts`).
- `plugin/ralph-hero/mcp-server/src/__tests__/hygiene.test.ts` — already exercises `fetchDashboardItems` transitively; reference for how `client.projectQuery` is mocked.

## Desired End State

Three new test files exist, each passing `npm test` from `plugin/ralph-hero/mcp-server/`. Per-module line coverage exceeds 80%. Tests assert public-API behavior; trivial no-op refactors of the lib modules do not break them.

### Verification

- [ ] `npm test` (in `plugin/ralph-hero/mcp-server/`) green with three new files.
- [ ] Coverage report shows ≥ 80% lines for each of the three target modules.
- [ ] Removing any one of the three new test files drops the package coverage below the configured threshold (sanity check that the new tests are doing real work).

## What We're NOT Doing

- No refactor of `rate-limiter.ts`, `group-detection.ts`, or `dashboard-fetch.ts`.
- No deeper `github-client.ts` coverage — that's Phase 4 / GH-1122.
- No replacement of the indirect coverage `dashboard.test.ts` and `hygiene.test.ts` provide; new tests are additive.
- No new shared test helpers — keep fixtures inline per established pattern.

## Implementation Approach

Three independent task groups, one per target module. They share no files and can be implemented in parallel within a single PR. The phase is small enough to land as one PR rather than splitting per-file.

---

## Phase 1: Direct unit tests for untested mcp-server lib modules

- **depends_on**: null

### Overview

Author three new vitest files under `plugin/ralph-hero/mcp-server/src/__tests__/` covering the public surface of each target module.

### Tasks

#### Task 1.1: rate-limiter.test.ts

- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/rate-limiter.test.ts` (create), `plugin/ralph-hero/mcp-server/src/lib/rate-limiter.ts` (read), `plugin/ralph-hero/mcp-server/src/types.ts` (read — for `RateLimitInfo` shape)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Test case: `update()` followed by `getStatus()` returns the new `remaining` and `resetAt` (parsed as `Date`).
  - [ ] Test case: `checkBeforeRequest()` is a no-op (no console.error, no delay) when `remaining > warningThreshold` (e.g., 5000).
  - [ ] Test case: `checkBeforeRequest()` logs to `console.error` (via `vi.spyOn(console, "error")`) but does not await any sleep when `blockThreshold < remaining <= warningThreshold` (e.g., 75 with defaults).
  - [ ] Test case: `checkBeforeRequest()` waits when `remaining <= blockThreshold` and `resetAt` is in the future. Use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` to assert the sleep happens; cap-at-60s behavior is asserted by setting `resetAt` to e.g. 5 minutes ahead and verifying the await resolves after advancing 60_000 ms.
  - [ ] Test case: `checkBeforeRequest()` does not sleep when `remaining <= blockThreshold` but `resetAt` is in the past (msUntilReset <= 0).
  - [ ] Test case: custom `warningThreshold` / `blockThreshold` options override the defaults (e.g., construct with `{ warningThreshold: 200, blockThreshold: 100 }` and assert state transitions occur at the new boundaries via `getStatus().isLow` / `isCritical`).
  - [ ] `console.error` is restored after each test (`vi.restoreAllMocks()` in `afterEach`).
  - [ ] All cases pass under `npx vitest run src/__tests__/rate-limiter.test.ts`.

#### Task 1.2: group-detection.test.ts

- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/group-detection.test.ts` (create), `plugin/ralph-hero/mcp-server/src/lib/group-detection.ts` (read), `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts` (read — for fixture-array pattern), `plugin/ralph-hero/mcp-server/src/github-client.ts` (read — for client shape needed by the mock)
- **tdd**: true
- **complexity**: high
- **depends_on**: null
- **acceptance**:
  - [ ] Mock `GitHubClient` is constructed inline (object literal with `query` / `projectQuery` as `vi.fn()`); no real network calls.
  - [ ] Test case: standalone issue (no parent, no subIssues, no blocking/blockedBy) — `detectGroup` returns `isGroup: false` with `groupTickets.length === 1` and `totalTickets === 1`.
  - [ ] Test case: parent + 3 subIssues — `detectGroup` called on parent number returns `isGroup: true`, `groupTickets.length === 4`, primary is the parent.
  - [ ] Test case: parent + 3 subIssues — `detectGroup` called on a child number still returns the same group (parent traversal), with primary set to the parent.
  - [ ] Test case: linear `blockedBy` chain (A blocked by B blocked by C, no parent) — group includes all three; topological order places C before B before A in `groupTickets`.
  - [ ] Test case: `order` field on returned `GroupIssue` entries is sequential (0..N-1) and matches topological order.
  - [ ] Test case: cross-repo `blockedBy` (a node whose `repository.owner.login` differs from the seed) sets the `repository` field on that `GroupIssue` to `"owner/repo"`.
  - [ ] Mock returns are scoped per-test (not shared module state) — avoid leaking fixtures between cases.
  - [ ] All cases pass under `npx vitest run src/__tests__/group-detection.test.ts`.
  - [ ] Branch + line coverage of `lib/group-detection.ts` reported by `npm test -- --coverage` is ≥ 80% lines.

#### Task 1.3: dashboard-fetch.test.ts

- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/dashboard-fetch.test.ts` (create), `plugin/ralph-hero/mcp-server/src/lib/dashboard-fetch.ts` (read), `plugin/ralph-hero/mcp-server/src/lib/cache.ts` (read — for `FieldOptionCache.populate` shape), `plugin/ralph-hero/mcp-server/src/__tests__/hygiene.test.ts` (read — for client mock pattern), `plugin/ralph-hero/mcp-server/src/types.ts` (read — for `resolveProjectNumbers`, `resolveProjectOwner`, config shape)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `toDashboardItems` pure-function test cases (no mocks): (a) filters out non-Issue content (PRs and DraftIssues are dropped); (b) maps `Workflow State`, `Priority`, `Estimate` single-select field values onto the item; (c) flattens `assignees` to `string[]`; (d) maps `trackedIssues` → `blockedBy` with `workflowState: "Done"` when the source state is `CLOSED`, `null` otherwise; (e) sets `parentNumber` / `parentState` from `trackedInIssues.nodes[0]`; (f) propagates `projectNumber` / `projectTitle` / `repository` / iteration fields when present; (g) defaults `title` to `"(untitled)"` and `updatedAt` to epoch when missing.
  - [ ] `fetchDashboardItems` test case: throws `"owner is required"` when `client.config` has no resolvable owner.
  - [ ] `fetchDashboardItems` test case: throws when no project numbers configured (empty `projectNumbers` and no `projectNumber`).
  - [ ] `fetchDashboardItems` test case: explicit `projectNumber` arg overrides config (assert by spying on `client.projectQuery` and confirming it was called with the expected `projectId`).
  - [ ] `fetchDashboardItems` test case: multi-project fan-out — `client.config.projectNumbers = [3, 4]` with two project IDs in `FieldOptionCache` produces a single flat `items` array with `projectNumber` tagged correctly per item.
  - [ ] `fetchDashboardItems` test case: when `ensureFieldCache` rejects for one project but succeeds for another, the failing project produces a `warnings` entry of the form `"Project #N: <error>, skipping"` and the surviving project's items are still returned.
  - [ ] `fetchDashboardItems` test case: when `fieldCache.getProjectId(pn)` returns `undefined`, that project is skipped with a `"could not resolve project ID, skipping"` warning.
  - [ ] `fetchDashboardItems` test case: project-title fetch failure is non-fatal — items are still returned with `projectTitle === undefined`.
  - [ ] `fetchDashboardItems` test case: pagination — `client.projectQuery` mock returns `hasNextPage: true` on the first call and `hasNextPage: false` on the second; total items returned equals the sum across pages.
  - [ ] `client.projectQuery` is mocked via `vi.fn()` returning shaped responses; `FieldOptionCache` is real (use `populate(...)` directly with stub field arrays).
  - [ ] All cases pass under `npx vitest run src/__tests__/dashboard-fetch.test.ts`.

### Phase Success Criteria

#### Automated Verification:

- [ ] `npm test` in `plugin/ralph-hero/mcp-server/` passes with three new files included.
- [ ] `npm run build` (tsc) — no errors.
- [ ] Per-file coverage on `lib/rate-limiter.ts`, `lib/group-detection.ts`, `lib/dashboard-fetch.ts` each ≥ 80% lines as reported by `@vitest/coverage-v8`.

#### Manual Verification:

- [ ] Apply a no-op refactor to one target module (e.g., extract a private helper) — tests still pass.
- [ ] Mutate one observable behavior (e.g., flip the `closedAt` → `Done` mapping in `toDashboardItems`) — at least one of the new tests fails with a clear assertion message.

**Creates for next phase**: N/A — single-phase plan. Sibling Phase 4 (GH-1122) and Phase 5 (GH-1123) are independent and tracked separately.

---

## Integration Testing

- [ ] Full `npm test` suite green — confirms no fixture/mocking leakage into adjacent test files (vitest isolation).

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1121
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1118
- Parent plan: thoughts/shared/plans/2026-05-07-GH-1118-test-coverage-hardening-epic.md (Phase 3 spec)
- Pattern: `plugin/ralph-hero/mcp-server/src/__tests__/cache.test.ts:1-50`
- Pattern: `plugin/ralph-hero/mcp-server/src/__tests__/github-client.test.ts:5-12`
- Pattern: `plugin/ralph-hero/mcp-server/src/__tests__/dashboard.test.ts`
- Pattern: `plugin/ralph-hero/mcp-server/src/__tests__/hygiene.test.ts`
