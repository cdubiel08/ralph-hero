---
type: eval-scenarios
skill: autopilot
date: 2026-05-09
status: defined
---

# Autopilot Eval Scenarios

Scenarios used to grade the `/ralph-hero:autopilot` skill on its primary control-flow paths: backlog clearing, escalation (delegated to hero), termination on empty queue, audit-log shape, cooldown skip-and-retry, and the worktree-collision safety gate.

> **Architecture note:** autopilot is `/loop /hero` with a smarter stop condition. One tick = pick one non-terminal, non-`Human Needed` issue → dispatch hero → diff pre/post → record → reschedule. Cross-tick state rides on `--state=BASE64` in the `ScheduleWakeup` prompt. Autopilot never escalates an issue itself except for the worktree-collision case (Step 3); hero owns all other escalation. Whatever `RALPH_REVIEW_MODE` (and other hero env) is set to is what autopilot inherits — there is no `--auto-merge` flag.

---

## Scenario 1: Empty backlog → immediate stop

### Input

A test project board with **zero** issues outside `Done` / `Canceled` / `Human Needed`.

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`
- **Invocation**: `/ralph-hero:autopilot`

### Expected

1. Step 0 passes. Step 1 initializes fresh state.
2. Step 2 calls `list_issues({})`, applies the non-terminal/non-Human-Needed filter, gets zero candidates.
3. STOP with `outcome=backlog_empty`. Final report. No `ScheduleWakeup`. No hero dispatch.
4. One audit-log line: `outcome=backlog_empty`, `next_action=stop`, `next_delay_seconds=null`, `issue_number=null`.

### Assertions

- [ ] No `Skill("ralph-hero:hero", ...)` dispatch
- [ ] No `ScheduleWakeup` call
- [ ] Audit row: `outcome=backlog_empty`, `next_action=stop`, `next_delay_seconds=null`
- [ ] No `save_issue(workflowState="__ESCALATE__", ...)` call

---

## Scenario 2: Single XS issue, interactive review mode → 1 tick PRs, 1 tick processes that PR (or stops if hero can't progress)

### Input

A test project board with **one** XS issue in `Ready for Plan`.

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`, `RALPH_REVIEW_MODE` unset (defaults to `interactive`)
- **Invocation**: `/ralph-hero:autopilot`

### Expected

1. Tick 1: pick the XS issue, dispatch hero. Hero lands a PR (interactive mode stops at PR). Issue → `In Review`. `outcome=pr_landed`, schedule tick 2 at 60s.
2. Tick 2: issue is still in `In Review` (non-terminal, non-Human-Needed) → eligible. Pick it again, dispatch hero. In interactive mode hero typically no-ops (stops at PR awaiting human merge). `pre == post` → `outcome=no_progress`. Set `cooldowns[N] = state.iteration + 3`. Schedule tick 3 at 1200s.
3. Tick 3: filter applies — issue is in cooldown until iteration+3. No other candidates. STOP `outcome=backlog_empty`.

### Assertions

- [ ] Tick 1: `outcome=pr_landed`, `next_delay_seconds=60`
- [ ] Tick 2: `outcome=no_progress`, `next_delay_seconds=1200`, cooldown set
- [ ] Tick 3: `outcome=backlog_empty`, `next_action=stop`, `next_delay_seconds=null`
- [ ] PR exists on the issue and remains open (interactive mode = human merges)
- [ ] No `Human Needed` escalation
- [ ] Final report lists the in-review PR as awaiting human merge (via cooldowns or explicit note)

> **Note**: with `RALPH_REVIEW_MODE=auto` (and CI/review env configured), the in-review issue would reach `Done` instead of cooldown — see Scenario 8.

---

## Scenario 3: Three XS issues → drains to empty (interactive)

### Input

Three XS issues in actionable states.

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`, interactive review mode
- **Invocation**: `/ralph-hero:autopilot`

### Expected

1. Ticks 1-3: each picks a different issue, lands a PR, advances to `In Review`.
2. Ticks 4-6: each in-review issue gets re-picked, hero no-ops, cooldown set.
3. Tick 7: all three issues in cooldown, no other candidates → STOP `backlog_empty`.

### Assertions

- [ ] Audit log: 3 `pr_landed`, 3 `no_progress`, 1 `backlog_empty`
- [ ] All three issues in `In Review` with open PRs
- [ ] No `Human Needed` escalations
- [ ] `iteration` strictly monotonic
- [ ] No `next_delay_seconds=300`

---

## Scenario 4: Hero escalates → autopilot trusts and continues to next issue

### Input

Two issues. The first is straightforward XS. The second triggers hero's escalation path (e.g., conflicting acceptance criteria) and ends in `Human Needed`.

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`
- **Invocation**: `/ralph-hero:autopilot`

