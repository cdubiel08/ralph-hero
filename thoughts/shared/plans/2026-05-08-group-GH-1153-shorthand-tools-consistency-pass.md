---
date: 2026-05-08
status: draft
type: plan
tags: [discovery-tools, consistency, mcp-tools, shorthand, refactoring, ralph-hero, tpm-ergonomics]
github_issue: 1153
github_issues: [1153]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1153
primary_issue: 1153
---

# Shorthand discovery tools — consistency and elegance pass (Group Plan)

## Prior Work

- builds_on:: [[2026-05-08-shorthand-tools-counts-and-filters]] (research — primary evidence; the 7-inconsistency audit this plan addresses)
- builds_on:: [[2026-05-07-GH-1129-list-issues-totalcount-misleading]] (research — defines the count-field cleanup precedent Phase 3 inherits)
- builds_on:: [[2026-05-07-GH-1129-list-issues-totalcount-misleading]] (plan — already-drafted XS atomic; referenced as in-flight, NOT absorbed)
- builds_on:: [[2026-04-30-group-GH-0921-hello-directions-implementation]] (plan — canonical `next_actions` ranking spec)
- builds_on:: [[2026-05-02-hello-composable-rewrite]] (research — `/hello` skill composition reference)

## Overview

A consistency-and-elegance pass on the ralph-hero shorthand discovery surface (~13 MCP tools + 5 wrapping skills). The 2026-05-08 audit documented seven structural inconsistencies that mislead non-implementer audiences (TPM / PO / tech-lead) and structurally prevent autopilot from clearing a `Backlog`-heavy board.

This is a **group plan** (parent issue + 8 atomic sub-issues, each shipping its own PR). Mostly XS/S; one M (Phase 4 — threshold centralization) due to cross-module surface area. Total estimated work: ~6–8 atomic PRs.

| Phase | Title | Estimate | Wave |
|-------|-------|----------|------|
| 1 | Widen `next_actions` for `audience="agent"` (Backlog/null-state fallback) | XS | 1 |
| 2 | Internalize PR fetch in `next_actions` (BREAKING — drop `openPRs` param) | S | 1 |
| 3 | Unify count field names across discovery tools | S | 1 |
| 4 | Centralize threshold defaults to `src/lib/thresholds.ts` + harmonize redundant pairs | M | 1 |
| 5 | Surface repo-scope mismatch via `health_check` warning | XS | 1 |
| 6 | Remove deprecated `hello_directions` and `pick_actionable_issue` | XS | 2 |
| 7 | Cross-tool count consistency tests | S | 3 |
| 8 | Audit skill output for explanatory flourishes | S | 1 |

**Posture**: code-fix-everything. Tool descriptions are rewritten as part of each phase and become the canonical reference (no separate glossary doc). Skill output prose (Phase 8) is tightened so user-visible text reads as results, not narration.

## Shared Constraints

- **Module system**: ESM with `"module": "NodeNext"`. All internal imports use `.js` extensions on TypeScript source.
- **Build/typecheck gate**: `npm run build` (`tsc`) is the primary code-quality gate; strict mode enabled.
- **Test runner**: vitest 4. Run from `plugin/ralph-hero/mcp-server/`.
- **Tool response shape**: Use `toolSuccess(...)` / `toolError(...)` from `src/types.ts`.
- **Auto-release awareness**: Merges to `main` touching `mcp-server/src/` auto-bump the patch version and publish to npm. Phase 2 (breaking) and Phase 6 (deprecation removal) MUST include `#minor` or `#major` markers in the merge commit message.
- **Tool description discipline**: Every changed tool's `server.tool(name, description, ...)` description string MUST be rewritten to clearly state: what it counts, what it filters, what's silently dropped, default thresholds + units. The description is the user-facing doc.
- **No backwards-compat shims**: Per the project posture, deprecated fields/params are removed cleanly when they go. No `// removed for X` comments or aliased re-exports.

## Current State Analysis

The audit document (`thoughts/shared/research/2026-05-08-shorthand-tools-counts-and-filters.md`) documents the full picture. Summary of the seven dimensions and what's already centralized:

**Already centralized per-module** (no scattered defaults):
- `DEFAULT_RANK_CONFIG` (`src/lib/directions.ts:210-213`): `stuckThresholdHours=48`, `lockStaleHours=24`, `treeRecentDoneDays=7`, `prStaleHours=24`
- `DEFAULT_DASHBOARD_CONFIG` (`src/lib/dashboard.ts:163-167`): `stuckThresholdHours=48`, `criticalStuckHours=stuck×2`, `doneWindowDays=7`, `archiveThresholdDays=14`
- `DEFAULT_HYGIENE_CONFIG` (`src/lib/hygiene.ts:24-29`): `archiveDays=14`, `staleDays=7`, `orphanDays=14`, `similarityThreshold=0.8`
- `DEFAULT_METRICS_CONFIG` (`src/lib/metrics.ts:35-39`): `velocityWindowDays=7`, `atRiskThreshold=2`, `offTrackThreshold=6`

