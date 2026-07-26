---
date: 2026-07-26
status: draft
type: plan
tags: [mcp-tools, surface-reduction, toolspace, 4cs, group-plan]
github_issues: [1609, 1610, 1611, 1612, 1613, 1614]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1609
  - https://github.com/cdubiel08/ralph-hero/issues/1610
  - https://github.com/cdubiel08/ralph-hero/issues/1611
  - https://github.com/cdubiel08/ralph-hero/issues/1612
  - https://github.com/cdubiel08/ralph-hero/issues/1613
  - https://github.com/cdubiel08/ralph-hero/issues/1614
primary_issue: 1609
estimate: S
research_doc: thoughts/shared/research/2026-07-26-GH-1591-tool-surface-reduction-sweep.md
---

# GH-1591 Group Plan — Tool surface reduction wave 2 (six children, one PR)

## Prior Work

- builds_on:: [[2026-07-26-GH-1591-tool-surface-reduction-sweep]] (research — authoritative inventory + audit-claim verification; every phase below cites it)
- builds_on:: [[2026-07-26-GH-1591-plan-of-plans]] (plan-of-plans — decomposition, one-PR integration strategy, sequencing)
- builds_on:: [[2026-07-19-GH-1563-mcp-tool-surface-pruning-and-tree-creation]] (research — wave-1 method and prune criteria, PR #1570)
- builds_on:: [[2026-07-22-GH-1552-pipeline-status-summary-phase-completed-event]] (plan — proves `phase_completed` is an activity-log event, independent of the summary tool)
- builds_on:: [[2026-04-25-GH-0870-archive-open-children-guard]] (plan — proves the guard was always scoped to `findArchiveCandidates()` in hygiene.ts)
- tensions:: [[2026-07-25-ralph-4cs-surface-reduction]] (idea — audit source; two of its location claims are refuted by the research and corrected here)

## Overview

One group plan for the six children of #1591 (GH-1538 sibling-group planning): one worktree (`GH-1609`), one branch (`feature/GH-1609`), one PR closing #1609 #1610 #1611 #1612 #1613 #1614. The wave cuts one zero-consumer tool, merges four tool pairs into parameterized single tools, deletes two orphans, gates the four `sre__*` tools behind an env flag, fixes a `get_issue` dependency-read defect found during research, and closes with a two-direction CI cross-reference check plus the final count assertion.

The default-registered tool surface goes **32 → 22** (source registrations 33 → 26, of which 4 are `RALPH_SRE_ENABLE`-gated). That is two over #1591's original "≤20" acceptance line — deliberately. The two tools that would close the gap (`create_status_update`, `project_hygiene`) both have live consumers and evidence-backed reasons to stay (see Design Decisions); the criterion is restated to the projected number with the arithmetic shown rather than forcing an unjustified cut.

Because the diff lands under `mcp-server/src/**`, the merge triggers `release.yml` — auto version bump, npm publish with OIDC provenance, `ralph/.mcp.json` pin. One PR means one release event carrying every removal, so the release-notes item in Phase 7 is load-bearing, not cosmetic. `main` is ruleset-protected: this plan doc, the research doc, and the plan-of-plans ride the same PR branch as the code (via `scripts/attest-pr.sh` + `scripts/merge-pr.sh`).

## Current State Analysis

The MCP server registers 33 tools: 32 unconditionally, plus `collate_debug` only when `RALPH_DEBUG=true` (`mcp-server/src/index.ts:549-552`). `tool-registration.test.ts:161-194` locks a 32-name manifest. Registration is one `registerXyzTools()` call per module, sequential in `main()` (`index.ts:505-552`); the debug gate is the only conditional registration today.

### Key Discoveries

- **`detect_stream_positions` has zero call sites** — sole non-doc reference is the roster line `ralph/skills/hero/SKILL.md:75`. Its lib entry `detectStreamPipelinePositions` (`lib/pipeline-detection.ts:410`) becomes unreachable; `detectPipelinePosition` in the same file backs `get_issue(includePipeline)` and must stay (research §2 claim 1).
- **`create_status_update`'s consumer survives** — catch-up `--mode report` (`ralph/skills/catch-up/SKILL.md:25,46,57,149,153`) is NOT deleted by #1603, and `createProjectV2StatusUpdate` exists nowhere else in the codebase. Cutting the tool would silently drop a working capability (research §2 claim 2, risk 4).
- **The summary→dashboard merge is total** — every `pipeline_status_summary` param already exists on `pipeline_dashboard` with identical defaults; both run the same `fetchDashboardItems` loop (`dashboard-tools.ts:155-197` vs `:430-466`). A strict `view` enum preserves everything (research §3a).
- **The GH-1552 `phase_completed` event is NOT in `pipeline_status_summary`** — it is an activity-log JSONL event written by `ralph/hooks/scripts/impl-verify-commit.sh:58-86` and read via `recent_activity`. The #1610 merge cannot lose it; the actual preservation target is `buildStatusSummary`'s output shape (`lib/status-summary.ts`) and `status-summary.test.ts` (research §2 claim 8 — refutes the issue body).
- **The GH-0870 open-children guard is NOT on `archive_items`** — it lives in `findArchiveCandidates()` (`mcp-server/src/lib/hygiene.ts:142`, backing `project_hygiene`). `archive_items` bulk mode re-scans by workflowStates with no sub-issue check — its scan query does not even fetch `subIssues` (`project-management-tools.ts:282-316`). The #1611 fold is the opportunity to ADD the guard server-side, closing today's bypass (research §2 claim 9 — refutes the issue body).
- **`sync_plan_graph` is NOT hook-warned** — `plan-postcondition.sh` (read in full) has no `depends_on`/`sync_plan_graph` logic; the claim traces to stale prose at `ralph/skills/plan/plan-shapes.md:163,209` describing a hook that does not exist. The tool has no roster grant anywhere and is uncallable on every autonomous path (research §2 claims 3, 10; §4).
- **`archive_items` already borrows `batch_update`'s mutation layer** — `buildBatchArchiveMutation` is imported from `batch-tools.ts` (`project-management-tools.ts:15,393`). The #1611 fold is schema surface, not plumbing (research §3b).
- **`get_issue` misreads dependencies** — it maps `blocking`/`blockedBy` from the legacy task-list `trackedInIssues`/`trackedIssues` connections (`issue-tools.ts:665-670,716-721,998-1007`) instead of the native dependency connection that `add_dependency`'s `addBlockedBy` mutation writes. It reported `blockedBy: []` for all six children of #1591 despite eight edges being present on the board. GH-1470 fixed this exact defect class in `dashboard-fetch.ts` (see `dashboard-fetch.test.ts:127,145`) but `get_issue` was missed; `list_dependencies` (`relationship-tools.ts:536-547`) and `group-detection.ts:67-128` already use the native connections (research §2 claim 11).
- **Flag-state test coverage requires one file per state** — `tool-registration.test.ts` imports `index.js` once per file (module cache); flag-ON coverage needs a second test file setting the env var before the dynamic import (research §5).
- **`scripts/check-doc-rosters.sh` covers neither new CI direction** — it checks docs⇔source only (tools one-directional, documented ⊆ source, `check-doc-rosters.sh:140-170`); nothing today checks prose→roster or registration→consumer. `scripts/__tests__/` is CI-run by the same discovery loop as hook tests (`ci.yml:117-123`); ShellCheck runs at severity=error on `scripts/` (research §6).

## Desired End State

1. Default-registered tool surface is exactly **22**; source holds 26 registrations (22 + 4 `RALPH_SRE_ENABLE`-gated `sre__*`). `collate_debug`, `sync_plan_graph`, `detect_stream_positions`, `pipeline_status_summary`, `get_project`, `capture_snapshot`, `archive_items` no longer exist in source.
2. Every capability of the four merged-away tools is reachable through a parameter on the surviving tool (`view: "summary"`, `includeFields: true`, `capture: true`, archive/unarchive operations with filter selector) — no output shape lost.
3. The GH-0870 open-children guard is enforced server-side in `batch_update`'s filter-driven archive mode (new behavior closing the pre-existing `archive_items` bypass); `project_hygiene`'s candidate-selection guard (`hygiene.ts:142`) is untouched.
4. `get_issue` reports `blocking`/`blockedBy` from the native dependency connections; the #1609→#1614 chain reads correctly.
5. A CI check fails on both drift directions — a skill prose naming a `ralph_hero__*` tool absent from that skill's `allowed-tools`, and a registered tool with zero rostered consumers — with fixture-driven tests in `scripts/__tests__/`.
6. `tool-registration.test.ts` asserts the 22-name manifest; a sibling test file asserts the 4 `sre__*` names appear under `RALPH_SRE_ENABLE=true`.
7. CLAUDE.md/README tool tables, env-var table, all skill rosters and prose, and `ralph/agents/sre-fixit.md` agree with the new surface; `plan-shapes.md`'s fictional hook claim is gone.
8. The PR body carries a release-notes section naming every removed/gated tool and its replacement path (this PR triggers `release.yml` on merge).

### Verification

- Automated: `npm test` in `mcp-server/` green (all retargeted suites); `bash scripts/check-doc-rosters.sh` green; new `bash scripts/check-tool-consumers.sh` green on the repo and failing on broken fixtures (proven by `scripts/__tests__/check-tool-consumers.test.sh`); hook/script test loop green; `shellcheck -S error` clean on `scripts/` and `ralph/hooks/scripts/`; `grep -rn` for each removed tool name over `ralph/` and `plugin/` returns only historical thoughts/ docs.
- Manual: MCP inspector (or a live session) shows 22 tools by default and 26 with `RALPH_SRE_ENABLE=true RALPH_DEBUG=false`; `get_issue(1610)` shows `blockedBy: [1609]`; a `batch_update` filter-mode dry run against a parent with open children reports it skipped.

## What We're NOT Doing

- **Not forcing the surface to ≤20.** The two candidate closers both fail the evidence test: `create_status_update` has a live consumer and a unique mutation (research risk 4), and `project_hygiene`→`pipeline_dashboard` is a real merge candidate (same `fetchDashboardItems` spine) but is unscoped, unresearched at parameter level, and belongs to a later wave. The criterion is restated (Design Decisions #1).
- Not extracting `sre__*` into a separate package — gating is the reversible step (plan-of-plans).
- Not touching `get_issue`/`create_issue`/`create_comment` beyond the Phase 6 dependency-read fix (downstream ralph-demo/ralph-playwright consumers; the fix changes data correctness, not response shape).
- Not removing composed workflow tools (`create_sub_issues`, `advance_issue`, `decompose_feature`).
- Not removing `RALPH_DEBUG` — it still gates `debug-logger.ts` JSONL logging and OTel export (`telemetry.ts`) after `collate_debug` is deleted; its CLAUDE.md row is reworded, not removed.
- Not deleting `caretake/modes/debug.md` or `caretake/modes/trends.md` — those deletions belong to #1603 (sibling feature #1590). This plan only neutralizes their references to tools this PR removes.
- Not doing server-side state-machine enforcement (#1592) or task-list-parent (`trackedInIssues`) semantics changes in `dashboard-fetch.ts`/`directions.ts` — the Phase 6 fix is scoped to `get_issue`'s `blocking`/`blockedBy` output only.

## Design Decisions & Open Ambiguities

- **Tool-count target** — options: force a seventh merge to hit ≤20; restate the criterion to the evidence-backed projection. **Decided: restate to 22.** Research risk 1 projected 21 assuming `create_status_update` is cut; keeping it (next decision) lands at 22. Arithmetic: 32 baseline → −1 (Phase 1: `detect_stream_positions`) → −2 (Phase 2: `pipeline_status_summary`, `get_project`) → −2 (Phase 3: `capture_snapshot`, `archive_items`) → −1 (Phase 4: `sync_plan_graph`; `collate_debug` was never default-registered) → −4 (Phase 5: `sre__*` gated) = **22**. Named candidates for a later wave: `project_hygiene`→`pipeline_dashboard` (−1, same fetch spine, caretake-only consumer), `create_status_update` (−1 iff report mode retires), a `health_check`/`setup_project` verify-path consolidation (−1). Evidence beats the round number; Phase 7 asserts 22 and restates #1591's acceptance line on the issue.
- **`create_status_update`** — options: keep the tool; cut it and reroute report posting. **Decided: keep.** Its consumer (catch-up `--mode report`) survives #1603; `createProjectV2StatusUpdate` exists nowhere else in the codebase, so every reroute is a disguised capability drop (`create_comment` posts an issue comment, not a Projects V2 status update visible in the project header; a `gh api graphql` call in skill prose pushes logic OUT of the shared server layer, against the wave's workflow-first principle). Consequence accepted: Phase 1 cuts only `detect_stream_positions`, and the projected count is 22, not 21.
- **`sync_plan_graph`** — options: delete; roster it and invent a caller. **Decided: DELETE** (settled by research §4): it is not hook-warned (`plan-postcondition.sh` has no such check — the claim is stale prose at `plan-shapes.md:163,209`), has never had a roster grant, and its function is already performed at decomposition time by direct `add_dependency`/`create_sub_issues` edge wiring. Tool, lib (`plan-graph.ts`), tests, and the stale prose all go in Phase 4.
- **`collate_debug` ahead of #1603** — options: hold Phase 4 until #1603 lands (board edge #1612←#1603); delete now. **Decided: delete now.** The tool is unrostered, env-gated (absent from the default surface), and its only consumer is prose in `caretake/modes/debug.md` that #1603 deletes. This PR removes the `collate_debug` references from `debug.md` itself (neutralizing edit, not a mode deletion), so the repo is self-consistent regardless of #1603's timing — and Phase 7's prose→roster check would otherwise flag `debug.md` immediately. Reviewer action: remove the #1612←#1603 board edge (or accept it as informational) — this plan supersedes it; note `get_issue` currently cannot display that edge anyway (the Phase 6 defect), so verify via `list_dependencies`.
- **GH-0870 guard placement** — options: preserve status quo (guard only in hygiene candidate selection); add the guard server-side to the merged filter-archive path. **Decided: add server-side.** Research §2 claim 9 shows `archive_items` bulk mode bypasses the guard today; the fold fetches `subIssuesSummary { total }` in the scan query and skips items with `total > 0`, mirroring `findArchiveCandidates()` (`hygiene.ts:142`) exactly. Explicit `issues`/`projectItemIds` selection deliberately bypasses (targeted archive stays possible); skipped items are reported with a reason. This is a small intentional behavior change beyond pure preservation, called out in release notes.
- **`get_issue` dependency-read fix rides this wave** — options: spin off as its own issue; fix here. **Decided: fix here (Phase 6).** It touches `issue-tools.ts` in a wave already editing the tool surface, has in-repo precedent (GH-1470's identical fix in `dashboard-fetch.ts`), silently breaks dependency-aware ordering for every consumer, and the response shape is unchanged (field names stay `blocking`/`blockedBy` — only the data source corrects).
- **Env flag name** — options: `RALPH_SRE_ENABLE`; `RALPH_SRE_TOOLS`. **Decided: `RALPH_SRE_ENABLE`** with strict `=== 'true'` string match — consistent with `RALPH_AUTOPILOT_ENABLE` and the `RALPH_DEBUG` gate pattern (`index.ts:550`).
- **Summary-view strictness** — options: reject dashboard-only params in `view: "summary"`; ignore them. **Decided: ignore, documented in the tool description.** Zod defaults make "explicitly set" detection unreliable; the strictness that protects the ~1-2KB payload guarantee is the `view` enum itself (a typo'd view fails schema validation instead of falling through to full output).
- **Merged `health_check` home** — options: keep in `index.ts` `registerCoreTools` and export `fetchProject` from project-tools; move `health_check` into `project-tools.ts`. **Decided: move into `project-tools.ts`** — one module owns the merged tool, `fetchProject`/`populateFieldCache` stay module-private, and `registerCoreTools` (whose only tool is `health_check`) is deleted.
- **CI check home** — options: extend `check-doc-rosters.sh` with checks 4/5; sibling script. **Decided: sibling `scripts/check-tool-consumers.sh`** — check-doc-rosters is docs⇔source, this is source⇔skill-surface, and #1614 wants fixture tests, which the existing script's repo-rooted design resists (the new script takes an optional root argument for fixture dirs).

None — no open design decisions.

## Implementation Approach

Seven phases: one per member in the plan-of-plans dependency order (#1609 → {#1610, #1611, #1612} → #1613 → #1614), plus the `get_issue` fix as an independent Phase 6 before the closing CI phase. Executed sequentially in the shared worktree `GH-1609` on `feature/GH-1609`, committed per phase; `/ralph:impl --mode pr` emits one `Closes #NNN` per member.

Shared-file ownership: `mcp-server/src/index.ts`, `mcp-server/src/__tests__/tool-registration.test.ts`, `CLAUDE.md`, and `README.md` are touched by multiple phases — each phase edits only the lines/rows for its own tools (manifest entries, registration calls, table rows). Phases are sequential in one branch, so this is ordering discipline, not a merge conflict. Every phase that removes a tool updates the CLAUDE.md/README rows in the same phase — `check-doc-rosters.sh` fails otherwise (documented ⊆ source).

## Phase 1: GH-1609 — Cut `detect_stream_positions`; keep `create_status_update` (documented decision)

- **depends_on**: null

### Overview

Remove the one genuinely zero-consumer tool and its unreachable lib code; record the evidence-backed keep decision for `create_status_update` instead of cutting a working capability.

### Changes Required

#### 1. Tool registration
**File**: `mcp-server/src/tools/dashboard-tools.ts`
**Changes**: Delete the `detect_stream_positions` registration (`:294-375`) and its now-unused imports (`detectStreamPipelinePositions`, `IssueState` from `pipeline-detection.js`; `detectWorkStreams`, `IssueFileOwnership` from `work-stream-detection.js` — verify each import's remaining uses in this file before deleting).

#### 2. Lib pruning
**File**: `mcp-server/src/lib/pipeline-detection.ts`
**Changes**: Delete `detectStreamPipelinePositions` (`:410`) and any helpers reachable only from it. KEEP `detectPipelinePosition` — it backs `get_issue(includePipeline)` (`issue-tools.ts:15`).

**File**: `mcp-server/src/lib/work-stream-detection.ts`
**Changes**: `detectWorkStreams` is still consumed by the dashboard streams section — delete only exports that become unreachable after the registration is gone (verify with `grep -rn` over `src/` excluding `__tests__`). If nothing becomes unreachable, this file is untouched.

#### 3. `create_status_update` — no code change
**File**: `mcp-server/src/tools/project-management-tools.ts`
**Changes**: None. The keep decision (Design Decisions) is recorded in the PR body and the #1609 issue comment: consumer is catch-up `--mode report`, mutation is unique, #1603 does not delete the consumer.

#### 4. Consumers and docs
**File**: `ralph/skills/hero/SKILL.md`
**Changes**: Delete the `mcp__plugin_ralph_ralph-github__ralph_hero__detect_stream_positions` roster line (`:75`).

**Files**: `CLAUDE.md` (dashboard-tools.ts row: drop `detect_stream_positions`), `README.md` (tools table row).

#### 5. Tests
**File**: `mcp-server/src/__tests__/tool-registration.test.ts`
**Changes**: Remove `ralph_hero__detect_stream_positions` from `EXPECTED_TOOLS`.

**Files**: `mcp-server/src/__tests__/pipeline-detection.test.ts` (remove `detectStreamPipelinePositions` cases only), `mcp-server/src/__tests__/work-stream-detection.test.ts` (keep — lib survives; prune only cases for deleted exports, if any).

### Success Criteria

#### Automated Verification
- [ ] `cd mcp-server && npm run build && npm test` green — specifically `tool-registration.test.ts`, `pipeline-detection.test.ts`, `work-stream-detection.test.ts`
- [ ] `bash scripts/check-doc-rosters.sh` green
- [ ] `grep -rn "detect_stream_positions" ralph/ mcp-server/src/ --include='*.md' --include='*.ts' | grep -v __tests__` returns nothing (thoughts/ history excluded)

#### Manual Verification
- [ ] `get_issue(NNN, includePipeline: true)` still returns a `pipeline` block on a live issue (proves `detectPipelinePosition` survived)

## Phase 2: GH-1610 — Merge `pipeline_status_summary` → `pipeline_dashboard`, `get_project` → `health_check`

- **depends_on**: [phase-1]

### Overview

Fold the two read pairs behind parameters: a strict `view` enum on `pipeline_dashboard` returning `buildStatusSummary`'s shape verbatim, and `owner`/`projectNumber`/`includeFields` on `health_check` absorbing `get_project`'s fields payload and cache side effect.

### Changes Required

#### 1. Summary view on `pipeline_dashboard`
**File**: `mcp-server/src/tools/dashboard-tools.ts`
**Changes**: Add `view: z.enum(["full", "summary"]).default("full")` to `pipeline_dashboard`'s schema. When `view: "summary"`: run the existing owner/projectNumbers resolution + `fetchDashboardItems` loop, build `HealthConfig`/`MetricsConfig` from the shared params exactly as `pipeline_status_summary` does today (`:468-481`), return `toolSuccess({ ...buildStatusSummary(items, healthConfig, metricsConfig), ...(fetchWarnings) })` — the `{health, riskScore, velocity, totalIssues, phaseCounts, stuckIssues, wipViolations, blockedDeps}` shape verbatim. `format`/`groupBy`/`issuesPerPhase`/`includeMetrics`/`includeHealth`/`streams`/`archiveAgeDays` are ignored in summary view — say so in the tool description, including the ~1-2KB payload guarantee. Delete the `pipeline_status_summary` registration (`:377-494`). `lib/status-summary.ts` is untouched (preservation target per GH-1552 correction: `buildStatusSummary`'s output shape and its tests, NOT the `phase_completed` event, which lives in the activity log via `impl-verify-commit.sh:58-86`).

#### 2. Merged `health_check`
**File**: `mcp-server/src/tools/project-tools.ts`
**Changes**: Move the `health_check` registration here from `index.ts` (`registerCoreTools`). Add params: `owner?: string`, `projectNumber?: number`, `includeFields?: boolean` (default false). `owner`/`projectNumber` override config for the project-access check and the fields fetch (repo checks stay config-based). When `includeFields: true`: call the module-private `fetchProject` + `populateFieldCache` (`:478` today — the cache side effect setup relies on) and append `project: {id, title, number, url, fields[{id, name, dataType, options[{id, name, color}]}]}` to the response. Existing response shape (`checks`, `orphanRepoIssues`, `config`) unchanged for zero-arg callers. Delete the `get_project` registration (`:437-504`). Note: the moved registration needs `fieldCache` — `registerProjectTools(server, client, fieldCache)` already receives it.

**File**: `mcp-server/src/index.ts`
**Changes**: Delete `registerCoreTools` (its only tool was `health_check`) and its call (`:505`); move any helpers it used (`getAuthenticatedUser` usage, orphan-scan) along with the registration.

#### 3. Consumers and docs
**File**: `ralph/skills/catch-up/SKILL.md`
**Changes**: Delete the `pipeline_status_summary` roster line (`:24`; `pipeline_dashboard` is already granted at `:23`).

**File**: `ralph/skills/catch-up/brief-composition.md`
**Changes**: `:14` — call becomes `ralph_hero__pipeline_dashboard` with `view: "summary"` (keep the soft-dependency degradation prose, retargeted). `:101` and `:161` — replace `mcp__plugin_ralph_ralph-github__ralph_hero__pipeline_status_summary` with `...__pipeline_dashboard` in both headless `--allowedTools` candidate lists. These lists are the out-of-repo rename hazard — named again in Phase 7 release notes for any live #1555 scheduled-task config.

**Files**: `ralph/skills/setup/SKILL.md` (`:19` roster line for `get_project` deleted; `:84` prose becomes "health_check with includeFields: true to verify; setup_project in extend mode"), `ralph/skills/setup/project-fields.md` (`:21` — same retarget), `ralph/skills/setup/setup-state.md` (verify prose — `health_check` semantics unchanged, likely no edit).

**Files**: `CLAUDE.md` (issue-tools/project-tools/dashboard-tools table rows; `health_check` moves module), `README.md` (tools table).

#### 4. Tests
**Files**: `mcp-server/src/__tests__/pipeline-status-summary.test.ts` — retarget to `pipeline_dashboard` with `view: "summary"`; rename to `dashboard-summary-view.test.ts`; assert the exact summary shape and that summary view ignores `format`. `status-summary.test.ts` — untouched (pure lib). `project-tools.test.ts` — retarget `get_project` cases to `health_check {includeFields: true}` (fields payload + cache population). `health-check.test.ts` — extend for override params and backward-compatible zero-arg shape. `tool-registration.test.ts` — remove two names. `ralph/skills/shared/__tests__/mcp-prefix.test.sh` — references `health_check` by name; unchanged (name survives), but run it.

### Success Criteria

#### Automated Verification
- [ ] `cd mcp-server && npm test` green — `dashboard-summary-view.test.ts` (né pipeline-status-summary), `status-summary.test.ts` (untouched, still green), `project-tools.test.ts`, `health-check.test.ts`, `tool-registration.test.ts`, `dashboard.test.ts`, `dashboard-group-by.test.ts`
- [ ] `bash scripts/check-doc-rosters.sh` green
- [ ] `grep -rn "pipeline_status_summary\|ralph_hero__get_project" ralph/ mcp-server/src/ --include='*.md' --include='*.ts' | grep -v __tests__` returns nothing
- [ ] `bash ralph/skills/shared/__tests__/mcp-prefix.test.sh` green

#### Manual Verification
- [ ] `pipeline_dashboard {view: "summary"}` on the live board returns the compact 8-field shape (~1-2KB)
- [ ] `health_check {includeFields: true}` returns checks + the fields/options payload, and a follow-up field mutation works without a separate cache-priming call (side effect preserved)

## Phase 3: GH-1611 — Merge `capture_snapshot` → `metrics_trends`, `archive_items` → `batch_update` (+ server-side GH-0870 guard)

- **depends_on**: [phase-1]

### Overview

Fold snapshot capture behind `capture: true` on `metrics_trends` (default stays offline-capable), and fold archive/unarchive into `batch_update` with a filter selector that preserves all five bulk capabilities and ADDS the open-children guard server-side.

### Changes Required

#### 1. `metrics_trends` gains capture
**File**: `mcp-server/src/tools/trends-tools.ts`
**Changes**: Add `capture: zBoolish().optional().default(false)` and `windowDays: z.number().int().positive().default(7)` (used only when capturing) to `metrics_trends`. When `capture: true`: run the full `capture_snapshot` path (fetch → `buildDashboard` → `calculateMetrics` → best-effort cycle-time enrichment via `fetchTransitionedIssues`/`rollupCycleTimes` → `appendSnapshot`), then compute trends over the now-updated file and return `{snapshot, owner, projectNumber, since, now, series, fetchWarnings?}` — the appended row stays visible to callers (the caretake trends flow prints velocity from it). When `capture: false` (default): the existing pure-local read, still works with GitHub unreachable. Tool description documents both semantics. Delete the `capture_snapshot` registration (`:40-128`). `lib/snapshots.ts`, `lib/trends.ts`, `lib/cycle-times.ts`, and `fixtures/snapshots.fixture.jsonl` untouched (persistence contract unchanged).

#### 2. `batch_update` absorbs archive
**File**: `mcp-server/src/tools/batch-tools.ts`
**Changes**: Extend the schema:
- `operations` items become a union: `{field: "workflow_state"|"estimate"|"priority", value: string}` **or** `{action: "archive"|"unarchive"}` (still 1-3 operations).
- Selectors: `issues?: number[]` (existing, now optional), `projectItemIds?: string[]` (draft items), `filter?: {workflowStates: string[], updatedBefore?: string, maxItems?: number}` — `filter` mutually exclusive with `issues`/`projectItemIds`.
- Top-level `dryRun: zBoolish().default(false)`.
- Validation (toolError on violation): field ops require `issues`; `filter` valid only with exactly one `archive` operation; `unarchive` requires `issues` or `projectItemIds`; at least one selector present.
- Filter mode ports `archive_items`' scan-until-full pagination (SCAN_CAP 2000, cap-200 maxItems, `hasMore`/`totalScanned`, `updatedBefore` validation) — move the `RawBulkArchiveItem` scan machinery here from `project-management-tools.ts` — and ADDS `subIssuesSummary { total }` to the scan query's Issue fragment, skipping items with `total > 0` (mirrors `findArchiveCandidates()`, `hygiene.ts:142`). Skipped parents are reported as `skipped: [{number, reason: "open-or-any-children"}]`. Explicit `issues`/`projectItemIds` selection bypasses the guard by design (deliberate targeting).
- Response: field ops keep the existing `BatchResult`; archive ops return `{dryRun, archivedCount|wouldArchive, items, skipped, errors, hasMore, totalScanned}`.

**File**: `mcp-server/src/tools/project-management-tools.ts`
**Changes**: Delete the `archive_items` registration (`:131-424`) and the scan machinery moved to batch-tools. `create_status_update` (`:43`) stays — the module survives.

#### 3. Consumers and docs
**File**: `ralph/skills/caretake/SKILL.md`
**Changes**: Delete the `archive_items` roster line (`:78`) and the `capture_snapshot` roster line (locate by grep); `batch_update` (`:74`) and `metrics_trends` grants stay.

**File**: `ralph/skills/caretake/modes/hygiene.md`
**Changes**: `:95-102` — the bulk-archive call becomes `ralph_hero__batch_update` with `filter: {workflowStates: [...], updatedBefore: ...}`, `operations: [{action: "archive"}]`, `dryRun` per `RALPH_HYGIENE_DRY_RUN`; error handling prose (`HYGIENE BLOCKED`) retargets the new tool name.

**File**: `ralph/skills/caretake/modes/trends.md`
**Changes**: `:21,49` capture calls become `metrics_trends {capture: true, windowDays: ...}`; `:27,38` read calls unchanged. (This file is deleted later by #1603 — the edit keeps the repo consistent whichever lands first; whoever lands second re-does the sweep, per research risk 3.)

**Scheduled-capture ownership** (research OQ3, named per plan requirement): today the capture cadence is owned by `caretake --mode trends` under the `--mode all`/`caretake:all` heartbeat fan-out (ralph/CLAUDE.md loop matrix). After this phase the callable path is `metrics_trends {capture: true}`; when #1603 deletes trends.md, #1603's plan must re-point the `--mode all` fan-out (or a scheduled task) at that call — recorded here and in the PR body so the capability is not dropped silently.

**Files**: `CLAUDE.md` (trends-tools/project-management-tools/batch-tools rows; "Performance tracking over time" section retargets `capture_snapshot` → `metrics_trends {capture: true}`), `README.md`.

#### 4. Tests
**Files**: `mcp-server/src/__tests__/trends-tools.test.ts` — add capture-mode cases (append happens, snapshot returned, trends computed post-append; `capture: false` path untouched offline). `snapshots.test.ts`, `trends.test.ts`, `cycle-times.test.ts` — untouched. `bulk-archive.test.ts` — retarget to `batch_update` filter mode; ADD guard coverage: scan result including an item with `subIssuesSummary.total > 0` is skipped and reported. `batch-tools.test.ts` — union-schema validation cases (filter+field-op rejected, unarchive-without-issues rejected, etc.). `project-management-tools.test.ts` — drop archive cases, keep `create_status_update` cases. `hygiene.test.ts` — untouched (guard already covered there). `tool-registration.test.ts` — remove two names.

### Success Criteria

#### Automated Verification
- [ ] `cd mcp-server && npm test` green — `trends-tools.test.ts`, `snapshots.test.ts`, `trends.test.ts`, `bulk-archive.test.ts`, `batch-tools.test.ts`, `project-management-tools.test.ts`, `hygiene.test.ts`, `tool-registration.test.ts`
- [ ] `bash scripts/check-doc-rosters.sh` green
- [ ] `grep -rn "capture_snapshot\|archive_items" ralph/ mcp-server/src/ --include='*.md' --include='*.ts' | grep -v __tests__` returns nothing

#### Manual Verification
- [ ] `metrics_trends {capture: true}` on the live board appends one row to `~/.ralph-hero/snapshots/<owner>/<project>.jsonl` and returns snapshot + series; `metrics_trends` (no args) still works with network off
- [ ] `batch_update {filter: {workflowStates: ["Done"]}, operations: [{action: "archive"}], dryRun: true}` on the live board previews candidates and lists any open-children parents under `skipped`

## Phase 4: GH-1612 — Delete the orphans: `sync_plan_graph` and `collate_debug` (+ stale-prose repair)

- **depends_on**: [phase-1]

### Overview

Delete both orphans per the evidence (Design Decisions), including the fictional hook claim in plan prose and the `collate_debug` references in caretake's debug mode — leaving `RALPH_DEBUG` itself intact for logging/OTel.

### Changes Required

#### 1. `sync_plan_graph` deletion
**Files**: `mcp-server/src/tools/plan-graph-tools.ts` (delete file), `mcp-server/src/lib/plan-graph.ts` (delete file), `mcp-server/src/index.ts` (remove `registerPlanGraphTools` import + call at `:537-538`).
**Tests deleted**: `mcp-server/src/__tests__/plan-graph.test.ts`, `plan-graph-tools.test.ts`.

#### 2. `collate_debug` deletion
**Files**: `mcp-server/src/tools/debug-tools.ts` (delete file), `mcp-server/src/index.ts` (remove the `RALPH_DEBUG` registration gate at `:549-552` + import). `debug-logger.ts` and `telemetry.ts` are NOT touched — `RALPH_DEBUG` still gates them.
**Tests deleted**: `collate-debug-langfuse.test.ts`, `collate-debug-phase3b.test.ts`, `collate-debug-roundtrip.test.ts`. `debug-issue-shape.test.ts`: inspect — delete if it only covers `collate_debug`'s issue shape; keep any debug-logger coverage.

#### 3. Stale-prose repair (required under every outcome — research risk 6)
**File**: `ralph/skills/plan/plan-shapes.md`
**Changes**: `:150` — drop "and by `sync_plan_graph` for graph snapshots" from the `depends_on` consumption sentence. `:163` and `:209` — delete the claims that `plan-postcondition.sh` greps `depends_on.*\[` / warns when `sync_plan_graph` wasn't called (the hook has no such logic — fictional behavior).

**File**: `ralph/skills/plan/decomposition.md`
**Changes**: `:90` — replace the "`sync_plan_graph` remains the post-hoc reconciliation path" paragraph with: post-hoc edge repair is manual `add_dependency`/`remove_dependency`.

**File**: `ralph/skills/caretake/modes/debug.md`
**Changes**: Neutralizing edit only (mode deletion is #1603's): remove/replace the `collate_debug` call instructions (`:3,15,57,146`) with a note that the tool was removed in this wave and the mode is pending #1603. Keeps Phase 7's prose→roster check green without an exemption entry.

**Files**: `CLAUDE.md` (tool-modules rows for `plan-graph-tools.ts` and `debug-tools.ts` deleted; lib-modules row for `plan-graph.ts` deleted; `RALPH_DEBUG` env row reworded to logging/OTel only; "debug-tools.ts (only registered when RALPH_DEBUG=true)" mention removed), `README.md` (`:89` tool mentions).

#### 4. Tests
**File**: `mcp-server/src/__tests__/tool-registration.test.ts`
**Changes**: Remove `ralph_hero__sync_plan_graph` from the manifest; update the header comment that explains `collate_debug`'s exclusion (tool no longer exists rather than being gated).

### Success Criteria

#### Automated Verification
- [ ] `cd mcp-server && npm run build && npm test` green (build proves no dangling imports); `tool-registration.test.ts`, `debug-logger.test.ts`, `telemetry`-related suites green
- [ ] `bash scripts/check-doc-rosters.sh` green
- [ ] Hook tests green: `find ralph/hooks/scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \) -print0 | xargs -0 -n1 bash` (plan-postcondition untouched — evidence anchor only)
- [ ] `grep -rn "sync_plan_graph\|collate_debug" ralph/ mcp-server/src/ scripts/ --include='*.md' --include='*.ts' --include='*.sh' | grep -v __tests__` returns nothing

#### Manual Verification
- [ ] With `RALPH_DEBUG=true`, the server starts, JSONL debug logging and OTel export still function, and no `collate_debug` tool appears

## Phase 5: GH-1613 — Gate the four `sre__*` tools behind `RALPH_SRE_ENABLE`

- **depends_on**: null

### Overview

Mirror the `RALPH_DEBUG` registration gate for `registerSreTools`; document the loud-failure contract on the `sre-fixit` agent; cover both flag states in tests.

### Changes Required

#### 1. Registration gate
**File**: `mcp-server/src/index.ts`
**Changes**: Wrap the `registerSreTools(server, client, fieldCache)` call (`:547`) in `if (process.env.RALPH_SRE_ENABLE === 'true') { ... }` with a comment mirroring the debug gate's. `sre-tools.ts` itself unchanged (research §5: its `client`/`fieldCache` params are already unused placeholders).

#### 2. Agent documentation
**File**: `ralph/agents/sre-fixit.md`
**Changes**: Add a prerequisite paragraph: "Requires `RALPH_SRE_ENABLE=true` in the MCP server environment; without it the four `sre__*` ops are absent (agent `tools:` lists are hard runtime allowlists — they cannot conjure unregistered tools) and this agent can only read/comment/escalate." Document-don't-fallback per the issue.

#### 3. Docs
**Files**: `CLAUDE.md` — new env-var table row for `RALPH_SRE_ENABLE` (with the sre-fixit prerequisite called out); `sre-tools.ts` row in the tool-modules table annotated "(only registered when RALPH_SRE_ENABLE=true)". `README.md` — matching note.

#### 4. Tests — one file per flag state
**File**: `mcp-server/src/__tests__/tool-registration.test.ts`
**Changes**: Remove the four `ralph_hero__sre__*` names from `EXPECTED_TOOLS`; `beforeAll` additionally does `delete process.env.RALPH_SRE_ENABLE` (mirroring the existing `RALPH_DEBUG` handling); manifest comment documents the gating.

**File**: `mcp-server/src/__tests__/tool-registration-sre-enabled.test.ts` (new)
**Changes**: Copy the harness (mock `McpServer.tool`, `RALPH_HERO_RUN_MAIN=true`, dynamic import); set `process.env.RALPH_SRE_ENABLE = "true"` BEFORE the import; assert the four `sre__*` names are registered. A second file is mandatory — the module cache prevents in-file toggling (research §5). `sre-tools.test.ts` (typed argv builders) unchanged.

### Success Criteria

#### Automated Verification
- [ ] `cd mcp-server && npm test` green — `tool-registration.test.ts` (flag off: 4 names absent), `tool-registration-sre-enabled.test.ts` (flag on: 4 names present), `sre-tools.test.ts`
- [ ] `bash scripts/check-doc-rosters.sh` green (sre rows still documented — they exist in source)

#### Manual Verification
- [ ] Server started without the flag exposes no `sre__*` tools; with `RALPH_SRE_ENABLE=true` all four appear

## Phase 6: `get_issue` dependency-read fix (bonus defect — no member issue; ships in the group PR)

- **depends_on**: null

### Overview

Fix `get_issue` to read `blocking`/`blockedBy` from the native dependency connections that `add_dependency` writes, instead of the legacy task-list `trackedInIssues`/`trackedIssues` — same defect class GH-1470 fixed in `dashboard-fetch.ts`. Response field names are unchanged; only the data source corrects.

### Changes Required

#### 1. Query + mapping
**File**: `mcp-server/src/tools/issue-tools.ts`
**Changes**: In `get_issue`'s GraphQL query, replace `trackedInIssues(first: 20)` / `trackedIssues(first: 20)` (`:716-721`) with `blocking(first: 20) { nodes { number title state } }` / `blockedBy(first: 20) { nodes { number title state } }` (pattern proven at `relationship-tools.ts:536-547`). Update the TS response interface (`:665-670`) and the output mapping (`:998-1007`): `blocking` ← `issue.blocking.nodes`, `blockedBy` ← `issue.blockedBy.nodes`. No other `get_issue` behavior changes; `dashboard-fetch.ts`'s `trackedInIssues`-as-parent use and `directions.ts` are explicitly out of scope.

#### 2. Tests
**File**: `mcp-server/src/__tests__/issue-tools.test.ts`
**Changes**: Update the mock fixture (`:402-403`) to `blocking`/`blockedBy` connection keys. Add regression cases mirroring `dashboard-fetch.test.ts:127,145`: (a) native `blockedBy` edges populate the output; (b) task-list `trackedIssues` data does NOT (an issue with only task-list references reports `blockedBy: []`).

**Files**: Sweep other suites whose get_issue-shaped mocks carry `trackedIssues`/`trackedInIssues` keys for THIS query — `cross-tool-consistency.test.ts:125-126` and any others found by `grep -rn "trackedIssues" mcp-server/src/__tests__/` that mock `get_issue` (fixtures mocking `list_issues`/dashboard fetch payloads are untouched — those queries legitimately still use task-list fields for parent detection).

### Success Criteria

#### Automated Verification
- [ ] `cd mcp-server && npm test` green — `issue-tools.test.ts` (including both new regression cases), `cross-tool-consistency.test.ts`, `group-detection.test.ts`
- [ ] `grep -n "trackedIssues\|trackedInIssues" mcp-server/src/tools/issue-tools.ts` returns nothing

#### Manual Verification
- [ ] `get_issue(1610)` on the live board reports `blockedBy: [#1609]` and `get_issue(1609)` reports `blocking` containing #1610/#1611/#1612 — matching `list_dependencies` output

## Phase 7: GH-1614 — Two-direction CI cross-reference check, final count assertion, docs, release notes

- **depends_on**: [phase-1, phase-2, phase-3, phase-4, phase-5, phase-6]

### Overview

Make both drift directions impossible in CI, assert the final 22-tool manifest, finish the doc sweep, restate #1591's acceptance criterion with the arithmetic, and write the release notes the auto-release makes load-bearing.

### Changes Required

#### 1. New CI script — both directions
**File**: `scripts/check-tool-consumers.sh` (new; sibling of `check-doc-rosters.sh`, whose awk/grep/comm idiom it copies — ShellCheck severity=error clean)
**Changes**: Accepts an optional root argument (default: repo root via `git rev-parse`) so fixture tests can point it at temp dirs. Two checks:
- **Direction A, prose→roster** (the `sync_plan_graph` failure class): for each skill dir `ralph/skills/<verb>/` (excluding `shared/`, `using-html/`), collect `ralph_hero__[a-z_]+` matches from all `.md` bodies (SKILL.md body below frontmatter + sibling refs + `modes/`), and FAIL any name not granted in that dir's SKILL.md `allowed-tools` as `mcp__plugin_ralph_ralph-github__ralph_hero__<name>`. Per-file exemption allowlist (in-script, commented) for documented negatives — seed entry: `ralph/skills/research/research-shapes.md` ↔ `decompose_feature` ("via `Read`, not `decompose_feature`").
- **Direction B, registration→consumer** (the `detect_stream_positions` failure class): every tool name registered in `mcp-server/src/**/*.ts` (excluding `__tests__`) must appear in ≥1 skill `allowed-tools` OR ≥1 `ralph/agents/*.md` `tools:` line. Maintain an explicit `GATED_TOOLS` list (the four `sre__*` names) with a comment — the source grep cannot distinguish gated from unconditional registration (`check-doc-rosters.sh:153-158` has the same blindness); the sre tools would pass anyway via the `sre-fixit` agent roster, but the list documents the gating for future gated tools.

#### 2. Script tests
**File**: `scripts/__tests__/check-tool-consumers.test.sh` (new)
**Changes**: Harness per `merge-pr-gates.test.sh` (`set -euo pipefail`, `mktemp -d` + trap cleanup, PASS/FAIL counter functions, inline fixtures — no `gh` stub needed, pure filesystem). Cases: (1) fixture skill dir whose prose names an ungranted tool → exit 1 + the specific Direction-A FAIL line; (2) fixture source tree registering a tool with no roster/agent consumer → exit 1 + Direction-B FAIL line; (3) clean fixture → exit 0; (4) exemption-list entry suppresses a Direction-A hit; (5) the real repo passes (`bash scripts/check-tool-consumers.sh` → exit 0). CI already discovers this file via the `find ralph/hooks/scripts/__tests__ scripts/__tests__ ...` loop (`ci.yml:117-123`).

#### 3. CI wiring
**File**: `.github/workflows/ci.yml`
**Changes**: Add a `check-tool-consumers` step to the existing `check-doc-rosters` job (`:287-295`) running `bash scripts/check-tool-consumers.sh` (same trigger surface). actionlint + zizmor lint the change; the ShellCheck job already covers `scripts/`.

#### 4. Final count assertion
**File**: `mcp-server/src/__tests__/tool-registration.test.ts`
**Changes**: The manifest now holds exactly these 22 names: `add_dependency`, `add_sub_issue`, `advance_issue`, `batch_update`, `create_comment`, `create_issue`, `create_status_update`, `create_sub_issues`, `decompose_feature`, `get_issue`, `health_check`, `list_dependencies`, `list_issues`, `list_sub_issues`, `metrics_trends`, `next_actions`, `pipeline_dashboard`, `project_hygiene`, `recent_activity`, `remove_dependency`, `save_issue`, `setup_project`. Add `expect(EXPECTED_TOOLS.length).toBe(22)` with a comment carrying the arithmetic (32 −1 −2 −2 −1 −4 = 22) and the restated criterion rationale (Design Decisions #1: evidence-backed scope lands at 22, not ≤20; later-wave candidates named).

#### 5. Docs + criterion restatement + release notes
**Files**: `CLAUDE.md`, `README.md` — final sweep of tool tables against the 22 + 4-gated surface; README's tool-count prose (~32 → 22 default + 4 gated).

**Issue #1591**: post a comment restating the acceptance line: "Registered tool count ≤20" → "default-registered count = 22 (asserted in tool-registration.test.ts)", with the arithmetic table and the named later-wave candidates (`project_hygiene`→`pipeline_dashboard`; `create_status_update` iff report mode retires).

**PR body — `## Release notes: tool surface changes`** (load-bearing: this merge triggers `release.yml` → version bump, npm publish with OIDC provenance, `ralph/.mcp.json` pin — one release carries every removal; rollback is one version pin):
- Removed: `detect_stream_positions` (no replacement — zero consumers), `pipeline_status_summary` (→ `pipeline_dashboard {view: "summary"}`), `get_project` (→ `health_check {includeFields: true}`), `capture_snapshot` (→ `metrics_trends {capture: true}`), `archive_items` (→ `batch_update` archive/unarchive operations + `filter`), `sync_plan_graph` (no replacement — wire edges at decomposition; manual `add_dependency` repair), `collate_debug` (no replacement; `RALPH_DEBUG` still gates logging/OTel).
- Gated (absent by default): `sre__scale`, `sre__rollout_restart`, `sre__delete_pod`, `sre__drain` — set `RALPH_SRE_ENABLE=true`.
- Behavior changes: filter-driven archive now skips parents with children server-side (GH-0870 guard, closing a bypass); `get_issue` `blocking`/`blockedBy` now reflect real dependency edges.
- Retained for downstream consumers: `get_issue`, `create_issue`, `create_comment` (ralph-demo, ralph-playwright).
- Out-of-repo consumers to check: headless `--allowedTools` lists naming `pipeline_status_summary` (from `brief-composition.md:101,161` adopters / #1555 scheduled tasks); machine-local scheduled `capture_snapshot` calls.

### Success Criteria

#### Automated Verification
- [ ] `bash scripts/check-tool-consumers.sh` exits 0 on the repo; `bash scripts/__tests__/check-tool-consumers.test.sh` passes all five cases
- [ ] `shellcheck -S error scripts/*.sh scripts/__tests__/*.sh` clean
- [ ] `cd mcp-server && npm test` fully green; `tool-registration.test.ts` asserts exactly 22 names; `tool-registration-sre-enabled.test.ts` green
- [ ] `bash scripts/check-doc-rosters.sh` green
- [ ] Hook + script test loop green: `find ralph/hooks/scripts/__tests__ scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \) -print0 | xargs -0 -n1 bash`

#### Manual Verification
- [ ] Temporarily adding a fake `ralph_hero__nonexistent` mention to a skill sibling .md makes `check-tool-consumers.sh` fail with the Direction-A message (then revert)
- [ ] PR body release-notes section reviewed against the removed-tool list above before merge

## Testing Strategy

### Unit Tests
Per phase, named above. Net test-file delta: deleted (`plan-graph.test.ts`, `plan-graph-tools.test.ts`, 3× `collate-debug-*.test.ts`, possibly `debug-issue-shape.test.ts`), renamed/retargeted (`pipeline-status-summary.test.ts` → `dashboard-summary-view.test.ts`, `bulk-archive.test.ts` → batch_update filter mode), extended (`health-check`, `trends-tools`, `batch-tools`, `issue-tools`, `tool-registration`), new (`tool-registration-sre-enabled.test.ts`, `scripts/__tests__/check-tool-consumers.test.sh`). Preservation anchors that must remain green UNCHANGED: `status-summary.test.ts` (GH-1552 shape), `hygiene.test.ts` (GH-0870 guard), `snapshots.test.ts` + `snapshots.fixture.jsonl` (persistence contract).

### Integration Tests
`tool-registration.test.ts` (default surface) + `tool-registration-sre-enabled.test.ts` (flag-on surface) together prove the registration matrix. `check-tool-consumers.test.sh` case 5 runs the real repo end-to-end. After each removing phase, `grep` sweeps (in the phase criteria) prove no live reference survives outside thoughts/ history — the ralph-knowledge eval-corpus fixture (`plugin/ralph-knowledge/__tests__/eval-corpus/2026-04-22-context-handoff-topology.md`) is corpus text, deliberately untouched.

### Manual Testing Steps
1. Build and run the server locally; list tools with no flags (expect 22), with `RALPH_SRE_ENABLE=true` (expect 26), with `RALPH_DEBUG=true` (expect no `collate_debug` — deleted).
2. Live-board smoke: `pipeline_dashboard {view: "summary"}`; `health_check {includeFields: true}`; `metrics_trends {capture: true}`; `batch_update` archive dry run; `get_issue(1610).blockedBy`.
3. Run `/ralph:catch-up --mode report --dry-run` and `/ralph:caretake --mode hygiene` (dry run) to exercise the retargeted skill prose.

## Performance Considerations

- Summary view keeps the ~1-2KB payload guarantee via the strict `view` enum (no silent fallthrough to full output).
- `metrics_trends {capture: true}` pays one extra local JSONL scan versus the old capture-only call — harmless (research §3b), noted in the tool description.
- Adding `subIssuesSummary { total }` to the archive scan query marginally grows the per-page payload; pagination caps (SCAN_CAP 2000, page 100) are unchanged.

## Migration Notes

- **Release**: one PR → one `release.yml` run → one npm version + `ralph/.mcp.json` pin carrying 7 removals + 4 gatings + 2 behavior changes. Rollback is a single version pin revert. The Phase 7 release-notes section is the downstream contract.
- **Merge path**: `main` rejects direct pushes — `scripts/attest-pr.sh` then `scripts/merge-pr.sh <PR>`. The research doc, plan-of-plans, and this plan are committed on `feature/GH-1609` and land in the same PR as the code.
- **Board**: `sync-pr-merge.yml` moves all six members to Done on merge (one `Closes #NNN` per member in the PR body). The #1612←#1603 board edge is superseded by the Design Decision above — reviewer removes it or ignores it; verify edges via `list_dependencies` until Phase 6 ships.
- **Cross-feature coordination (#1603, sibling feature #1590)**: this PR edits `caretake/modes/trends.md` and `caretake/modes/debug.md`, which #1603 later deletes; whichever lands second re-runs the consumer sweep (research risk 3). #1603's plan must also name the scheduled-capture surface that calls `metrics_trends {capture: true}` after trends.md dies (Phase 3 note).
- **Out-of-repo consumers**: machines with headless allowlists naming `pipeline_status_summary`, or scheduled `capture_snapshot` invocations, must retarget after the release — named in release notes.

## References

- Research (authoritative): `thoughts/shared/research/2026-07-26-GH-1591-tool-surface-reduction-sweep.md`
- Plan-of-plans: `thoughts/shared/plans/2026-07-26-GH-1591-plan-of-plans.md`
- Issues: #1591 (parent), #1609–#1614 (members), #1588 (epic), #1603/#1590 (sibling-feature coupling)
- Key code anchors: `mcp-server/src/index.ts:505-552`; `dashboard-tools.ts:294-494`; `project-tools.ts:437-504`; `project-management-tools.ts:43,131-424`; `batch-tools.ts:224-`; `trends-tools.ts:40-209`; `issue-tools.ts:665-670,716-721,998-1007`; `lib/hygiene.ts:142`; `lib/pipeline-detection.ts:410`; `relationship-tools.ts:536-547`; `__tests__/tool-registration.test.ts:158-194`; `scripts/check-doc-rosters.sh:140-170`; `.github/workflows/ci.yml:117-123,277-295`
- Prior art: GH-1470 (`dashboard-fetch` native-blockedBy fix), GH-1552 plan, GH-0870 plan, wave 1 PR #1570