### Expected

1. Tick 1: first issue → `pr_landed`. Schedule.
2. Tick 2: second issue picked. Hero drives partway, escalates to `Human Needed`. Step 6 detects `post.workflowState=Human Needed` → `outcome=escalated`.
3. Step 8 row 1 fires → STOP. Audit row records `escalation_reason` from last comment.
4. Final report: 1 `pr_landed`, 1 `escalated`. Notes the escalated issue is now ineligible (Human Needed) and recommends running `/unblock` separately.

### Assertions

- [ ] Audit log: 1 `pr_landed`, 1 `escalated` with `escalation_reason` populated
- [ ] Escalated tick has `next_action=stop`, `next_delay_seconds=null`
- [ ] Second issue's workflow state is `Human Needed`
- [ ] First issue still in `In Review`
- [ ] No `ScheduleWakeup` after the escalation tick

> **Design note**: per the new design, autopilot stops on first escalation in a tick. A future enhancement could continue past hero-escalations to the next eligible issue (since `Human Needed` is filtered out, no infinite loop), but MVP keeps the `escalated → stop` rule for forensic clarity.

---

## Scenario 5: Cooldown skip-and-retry → no infinite loop on stuck issue

### Input

Two issues: one stuck (hero will repeatedly no-op without escalating, e.g., a locked `In Progress` from a prior session) and one fresh XS.

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`
- **Invocation**: `/ralph-hero:autopilot`

### Expected

1. Tick 1: stuck issue picked first (oldest `updatedAt`). Hero no-ops. `outcome=no_progress`. Cooldown set: `cooldowns[stuck] = 2 + 3 = 5`. Schedule at 1200s.
2. Tick 2: stuck issue is in cooldown. Filter drops it. Fresh XS picked, `pr_landed`. Schedule at 60s.
3. Tick 3-4: fresh issue cycles through (PR landed → no_progress → cooldown), stuck still in cooldown.
4. Eventually all eligible items are in cooldown or processed → STOP `backlog_empty`.
5. Final report lists `cooldowns` so the user knows which issues to look at next run.

### Assertions

- [ ] Stuck issue is NOT re-picked while in cooldown
- [ ] No `Human Needed` escalation by autopilot itself for the stuck issue
- [ ] Final report includes a `Cooldowns at exit` section listing the stuck issue
- [ ] No `next_delay_seconds=300` ever

---

## Scenario 6: `RALPH_AUTOPILOT_ENABLE` unset → refuses

### Input

- **Env**: `RALPH_AUTOPILOT_ENABLE` unset
- **Invocation**: `/ralph-hero:autopilot`

### Expected

Step 0 short-circuits. Output includes the enable command. No API calls, no audit row, no wakeup.

### Assertions

- [ ] Output contains `export RALPH_AUTOPILOT_ENABLE=true`
- [ ] No `list_issues`, `get_issue`, or `save_issue` call
- [ ] No `ScheduleWakeup`
- [ ] No new line in `~/.ralph-hero/autopilot.jsonl`

---

## Scenario 7: `--dry-run` → no dispatch, no schedule

### Input

At least one XS issue in actionable state. `--dry-run` flag.

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`
- **Invocation**: `/ralph-hero:autopilot --dry-run`

### Expected

1. Steps 0-4 run normally: pick issue, capture pre-state.
2. Step 5: `--dry-run` → skip dispatch, mark `outcome=dry_run`, skip Step 6.
3. Step 8: `outcome == dry_run` → STOP. No `ScheduleWakeup`.
4. Audit row: `outcome=dry_run`, `next_action=stop`, `next_delay_seconds=null`.

### Assertions

- [ ] One audit row, `outcome=dry_run`
- [ ] No hero dispatch, no `ScheduleWakeup`
- [ ] Picked issue's workflow state unchanged
- [ ] Output indicates "Would dispatch hero for #N"

---

## Scenario 8: `RALPH_REVIEW_MODE=auto` end-to-end → completed, drains to empty

### Input