**Cross-module duplications** (the elegant-collapse target for Phase 4):
- `archiveThresholdDays` (dashboard) and `archiveDays` (hygiene) — both default to 14, both describe "Done/Canceled item age before archive eligibility". Same concept, two names.
- `staleDays=7` (hygiene non-terminal), `doneWindowDays=7` (dashboard recent completions), `treeRecentDoneDays=7` (directions sibling completion) — same value, three distinct concepts. Phase 4 keeps the names but factors out the `RECENT_WINDOW_DAYS=7` shared constant they all reference, so changing one changes all three.
- `stuckThresholdHours=48` appears in both `directions.ts` and `dashboard.ts` — same value, same meaning, two definitions.

**Production callers of deprecated tools** (`pick_actionable_issue` migration target for Phase 6):
- `plugin/ralph-hero/skills/team/SKILL.md:23` — allowed-tools list
- `plugin/ralph-hero/skills/hero/SKILL.md:37` — allowed-tools list

`hello_directions` has no production callers (only test fixtures and the registration itself).

**`openPRs` callers** (Phase 2 breaking-change blast radius):
- `plugin/ralph-hero/skills/hello/SKILL.md` — only production caller
- Test fixtures in `directions-tools.test.ts` — must be updated

## Desired End State

After all 8 phases land:

- `next_actions(audience="agent")` returns Backlog and null-state items as fallback when no items are in `ACTIONABLE_PHASES` — autopilot can clear a Backlog-heavy board.
- `next_actions` fetches open PRs internally; callers no longer pass `openPRs[]`.
- All discovery tools return a uniform `boardItems` (raw, pre-filter) count field. Tool-specific post-filter counts (`directions[].length`, `phases[].count`, `filteredCount`, `summary[category]`) keep their distinct names but are clearly documented.
- All threshold defaults live in `src/lib/thresholds.ts`. The `archiveThresholdDays`/`archiveDays` duplication is collapsed into `archiveAgeDays`. The shared 7-day window is factored out as `RECENT_WINDOW_DAYS`.
- `health_check` reports the count of orphan repo issues (in repo but not on project board).
- `hello_directions` and `pick_actionable_issue` are deleted from the codebase. `team/SKILL.md` and `hero/SKILL.md` use `next_actions(audience="agent", limit=1)`.
- A vitest cross-tool integration test asserts count-field semantics agree across `next_actions`, `pipeline_dashboard`, `list_issues`, `project_hygiene`.
- Skills render results without narrating internal filter rationale — explanatory prose is moved from output text into source comments and instruction blocks.

### Verification (final, after all phases)

- [ ] `npm run build` clean across all changed files
- [ ] `npm test` passes including new cross-tool consistency tests (Phase 7)
- [ ] `next_actions(audience="agent")` against a Backlog-only board returns at least one direction (manual test, Phase 1)
- [ ] `gh mcp` invocation of `next_actions` succeeds without `openPRs` (manual test, Phase 2)
- [ ] All 4 discovery tools return a `boardItems` field with the same value against a fresh fixture (Phase 3 + Phase 7 cross-test)
- [ ] `src/lib/thresholds.ts` exists; the 4 `DEFAULT_*_CONFIG` objects re-export from it (Phase 4)
- [ ] `health_check` returns a `orphanRepoIssues: { count, sample }` field when orphans exist (Phase 5)
- [ ] `grep -r "hello_directions\|pick_actionable_issue"` returns 0 hits in `src/`, `skills/`, `agents/` (Phase 6)
- [ ] Skill output for `/hello`, `/status`, `/catch-up`, `/trends`, autopilot does not narrate filter decisions (Phase 8 — manual review against checklist)

### Key Discoveries (from research and validation)

- `ACTIONABLE_PHASES` is defined in `directions.ts:221-226`, NOT in the canonical `workflow-states.ts`. This is the structural reason the filter has drifted from the state machine without test failures — it's a private contract of one tool.
- `DASHBOARD_ITEMS_QUERY` (`src/lib/dashboard-fetch.ts:132`) is shared infrastructure with 5 production callers (`pipeline_dashboard`, `project_hygiene`, `metrics_trends`, `next_actions` via `toDashboardItems()`, internal `fetchDashboardItems`). Phase 3's count-rename touches the response layer, NOT the shared fetch layer.
- The `audience` parameter in `directions.ts:318-323` only modifies score (`audiencePenalty`), not the candidate set. Phase 1 introduces the first audience-conditional candidate-set behavior.

## What We're NOT Doing

