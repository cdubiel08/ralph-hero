---
date: 2026-05-08
status: draft
type: plan
github_issue: 1139
github_issues: [1139]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1139
primary_issue: 1139
parent_plan: thoughts/shared/plans/2026-05-07-GH-1136-autopilot-skill.md
tags: [skill, autopilot, schedulewakeup, loop, termination, autonomous]
---

# Autopilot Phase 3 — ScheduleWakeup Loop + Four Termination Conditions

## Prior Work

- builds_on:: [[2026-05-07-GH-1136-autopilot-skill]]
- builds_on:: [[2026-05-08-GH-1137-autopilot-scaffold]]
- builds_on:: [[2026-05-08-GH-1138-autopilot-tick-body]]

## Overview

Single-issue plan for GH-1139, Phase 3 of the parent plan-of-plans (`2026-05-07-GH-1136-autopilot-skill.md`). Appends Steps 7 through 10 to the autopilot skill body extended through Step 6 in Phase 2 (#1138): (7) per-tick counter update + `no_progress_streak` arithmetic + `state.history` append, (8) the four termination conditions evaluated as a priority-ordered table with an exhaustive invariant guaranteeing exactly one branch per code path, (9) the `ScheduleWakeup` call with delay buckets restricted to `{60, 1200}` and a `--state=BASE64` equals-form re-encoding of the cross-tick state object, and (10) the terminal-turn final markdown report (totals, elapsed, escalations, audit-log path).

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1139 | Autopilot: ScheduleWakeup loop + 4 termination conditions | S |

## Shared Constraints

Inherited from parent plan-of-plans `2026-05-07-GH-1136-autopilot-skill.md`. Constraints that bind this phase:

1. **Pure markdown skill** — no TypeScript / MCP changes. The skill body composes existing tools.
2. **No new dependencies** — `package.json` unchanged; `npm test` continues to pass without modification.
3. **`delaySeconds` only ever takes values from {60, 1200}** in branch logic. The Configuration block from Phase 1 mentions `1800` as a documentation default for idle scheduling, but Step 9's branch logic must NEVER select 1800. Step 8 short-circuits all stop conditions before Step 9 runs, so the live set is exactly `{60, 1200}`. **Never 300** — that is the cache-window anti-pattern Phase 4's hook gate enforces, but Phase 3 must already comply by construction.
4. **`--state=BASE64` uses equals-form** (e.g., `--state=eyJ...==`), not space-separated. Argument parser must accept everything after the first `=` as the value, including additional `=` characters introduced by base64 padding. This was already specified by Phase 1's argument parser; Phase 3 must produce wire-compatible output.
5. **Cross-tick state rides on the `prompt` field of `ScheduleWakeup`**, not the audit log. Phase 4 will add audit-log writes; Phase 3 only consumes / produces the prompt-borne state.
6. **Invariant table is mandatory and exhaustive** — exactly one branch per outcome. Either Step 8 fires a STOP condition and we call Step 10 (final report) without `ScheduleWakeup`, OR Step 8 does not fire and we call `ScheduleWakeup` exactly once and emit a brief tick summary. There is no third path.
7. **Outcome → streak update mapping** (canonical, from parent plan §Step 7):
   - `completed | pr_landed | advanced | other_change` → `no_progress_streak = 0`
   - `no_progress` → `no_progress_streak += 1`
   - `escalated` → loop will stop in Step 8 anyway; streak update is irrelevant
   - `dry_run` → do NOT increment streak (one-shot test mode)
8. **Termination priority order** (canonical, from parent plan §Step 8): escalated → dry_run → no_progress_streak >= 3 → iteration > MAX_ITERATIONS → backlog re-check empty → continue. Any earlier condition short-circuits later ones.
9. **No-progress-streak ≥ 3 STOPs AND escalates the picked issue** with reason "autopilot detected no-progress streak of 3" — the streak escalation is a state-machine action, not just a STOP, so the picked issue moves to `Human Needed` with an explanatory comment before the loop terminates.
10. **The backlog re-check inside Step 8** calls `next_actions` again with the same Step 2/2.5 filter logic; this catches the case where the picked issue was the last actionable item and post-tick the queue is empty. Re-checking inside Step 8 (rather than relying on the next tick to discover empty backlog) avoids one wasted `ScheduleWakeup` round-trip and gives the user a tight terminal report.
11. **Resolved configuration** for runtime lookups (echoed by load-time backticks in Phase 1's Configuration block): Owner=cdubiel08, Repo=ralph-hero, Project=3.
12. **Phase 3 does NOT write to `~/.ralph-hero/autopilot.jsonl`** — that file is created and appended in Phase 4 (#1140). Phase 3 only references the path in Step 10's final report (informational). The `next_delay_seconds` and `next_action` fields that Phase 4 will persist are computed in Step 8/9 but kept in scope only.
13. **Phase 3 does NOT add the `PreToolUse` hook gate** for `ScheduleWakeup` — that's Phase 4. The skill body issued in Phase 3 must already comply with the gate's invariants (`prompt =~ ^/ralph-hero:autopilot`, `delaySeconds != 300`) so Phase 4's gate doesn't block any pre-existing call.
14. **HTML-comment marker at end of file** (added in Phase 2, currently `<!-- Steps 7+ added in subsequent phases (GH-1139, GH-1140, GH-1141) -->`) must be updated to point at the remaining phases — Phase 4 adds the audit-log section between Step 7 and Step 8 plus the frontmatter `PreToolUse` hook, and Phase 5 adds the eval-scenarios + README + CLAUDE.md edits. Phase 3 must not leave a dangling `## Step 11:` placeholder.

## Current State Analysis

After Phase 2 (#1138) lands, `plugin/ralph-hero/skills/autopilot/SKILL.md` exists with frontmatter, Configuration block, Steps 0 through 6, and a closing HTML comment placeholder for Steps 7+. The file ends after Step 6's pre/post diff outcome table. Phase 3 work begins from a known `<picked>` issue identifier and a derived `<outcome>` (one of: `completed`, `escalated`, `advanced`, `pr_landed`, `no_progress`, `other_change`, `dry_run`) in scope.

**Note on merge order**: At plan-write time, both #1137 and #1138 are in `In Progress`. #1137's implementation lives in branch `feature/GH-1137`; #1138's lives in `feature/GH-1138`. Neither has merged to `main` yet. The Phase 3 implementer will work from a fresh branch off main *after* Phases 1 and 2 land, so the SKILL.md scaffold-plus-tick-body will be on disk before Phase 3 appends Steps 7-10. If for any reason Phase 2 has not landed when Phase 3 starts, the implementer should rebase or wait — Phase 3 cannot proceed against a missing tick body.

Reference points for Phase 3 work:

- Parent plan `2026-05-07-GH-1136-autopilot-skill.md` lines 295-384 — drop-in copy for Steps 7-10 markdown.
- Parent plan lines 318-336 — the canonical termination-conditions table + the invariant-table block guaranteeing exactly one branch per code path.
- Parent plan lines 338-358 — the canonical `ScheduleWakeup` call shape, delay-bucket selection logic, and `--state=BASE64` equals-form re-encoding.
- Parent plan lines 360-369 — the canonical Step 10 final-report shape (totals, elapsed, escalations, audit-log path).
- `plugin/ralph-hero/scripts/ralph-loop.sh` — out-of-process counterpart for termination logic. Reference for how `MAX_ITERATIONS` capping works in the shell script (`MAX_ITERATIONS=10` cap; same general termination idea, different mechanism).
- `ScheduleWakeup` tool description (visible in this skill's allowed-tools and the system tool list) — cache-window guidance restating "never pick 300s" and "default idle 1800s for genuinely idle ticks."
- Phase 1's Configuration block sets `RALPH_AUTOPILOT_MAX_ITERATIONS:-20`; Phase 1's Step 1 stores parsed `--max-iterations N` into a local variable. Phase 3's Step 8 reads that variable for the iteration-cap check.
- Phase 1's `state` object shape (re-encoded in Step 9): `{iteration, no_progress_streak, started_at, history: [{issue, outcome}]}`.
- Phase 2's outcome variable: one of seven strings in scope after Step 6.

## Desired End State

After this phase:

- `plugin/ralph-hero/skills/autopilot/SKILL.md` contains Steps 7 through 10, appended after Step 6.
- Step 7 increments `iteration`, applies the canonical streak-update mapping, appends `{issue, outcome}` to `state.history`.
- Step 8 evaluates the five termination conditions in priority order and yields exactly one of: STOP-with-final-report, or CONTINUE-to-Step-9. Step 8 also performs the no-progress-streak escalation as a side effect when streak >= 3.
- Step 9 computes `delaySeconds` from outcome (only `60` or `1200`), base64-encodes the next-tick state, builds the prompt with all original flags plus `--state=BASE64`, and calls `ScheduleWakeup` exactly once. After scheduling, emits a brief tick summary and stops the current turn.
- Step 10 is a terminal-turn-only block that emits a markdown summary: total ticks, wall-clock elapsed, issues processed (with per-issue outcome), PRs created, escalations (count + reasons), audit-log path.
- The HTML-comment placeholder at end of file is updated to reference Phase 4 (audit log + hook gate, #1140) and Phase 5 (docs + evals, #1141), no dangling `## Step 11:` placeholder.
- `npm test` in `plugin/ralph-hero/mcp-server/` still passes (unchanged from Phase 2 baseline).
- No `package.json` change.

### Verification

- [ ] Step 7 (`## Step 7: Update tick counters`) heading present immediately after Step 6, applies canonical outcome → streak mapping, appends to `state.history`
- [ ] Step 8 (`## Step 8: Termination conditions`) heading present, includes the canonical 5-row priority-ordered termination-conditions table, includes the invariant table guaranteeing exactly one branch per code path, performs the streak >= 3 escalation as a side effect (calls `save_issue(__ESCALATE__)` + `create_comment` on the picked issue) before STOP
- [ ] Step 9 (`## Step 9: Schedule next tick`) heading present, branches `delaySeconds` only into `{60, 1200}` (verified by `grep -E "delaySeconds.*=" SKILL.md` returning only those values in branch lines), uses equals-form `--state=BASE64`, builds prompt that re-invokes `/ralph-hero:autopilot` with all original flags carried forward
- [ ] Step 10 (`## Step 10: Final report`) heading present, only emitted on terminal turns (i.e., when Step 8 STOPped), markdown summary with totals + elapsed + per-issue outcomes + PR count + escalation count/reasons + audit-log path
- [ ] HTML comment at end of file updated to point at Phases 4 and 5; no dangling `## Step 11:` heading
- [ ] No `package.json` change (`git diff plugin/ralph-hero/mcp-server/package.json` shows nothing)
- [ ] YAML frontmatter still parses (`python -c "import yaml; yaml.safe_load(open('plugin/ralph-hero/skills/autopilot/SKILL.md').read().split('---')[1])"` exits 0)
- [ ] `npm test` in `plugin/ralph-hero/mcp-server/` passes (unchanged from Phase 2 baseline)
- [ ] `grep -E "delaySeconds\s*=" plugin/ralph-hero/skills/autopilot/SKILL.md | grep -v "1200\|60\|<chosen>"` returns no lines (no other numeric values appear in `delaySeconds = N` form anywhere in the body — `1800` is allowed in the Configuration block as a documentation reference but never as a `delaySeconds = 1800` assignment)
- [ ] `grep -E "delaySeconds\s*=\s*300" plugin/ralph-hero/skills/autopilot/SKILL.md` returns no lines (cache-window anti-pattern absent by construction)
- [ ] Manual: 3-issue XS backlog → 3 ticks fire, each picks the next XS, "Backlog empty" stops cleanly on the 4th tick (or on the in-Step-8 backlog re-check after the 3rd tick, depending on implementation)
- [ ] Manual: `--max-iterations 1` → exactly one tick fires, the second tick stops in Step 8 with "max iterations hit" before any work happens
- [ ] Manual: forced escalation → autopilot stops on the first escalation (Step 8's `outcome == escalated` row), no `ScheduleWakeup` call
- [ ] Manual: cross-tick state survives — set `--max-iterations 5`, run 3 ticks, confirm `iteration` field grows correctly across ticks (verifiable via the `--state=BASE64` value passed to each successive tick, decoded by `base64 -d | jq .iteration`)
- [ ] Manual: no-progress streak hits 3 → picked issue moves to `Human Needed` with explanatory comment, Step 10 final report cites the streak-escalation as one of the terminal outcomes

## What We're NOT Doing

- **No audit log writes** — Phase 4 (#1140). Step 7's counter update and Step 8's outcome resolution will be persisted to `~/.ralph-hero/autopilot.jsonl` in Phase 4, but Phase 3 leaves them as in-scope local variables only.
- **No `PreToolUse` hook gate** for `ScheduleWakeup` — Phase 4 (#1140). Phase 3 must comply with the gate's invariants by construction (no `delaySeconds=300`, prompt always `^/ralph-hero:autopilot`) so the gate, when added, does not need to block any pre-existing call.
- **No frontmatter additions** — Phase 4 will add the `PreToolUse: ScheduleWakeup` matcher block; Phase 3 leaves the `hooks:` block as Phase 1 left it (`SessionStart` only).
- **No README / CLAUDE.md / eval-scenarios.md edits** — Phase 5 (#1141).
- **No token / budget tracking** — explicitly deferred per parent plan §Follow-up Work. Hero does not surface structured token tallies; building a budget cap on guesses isn't worth the surface area.
- **No CI babysitting** — when hero lands a PR awaiting CI, that's a `pr_landed` outcome and the loop moves on. Autopilot is a dispatcher, not a CI watcher (parent plan §What We're NOT Doing).
- **No 1800s delay bucket in branch logic** — `1800` may appear in the Configuration block as a documentation default for idle ticks (per parent plan §Key Discoveries), but Step 9's branch logic must NEVER select it. The live set of values that ever flow into a `ScheduleWakeup(delaySeconds=...)` call is exactly `{60, 1200}`.
- **No 300s delay bucket** — never. Cache-window anti-pattern. Phase 4's hook gate will enforce this, but Phase 3 must already comply.
- **No worktree auto-cleanup** — Phase 2's escalation-on-collision is the safe default; Phase 3 inherits it unchanged.
- **No multi-issue parallel dispatch** — one tick = one issue.

## Implementation Approach

A single skill-body append to the file extended in Phase 2. The implementer copies Steps 7-10 markdown from parent plan §Phase 3 (lines 295-384) verbatim, then patches the trailing HTML comment to reference Phases 4 and 5.

**Phase dependency annotations**

This is a single-phase plan; the lone phase has `depends_on: null` at the plan-level. The work itself depends on Phase 2 (#1138) merging to main first — that dependency is enforced via the GitHub `blockedBy` edge maintained on the issue (not via a `depends_on` line inside this plan).

---

## Phase 1: ScheduleWakeup Loop + Four Termination Conditions

- **depends_on**: null

### Overview

Append Steps 7 through 10 to `plugin/ralph-hero/skills/autopilot/SKILL.md`. Each step is independently verifiable via heading-presence and content-match grep. The file ends after Step 10 with an updated HTML comment pointing at Phases 4 and 5.

### Tasks

#### Task 1.1: Add Step 7 — Update tick counters

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `## Step 7: Update tick counters` heading present immediately after Step 6's body
  - [ ] Body instructs `iteration += 1` (referencing the `state.iteration` field decoded in Phase 1's Step 1)
  - [ ] Body documents the canonical outcome → streak mapping verbatim:
    - `completed | pr_landed | advanced | other_change` → `state.no_progress_streak = 0`
    - `no_progress` → `state.no_progress_streak += 1`
    - `escalated` → "irrelevant — loop will STOP in Step 8 regardless"
    - `dry_run` → "do NOT increment streak (one-shot test mode)"
  - [ ] Body instructs appending `{issue: <picked>, outcome: <derived>}` to `state.history`
  - [ ] Body notes that `state.history` is the source-of-truth used by Step 2.5's history-based In-Review filter on the next tick (cross-reference Phase 1)
  - [ ] Body explicitly notes that no audit-log write happens here — that is Phase 4

#### Task 1.2: Add Step 8 — Termination conditions

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `## Step 8: Termination conditions (any one stops the loop)` heading present immediately after Step 7
  - [ ] Body opens by stating "check in priority order — earlier rows short-circuit later ones"
  - [ ] Body includes the canonical 5-row termination-conditions table (verbatim from parent plan lines 322-329), with these exact rows in this order:
    1. `outcome == "escalated"` → STOP, reason: "escalation already moved issue to Human Needed; loop done"
    2. `outcome == "dry_run"` → STOP, reason: "one-shot test mode"
    3. `state.no_progress_streak >= 3` → STOP + escalate picked issue, reason: "autopilot detected no-progress streak of 3"
    4. `state.iteration > MAX_ITERATIONS` → STOP, reason: "hard ceiling"
    5. `next_actions` (re-checked, with Step 2/2.5 filters reapplied) returns 0 issue-kind candidates → STOP, reason: "backlog cleared"
    6. (else) → CONTINUE
  - [ ] Body includes the canonical invariant table (verbatim from parent plan lines 331-336):
    - "any STOP condition matches" → "call Step 10: Final report, return; do NOT call ScheduleWakeup"
    - "no STOP condition matches" → "call ScheduleWakeup(...) exactly once, then return"
  - [ ] Body explicitly states the invariant: "exactly one branch per code path — there is no third option"
  - [ ] Streak-escalation side effect documented in body: when the no_progress_streak >= 3 row matches, before stopping, call `save_issue(number=<picked>, workflowState="__ESCALATE__", command="ralph_plan")` AND post a `create_comment` with reason "Autopilot detected a no-progress streak of 3 ticks against this issue. Escalating to Human Needed for review. Audit log: ~/.ralph-hero/autopilot.jsonl"
  - [ ] Body documents the backlog re-check rule: "the backlog re-check in row 5 calls `next_actions(audience=\"agent\", limit=10)` again and re-applies Step 2/2.5 filters; this catches the case where the picked issue was the last actionable item and post-tick the queue is now empty, avoiding one wasted ScheduleWakeup round-trip"
  - [ ] Body explicitly cross-references Step 10 (final report on STOP) and Step 9 (ScheduleWakeup on CONTINUE)

#### Task 1.3: Add Step 9 — Schedule next tick

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] `## Step 9: Schedule next tick` heading present immediately after Step 8
  - [ ] Body documents constructing `next_state = {iteration: state.iteration, no_progress_streak: state.no_progress_streak, started_at: state.started_at, history: state.history}` and base64-encoding the JSON-serialized form
  - [ ] Body documents the delay-bucket selection logic verbatim:
    - `pr_landed | advanced | completed | other_change` → `delaySeconds = 60` (stay in cache, immediately pick next)
    - `no_progress` (with streak 1 or 2 — streak 3 was short-circuited to STOP in Step 8) → `delaySeconds = 1200` (cache miss, longer cooldown — give the system time)
    - "all other outcomes already short-circuited to STOP in Step 8" — Step 9 is unreachable for `escalated` and `dry_run`
  - [ ] Body explicitly forbids `delaySeconds=300` ("cache-window anti-pattern; Phase 4's hook gate will enforce this, but Phase 3 must comply by construction")
  - [ ] Body explicitly forbids `delaySeconds=1800` in branch logic ("`1800` is mentioned in the Configuration block as a documentation default for idle ticks but is never selected by Step 9 — the live set is exactly `{60, 1200}`")
  - [ ] Body documents the equals-form `--state=BASE64` rule verbatim: "use the equals-form, not space-separated. Base64 padding (`=` chars) and URL-safe alternates can confuse a positional parser; the equals-form makes the boundary unambiguous. The argument-parser in Phase 1 Step 1 already accepts `--state=...` (everything after the first `=` is the value, even if it contains additional `=` from base64 padding)"
  - [ ] Body documents the prompt construction: re-invokes `/ralph-hero:autopilot` and carries forward all original flags from Step 1 (`--max-iterations N`, `--auto-merge` if present, `--dry-run` if present — though dry-run will have STOPped in Step 8) PLUS the new `--state=<BASE64>` argument
  - [ ] Body shows the canonical `ScheduleWakeup` call shape verbatim (matches parent plan lines 347-352):
    ```
    ScheduleWakeup(
      delaySeconds = <chosen>,
      reason = "autopilot tick <iteration+1>: continuing after <picked> <outcome>",
      prompt = "/ralph-hero:autopilot --max-iterations <N> [--auto-merge] --state=<BASE64>"
    )
    ```
  - [ ] Body instructs emitting a brief tick summary to text output AFTER the `ScheduleWakeup` call ("Tick N complete: dispatched #X, outcome=Y, next tick in Zs"), then stopping the current turn
  - [ ] Body notes that Step 10 (final report) is NOT called when Step 9 fires — Step 10 is reached only via the STOP branch of Step 8

#### Task 1.4: Add Step 10 — Final report

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] `## Step 10: Final report (terminal turn only)` heading present immediately after Step 9
  - [ ] Body opens by stating "this step runs only when Step 8 STOPped (any STOP condition matched) — when Step 9 schedules the next tick, Step 10 is skipped and the current turn ends after the brief tick summary"
  - [ ] Body documents the canonical final-report shape verbatim (matches parent plan lines 362-368):
    - Total ticks run (from `state.iteration`)
    - Wall-clock elapsed time (`now - state.started_at`)
    - Issues processed (from `state.history`, with per-issue workflow-state outcome)
    - PRs created (count from `state.history` outcomes where `outcome == "pr_landed"`)
    - Escalations (count + reasons — escalations include the original `outcome=escalated` ticks AND the streak-escalation from Step 8 row 3)
    - Audit log path: `~/.ralph-hero/autopilot.jsonl` (informational; the file itself is created in Phase 4)
  - [ ] Body documents that the report should also call out any in-review PRs that were filtered out by Step 2.5 during the loop, with phrasing like "N issues are awaiting human merge in In Review — they were filtered out of autopilot picks; merge them manually or re-run with --auto-merge" (per parent plan line 199)
  - [ ] Body emits the report as markdown to the user-visible output (not stderr), so the terminal turn surfaces the summary cleanly

#### Task 1.5: Update end-of-file marker

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.4]
- **acceptance**:
  - [ ] HTML comment at end of file points at remaining phases: e.g., `<!-- Audit log writes (between Step 7 and Step 8) and PreToolUse hook gate added in Phase 4 (GH-1140); README/CLAUDE.md/eval-scenarios in Phase 5 (GH-1141) -->`
  - [ ] No dangling section header (no `## Step 11:` placeholder, no leftover Phase 2 marker text)
  - [ ] Single trailing newline preserved
  - [ ] Phase 2's placeholder comment (which referenced #1139, #1140, #1141) is replaced — it must not still claim "Steps 7+ added in subsequent phases" because Steps 7-10 now exist on disk

#### Task 1.6: Verify YAML still parses + tests still pass + delaySeconds invariant holds

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (read), `plugin/ralph-hero/mcp-server/package.json` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.5]
- **acceptance**:
  - [ ] `python -c "import yaml; yaml.safe_load(open('plugin/ralph-hero/skills/autopilot/SKILL.md').read().split('---')[1])"` exits 0
  - [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes (1184 passed | 2 skipped baseline from Phase 1 / Phase 2, ±0 expected)
  - [ ] `git diff --stat` shows only `plugin/ralph-hero/skills/autopilot/SKILL.md` modified (no MCP server source touched, no `package.json` touched)
  - [ ] `grep -E "delaySeconds\s*=\s*300" plugin/ralph-hero/skills/autopilot/SKILL.md` returns no lines (cache-window anti-pattern absent — verifiable mechanically)
  - [ ] `grep -E "delaySeconds\s*=\s*1800" plugin/ralph-hero/skills/autopilot/SKILL.md` returns no lines (the `1800` Configuration-block reference is in the form `Max iterations: 1800` or similar, NEVER `delaySeconds = 1800`)
  - [ ] `grep -E "delaySeconds\s*=" plugin/ralph-hero/skills/autopilot/SKILL.md` only shows lines whose RHS is `60`, `1200`, or `<chosen>` (the placeholder in the canonical example shape)
  - [ ] `grep -q '## Step 7: Update tick counters' plugin/ralph-hero/skills/autopilot/SKILL.md`
  - [ ] `grep -q '## Step 8: Termination' plugin/ralph-hero/skills/autopilot/SKILL.md`
  - [ ] `grep -q '## Step 9: Schedule next tick' plugin/ralph-hero/skills/autopilot/SKILL.md`
  - [ ] `grep -q '## Step 10: Final report' plugin/ralph-hero/skills/autopilot/SKILL.md`
  - [ ] `grep -q 'no_progress_streak' plugin/ralph-hero/skills/autopilot/SKILL.md` (streak machinery present)
  - [ ] `grep -q 'exactly one branch per code path' plugin/ralph-hero/skills/autopilot/SKILL.md` (invariant explicitly stated)

### Phase Success Criteria

#### Automated Verification:
- [x] `test -f plugin/ralph-hero/skills/autopilot/SKILL.md`
- [x] `grep -q '## Step 7: Update tick counters' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [x] `grep -q '## Step 8: Termination' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [x] `grep -q '## Step 9: Schedule next tick' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [x] `grep -q '## Step 10: Final report' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [x] `grep -q 'no_progress_streak' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [x] `grep -q 'exactly one branch per code path' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [x] `grep -E "delaySeconds\s*=\s*300" plugin/ralph-hero/skills/autopilot/SKILL.md` returns no lines
- [x] `grep -E "delaySeconds\s*=\s*1800" plugin/ralph-hero/skills/autopilot/SKILL.md` returns no lines
- [x] `python -c "import yaml; yaml.safe_load(open('plugin/ralph-hero/skills/autopilot/SKILL.md').read().split('---')[1])"` exits 0
- [x] `cd plugin/ralph-hero/mcp-server && npm test` passes
- [x] `git diff plugin/ralph-hero/mcp-server/package.json` is empty (no dep changes)
- [x] `git diff --stat` shows only `plugin/ralph-hero/skills/autopilot/SKILL.md`

#### Manual Verification:
- [ ] 3-issue XS backlog → 3 ticks fire, "Backlog empty" stops cleanly
- [ ] `--max-iterations 1` → exactly one tick fires, second tick stops in Step 8 with "max iterations hit"
- [ ] Forced escalation → autopilot stops on first escalation
- [ ] Cross-tick state survives — set `--max-iterations 5`, run 3 ticks, confirm `iteration` field grows correctly across ticks (verifiable by decoding the `--state=BASE64` value passed to each successive tick: `echo "$BASE64" | base64 -d | jq .iteration`)
- [ ] No-progress streak hits 3 → picked issue moves to `Human Needed` with explanatory comment + Step 10 final report shows the streak-escalation
- [ ] No `ScheduleWakeup` call ever uses `delaySeconds=300` (manual inspection of the skill body + Phase 4 audit-log inspection once Phase 4 lands)
- [ ] No `ScheduleWakeup` call ever uses `delaySeconds=1800` in branch logic (Configuration-block mention is fine; assignment in Step 9 is forbidden)

**Creates for next phase**: A working skill body through Step 10 with all five termination conditions wired up and `ScheduleWakeup` calls compliant with Phase 4's gate invariants by construction. Phase 4 (#1140) adds the audit-log section between Step 7 and Step 8 (no other restructuring needed) and the `PreToolUse: ScheduleWakeup` matcher block in frontmatter pointing at the new `autopilot-wakeup-gate.sh` script.

---

## Integration Testing

Phase-3-only — full integration (audit log writes, hook gate, eval scenarios) is verified in later phases. For Phase 3, the manual verification list above is the integration test. Specifically: the four manual scenarios (3-issue happy path, max-iterations cap, forced escalation, cross-tick state survival) collectively cover the four primary code paths through Steps 7-10. The fifth scenario (no-progress streak escalation) covers the only Step 8 row that has both a STOP and a side effect.

A useful manual smoke test before merging Phase 3: run `--max-iterations 2` against a 3-issue backlog. Expected: tick 1 dispatches issue A → tick 2 dispatches issue B → tick 3 stops in Step 8 with "max iterations hit" (since `iteration > 2` after tick 2's increment); issue C remains in `Ready for Plan`, no `ScheduleWakeup` call from tick 3, Step 10 final report mentions issue C as "queued for next run."

## References

- Parent plan-of-plans: [thoughts/shared/plans/2026-05-07-GH-1136-autopilot-skill.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-07-GH-1136-autopilot-skill.md) (§Phase 3, lines 295-384)
- Phase 1 plan: [thoughts/shared/plans/2026-05-08-GH-1137-autopilot-scaffold.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-08-GH-1137-autopilot-scaffold.md)
- Phase 2 plan: [thoughts/shared/plans/2026-05-08-GH-1138-autopilot-tick-body.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-08-GH-1138-autopilot-tick-body.md)
- Issue: [GH-1139](https://github.com/cdubiel08/ralph-hero/issues/1139)
- Parent issue: [GH-1136](https://github.com/cdubiel08/ralph-hero/issues/1136)
- ScheduleWakeup tool description: cache-window guidance restating "never pick exactly 300s; prefer ≤270s (warm) or ≥1200s (committed). Default idle delay 1800s."
- Out-of-process loop reference: `plugin/ralph-hero/scripts/ralph-loop.sh` — `MAX_ITERATIONS=10` cap; same termination idea, different mechanism (subprocess `claude -p` rather than in-process `ScheduleWakeup`)
- Termination-conditions table source: parent plan lines 322-329 (canonical 5-row table)
- Invariant-table source: parent plan lines 331-336 (exactly one branch per code path)
- Streak-update mapping source: parent plan §Step 7 (canonical outcome → streak rules)
- Final-report shape source: parent plan lines 362-368
- `--state=BASE64` equals-form rationale: parent plan §Step 9 R3 note (base64 padding `=` chars; argument parser must split on first `=` only)