One XS issue. Hero env configured for true auto end-to-end (`RALPH_REVIEW_MODE=auto`, `--admin` merge or whatever the user's gh setup requires for unattended merge — see CLAUDE.md and the `feedback_finish_merge_review_gap` memory).

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`, `RALPH_REVIEW_MODE=auto`
- **Invocation**: `/ralph-hero:autopilot`

### Expected

1. Tick 1: pick issue, dispatch hero. Hero drives plan → impl → PR → code-review → merge. Issue → `Done`. `outcome=completed`.
2. Tick 2: filter excludes `Done` issues. No other candidates → STOP `backlog_empty`.

### Assertions

- [ ] Audit: 1 `completed`, 1 `backlog_empty`
- [ ] Issue is `Done`, PR is `MERGED`
- [ ] Worktree cleaned up
- [ ] Autopilot did NOT set `RALPH_REVIEW_MODE` itself — it inherited it

---

## Scenario 9: Pre-existing worktree → escalates without dispatching

### Input

One XS issue. Manually `git worktree add worktrees/GH-<picked> -b feature/GH-<picked>` before invoking autopilot to simulate an interrupted prior run.

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`
- **Invocation**: `/ralph-hero:autopilot`

### Expected

1. Tick 1: Step 2 picks the issue. Step 3 worktree check finds the stale worktree.
2. Autopilot escalates the issue with reason mentioning the stale worktree, posts a comment with cleanup instructions.
3. `outcome=escalated` → STOP. No hero dispatch, no `ScheduleWakeup`.

### Assertions

- [ ] No hero dispatch
- [ ] Issue is `Human Needed`
- [ ] Escalation comment mentions the stale worktree path
- [ ] Pre-existing worktree directory NOT touched
- [ ] Audit row: `outcome=escalated`, `escalation_reason` mentions "stale worktree"

---

## Scenario 10: Cross-tick state survives — `iteration`, `history`, `cooldowns`

### Input

Five XS issues with at least one expected to no-op (so cooldown gets exercised).

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`
- **Invocation**: `/ralph-hero:autopilot`

### Expected

1. Each tick decodes `--state`, increments iteration, encodes the new state into the next `ScheduleWakeup` prompt.
2. `history` accumulates entries (one per tick).
3. `cooldowns` accumulates and decays correctly: an issue with cooldown=N becomes eligible again at iteration N (test by running long enough to cross the cooldown boundary).
4. `started_at` stable across all ticks.

### Assertions

- [ ] Audit `iteration` is strictly monotonic
- [ ] N-th tick's `--state=BASE64` decodes to (N-1) history entries
- [ ] An issue cooldowned at tick K is re-picked at tick K+3 (if still eligible)
- [ ] `started_at` identical across all ticks
- [ ] No `next_delay_seconds=300`

---

## Grading Rubric

A scenario PASSES if all `[ ]` assertions hold. The critical regression checks:

- **Empty queue stops the loop** (Scenarios 1, 3, 5, 8) — autopilot never spins forever
- **Hero escalation is trusted** (Scenario 4) — autopilot doesn't escalate on hero's behalf
- **Cooldown prevents tight loops** (Scenarios 2, 5) — stuck issues don't pin the loop
- **Worktree gate fires before dispatch** (Scenario 9) — never clobber in-progress work
- **Opt-in gate refuses cleanly** (Scenario 6) — never run unattended without explicit consent
- **`delaySeconds=300` never observed** — the cache-window anti-pattern stays blocked

## Anti-Patterns

1. **Autopilot escalating an issue itself for any reason other than worktree collision** — escalation is hero's job. If autopilot calls `save_issue(workflowState="__ESCALATE__", ...)` outside Step 3, it's a regression.
2. **Filter accepting `Human Needed` issues** — Step 2 must drop them. If a `Human Needed` issue is dispatched to hero, it's a regression.
3. **Filter dropping `In Review` issues** — the old design did this; the new one does not. `In Review` is non-terminal and must remain eligible (so auto-mode runs can drive it to `Done`).
4. **Tight loop on stuck issue** — without cooldown, hero re-pick-no-op-re-pick would burn ticks. Detected by Scenario 5.
5. **`next_action=stop` with `next_delay_seconds != null`** — invariant violation. `jq 'select(.next_action == "stop" and .next_delay_seconds != null)' ~/.ralph-hero/autopilot.jsonl` must be empty.
6. **`ScheduleWakeup` with prompt not starting `/ralph-hero:autopilot`** — wakeup-gate hook should block. Regression if observed.
7. **Cross-tick state read from audit log** — audit is forensic, state is the `--state=BASE64` channel.
8. **Autopilot setting `RALPH_REVIEW_MODE`** — autopilot must inherit, never override. End-to-end behavior is the user's env's responsibility.