- Not absorbing `GH-1129` (`list_issues.totalCount` removal). It is already drafted as an XS atomic plan; Phase 3 inherits its naming pattern and references it but does not duplicate the work.
- Not modifying `paginateConnection` / `PaginatedResponse<T>` (`src/lib/pagination.ts`). Other callers depend on its `totalCount` return shape.
- Not changing the `WORKFLOW_STATE_TO_STATUS` map or any state-machine definitions in `src/lib/workflow-states.ts`. Phase 1 widens `next_actions`'s candidate set, NOT the state machine itself.
- Not touching the activity log surface (`recent_activity` / `~/.ralph-hero/activity/`) — it's a separate persistence surface with no workflow-state concept and no overlap with the count-rename work.
- Not changing `metrics_trends` or `capture_snapshot` count semantics — snapshots are point-in-time and out of scope for cross-tool consistency.
- Not adding a separate "TPM/PO glossary" markdown doc. Tool descriptions and `CLAUDE.md` are the documentation surface.
- Not touching the relationship-tools (`list_sub_issues`, `list_dependencies`, `list_groups`) — they have their own count semantics that the audit flagged as out of scope.
- Not changing default *values* in Phase 4 except where two parameter names collide on the same concept. Behavior preservation is the constraint; only names and module location change.

## Implementation Approach

Eight phases organized into three dependency waves:

- **Wave 1** (parallel, no inter-phase deps): Phases 1, 2, 3, 4, 5, 8 — all touch independent surfaces.
- **Wave 2** (after Wave 1): Phase 6 — depends on Phase 1 (widened agent set must replace `pick_actionable_issue`'s narrowing) and Phase 3 (count rename must land before deprecation removal so the migration is to the new shape).
- **Wave 3** (validation): Phase 7 — depends on Phases 1–4 having landed so the cross-tool tests assert against the new contract.

Each phase ships as one atomic PR. Sub-issues will be filed at plan-link time. Phase 4 is the largest (M); the rest are XS/S.

---

## Phase 1: Widen `next_actions` for `audience="agent"` (Backlog/null-state fallback)

- **estimate**: XS
- **depends_on**: null
- **wave**: 1

### Overview

Add a fallback branch in `next_actions` candidate selection: when `audience === "agent"` AND no items pass `isCandidatePhase`, widen the candidate set to include items in `Backlog` and items with `workflowState === null`. This restores autopilot's ability to clear a Backlog-heavy board (today's failure mode). The fallback mirrors the existing blocker fallback at `directions.ts:839-850`.

### Changes Required

#### 1. `src/lib/directions.ts`

**Files**: `plugin/ralph-hero/mcp-server/src/lib/directions.ts`

**Changes**: Insert a new fallback after the existing phase filter block. The fallback only fires for `audience === "agent"` and only when the post-phase candidate set is empty. Backlog/null items get a low-priority score so they never outrank legitimate actionable items when those exist.

```typescript
// After the existing phase filter at directions.ts:826-833:

// Phase fallback for autonomous audience: widen to Backlog and null-state
// items when no items pass ACTIONABLE_PHASES. Mirrors the blocker fallback.
if (config.audience === "agent" && candidates.length === 0) {
  const widened = allItems.filter(
    (item) => item.workflowState === "Backlog" || item.workflowState === null,
  );
  if (widened.length > 0) {
    candidates = widened.map((item) => ({
      ...scoreIssue(item, allItems, config),
      score: scoreIssue(item, allItems, config).score + AGENT_BACKLOG_FALLBACK_PENALTY,
    }));
  }
}
```

Add `AGENT_BACKLOG_FALLBACK_PENALTY = 100` near the existing scoring constants (around `directions.ts:242-245`). The +100 penalty ensures Backlog items always rank below any actionable-phase item that exists — Backlog only surfaces when the actionable pool is empty.

Update the tool description in `directions-tools.ts:472-485` to document the fallback:

> "When `audience='agent'` and no items are in actionable phases (Plan in Review, In Review, Ready for Plan, Research Needed), the picker falls back to Backlog and unstated items so autopilot can drive triage. Fallback never outranks actionable items."

#### 2. `src/__tests__/directions.test.ts`

**Files**: `plugin/ralph-hero/mcp-server/src/__tests__/directions.test.ts`

**Changes**: Add a test block `"audience=agent Backlog fallback"` with three cases:
- Case A: agent audience, board has only Backlog items → returns Backlog item as direction.
- Case B: agent audience, board has both Backlog and Ready-for-Plan → returns Ready-for-Plan (fallback does NOT fire).
- Case C: human audience, board has only Backlog → returns empty (fallback is agent-only).

### Success Criteria

#### Automated Verification:
- [ ] `npm run build` passes
- [ ] `npm test src/__tests__/directions.test.ts` passes including 3 new cases
- [ ] No other test file regresses

#### Manual Verification:
- [ ] Against the live ralph-hero project (Backlog: 1, all other actionable phases: 0), `mcp call ralph_hero__next_actions audience=agent` returns at least one direction with `kind=issue` for the Backlog item
- [ ] Re-running the autopilot dry-run completes Step 2 with a non-empty candidate list

---

## Phase 2: Internalize PR fetch in `next_actions` (BREAKING — drop `openPRs` param)

