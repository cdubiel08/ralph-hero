---
date: 2026-05-08
status: draft
type: plan
github_issue: 1138
github_issues: [1138]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1138
primary_issue: 1138
parent_plan: thoughts/shared/plans/2026-05-07-GH-1136-autopilot-skill.md
tags: [skill, autopilot, hero, dispatch, worktree, autonomous]
---

# Autopilot Phase 2 — Tick Body: Worktree Check + Hero Dispatch + Pre/Post Diff

## Prior Work

- builds_on:: [[2026-05-07-GH-1136-autopilot-skill]]
- builds_on:: [[2026-05-08-GH-1137-autopilot-scaffold]]

## Overview

Single-issue plan for GH-1138, Phase 2 of the parent plan-of-plans (`2026-05-07-GH-1136-autopilot-skill.md`). Appends Steps 3-6 to the autopilot skill body created in Phase 1 (#1137): (3) `git worktree list` liveness check that escalates on collision rather than auto-cleaning, (4) pre-state capture via `get_issue(includePipeline=true)`, (5) hero dispatch (with `--dry-run` short-circuit), and (6) post-state capture + structured pre/post diff that derives the tick outcome — replacing the R1 text-grep approach explicitly rejected by review.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1138 | Autopilot: tick body — worktree check + hero dispatch + pre/post diff | S |

## Shared Constraints

Inherited from parent plan-of-plans `2026-05-07-GH-1136-autopilot-skill.md`. Highlights that bind this phase:

1. **Pure markdown skill** — no TypeScript / MCP changes. The skill body composes existing tools.
2. **No new dependencies** — `package.json` unchanged; `npm test` continues to pass without modification.
3. **Worktree liveness check escalates, never auto-cleans** — the alternative (auto-cleanup) risks destroying in-progress work. The safe MVP escalates the picked issue with a worktree-collision reason and stops the loop. (Auto-cleanup is tracked as follow-up in parent plan §Follow-up Work.)
4. **Outcome derivation MUST use structured pre/post `get_issue(includePipeline=true)` diff** — NOT text-grep on hero's free-text output. R1's text-grep approach was rejected by review (anti-pattern called out via the `ralph-loop.sh` reference). Hero's textual output is captured for the audit log only, never parsed for outcome.
5. **Catch-all `other_change` row (R3) MUST land** — anything that changes the workflow state but doesn't match a documented forward path is recorded with `outcome=other_change` and treated as progress for streak-reset purposes. Prevents silent loss of unexpected transitions (e.g., backward transitions).
6. **`--dry-run` short-circuits to `outcome=dry_run`** — does not call hero, does not capture pre/post state in the same way (pre-state capture may still happen for logging, but no diff is computed).
7. **Resolved configuration** for runtime lookups (echoed by load-time backticks in Phase 1's Configuration block): Owner=cdubiel08, Repo=ralph-hero, Project=3.
8. **Phase ends after Step 6** — Steps 7+ (counter update, termination conditions, ScheduleWakeup) are added in Phase 3 (#1139). The HTML-comment marker placed at end of Phase 1 must be replaced/relocated to reference the next remaining phases.
9. **Hero's review-mode is controlled via `RALPH_REVIEW_MODE` env var, not a CLI flag** — hero/SKILL.md:50 reads `${RALPH_REVIEW_MODE:-interactive}` at load time, and hero's `argument-hint` is just `<issue-number>` (no `--review-mode`). When `--auto-merge` is set, autopilot must export `RALPH_REVIEW_MODE=auto` in the dispatch shell context (or use Bash to invoke the dispatch with the env var inlined). The skill body should document this clearly so the implementer doesn't pass an unsupported flag.

## Current State Analysis

After Phase 1 (#1137) lands, `plugin/ralph-hero/skills/autopilot/SKILL.md` exists with frontmatter, Configuration block, Step 0 safety check, Step 1 argument parsing + state decode, Step 2 pick-next-actionable, and Step 2.5 In-Review filter. The file ends with an HTML comment placeholder for Steps 3+. Phase 2 work begins from a known `<picked>` issue identifier in scope (the survivor of Step 2.5's filter).

**Note on merge order**: At plan-write time, #1137's implementation lives in worktree branch `feature/GH-1137` and has not yet merged to main. The Phase 2 implementer will work from a fresh branch off main *after* Phase 1 merges, so the SKILL.md scaffold will be on disk before Phase 2 appends its sections. If for any reason Phase 1 has not landed when Phase 2 starts, the implementer should rebase or wait — Phase 2 cannot proceed against a missing scaffold.

Reference points for Phase 2 work:

- Parent plan `2026-05-07-GH-1136-autopilot-skill.md` lines 222-292 — drop-in copy for Steps 3-6 markdown.
- Parent plan lines 265-274 — the canonical 8-row pre/post diff outcome table (including the catch-all `other_change` row from R3).
- `plugin/ralph-hero/skills/hero/SKILL.md:3` — hero's `argument-hint: <issue-number>` (single positional argument).
- `plugin/ralph-hero/skills/hero/SKILL.md:50` — hero reads `${RALPH_REVIEW_MODE:-interactive}` at load time.
- `plugin/ralph-hero/skills/hero/SKILL.md:517` — `RALPH_REVIEW_MODE` accepts `interactive` or `auto`.
- Existing `Skill()` dispatch examples for arg-passing patterns: `plugin/ralph-hero/skills/hero/SKILL.md:349-365` (nested skill dispatches with positional + flag args).

## Desired End State

After this phase:

- `plugin/ralph-hero/skills/autopilot/SKILL.md` contains Steps 3 through 6, appended after Step 2.5.
- Step 3 runs `git worktree list` via Bash, scans for `worktrees/GH-<picked>/`, escalates the picked issue + stops the loop on collision.
- Step 4 captures pre-state from `get_issue(number=<picked>, includePipeline=true)` into `pre.workflowState`, `pre.phase`, `pre.subIssueCount`, `pre.linkedPRs`.
- Step 5 dispatches `Skill("ralph-hero:hero", args="<picked>")` after exporting `RALPH_REVIEW_MODE=interactive` (default) or `RALPH_REVIEW_MODE=auto` (when `--auto-merge`). `--dry-run` short-circuits to `outcome=dry_run`.
- Step 6 calls `get_issue(number=<picked>, includePipeline=true)` again, compares to pre, and derives outcome via the 8-row table including the `other_change` catch-all.
- The HTML-comment placeholder is updated to reference Steps 7+ (Phase 3, #1139).
- `npm test` in `plugin/ralph-hero/mcp-server/` still passes (unchanged).
- No `package.json` change.

### Verification

- [ ] Step 3 (`## Step 3: Worktree liveness check`) heading present, references `worktrees/GH-<picked>/` collision pattern, escalates without auto-cleanup
- [ ] Step 4 (`## Step 4: Capture pre-state`) heading present, calls `get_issue(number=<picked>, includePipeline=true)`, captures four pre.* fields
- [ ] Step 5 (`## Step 5: Dispatch hero`) heading present, documents `RALPH_REVIEW_MODE` env-var control, `--dry-run` short-circuits to `outcome=dry_run`
- [ ] Step 6 (`## Step 6: Capture post-state and derive outcome`) heading present with 8-row pre/post diff table including catch-all `other_change` row
- [ ] HTML comment at end of file updated to point at Steps 7+ / Phase 3 (#1139), no dangling `## Step 7:` placeholder
- [ ] No `package.json` change (`git diff plugin/ralph-hero/mcp-server/package.json` shows nothing)
- [ ] YAML frontmatter still parses (`python -c "import yaml; yaml.safe_load(open('plugin/ralph-hero/skills/autopilot/SKILL.md').read().split('---')[1])"` exits 0)
- [ ] `npm test` in `plugin/ralph-hero/mcp-server/` passes (unchanged)
- [ ] Manual: `--dry-run` against a 1-issue backlog → reports "Would dispatch hero for #N", does not call hero, exits cleanly
- [ ] Manual: default flags against 1 XS issue → hero runs, autopilot reports outcome derived from `get_issue` diff, exits without scheduling (loop is Phase 3)
- [ ] Manual: pre-existing worktree at `worktrees/GH-<picked>/` for the top picked issue → autopilot escalates without dispatching
- [ ] Manual: ambiguous issue triggers hero escalation → autopilot's pre/post diff detects `Human Needed` post-state → outcome=`escalated`
- [ ] Manual: an unexpected backward transition lands `outcome=other_change`, treated as progress for streak-reset

## What We're NOT Doing

- **No counter increment / streak update** — Phase 3 (`Step 7`).
- **No termination check** — Phase 3 (`Step 8`).
- **No `ScheduleWakeup` call** — Phase 3 (`Step 9`).
- **No final summary report** — Phase 3 (`Step 10`).
- **No audit log writes** — Phase 4 (#1140). Step 5/6 capture hero's textual output and outcome metadata in scope, but persistence to `~/.ralph-hero/autopilot.jsonl` is Phase 4.
- **No PreToolUse hook gate** for `ScheduleWakeup` — Phase 4 (#1140).
- **No README / CLAUDE.md / eval-scenarios.md edits** — Phase 5 (#1141).
- **No worktree auto-cleanup** — explicit non-goal in this phase. Escalation is the safe MVP. Auto-cleanup tracked as follow-up.
- **No text-grep on hero output for outcome derivation** — explicit anti-pattern. Outcome MUST come from the structured `get_issue` diff.

## Implementation Approach

A single skill-body append to the file created in Phase 1. The implementer copies Steps 3-6 markdown from parent plan §Phase 2 (lines 233-279) verbatim, then patches the trailing HTML comment to reference Phase 3.

**Phase dependency annotations**

This is a single-phase plan; the lone phase has `depends_on: null` at the plan-level. The work itself depends on Phase 1 (#1137) merging to main first — that dependency is enforced via the GitHub `blockedBy` edge maintained on the issue (not via a `depends_on` line inside this plan).

---

## Phase 1: Tick Body — Worktree Check, Hero Dispatch, Pre/Post Diff

- **depends_on**: null

### Overview

Append Steps 3 through 6 to `plugin/ralph-hero/skills/autopilot/SKILL.md`. Each step is independently verifiable via heading-presence and content-match grep. The file ends after Step 6 with an updated HTML comment pointing at Phase 3 work.

### Tasks

#### Task 1.1: Add Step 3 — Worktree liveness check

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `## Step 3: Worktree liveness check` heading present immediately after Step 2.5's body
  - [ ] Body instructs running `git worktree list` via Bash and scanning for any path matching `worktrees/GH-<picked-number>/`
  - [ ] On collision: ESCALATE the picked issue with reason "stale worktree at `<path>` from prior tick — needs human cleanup before autopilot can re-dispatch"
  - [ ] On collision: stop the loop (do NOT proceed to Step 4; do NOT schedule next — though scheduling is Phase 3, this step must explicitly mark the tick as terminal-on-escalation)
  - [ ] Body explicitly states "this is the safe default — auto-cleanup risks destroying in-progress work"
  - [ ] No call to delete or `git worktree remove` anywhere in the step body

#### Task 1.2: Add Step 4 — Capture pre-state

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `## Step 4: Capture pre-state` heading present immediately after Step 3
  - [ ] Body instructs calling `get_issue(number=<picked>, includePipeline=true)`
  - [ ] Body documents the four captured fields: `pre.workflowState`, `pre.phase` (from pipeline payload), `pre.subIssueCount`, `pre.linkedPRs`
  - [ ] Body notes that `pre.subIssueCount` may be derived from the `subIssuesSummary` field on the response (no separate `list_sub_issues` call needed in MVP — keep it lean) OR from `list_sub_issues` if the pipeline payload doesn't carry it; document the chosen source
  - [ ] Body notes `pre.linkedPRs` source: from issue body / linked PRs in the response payload (pre-existing field on the `get_issue` result)

#### Task 1.3: Add Step 5 — Dispatch hero

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] `## Step 5: Dispatch hero` heading present immediately after Step 4
  - [ ] Dry-run branch: if `--dry-run` flag is set, skip dispatch entirely; mark this tick as `outcome=dry_run`; emit a "Would dispatch hero for #<picked>" report; do NOT call `get_issue` again in Step 6 for diff purposes (treat dry-run as terminal for outcome derivation)
  - [ ] Real dispatch branch: documents that `RALPH_REVIEW_MODE` env var (NOT a `--review-mode` CLI flag — hero/SKILL.md:3 only accepts `<issue-number>`) controls hero's merge mode
  - [ ] Real dispatch branch: when `--auto-merge` is set → set `RALPH_REVIEW_MODE=auto` for the dispatch (via Bash `RALPH_REVIEW_MODE=auto` prefix or `export` before the `Skill()` call, whichever the skill body uses elsewhere — match Phase 1's existing convention if any); default → `RALPH_REVIEW_MODE=interactive`
  - [ ] Real dispatch branch: calls `Skill("ralph-hero:hero", args="<picked>")` (single positional `<issue-number>`)
  - [ ] Real dispatch branch: captures hero's text output to a local variable for later audit-log inclusion (Phase 4) — but explicitly documents that the output MUST NOT be parsed for outcome derivation
  - [ ] Body cites the parent plan's R1 anti-pattern: text-grep on hero output is explicitly rejected; outcome derivation comes from Step 6's structured diff

#### Task 1.4: Add Step 6 — Capture post-state and derive outcome

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] `## Step 6: Capture post-state and derive outcome` heading present immediately after Step 5
  - [ ] Skipped on dry-run: body opens with "If `--dry-run` short-circuited Step 5, outcome is already `dry_run`; skip this step" (or equivalent — match Phase 1's tone)
  - [ ] Body instructs calling `get_issue(number=<picked>, includePipeline=true)` again to get post-state
  - [ ] Body includes the canonical 8-row pre/post diff table (verbatim from parent plan lines 265-274), with these exact rows in this order:
    1. `any` → `Done` ⇒ `completed` (progress: yes)
    2. `any` → `Human Needed` ⇒ `escalated` (capture last comment for `escalation_reason`) (progress: no)
    3. `Backlog`/`Research Needed` → `Ready for Plan`/`Plan in Review`/`In Progress` ⇒ `advanced` (yes)
    4. `Ready for Plan`/`Plan in Review` → `In Progress`/`In Review` ⇒ `advanced` (yes)
    5. `In Progress` → `In Review` (PR linked) ⇒ `pr_landed` (yes)
    6. `any` → unchanged AND `pre.subIssueCount < post.subIssueCount` ⇒ `advanced` (split happened) (yes)
    7. `any` → unchanged ⇒ `no_progress` (no)
    8. `any` → different from pre, not matched by rows above (catch-all) ⇒ `other_change` (treat as progress for streak-reset)
  - [ ] Catch-all row explicitly cites R3 origin and rationale: "prevents silent loss of unexpected state transitions (e.g., backward transitions, regressions)"
  - [ ] Body explicitly states "no fragile string matching" — outcome derivation is purely from `get_issue` field comparisons
  - [ ] When `outcome=escalated`, the step body documents capturing the last comment text on the issue (the escalation reason) into a local variable for the audit log (Phase 4)
  - [ ] When the diff matches multiple rows (e.g., row 6 + row 7 ambiguity), document the priority: rows are evaluated top-to-bottom and the first match wins; the table's row order encodes precedence

#### Task 1.5: Update end-of-file marker

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.4]
- **acceptance**:
  - [ ] HTML comment at end of file points at remaining phases: e.g., `<!-- Steps 7+ added in subsequent phases (GH-1139, GH-1140, GH-1141) -->`
  - [ ] No dangling section header (no `## Step 7:` placeholder)
  - [ ] Single trailing newline preserved
  - [ ] The Phase 1 placeholder comment (which referenced #1138, #1139, #1140) is removed or replaced — it must not still claim "Steps 3+ added in subsequent phases" because Steps 3-6 now exist on disk

#### Task 1.6: Verify YAML still parses + tests still pass

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (read), `plugin/ralph-hero/mcp-server/package.json` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.5]
- **acceptance**:
  - [ ] `python -c "import yaml; yaml.safe_load(open('plugin/ralph-hero/skills/autopilot/SKILL.md').read().split('---')[1])"` exits 0
  - [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes (1184 passed | 2 skipped baseline from Phase 1, ±0 expected)
  - [ ] `git diff --stat` shows only `plugin/ralph-hero/skills/autopilot/SKILL.md` modified (no MCP server source touched, no `package.json` touched)

### Phase Success Criteria

#### Automated Verification:
- [ ] `test -f plugin/ralph-hero/skills/autopilot/SKILL.md`
- [ ] `grep -q '## Step 3: Worktree liveness check' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [ ] `grep -q '## Step 4: Capture pre-state' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [ ] `grep -q '## Step 5: Dispatch hero' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [ ] `grep -q '## Step 6: Capture post-state and derive outcome' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [ ] `grep -q 'other_change' plugin/ralph-hero/skills/autopilot/SKILL.md` (catch-all row landed)
- [ ] `python -c "import yaml; yaml.safe_load(open('plugin/ralph-hero/skills/autopilot/SKILL.md').read().split('---')[1])"` exits 0
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes
- [ ] `git diff plugin/ralph-hero/mcp-server/package.json` is empty (no dep changes)
- [ ] `git diff --stat` shows only `plugin/ralph-hero/skills/autopilot/SKILL.md`

#### Manual Verification:
- [ ] `--dry-run` against 1-issue backlog → reports "Would dispatch hero for #N", does not call hero, exits cleanly
- [ ] Default flags against 1 XS issue → hero runs, autopilot reports outcome derived from `get_issue` diff, exits without scheduling
- [ ] Pre-existing worktree at `worktrees/GH-N/` for the top picked issue → autopilot escalates without dispatching
- [ ] Manually-set-up ambiguous issue → hero escalates → autopilot's pre/post diff detects `Human Needed` post-state → outcome=`escalated`
- [ ] Catch-all `other_change` row works: an unexpected backward state transition is recorded with `outcome=other_change` and treated as progress for streak purposes (no silent loss). (Verifiable in Phase 3 once streak machinery exists; for Phase 2 alone, verify the outcome string is computed and surfaced in the tick output.)

**Creates for next phase**: A working skill body through Step 6 with `<picked>` and `<outcome>` (one of: `completed`, `escalated`, `advanced`, `pr_landed`, `no_progress`, `other_change`, `dry_run`) in scope. Phase 3 (#1139) appends Steps 7-10 (counter update, termination check, ScheduleWakeup, final report).

---

## Integration Testing

Phase-2-only — full integration (loop, audit log, hook gate, eval scenarios) is verified in later phases. For Phase 2, the manual verification list above is the integration test. Specifically: the four manual scenarios (dry-run, default 1-issue, worktree collision, escalation diff) collectively cover the four primary code paths through Steps 3-6.

## References

- Parent plan-of-plans: [thoughts/shared/plans/2026-05-07-GH-1136-autopilot-skill.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-07-GH-1136-autopilot-skill.md) (§Phase 2, lines 222-292)
- Phase 1 plan: [thoughts/shared/plans/2026-05-08-GH-1137-autopilot-scaffold.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-08-GH-1137-autopilot-scaffold.md)
- Issue: [GH-1138](https://github.com/cdubiel08/ralph-hero/issues/1138)
- Parent issue: [GH-1136](https://github.com/cdubiel08/ralph-hero/issues/1136)
- Hero entry point: `plugin/ralph-hero/skills/hero/SKILL.md` (`argument-hint: <issue-number>` at line 3; `RALPH_REVIEW_MODE` resolved at line 50; env var documented at line 517)
- Outcome diff table source: parent plan lines 265-274 (canonical 8-row table including R3's `other_change` catch-all)
- R1 anti-pattern (rejected): text-grep on hero output — see `plugin/ralph-hero/scripts/ralph-loop.sh` for the original `grep -qiE "Queue empty|Triage complete"` approach this phase explicitly replaces
