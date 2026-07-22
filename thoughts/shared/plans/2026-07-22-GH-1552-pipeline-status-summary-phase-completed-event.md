---
date: 2026-07-22
status: draft
type: plan
tags: [mcp-server, dashboard, activity-log, hooks, ways-of-working]
github_issue: 1552
github_issues: [1552]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1552
primary_issue: 1552
estimate: S
---

# pipeline_status_summary tool + phase-completed activity event

## Prior Work

- builds_on:: [[2026-07-19-GH-1550-ways-of-working-action-surfaces]] — the epic research doc that grouped these two J2 pieces as "Feature B."
- builds_on:: [[2026-07-19-GH-1550-epic-ways-of-working-surfaces]] — plan-of-plans, Feature B section (`#1552`, S): "Implement the 2026-05-06 idea: compact summary tool in `dashboard-tools.ts` reusing `lib/dashboard.ts` aggregation (~1-2KB). Add one `phase_completed` activity event from the impl hook chain (`impl-verify-commit.sh`)... No flow_state split (deferred)." Integration Strategy also fixes this feature as a **soft** input to Feature C (`B → C is soft`) — no coupling required here.
- builds_on:: [[2026-05-06-pipeline-status-summary-tool]] — the original idea doc. Rough shape: `{ health, riskScore, velocity, totalIssues, phaseCounts: {state: count}, stuckIssues: [{number, title, state, ageHours}], wipViolations, blockedDeps }`, reusing `lib/dashboard.ts` aggregation, skipping per-issue detail arrays and markdown rendering. The idea doc's `since`/delta parameter is explicitly an "Open Question," not committed scope.

## Overview

Two independent, small additions inside the existing dashboard/activity subsystems:

1. A new MCP tool, `ralph_hero__pipeline_status_summary`, that returns the same ~10-field compact shape as the idea doc — a projection over the existing `lib/dashboard.ts` aggregation (`aggregateByPhase` + `detectHealthIssues`) and `lib/metrics.ts` (`calculateVelocity` + `calculateRiskScore` + `determineStatus`), with no per-phase issue arrays and no markdown/ASCII rendering. This solves the payload-size problem `pipeline_dashboard` has for callers that only want status numbers (~60KB there vs ~1-2KB here).
2. One additional activity-log event, `phase_completed`, appended by `impl-verify-commit.sh` (the impl Stop chain's PostToolUse hook on `Bash`) whenever a `git commit` inside `/ralph:impl` succeeds with a commit message matching the plan's phase convention (`Phase [N] of [M]: #NNN - [Title]`, per `plan-compliance.md` §Staging Algorithm step 6). This lets `recent_activity` and the catch-up narrative surface phase-level progress inside an in-flight `/ralph:impl` run, which today is invisible between `/ralph:hero` dispatch events.

Both pieces are read paths/observability side-channels only — no workflow-state, schema, or lock-state changes.

## Current State Analysis

`mcp-server/src/lib/dashboard.ts` already contains every aggregation primitive the summary tool needs; `mcp-server/src/tools/dashboard-tools.ts` already contains the exact fetch → health-config → build pipeline to copy. `ralph/hooks/scripts/impl-verify-commit.sh` already runs on every commit/push during `/ralph:impl` but has no success-path branch — it only ever warns or blocks, then falls through to a bare `allow` at the bottom. The activity log has one precedent writer (`hero-dispatch-log.sh`) and one reader (`lib/activity.ts`), and — this is the load-bearing discovery for Phase 2 — **the precedent writer's directory shape does not match what the reader actually parses**, so this plan does not copy it verbatim.

### Key Discoveries

- `mcp-server/src/lib/dashboard.ts:241` `aggregateByPhase(items, now, config)` returns `PhaseSnapshot[]` (`:60-75`: `state`/`count`/`estimatePoints`/`issues[]`, each issue carrying `number`, `title`, `priority`, `estimate`, `assignees`, `ageHours`, `isLocked`, `blockedBy`, `subIssueCount`). The summary needs `state`/`count` (for `phaseCounts`) and, from `issues[]`, only `number`/`title`/`ageHours` (for `stuckIssues`) — everything else in the array is dropped.
- `mcp-server/src/lib/dashboard.ts:342` `detectHealthIssues(phases, config)` returns `HealthWarning[]` (`:77-89`: `type`/`severity`/`message`/`issues: number[]`), sorted critical-first. Relevant warning types: `wip_exceeded` (`:352`), `stuck_issue` (`:394-408`, one warning per stuck issue — `issues` is a 1-element array), `blocked` (`:415-422`, one warning per blocked issue). `wipViolations`/`blockedDeps` in the summary are counts of warnings of those two types; `stuckIssues` is built by looking up each `stuck_issue` warning's issue number against the `PhaseSnapshot.issues[]` index (for title/ageHours/state), sorting descending by `ageHours`, and taking the top 5.
- `mcp-server/src/lib/dashboard.ts:175` `DEFAULT_HEALTH_CONFIG` and `:167-173` `HealthConfig` — reused as-is (`stuckThresholdHours`, `criticalStuckHours`, `wipLimits`, `doneWindowDays`, `archiveAgeDays`). The summary function doesn't call `computeArchiveStats` so `archiveAgeDays` is present in the type but unused by the projection — pass the default.
- `mcp-server/src/lib/metrics.ts:19-45` `MetricsConfig`/`DEFAULT_METRICS_CONFIG`, `:57-69` `calculateVelocity(items, windowDays, now)`, `:81-89` `calculateRiskScore(warnings, weights)`, `:98-105` `determineStatus(riskScore, config)` returning `"ON_TRACK"|"AT_RISK"|"OFF_TRACK"`. `calculateMetrics` (`:152-167`) is the existing all-in-one orchestrator `pipeline_dashboard` uses, but it requires a full `DashboardData` object (for `extractHighlights`, which the summary shape doesn't need — no `highlights` field in the idea doc's shape). Calling the three sub-functions directly avoids building an unneeded `DashboardData`/`highlights` payload. `determineStatus`'s return value maps directly onto the summary's `health` field (the idea doc names it `health`, not `status`).
- `mcp-server/src/tools/dashboard-tools.ts:47` `registerDashboardTools(server, client, fieldCache)` registers two tools already, back to back — `pipeline_dashboard` (`:52-291`) and `detect_stream_positions` (`:296-374`) — the direct precedent for adding a third `server.tool(...)` call in the same function/file. `pipeline_dashboard`'s handler (`:154-289`) is the exact fetch pattern to copy: owner/project-number resolution (`:156-169`), per-project `fetchDashboardItems` loop when `projectNumbers` is explicit vs. the default-config path (`:176-196`), `HealthConfig` construction including the `criticalStuckHours = stuckThresholdHours * 2` convention (`:199-206`).
- `ralph/hooks/scripts/impl-verify-commit.sh` (58 lines total) is a PostToolUse hook on `Bash`, registered in `ralph/skills/impl/SKILL.md:44-47`, scoped to `RALPH_COMMAND=impl` (`:13-15`), only acting when the command string contains `git commit` or `git push` (`:24-26`). It inspects `tool_response.stdout`+`stderr` for `nothing to commit` (`:36-38`, `warn()` → exit 0), rejected/failed push (`:40-48`, `block()` → exit 2), and pre-commit hook failure (`:50-56`, `block()` → exit 2). There is **no success-path branch** — `allow` at `:58` is the unconditional fallthrough reached only when none of the failure patterns matched. The `phase_completed` append belongs immediately before that `allow`, gated on `$command` containing `git commit` (push-only commands correctly skip — they never carry the phase message, see below).
- `ralph/skills/impl/plan-compliance.md:55` (§Staging Algorithm step 6): "Commit with a message identifying the phase: `feat(component): [phase description]` body line `Phase [N] of [M]: #NNN - [Title]`." Step 7 pushes separately. Per the transcript, commit and push are distinct `Bash` tool calls, so the hook fires once per call — the commit call's `tool_input.command` string contains the full `-m`/heredoc message text (including the phase line) and is the only call where phase/issue numbers are extractable; the push call's command (`git push -u origin feature/GH-NNN`) never carries them, so it correctly no-ops under a `git commit`-only gate.
- `mcp-server/src/lib/activity.ts:17-25` `ActivityEvent { ts, kind, category: "work"|"meta", actor?, target?: Record<string,unknown>, project?, session_id? }`. `readActivity` (`:54-126`) walks `rootDir/YYYY/MM/` (`:73-78`) then filters files **directly inside the month directory** matching `/^\d{2}\.jsonl$/` (`:79`) — i.e. one file per day, named `DD.jsonl`, sitting straight in the month dir. Unknown `kind` values pass through untouched when the caller doesn't filter by `kinds` (`:100`) — a new `phase_completed` kind is safely additive.
- `ralph/hooks/scripts/hero-dispatch-log.sh:35-42` is the only in-repo writer, but its path shape **does not match** what `readActivity` parses: `log_dir="$ROOT/$(date +%Y/%m/%d)"` (a full **day directory**, e.g. `.../activity/2026/07/22/`) then appends to `"$log_dir/$(date +%H).jsonl"` (an **hourly file** inside it, e.g. `22/14.jsonl`). `readActivity`'s regex only matches `\d{2}\.jsonl` entries sitting directly in the **month** directory (`.../activity/2026/07/22.jsonl`), so it never descends into a `22/` subdirectory to find `14.jsonl`. Confirmed empirically on this machine: `~/.ralph-hero/activity/2026/05/25` exists as an **empty directory** (dead write attempt from this exact bug), while every event `readActivity` actually returns lives in sibling `.../2026/05/DD.jsonl` files written some other way. Corroborated by the test fixture builder `mcp-server/src/__tests__/activity.test.ts:51-56` (`writeEvents`), which writes to `rootDir/YYYY/MM/DD.jsonl` — the shape the reader expects, not the shape `hero-dispatch-log.sh` produces. This plan's Phase 2 writer targets the reader's real contract (`YYYY/MM/DD.jsonl`), not `hero-dispatch-log.sh`'s path shape — see Design Decisions.
- No `dashboard-tools.test.ts` exists today (confirmed via `mcp-server/src/__tests__/` listing) — `directions-tools.test.ts` is the closest integration-test harness (mocked `client.projectQuery`, `McpServer` + tool extraction) for a tool-registration test. `mcp-server/src/__tests__/dashboard.test.ts` is the pure-function unit-test pattern for the new lib projection helper.
- Bash hook tests live in `ralph/hooks/scripts/__tests__/*.test.sh`; `plan-research-required.test.sh` and `split-size-gate.test.sh` show the harness: build `tool_input`/`tool_response` JSON with `jq -n`, pipe to the hook via `<<<`, assert exit code, using `env -u RALPH_*` to isolate from the shell profile's exported `RALPH_*` vars (per `reference_shell_exports_ralph_env_vars` — this machine's profile exports `RALPH_REVIEW_PLAN`; the new test must not assume a clean env).