- **estimate**: S
- **depends_on**: null
- **wave**: 1

### Overview

Remove the `openPRs` parameter from `next_actions`. The tool fetches open PRs internally via GraphQL `search { ... on PullRequest }`. This eliminates the caller burden, removes the silent-failure mode (empty `openPRs=[]` silences all PR directions), and tightens the tool's contract.

This is a **breaking change**. Mitigation: only `/hello` skill passes `openPRs` today (validated by codebase search). Migration is a single skill update.

### Changes Required

#### 1. `src/tools/directions-tools.ts`

**Files**: `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts`

**Changes**:
1. Remove the `openPRs` field from the Zod schema (around `directions-tools.ts:466-475`).
2. Remove `openPRs` from the `runDirections` parameter destructuring.
3. Add a new helper `fetchOpenPRs(client)` in `directions-tools.ts` (or extract to `src/lib/pr-fetch.ts` if reused) that runs:
   ```graphql
   query OpenPRs($repo: String!) {
     search(query: $repo, type: ISSUE, first: 100) { ... }
   }
   ```
   filtered to `is:pr is:open` and `repo:owner/name`. Return `EnrichedPR[]` shape compatible with the existing direction logic.
4. Call `fetchOpenPRs` inside `runDirections` and pass the result into `rankDirections` in place of caller-supplied `openPRs`.
5. Update the tool description to remove the `openPRs` reference and add: "Open PRs are fetched internally via the configured GitHub token's `repo` scope."

#### 2. `src/__tests__/directions-tools.test.ts`

**Files**: `plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts`

**Changes**:
- Remove all `openPRs: [...]` arguments from existing test calls.
- Add a structural assertion: source does NOT contain `openPRs:` in the Zod schema declaration.
- Mock the new `fetchOpenPRs` helper at the test layer.

#### 3. `plugin/ralph-hero/skills/hello/SKILL.md`

**Files**: `plugin/ralph-hero/skills/hello/SKILL.md`

**Changes**:
- Remove the parallel `gh pr list` Bash call from Step 1 (around `hello/SKILL.md:29`).
- Remove the `openPRs=<parsed>` argument from the `next_actions` invocation (around `hello/SKILL.md:40-45`).
- Update Step 1 prose to reflect the simplified flow.

### Success Criteria

#### Automated Verification:
- [ ] `npm run build` passes (no TS errors from schema removal)
- [ ] `npm test` passes including modified directions-tools tests
- [ ] grep for `openPRs:` in `plugin/ralph-hero/` returns 0 hits

#### Manual Verification:
- [ ] `mcp call ralph_hero__next_actions audience=human limit=3` (no `openPRs`) succeeds and returns PR-kind directions when stale PRs exist
- [ ] `/hello` skill runs end-to-end against the live project; PR directions surface in the briefing
- [ ] Commit message includes `#minor` to trigger the appropriate auto-release bump

---

## Phase 3: Unify count field names across discovery tools

- **estimate**: S
- **depends_on**: null
- **wave**: 1

### Overview

Standardize the response-level "raw count" field across `next_actions`, `pipeline_dashboard`, and `project_hygiene`. Single canonical name: `boardItems` (= count of all `DashboardItem`s pre-filter). Per-tool post-filter counts keep their distinct names but get description prose explaining what they count.

Aligns with `GH-1129`'s precedent (`filteredCount` was the right name; `totalCount` was the wrong one).

### Changes Required

#### 1. `src/tools/directions-tools.ts`

**Changes**: Rename `totalCandidates` → `boardItems` in the `runDirections` return shape (around `directions-tools.ts:367-371`). Update the `Direction` interface response documentation.

#### 2. `src/tools/dashboard-tools.ts` + `src/lib/dashboard.ts`

**Changes**: Rename `totalIssues` → `boardItems` on the dashboard return object (`dashboard.ts:805`). Add a comment near the assignment clarifying that `boardItems` includes PRs on the project board (carryover behavior, not changed in this phase).

Update the tool description for `pipeline_dashboard`:
> "`boardItems` is the count of all project items including PRs. Per-phase `count` values reflect that phase's bucket; for `Done` and `Canceled`, the count is bounded by `doneWindowDays` (default 7) and may be smaller than the actual phase membership."

#### 3. `src/tools/hygiene-tools.ts`

**Changes**: Add `boardItems` to the `project_hygiene` return shape (top-level). Currently the tool returns category-specific counts in `summary` but no overall count.

#### 4. Tool descriptions for all three tools

Document the count-field contract:
- `boardItems`: raw count of items on the project board, pre-filter
- Tool-specific filtered counts: documented per tool

#### 5. Tests

Update `directions-tools.test.ts`, `dashboard-tools.test.ts`, `hygiene-tools.test.ts` to assert the new field names. Add a structural test that the old names (`totalCandidates`, `totalIssues`) are NOT present in source.

### Success Criteria

#### Automated Verification:
- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] grep for `totalCandidates\|totalIssues` in `src/tools/` and `src/lib/` returns 0 hits (except in pagination helper, which is out of scope)

#### Manual Verification:
- [ ] Live `mcp call` against each of the 3 tools confirms the new `boardItems` field is present and correct
- [ ] Field value matches across tools when called against the same project at the same time (modulo race conditions for live data)
- [ ] Commit message includes `#minor` for the breaking field rename

---

## Phase 4: Centralize threshold defaults to `src/lib/thresholds.ts` + harmonize redundant pairs

- **estimate**: M
- **depends_on**: null
- **wave**: 1

### Overview

Create `src/lib/thresholds.ts` as the single source of truth for all threshold defaults. Collapse the `archiveThresholdDays`/`archiveDays` duplication into a unified `archiveAgeDays`. Factor the shared 7-day window into `RECENT_WINDOW_DAYS` (referenced by `staleDays`, `doneWindowDays`, `treeRecentDoneDays`). The four existing per-module CONFIG objects re-export from `thresholds.ts`.

### Changes Required

#### 1. NEW `src/lib/thresholds.ts`

**Files**: `plugin/ralph-hero/mcp-server/src/lib/thresholds.ts` (new file)

**Changes**:
```typescript
/**
 * Shared threshold defaults across discovery tools.
 *
 * Where the same value appears under multiple names (archiveAgeDays,
 * RECENT_WINDOW_DAYS), the names describe distinct concepts but the
 * value is shared so changing one changes all related places.
 */

// Lock-state staleness — short, hours-based because lock collisions are urgent.
export const LOCK_STALE_HOURS = 24;

// PR staleness — short, hours-based because review timeliness matters.
export const PR_STALE_HOURS = 24;

// Non-lock stuck threshold — longer, hours-based for warnings.
export const STUCK_THRESHOLD_HOURS = 48;
export const CRITICAL_STUCK_HOURS = STUCK_THRESHOLD_HOURS * 2;

// Recent activity window — single shared value for "recent enough to be relevant."
// Used by:
//   - hygiene.staleDays    → "non-terminal item hasn't moved in N days"
//   - dashboard.doneWindowDays → "show recent completions"
//   - directions.treeRecentDoneDays → "sibling done within window"
//   - metrics.velocityWindowDays → "completion window for velocity calc"
export const RECENT_WINDOW_DAYS = 7;

// Archive age — unified replacement for archiveThresholdDays + archiveDays.
// Both previously default to 14; describe the same concept (Done/Canceled
// item age before archive eligibility).
export const ARCHIVE_AGE_DAYS = 14;

// Backlog assignment-gap — separate concept from archive age.
export const ORPHAN_AGE_DAYS = 14;

// Risk score classifications.
export const AT_RISK_THRESHOLD = 2;
export const OFF_TRACK_THRESHOLD = 6;

// Duplicate detection similarity (0–1).
export const SIMILARITY_THRESHOLD = 0.8;

// Phase 1 fallback penalty — keeps Backlog items below actionable items.
export const AGENT_BACKLOG_FALLBACK_PENALTY = 100;
```

#### 2. Update `src/lib/directions.ts`

**Changes**: Import from `./thresholds.js`. Replace the `DEFAULT_RANK_CONFIG` literal values with constant references. Existing config object structure preserved (only the values change source).

#### 3. Update `src/lib/dashboard.ts`

**Changes**: Import from `./thresholds.js`. Replace `DEFAULT_DASHBOARD_CONFIG` values. Rename `archiveThresholdDays` field on `DashboardConfig` to `archiveAgeDays`. Update all internal references.

Update the tool description for `pipeline_dashboard`: rename `archiveThresholdDays` parameter to `archiveAgeDays`. **This is a breaking parameter rename.**

#### 4. Update `src/lib/hygiene.ts`

**Changes**: Import from `./thresholds.js`. Replace `DEFAULT_HYGIENE_CONFIG` values. Rename `archiveDays` field on `HygieneConfig` to `archiveAgeDays`. Update all internal references including the rule at `hygiene.ts:116-130`.

Update the tool description for `project_hygiene`: rename `archiveDays` parameter to `archiveAgeDays`. **Breaking parameter rename.**

#### 5. Update `src/lib/metrics.ts`

**Changes**: Import from `./thresholds.js`. Replace `DEFAULT_METRICS_CONFIG` values.

#### 6. Update tool registration descriptions

For each affected tool (`pipeline_dashboard`, `project_hygiene`, `next_actions`, `metrics_trends`), the description string documents:
- Default values for every threshold parameter
- Units (`days` vs `hours`)
- Which thresholds share the `RECENT_WINDOW_DAYS` value (so users understand changes propagate)

#### 7. Tests

- New test file `src/__tests__/thresholds.test.ts`: asserts the constant values, asserts the four CONFIG objects pull from the shared module.
- Update existing tests for `dashboard`, `hygiene`, `directions`, `metrics` to use the new field names where parameters were renamed.

### Success Criteria