## Desired End State

1. `ralph_hero__pipeline_status_summary` is registered alongside `pipeline_dashboard`/`detect_stream_positions` in `dashboard-tools.ts` and returns exactly `{ health, riskScore, velocity, totalIssues, phaseCounts, stuckIssues, wipViolations, blockedDeps }` (plus an optional `fetchWarnings` array on partial-fetch failure, matching `pipeline_dashboard`'s convention) — no per-phase `issues[]` arrays, no `formatted`/markdown/ascii field.
2. The summary's aggregation logic lives in a new pure lib function (`buildStatusSummary`) that calls the existing `aggregateByPhase`/`detectHealthIssues`/`calculateVelocity`/`calculateRiskScore`/`determineStatus` — it does not reimplement any bucketing, warning-detection, or scoring logic.
3. During `/ralph:impl`, every successful `git commit` whose message contains a `Phase [N] of [M]: #NNN` line appends one `phase_completed` JSONL line to `${RALPH_ACTIVITY_DIR:-$HOME/.ralph-hero/activity}/YYYY/MM/DD.jsonl` (the shape `readActivity` actually parses), with fields `ts`, `category: "work"`, `kind: "phase_completed"`, `target: { issue, phase, totalPhases }`.
4. The hook never blocks the impl flow because of this addition — commits without a phase-pattern match, JSON-append failures, and missing `RALPH_ACTIVITY_DIR`-writable directories all degrade to a silent no-op, and the hook still reaches `allow` (exit 0) on the previously-passing success path.
5. `recent_activity`/`ralph_hero__recent_activity` (unmodified) returns `phase_completed` events for calls that don't filter `kinds`, since `readActivity` passes unknown kinds through.

### Verification

- `npm test` (from `mcp-server/`) passes, including new `status-summary.test.ts` and (if added) `pipeline-status-summary.test.ts` files.
- `npm run build` (from `mcp-server/`) exits 0 with no new TypeScript errors.
- New bash test `ralph/hooks/scripts/__tests__/impl-verify-commit.test.sh` passes.
- ShellCheck is clean on `ralph/hooks/scripts/impl-verify-commit.sh` (CI runs ShellCheck on `ralph/hooks`).
- Manual: call `ralph_hero__pipeline_status_summary` against a live project and confirm response size is ~1-2KB (vs. `pipeline_dashboard`'s tens of KB) and field shape matches the idea doc exactly.
- Manual: run a real `/ralph:impl` phase commit locally, then call `ralph_hero__recent_activity` and confirm a `phase_completed` event with the correct issue/phase/totalPhases appears.

## What We're NOT Doing

- No `since`/delta parameter on the summary tool — explicitly an open question in the idea doc, not committed scope here.
- No `flow_state`/health split — deferred per the epic's resolved decisions.
- No richer per-phase progress surfaces (e.g. percent-complete, ETA) beyond the single `phase_completed` event — deferred to whatever consumes it later (Feature C is a soft, not hard, consumer).
- No changes to `recent_activity`/`lib/activity.ts` — `phase_completed` is a new `kind` value only; the reader already passes unrecognized kinds through untouched.
- No fix to `hero-dispatch-log.sh`'s pre-existing path-shape bug (writes `YYYY/MM/DD/HH.jsonl`, which `readActivity` never reads — see Key Discoveries). It's a real, evidenced bug, but it's outside this issue's scope and touches a different hook/command surface (`/ralph:hero`, not `/ralph:impl`); the new writer in this plan uses the *correct* shape rather than propagating the bug, but does not retrofit the existing writer.
- No coupling to `#1551` (Feature A) — Feature B is independent, Wave 1 parallel work per the epic plan.
- No changes to `pipeline_dashboard` itself (format, schema, or behavior) — the new tool is additive.

## Design Decisions & Open Ambiguities

- **Where the projection logic lives** — options: inline in `dashboard-tools.ts`'s handler; a new pure function in `lib/dashboard.ts`; a new small lib file that imports both `dashboard.ts` and `metrics.ts`. **Decided: new file `mcp-server/src/lib/status-summary.ts`.** `dashboard.ts` cannot import `metrics.ts` without risking a cycle (`metrics.ts` already imports types from `dashboard.ts`), and the summary needs both `aggregateByPhase`/`detectHealthIssues` (dashboard.ts) and `calculateVelocity`/`calculateRiskScore`/`determineStatus` (metrics.ts). A new leaf-level file mirrors how `dashboard-tools.ts` already composes both modules at the tool layer, but keeps the pure logic testable independent of MCP registration.
- **Reuse `calculateMetrics` wholesale vs. call its three sub-functions directly** — options: call `calculateMetrics(items, dashboardData, config)` (requires building a `DashboardData`-shaped object just to get `highlights` the summary discards); call `calculateVelocity`/`calculateRiskScore`/`determineStatus` directly. **Decided: call the three sub-functions directly.** Building a full `DashboardData` (with `boardItems`, `archive`, etc.) purely to satisfy `calculateMetrics`'s signature would reintroduce exactly the per-issue/markdown overhead this tool exists to avoid; `extractHighlights`'s output isn't part of the committed summary shape.
- **stuckIssues top-5 field shape** — options: reuse the full `PhaseSnapshot.issues[]` entry shape; a minimal `{number, title, state, ageHours}` per the idea doc. **Decided: minimal shape**, sourced by cross-referencing `stuck_issue` `HealthWarning.issues` (the affected issue numbers) against the `PhaseSnapshot.issues[]` index built during aggregation, sorted descending by `ageHours`, capped at 5.
- **`wipViolations`/`blockedDeps` as counts vs. issue-number arrays** — options: return the count of matching `HealthWarning`s; return the full list of affected issue numbers. **Decided: scalar counts** (`warnings.filter(w => w.type === "...").length`), matching the idea doc's flat numeric-field rough shape (`wipViolations`, `blockedDeps` sit alongside `riskScore`/`velocity`, not `stuckIssues`, in the enumerated shape) and keeping the payload flat/compact.
- **Activity-log write path shape for the new `phase_completed` writer** — options: copy `hero-dispatch-log.sh`'s existing path shape (`YYYY/MM/DD/HH.jsonl`) for consistency with the only precedent writer; write to the path `readActivity` actually parses (`YYYY/MM/DD.jsonl`, appending to a per-day file). **Decided: write to `YYYY/MM/DD.jsonl`.** Verified via code read + on-disk evidence (see Key Discoveries) that `hero-dispatch-log.sh`'s shape is invisible to `readActivity` — copying it would ship a `phase_completed` event that `recent_activity` can never return, defeating the issue's stated purpose ("so recent_activity and the catch-up narrative can report progress"). Fixing `hero-dispatch-log.sh` itself is out of scope (see What We're NOT Doing).
- **What triggers the append: commit success vs. push success** — options: append when the `git commit` command succeeds (phase message is only present in the commit's own `tool_input.command`); append when the subsequent `git push` succeeds (durability signal, but the push command carries no phase/issue text to parse). **Decided: append on successful `git commit`.** The block-on-rejected-push check (`impl-verify-commit.sh:40-48`) still runs on the push call and would `block()` before any future commit in the phase proceeds, so a phase whose push actually fails blocks the *next* phase's commit rather than silently leaving a stale `phase_completed` event — acceptable because `impl-verify-commit.sh` already treats push failure as a hard stop for the whole workflow, not something that unwinds a prior commit's event.
- **Malformed/missing phase pattern in the commit message** — options: block the hook (force well-formed messages); warn to stderr but continue; skip the append silently. **Decided: skip silently**, per the issue's explicit design guidance — this is an observability side-channel, not a policy gate; `impl-staging-gate.sh`/`plan-compliance.md` are the correct places to enforce commit-message shape, not this hook.

None — no open design decisions.

## Implementation Approach

Two independent phases, no shared files, no ordering dependency — both can be implemented and merged in either order (or in parallel across two agents). Phase 1 adds a pure lib function plus one tool registration in the existing dashboard-tools module. Phase 2 adds one guarded, best-effort append block to the existing impl-verify-commit hook. Both changes are additive: no existing tool, hook exit code, or activity-log reader behavior changes for any caller that isn't specifically exercising the new tool or the new `phase_completed` kind.

## Phase 1: `pipeline_status_summary` tool

depends_on: null

### Overview

Add a pure `buildStatusSummary` projection function and register `ralph_hero__pipeline_status_summary` as a third tool in `dashboard-tools.ts`, reusing the exact fetch pipeline `pipeline_dashboard` already uses.

### Changes Required

#### 1. New pure projection helper
**File**: `mcp-server/src/lib/status-summary.ts` (new)
**Changes**: Export `PipelineStatusSummary` interface (`health`, `riskScore`, `velocity`, `totalIssues`, `phaseCounts: Record<string, number>`, `stuckIssues: Array<{number, title, state, ageHours}>`, `wipViolations`, `blockedDeps`) and `buildStatusSummary(items: DashboardItem[], healthConfig: HealthConfig = DEFAULT_HEALTH_CONFIG, metricsConfig: MetricsConfig = DEFAULT_METRICS_CONFIG, now: number = Date.now()): PipelineStatusSummary`. Implementation: `aggregateByPhase` → `detectHealthIssues` → build a `Map<number, {title, state, ageHours}>` by iterating `phases[]` and tagging each `phase.issues[]` entry with its enclosing `phase.state` (the issue entries themselves carry no `state` field) → `phaseCounts` from non-zero `phases[].count` → `stuckIssues` from `stuck_issue`-type warnings looked up against the map, sorted desc by `ageHours`, sliced to 5 → `wipViolations`/`blockedDeps` as warning-type counts → `velocity = calculateVelocity(items, metricsConfig.velocityWindowDays, now)` → `riskScore = calculateRiskScore(warnings, metricsConfig.severityWeights)` → `health = determineStatus(riskScore, metricsConfig)`.

#### 2. New tool registration
**File**: `mcp-server/src/tools/dashboard-tools.ts`
**Changes**: Import `buildStatusSummary`/`PipelineStatusSummary` from `../lib/status-summary.js`; add `server.tool("ralph_hero__pipeline_status_summary", ...)` after the existing `detect_stream_positions` registration (or before it — order doesn't matter, both live in the same `registerDashboardTools` body). Schema: `owner` (optional string), `projectNumbers` (optional `z.array(z.coerce.number())`), `stuckThresholdHours` (optional, default 48), `wipLimits` (optional `z.record(z.coerce.number())`), `doneWindowDays` (optional, default 7), `velocityWindowDays` (optional, default 7), `atRiskThreshold` (optional, default 2), `offTrackThreshold` (optional, default 6). Handler: copy `pipeline_dashboard`'s owner/projectNumbers resolution and `fetchDashboardItems` loop verbatim (`dashboard-tools.ts:156-196`), build `HealthConfig` with the same `criticalStuckHours = stuckThresholdHours * 2` convention (`:199-206`) and a `MetricsConfig` from the new params, call `buildStatusSummary(allItems, healthConfig, metricsConfig)`, return `toolSuccess({ ...summary, ...(fetchWarnings.length > 0 ? { fetchWarnings } : {}) })`. No `format`, `includeMetrics`, `groupBy`, `streams`, or `issuesPerPhase` params — this tool has exactly one compact JSON shape.

#### 3. Unit tests for the projection
**File**: `mcp-server/src/__tests__/status-summary.test.ts` (new)
**Changes**: Pure-function tests mirroring `dashboard.test.ts`'s style. Cases: empty `items` → all-zero/empty summary; `totalIssues` equals `items.length`; `phaseCounts` omits zero-count phases; `stuckIssues` returns at most 5 entries sorted descending by `ageHours` with correct `{number, title, state, ageHours}` shape when >5 issues are stuck; `wipViolations`/`blockedDeps` equal the count of matching `HealthWarning` types; `velocity`/`riskScore`/`health` match hand-computed values for a small fixture (cross-checked against direct calls to `calculateVelocity`/`calculateRiskScore`/`determineStatus` with the same fixture, proving delegation rather than reimplementation).

#### 4. Tool-registration test
**File**: `mcp-server/src/__tests__/pipeline-status-summary.test.ts` (new)
**Changes**: Integration test following `directions-tools.test.ts`'s mock-`client.projectQuery` + `McpServer` harness. Registers `registerDashboardTools`, invokes `ralph_hero__pipeline_status_summary` with a small fixture set of project items, and asserts: the response has exactly the compact top-level keys (no `issues`, no `formatted`, no `archive`, no `projectBreakdowns`); `phaseCounts` matches the fixture; `stuckIssues` length ≤ 5.

### Success Criteria

#### Automated Verification
- [x] `cd mcp-server && npm run build` exits 0
- [x] `cd mcp-server && npx vitest run src/__tests__/status-summary.test.ts` passes
- [x] `cd mcp-server && npx vitest run src/__tests__/pipeline-status-summary.test.ts` passes
- [x] `cd mcp-server && npm test` passes (full suite, no regressions in `dashboard.test.ts`/`dashboard-fetch.test.ts`/`dashboard-group-by.test.ts`)

#### Manual Verification
- [ ] Call `ralph_hero__pipeline_status_summary` against the live `cdubiel08/ralph-hero` project and eyeball the response: field shape matches the idea doc exactly, response is on the order of 1-2KB, and no per-phase `issues[]` array is present.
- [ ] Compare `stuckIssues`/`wipViolations`/`blockedDeps` from the new tool against `pipeline_dashboard --includeHealth=true`'s health warnings for the same project and confirm the counts agree.

## Phase 2: `phase_completed` activity event

depends_on: null

### Overview

Append one best-effort `phase_completed` JSONL event from `impl-verify-commit.sh` on every successful `/ralph:impl` phase commit, written to the path shape `readActivity` actually parses.

### Changes Required

#### 1. Hook script change
**File**: `ralph/hooks/scripts/impl-verify-commit.sh`
**Changes**: Add a `log_phase_completed_event()` function that: extracts `phase_n`/`phase_m`/`issue_num` from `$command` via the bash regex `Phase\ ([0-9]+)\ of\ ([0-9]+):\ \#([0-9]+)` (returns 0 with no side effect if no match); on match, computes `activity_root="${RALPH_ACTIVITY_DIR:-$HOME/.ralph-hero/activity}"`, `month_dir="$activity_root/$(date +%Y/%m)"`, `day_file="$month_dir/$(date +%d).jsonl"`, `mkdir -p "$month_dir" 2>/dev/null || return 0`, then appends `printf '{"ts":"%s","category":"work","kind":"phase_completed","target":{"issue":%s,"phase":%s,"totalPhases":%s}}\n' "$ts" "$issue_num" "$phase_n" "$phase_m" >> "$day_file" 2>/dev/null || return 0`. Call it right before the final `allow` at the bottom of the script: `if [[ "$command" == *"git commit"* ]]; then log_phase_completed_event "$command" || true; fi` then `allow`. No change to any existing `warn`/`block` condition — this is purely additive on the success fallthrough.

#### 2. Bash hook test
**File**: `ralph/hooks/scripts/__tests__/impl-verify-commit.test.sh` (new)
**Changes**: Follow `plan-research-required.test.sh`/`split-size-gate.test.sh`'s harness (`jq -n` to build `tool_input`/`tool_response` JSON, pipe via `<<<`, `env -u RALPH_*` isolation per `reference_shell_exports_ralph_env_vars`, assert exit codes). Extend the harness beyond exit-code-only assertions: point `RALPH_ACTIVITY_DIR` at a per-test temp dir and read the JSONL back with `jq` to assert file contents. Cases: (a) `RALPH_COMMAND=impl`, `git commit` command containing `Phase 2 of 5: #1552 - Title`, successful `tool_response` → exit 0 AND `RALPH_ACTIVITY_DIR/<today YYYY/MM/DD>.jsonl` contains one line with `kind: "phase_completed"`, `target.issue: 1552`, `target.phase: 2`, `target.totalPhases: 5`; (b) same but commit message has no `Phase N of M` pattern → exit 0, no file written; (c) `git push` only (no `git commit` substring) → exit 0, no file written (existing behavior preserved); (d) rejected push → exit 2 (existing `block()` behavior unchanged), no file written; (e) `nothing to commit` → exit 0 (existing `warn()` behavior unchanged), no file written; (f) `RALPH_COMMAND` unset (scope guard) → exit 0, no file written even with a matching commit message.

### Success Criteria

#### Automated Verification
- [x] `bash ralph/hooks/scripts/__tests__/impl-verify-commit.test.sh` — all cases pass
- [x] `shellcheck ralph/hooks/scripts/impl-verify-commit.sh` reports no new warnings
- [x] Existing hook test suite still passes (no regressions from the added function): `for f in ralph/hooks/scripts/__tests__/*.test.sh; do bash "$f" || exit 1; done`

#### Manual Verification
- [ ] Run a real `/ralph:impl` phase locally (or a hand-crafted `git commit` with the phase-line convention on a scratch branch), confirm a new `~/.ralph-hero/activity/YYYY/MM/DD.jsonl` line appears with the expected `phase_completed` shape.
- [ ] Call `ralph_hero__recent_activity` (no `kinds` filter) afterward and confirm the `phase_completed` event is returned.

## Testing Strategy

### Unit Tests
- `mcp-server/src/__tests__/status-summary.test.ts` — pure-function coverage of `buildStatusSummary` (Phase 1).

### Integration Tests
- `mcp-server/src/__tests__/pipeline-status-summary.test.ts` — tool-registration + payload-shape coverage (Phase 1).
- `ralph/hooks/scripts/__tests__/impl-verify-commit.test.sh` — hook exit-code + file-write coverage across success/failure/no-op branches (Phase 2).

### Manual Testing Steps
1. Build and run the MCP server locally; call `ralph_hero__pipeline_status_summary` and `ralph_hero__pipeline_dashboard --includeMetrics=true` side by side against the same project; confirm `health`/`riskScore`/`velocity` agree between the two.
2. Trigger a real `/ralph:impl` phase commit; tail `~/.ralph-hero/activity/$(date +%Y/%m/%d).jsonl` (note: `.jsonl` suffix directly, not a `DD` subdirectory) and confirm the new line appears within the same hook invocation that ran the commit.

## Migration Notes

No data migration. No existing tool schemas or hook exit-code contracts change. The new `phase_completed` `kind` is additive to the activity-log schema (which is intentionally schema-loose — `readActivity` does not validate against a fixed `kind` enum).

## References

- Idea doc: `thoughts/shared/ideas/2026-05-06-pipeline-status-summary-tool.md`
- Epic plan-of-plans: `thoughts/shared/plans/2026-07-19-GH-1550-epic-ways-of-working-surfaces.md` (Feature B, lines 67-68)
- Research: `thoughts/shared/research/2026-07-19-GH-1550-ways-of-working-action-surfaces.md`
- `mcp-server/src/lib/dashboard.ts`
- `mcp-server/src/lib/metrics.ts`
- `mcp-server/src/tools/dashboard-tools.ts`
- `mcp-server/src/lib/activity.ts`
- `ralph/hooks/scripts/impl-verify-commit.sh`
- `ralph/hooks/scripts/hero-dispatch-log.sh` (path-shape bug reference)
- `ralph/skills/impl/plan-compliance.md` (§Staging Algorithm, commit-message convention)