#### Automated Verification:
- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] grep for `archiveThresholdDays\|archiveDays` returns hits ONLY in test fixtures asserting the migration
- [ ] grep for the literal value `14` in non-test source files returns 0 hits in `dashboard.ts`/`hygiene.ts`/`directions.ts` (sanity — values are sourced from `thresholds.ts`)

#### Manual Verification:
- [ ] `mcp call ralph_hero__pipeline_dashboard archiveAgeDays=21` works (new param name)
- [ ] `mcp call ralph_hero__project_hygiene archiveAgeDays=21` works (new param name)
- [ ] Old param names produce a Zod validation error with a clear message (no silent ignore)
- [ ] Commit message includes `#minor` for the breaking parameter rename

---

## Phase 5: Surface repo-scope mismatch via `health_check` warning

- **estimate**: XS
- **depends_on**: null
- **wave**: 1

### Overview

Add a check to `health_check` that compares the count of OPEN issues in the repo (via `gh issue list` GraphQL equivalent) to the count of `type=ISSUE` items on the configured project board. If repo > board, emit a `orphanRepoIssues: { count, sample }` field in the `health_check` response with a warning.

Today's audit found 35 OPEN repo issues but only 4 on the project board — 31 issues were structurally invisible to all shorthands. This phase makes that delta visible.

### Changes Required

#### 1. `src/index.ts` (`health_check` handler)

**Files**: `plugin/ralph-hero/mcp-server/src/index.ts`

**Changes**: Add a step to the existing `health_check` flow (around `index.ts:214-310`):

```typescript
// New section: orphan-repo-issues check
const repoOpenCount = await client.query<{ repository: { issues: { totalCount: number } } }>(`
  query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      issues(states: OPEN, first: 1) { totalCount }
    }
  }
`, { owner: owner, repo: repo });

const boardItemCount = projectInfo.items.totalCount; // already fetched

const orphanCount = Math.max(0, repoOpenCount.repository.issues.totalCount - boardItemCount);

if (orphanCount > 0) {
  // include in response as a warning, not an error — the project may intentionally
  // exclude some repo issues
  result.orphanRepoIssues = {
    count: orphanCount,
    repoOpen: repoOpenCount.repository.issues.totalCount,
    boardItems: boardItemCount,
    note: "Issues exist in the repo that are not on the project board. They are invisible to discovery tools (next_actions, list_issues, pipeline_dashboard, project_hygiene). To make them visible, add them to the project or use 'gh issue list' directly.",
  };
}
```

Update the `health_check` tool description to document the new field.

#### 2. Tests

Add a test in `src/__tests__/health-check.test.ts` (create if missing) asserting the warning fires when a mock returns `repoOpenCount > boardItemCount`.

### Success Criteria

#### Automated Verification:
- [x] `npm run build` passes
- [x] `npm test` passes
- [x] New `orphanRepoIssues` test passes

#### Manual Verification:
- [ ] `mcp call ralph_hero__health_check` against the live ralph-hero project returns `orphanRepoIssues.count >= 31` (today's known delta)
- [ ] When repo == board (no orphans), the field is either absent or `count: 0` (cleanly typed)

---

## Phase 6: Remove deprecated `hello_directions` and `pick_actionable_issue`

- **estimate**: XS
- **depends_on**: [Phase 1, Phase 3]
- **wave**: 2

### Overview

Migrate the two remaining production callers of `pick_actionable_issue` to `next_actions(audience="agent", limit=1)`. Delete both deprecated tools, their tests, and all documentation references. Phase 1 is a hard prerequisite because `pick_actionable_issue`'s narrowing (`kind="issue"`-only, `maxEstimate<=S`, drops blocked) needs the widened agent candidate set to keep the migration semantically equivalent for Backlog cases.

### Changes Required

#### 1. Migrate skill callers

**Files**:
- `plugin/ralph-hero/skills/team/SKILL.md`
- `plugin/ralph-hero/skills/hero/SKILL.md`

**Changes**: Replace `pick_actionable_issue` references in allowed-tools lists with `next_actions`. Update any prose that references the old tool name. The replacement call site uses `next_actions(audience="agent", limit=1)` and inspects `directions[0]` for the picked issue.

#### 2. Delete deprecated tool registrations

**Files**:
- `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts:391-455` (delete `hello_directions` registration)
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1680-1800` (delete `pick_actionable_issue` registration)

**Changes**: Remove the `server.tool(...)` registration calls and any private helper functions only used by them.

#### 3. Delete test files

**Files**:
- `plugin/ralph-hero/mcp-server/src/__tests__/pick-actionable-issue.test.ts` (delete entire file)
- `plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts` (remove `hello_directions` test cases)

#### 4. Remove documentation references

**Files**:
- `plugin/ralph-hero/README.md:149` (or wherever the table references the deprecated tool)
- `plugin/ralph-hero/CLAUDE.md:113` (architecture docs)

**Changes**: Remove rows / lines mentioning the deprecated tools.

### Success Criteria

#### Automated Verification:
- [ ] `npm run build` passes
- [ ] `npm test` passes (no deleted tests are referenced elsewhere)
- [ ] `grep -r "hello_directions\|pick_actionable_issue" plugin/` returns 0 hits except this plan and the research doc
- [ ] `grep` in `.github/workflows/` returns 0 hits

#### Manual Verification:
- [ ] `/team` and `/hero` skills run end-to-end and successfully pick an issue via the migrated `next_actions` call
- [ ] `mcp call ralph_hero__hello_directions` returns "tool not found" (clean removal)
- [ ] Commit message includes `#minor` (breaking — tool removal)

---

## Phase 7: Cross-tool count consistency tests

- **estimate**: S
- **depends_on**: [Phase 1, Phase 2, Phase 3, Phase 4]
- **wave**: 3

### Overview

Add a vitest integration test that constructs a synthetic `DashboardItem[]` fixture and calls `next_actions`, `pipeline_dashboard`, `list_issues`, and `project_hygiene` against it. Asserts:
- All four tools agree on `boardItems` count.
- Per-tool filtered counts are ≤ `boardItems`.
- Sum of `pipeline_dashboard.phases[].count` equals `boardItems` IF `doneWindowDays` is large enough to include all Done/Canceled items in the fixture.
- Items in `Backlog` are visible to `pipeline_dashboard`, `list_issues`, and `next_actions(audience="agent")` but NOT `next_actions(audience="human")`.
- Items with `workflowState=null` are visible to `pipeline_dashboard` (Unknown bucket), `list_issues`, and `project_hygiene.staleItems` (when age qualifies), but NOT `next_actions(audience="human")`.

### Changes Required

#### 1. NEW `src/__tests__/cross-tool-consistency.test.ts`

**Changes**: Construct a 12-item fixture covering every workflow state including `null`. Stub the GraphQL client to return the fixture. Call each tool with default args. Assert the cross-tool invariants listed above.

Each invariant gets its own `it(...)` block with a clear name matching the audit document's matrix entries.

### Success Criteria

#### Automated Verification:
- [ ] `npm test src/__tests__/cross-tool-consistency.test.ts` passes
- [ ] `npm run build` passes

#### Manual Verification:
- [ ] Test reads as a clear contract — a future contributor changing one tool's count semantics sees an immediate failure with a descriptive error
- [ ] No live API calls — fully mocked

---

## Phase 8: Audit skill output for explanatory flourishes

- **estimate**: S
- **depends_on**: null
- **wave**: 1

### Overview

Audit the user-visible output prose of `/hello`, `/status`, `/catch-up`, `/trends`, `/ralph-hygiene`, and `/ralph-hero:autopilot`. Where the skill narrates internal filter rationale to the user (e.g., "I'm excluding `In Review` items because they're human-gated"), move that rationale from output prose to source comments / instruction blocks where the LLM reads it but doesn't render it. Output text reads as results, not commentary.

### Changes Required

#### 1. Audit checklist

**Files** (read-only audit pass):
- `plugin/ralph-hero/skills/hello/SKILL.md`
- `plugin/ralph-hero/skills/status/SKILL.md`
- `plugin/ralph-hero/skills/catch-up/SKILL.md`
- `plugin/ralph-hero/skills/trends/SKILL.md`
- `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md`
- `plugin/ralph-hero/skills/autopilot/SKILL.md`

For each, identify:
- **Instruction prose** (telling the LLM how to behave): KEEP, but move into clearly-marked instruction blocks (HTML comments, or `## Internal logic` sections that are explicitly for LLM consumption only).
- **Output template prose** (telling the LLM what to say to the user): KEEP if results-oriented; STRIP narration like "I excluded N items because...", "Filtering to non-PR-kind directions...", "Backlog excluded because human-gated."

#### 2. Per-skill edits

**Concrete examples** (non-exhaustive — the audit will identify all):

- `autopilot/SKILL.md` Step 2.5 currently has prose like:
  > "Apply both filter rules to the candidate list... Exclude `In Review` outright — these are human-gated by design in interactive mode."

  This is internal-logic prose that should NOT leak into user-visible output. Move to a `<!-- internal -->` block or rephrase as instruction without narrative tone.

- `hello/SKILL.md` final-render section: any prose like "Skipping N stale PRs because..." should be stripped — render the result, not the reasoning.

- `status/SKILL.md` is mostly clean (renders `formatted` verbatim) — quick pass.

#### 3. Style guide addition

Add a short `STYLE.md` in `plugin/ralph-hero/skills/` (or append to `CLAUDE.md`) documenting the rule:

> **Skill output discipline**: User-visible text renders results, not internal reasoning. Filter rationale and decision logic live in instruction blocks (HTML comments or `## Internal logic` sections), not in output templates. The user sees what was decided, not why the skill decided it — unless the rationale is genuinely useful to them (e.g., "stopped because backlog empty" is fine; "filtered out items where workflowState was null" is internal noise).

### Success Criteria

#### Automated Verification:
- [ ] No regression in skill execution — all skills still run
- [ ] (Limited automatable verification — this is mostly a content audit)

#### Manual Verification:
- [ ] Run each affected skill against the live project; user-visible output reads as a result report, not a filter narration
- [ ] Spot-check: `/hello`, `/autopilot --dry-run` produce output free of "filtering to..." / "excluding..." prose
- [ ] The new `STYLE.md` (or `CLAUDE.md` addition) is committed and referenced in the audit checklist

---

## Sub-issue dependency graph

```
Wave 1 (parallel — no inter-phase deps):
  Phase 1: Widen next_actions agent set        [XS]
  Phase 2: Internalize PR fetch (BREAKING)     [S]
  Phase 3: Unify count field names             [S]
  Phase 4: Centralize thresholds + harmonize   [M]
  Phase 5: Repo-scope warning                  [XS]
  Phase 8: Skill output flourish audit         [S]

Wave 2 (after Wave 1):
  Phase 6: Remove deprecated tools             [XS]
    └── depends_on: Phase 1 (agent widen), Phase 3 (count rename)

Wave 3 (validation):
  Phase 7: Cross-tool consistency tests        [S]
    └── depends_on: Phase 1, Phase 2, Phase 3, Phase 4
```

## Testing Strategy

### Unit Tests
- Phase 1: 3 cases for the audience-conditional Backlog fallback
- Phase 2: removal of `openPRs` schema field; mocked internal PR fetch
- Phase 3: structural assertions on response field names
- Phase 4: shared-constants module assertions; renamed-parameter Zod validation
- Phase 5: `health_check` orphan-count branch
- Phase 6: structural assertion that deprecated tool names are absent
- Phase 7: cross-tool consistency invariants
- Phase 8: spot-check assertions on output template strings (limited)

### Integration Tests
- Phase 7 IS the integration test layer — it exercises the contract across all four discovery tools.

### Manual Testing Steps
1. **End-of-Wave-1** smoke test: run `/hello`, `/status`, `/catch-up` against the live project. Confirm no errors, output reads cleanly.
2. **Post-Phase-1**: re-run `/ralph-hero:autopilot` (which failed on 2026-05-08 due to the Backlog gap). Expect at least one direction returned for `audience=agent`.
3. **Post-Phase-6**: confirm `mcp list-tools | grep -E "hello_directions|pick_actionable_issue"` returns nothing.
4. **Post-all**: TPM/PO sanity check — ask a non-implementer to read the renamed tool descriptions and explain in their own words what each tool counts. If they can't, the description failed and needs revision.

## Migration Notes

### Breaking changes summary
- **Phase 2**: `next_actions` removes `openPRs` parameter. Callers passing it fail with Zod validation error. Single in-tree caller (`/hello`) migrated in same PR.
- **Phase 3**: `next_actions.totalCandidates` → `boardItems`; `pipeline_dashboard.totalIssues` → `boardItems`. External callers reading these field names break. Project assumed to have no external callers (private MCP).
- **Phase 4**: `pipeline_dashboard.archiveThresholdDays` → `archiveAgeDays`; `project_hygiene.archiveDays` → `archiveAgeDays`. Same blast radius as Phase 3.
- **Phase 6**: `hello_directions` and `pick_actionable_issue` deleted. Migration: use `next_actions(audience="human")` and `next_actions(audience="agent", limit=1)` respectively.

All breaking PRs include `#minor` in commit message to ensure auto-release bumps minor version (semver: breaking-during-pre-1.0 is acceptable as minor; reconsider if reaching 1.0 before this lands).

### No-op for end users
- Phase 1, 5, 7, 8 are non-breaking from the MCP-protocol perspective.
- Phase 4 widens semantic clarity but doesn't change behavior (only names + module location).

## References

- Research: [thoughts/shared/research/2026-05-08-shorthand-tools-counts-and-filters.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-05-08-shorthand-tools-counts-and-filters.md)
- Adjacent in-flight plan: [thoughts/shared/plans/2026-05-07-GH-1129-list-issues-totalcount-misleading.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-07-GH-1129-list-issues-totalcount-misleading.md) (referenced, not absorbed)
- `next_actions` source: [plugin/ralph-hero/mcp-server/src/lib/directions.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/directions.ts)
- `pipeline_dashboard` source: [plugin/ralph-hero/mcp-server/src/lib/dashboard.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/dashboard.ts)
- `project_hygiene` source: [plugin/ralph-hero/mcp-server/src/lib/hygiene.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/hygiene.ts)
- Existing CONFIG modules: `directions.ts:210-213`, `dashboard.ts:163-167`, `hygiene.ts:24-29`, `metrics.ts:35-39`
- Migration target callers: `skills/team/SKILL.md:23`, `skills/hero/SKILL.md:37`, `skills/hello/SKILL.md`
