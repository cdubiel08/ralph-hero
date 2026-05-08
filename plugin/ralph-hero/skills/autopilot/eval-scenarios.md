---
type: eval-scenarios
skill: autopilot
date: 2026-05-08
status: defined
---

# Autopilot Eval Scenarios

Thirteen scenarios used to grade the `/ralph-hero:autopilot` skill on its primary control-flow paths: backlog clearing, escalation, termination conditions, audit-log shape, and the R3-critical In-Review filter (Step 2.5) regression test.

> **Architecture note:** autopilot is a self-paced backlog clearer that wraps `/ralph-hero:hero` in a `ScheduleWakeup`-based loop. One tick = one issue end-to-end. Cross-tick state rides on the `prompt` field of `ScheduleWakeup` as `--state=BASE64`. The audit log at `~/.ralph-hero/autopilot.jsonl` is forensic, not a state channel. The skill is purely markdown — no MCP/TypeScript code is exercised by these scenarios beyond the existing `next_actions`, `get_issue`, `save_issue`, and `create_comment` tools that autopilot composes.

> **Execution note:** These scenarios are written for manual walkthrough against a real test project board. Scenarios 12 and 13 are R3-critical regression tests for the In-Review filter (Step 2.5) — without them passing, the autopilot would falsely escalate healthy in-review PRs to `Human Needed` after three 60s ticks. Both MUST be walked through manually before the autopilot skill is considered feature-complete.

---

## Scenario 1: Empty backlog → immediate stop

### Input

A test project board with **zero** actionable issues (every issue is in `Done`, `Canceled`, `Human Needed`, or some non-`ACTIONABLE_PHASES` state).

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`
- **Invocation**: `/ralph-hero:autopilot`

### Expected Behavior

1. Step 0 safety check passes (`RALPH_AUTOPILOT_ENABLE=true`).
2. Step 1 argument parsing: no `--state`, initialize `{iteration: 1, no_progress_streak: 0, started_at: <now>, history: []}`.
3. Step 2 calls `next_actions(audience="agent", limit=10)` → empty `items`.
4. Skill emits "Backlog empty" final report and STOPS.
5. No `ScheduleWakeup` call. No hero dispatch. No audit-log entry (or one entry with `outcome="backlog_empty"`, `next_action="stop"`, `next_delay_seconds=null`, `issue_number=null`).

### Assertions

- [ ] Skill output begins with or contains "Backlog empty"
- [ ] No `ScheduleWakeup` tool call observed
- [ ] No `Skill("ralph-hero:hero", ...)` dispatch observed
- [ ] If audit log line written: `outcome=backlog_empty`, `next_action=stop`, `next_delay_seconds=null`, `issue_number=null`
- [ ] No false escalation, no `save_issue(workflowState="__ESCALATE__", ...)` call

---

## Scenario 2: Single XS issue, default flags → 1 tick, 1 PR, stops

### Input

A test project board with **one** XS issue in `Ready for Plan` (or wherever the picked-by-`next_actions` rules land it).

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`, `RALPH_REVIEW_MODE` unset (defaults to `interactive`)
- **Invocation**: `/ralph-hero:autopilot`

### Expected Behavior

1. Tick 1 fires: pick the XS issue, dispatch `Skill("ralph-hero:hero", args="<picked>")`.
2. Hero drives the issue through plan → impl → PR. Lands a PR. Issue advances to `In Review`.
3. Autopilot Step 6 pre/post diff: `pre.workflowState ∈ {Backlog, Ready for Plan, In Progress}` → `post.workflowState = In Review` → `outcome=pr_landed`.
4. Step 7: `no_progress_streak = 0`. History appends `{issue: <picked>, outcome: pr_landed}`.
5. Audit log appended: `outcome=pr_landed`, `next_action=schedule`, `next_delay_seconds=60`.
6. Step 9: `ScheduleWakeup(delaySeconds=60, prompt="/ralph-hero:autopilot --max-iterations 20 --state=<BASE64>")`.
7. Tick 2 fires 60s later. Step 2 calls `next_actions` → returns the same issue (since `In Review` is in `ACTIONABLE_PHASES`).
8. Step 2.5 In-Review filter: `candidates = candidates.filter(c => c.workflowState !== "In Review")` → empty.
9. No remaining candidates → STOP with `outcome=backlog_empty`. Final report mentions the in-review PR awaiting human merge.

### Assertions

- [ ] Exactly two ticks observed in audit log
- [ ] Tick 1: `outcome=pr_landed`, `next_action=schedule`, `next_delay_seconds=60`
- [ ] Tick 2: `outcome=backlog_empty`, `next_action=stop`, `next_delay_seconds=null`
- [ ] PR exists on the issue (`gh pr list --head feature/GH-<picked>` returns one open PR)
- [ ] Issue workflow state is `In Review` at end of run
- [ ] Final report mentions "awaiting human merge" or equivalent for the in-review PR
- [ ] No `Human Needed` escalation occurred
- [ ] No `delaySeconds=300` ever observed

---

## Scenario 3: Three XS issues → 3 ticks, 3 PRs, stops cleanly

### Input

A test project board with **three** XS issues in actionable states (`Ready for Plan` or earlier phases hero can drive forward).

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`
- **Invocation**: `/ralph-hero:autopilot`

### Expected Behavior

1. Ticks 1, 2, 3 each pick a different XS issue (priority-ordered by `next_actions`), dispatch hero, hero lands a PR, issue moves to `In Review`.
2. Each tick records `outcome=pr_landed`, `next_delay_seconds=60`.
3. Tick 4 fires: `next_actions` returns the three in-review issues; Step 2.5 filters all three; no remaining candidates → STOP with `outcome=backlog_empty`.
4. Final report lists three in-review PRs awaiting human merge.

### Assertions

- [ ] Audit log contains 4 lines: 3 with `outcome=pr_landed` and one with `outcome=backlog_empty`
- [ ] All three issues are in `In Review` at end of run
- [ ] Three open PRs exist (one per issue)
- [ ] No `Human Needed` escalation occurred
- [ ] `iteration` field grows monotonically: 1, 2, 3, 4
- [ ] No `delaySeconds=300` ever observed
- [ ] Final report enumerates all three in-review PRs

---

## Scenario 4: Mid-loop escalation → stops on first escalation

### Input

A test project board with one XS issue followed by one **ambiguous** issue that hero will escalate (e.g., conflicting acceptance criteria, missing plan, or any condition that triggers hero's `__ESCALATE__` path).

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`
- **Invocation**: `/ralph-hero:autopilot`

### Expected Behavior

1. Tick 1: picks the first XS issue, hero lands PR, `outcome=pr_landed`. Schedules tick 2 at 60s.
2. Tick 2: picks the ambiguous issue. Hero drives partway, then escalates via `save_issue(workflowState="__ESCALATE__", ...)`. Issue moves to `Human Needed`.
3. Step 6 pre/post diff: `post.workflowState = Human Needed` → `outcome=escalated`. Capture last comment as `escalation_reason`.
4. Step 8 termination check: `outcome == escalated` → STOP. Do NOT call `ScheduleWakeup`.
5. Final report includes the escalation count and reason.

### Assertions

- [ ] Audit log contains exactly 2 lines: one `outcome=pr_landed`, one `outcome=escalated`
- [ ] Escalated tick has `next_action=stop`, `next_delay_seconds=null`, populated `escalation_reason`
- [ ] Ambiguous issue's workflow state is `Human Needed` at end of run
- [ ] First issue still in `In Review` (not regressed)
- [ ] No subsequent `ScheduleWakeup` call observed after the escalation tick
- [ ] Final report mentions the escalation count and surfaces the reason text

---

## Scenario 5: `--max-iterations 2` against 5-issue backlog → stops at 2

### Input

A test project board with **five** XS issues in actionable states.

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`
- **Invocation**: `/ralph-hero:autopilot --max-iterations 2`

### Expected Behavior

1. Ticks 1, 2 each pick an XS issue, hero lands PR, `outcome=pr_landed`.
2. End of tick 2: `iteration` incremented to 3 in next-state encoding. Step 8 termination check: `iteration > MAX_ITERATIONS` (3 > 2) → STOP with reason "max iterations hit".
3. No tick 3 fires. `ScheduleWakeup` is NOT called from tick 2.
4. Three of the five issues remain untouched in their pre-run states.

### Assertions

- [ ] Audit log contains exactly 2 lines, both `outcome=pr_landed`
- [ ] Final tick has `next_action=stop`, `next_delay_seconds=null`, reason mentions "max iterations"
- [ ] Three of the five issues still in their original pre-run workflow state
- [ ] Two issues are in `In Review` with open PRs
- [ ] No tick 3 wakeup fired (`/tasks` shows no pending autopilot wakeup)
- [ ] Final report cites max-iterations as termination cause

---

## Scenario 6: Three consecutive locked-issue ticks → no_progress_streak escalation

### Input

A test project board with one issue that hero cannot advance (e.g., locked `In Progress` from a prior session, or some structural block that produces no state change). `next_actions` keeps returning the same issue across ticks.

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`
- **Invocation**: `/ralph-hero:autopilot`

### Expected Behavior

1. Tick 1: picks the locked issue, hero runs but cannot make progress. Step 6 pre/post diff: `pre == post` → `outcome=no_progress`. `no_progress_streak = 1`. Schedule tick 2 at 1200s.
2. Tick 2: same. `no_progress_streak = 2`. Schedule tick 3 at 1200s.
3. Tick 3: same. After Step 7, `no_progress_streak = 3`. Step 8: `no_progress_streak >= 3` → STOP and escalate the picked issue with reason "autopilot detected no-progress streak of 3".
4. Issue moves to `Human Needed` via `save_issue(workflowState="__ESCALATE__", ...)`. Final report cites the streak as termination cause.

### Assertions

- [ ] Audit log contains 3 lines, all with the same `issue_number`, `outcome=no_progress`
- [ ] Tick 1 and 2 have `next_delay_seconds=1200` (no_progress streak 1 or 2)
- [ ] Tick 3 has `next_action=stop`, `next_delay_seconds=null`
- [ ] Issue is in `Human Needed` at end of run
- [ ] An escalation comment was posted to the issue citing the no-progress streak
- [ ] No `delaySeconds=300` ever observed

---

## Scenario 7: `RALPH_AUTOPILOT_ENABLE` unset → refuses

### Input

Any test project board (state irrelevant — Step 0 short-circuits before any querying).

- **Env**: `RALPH_AUTOPILOT_ENABLE` unset (or set to anything other than `"true"`)
- **Invocation**: `/ralph-hero:autopilot`

### Expected Behavior

1. Step 0 safety check: `RALPH_AUTOPILOT_ENABLE != "true"` → STOP immediately with the opt-in refusal message.
2. Output includes a copy-pasteable enable command (`export RALPH_AUTOPILOT_ENABLE=true`).
3. No `next_actions` call. No `ScheduleWakeup` call. No audit log entry written.

### Assertions

- [ ] Skill output contains "opt-in" or equivalent refusal language
- [ ] Output includes the enable command `export RALPH_AUTOPILOT_ENABLE=true`
- [ ] No GitHub API calls observed (no `next_actions`, no `get_issue`, no `save_issue`)
- [ ] No `ScheduleWakeup` call observed
- [ ] No new line appended to `~/.ralph-hero/autopilot.jsonl`

---

## Scenario 8: `--auto-merge` with passing CI → merges PRs

### Input

A test project board with one XS issue and CI configured to pass on the resulting PR.

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`
- **Invocation**: `/ralph-hero:autopilot --auto-merge`

### Expected Behavior

1. Tick 1: picks the XS issue. Autopilot exports `RALPH_REVIEW_MODE=auto` so hero runs in auto-merge mode.
2. Hero drives plan → impl → PR → code-review → merge. Issue advances to `Done`.
3. Step 6 pre/post diff: `post.workflowState = Done` → `outcome=completed`.
4. Tick 2: `next_actions` returns 0 actionable issues → STOP with `outcome=backlog_empty`.

### Assertions

- [ ] Audit log: tick 1 `outcome=completed`, tick 2 `outcome=backlog_empty`
- [ ] Issue workflow state is `Done` at end of run
- [ ] PR is merged (`gh pr view --json state` returns `MERGED`)
- [ ] Worktree for the issue has been cleaned up (per merge skill behavior)
- [ ] Final report cites one completion, no escalations
- [ ] `--state=BASE64` carries the `--auto-merge` flag forward across the schedule (visible in tick 2 prompt regex)

---

## Scenario 9: `--dry-run` → no hero dispatch, no schedule

### Input

A test project board with at least one XS issue.

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`
- **Invocation**: `/ralph-hero:autopilot --dry-run`

### Expected Behavior

1. Step 0–5 run as normal: pick an issue, capture pre-state.
2. Step 5: `--dry-run` is set → skip `Skill("ralph-hero:hero", ...)` entirely. Mark tick as `outcome=dry_run`.
3. Step 8: `outcome == dry_run` → STOP. Do NOT call `ScheduleWakeup`.
4. Audit log line written with `outcome=dry_run`, `next_action=stop`, `next_delay_seconds=null`.

### Assertions

- [ ] Exactly one audit log line written, with `outcome=dry_run`
- [ ] No `Skill("ralph-hero:hero", ...)` dispatch observed
- [ ] No `ScheduleWakeup` call observed
- [ ] Picked issue's workflow state is unchanged (no side effects)
- [ ] Output indicates "would dispatch hero for #N" or equivalent dry-run language
- [ ] Final report cites dry-run as termination cause

---

## Scenario 10: Pre-existing worktree at `worktrees/GH-N/` → escalates without dispatching

### Input

A test project board with one XS issue picked by `next_actions`. **Before** invoking autopilot, manually create a directory at `worktrees/GH-<picked>/` (e.g., `git worktree add worktrees/GH-<picked> -b feature/GH-<picked>`) to simulate an interrupted prior tick.

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`
- **Invocation**: `/ralph-hero:autopilot`

### Expected Behavior

1. Tick 1: Step 2 picks the XS issue. Step 2.5 In-Review filter passes (issue is not in `In Review`).
2. Step 3 worktree liveness check: `git worktree list` shows `worktrees/GH-<picked>/` exists.
3. Skill ESCALATES the issue with reason "stale worktree at `worktrees/GH-<picked>/` from prior tick — needs human cleanup before autopilot can re-dispatch".
4. Issue moves to `Human Needed` via `save_issue(workflowState="__ESCALATE__", ...)`.
5. Step 8: `outcome == escalated` → STOP. Do NOT call `ScheduleWakeup`. Do NOT call hero.

### Assertions

- [ ] No `Skill("ralph-hero:hero", ...)` dispatch observed (worktree gate fired before dispatch)
- [ ] Issue is in `Human Needed` at end of run
- [ ] Escalation comment on issue mentions the stale worktree path
- [ ] Audit log line: `outcome=escalated`, `next_action=stop`, `next_delay_seconds=null`, `escalation_reason` mentions "stale worktree"
- [ ] No `ScheduleWakeup` call observed
- [ ] Pre-existing worktree directory is NOT modified or deleted by autopilot (safe-default behavior)

---

## Scenario 11: Cross-tick state survives — `iteration` grows monotonically

### Input

A test project board with five XS issues in actionable states.

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`
- **Invocation**: `/ralph-hero:autopilot --max-iterations 5`

### Expected Behavior

1. Tick 1: `state.iteration = 1`. After Step 7, encode `iteration = 2` into the next `--state=BASE64`.
2. Each subsequent tick decodes `--state`, reads `iteration`, increments, and encodes the new value into the next schedule.
3. Cross-tick state rides on the `prompt` field of `ScheduleWakeup`, NOT on the audit log (per Tick Isolation table).
4. After three ticks, `jq -s 'map(.iteration)' ~/.ralph-hero/autopilot.jsonl` should yield `[1, 2, 3]` (or similar monotonic sequence) at minimum.

### Assertions

- [ ] Audit log `iteration` field is strictly monotonically increasing across ticks (1, 2, 3, ...)
- [ ] No tick re-uses an `iteration` value (no duplicates)
- [ ] `state.history` (visible via base64-decoding the `prompt` field of intermediate `ScheduleWakeup` calls) accumulates entries — N-th tick's prompt encodes (N-1) history entries
- [ ] `started_at` is stable across all ticks (not reset on each tick)
- [ ] Termination at iteration 5 (or backlog-empty if reached first) stops with `next_action=stop`

---

## Scenario 12: In-Review filter (R3 critical fix) — single XS, interactive default

### Input

A test project board with **one** XS issue in `Ready for Plan`.

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`, `RALPH_REVIEW_MODE` unset (defaults to `interactive`)
- **Invocation**: `/ralph-hero:autopilot`

> **R3-critical regression test.** This scenario exercises the In-Review filter from Step 2.5 (introduced in plan revision 3 to fix the false-escalation bug R2 left open). Without Step 2.5, autopilot would re-pick the just-PR'd issue, hero would no-op three times in a row, `no_progress_streak` would hit 3, and autopilot would escalate a perfectly healthy in-review PR to `Human Needed`. With Step 2.5, the just-PR'd issue is filtered out and autopilot exits cleanly.

### Expected Behavior

1. Tick 1: picks the XS issue, dispatches hero. Hero lands a PR (interactive mode → stops at PR). Issue moves to `In Review`.
2. Step 6 pre/post diff: `outcome=pr_landed`. `no_progress_streak = 0`. Schedule tick 2 at 60s.
3. Tick 2 fires 60s later: Step 2 calls `next_actions(audience="agent", limit=10)` → returns the in-review issue (since `In Review` is in `ACTIONABLE_PHASES`).
4. Step 2.5 first filter rule: `candidates = candidates.filter(c => c.workflowState !== "In Review")` → empty.
5. Step 2.5 second filter rule (also satisfies): `state.history.some(h => h.issue === <picked> && h.outcome === "pr_landed")` is true → would also filter, but the first rule already removed it.
6. No remaining candidates → STOP with `outcome=backlog_empty`. Final report mentions the in-review PR awaiting human merge.

### Assertions (R3 critical)

- [ ] Issue is NOT re-dispatched to hero in tick 2 (no `Skill("ralph-hero:hero", ...)` call observed in tick 2)
- [ ] `no_progress_streak` does NOT exceed 0 across the entire run (no streak accumulates)
- [ ] Issue is NOT escalated to `Human Needed` (workflow state stays at `In Review`)
- [ ] No `save_issue(workflowState="__ESCALATE__", ...)` call observed for this issue
- [ ] Final tick has `outcome=backlog_empty`, `next_action=stop`, `next_delay_seconds=null`
- [ ] Total tick count is exactly 2 (tick 1 lands PR; tick 2 filter→stop)
- [ ] Final report explicitly lists the in-review PR as "awaiting human merge"
- [ ] PR remains open (not merged, not closed) at end of run
- [ ] **Regression check**: re-running this scenario after any future change to autopilot must continue to pass — this is the canary for the R3 In-Review filter

---

## Scenario 13: In-Review filter — multi-issue mix

### Input

A test project board with:
- **Two** fresh XS issues in `Ready for Plan`
- **One** issue already in `In Review` from a prior session (with an open PR awaiting human merge)

- **Env**: `RALPH_AUTOPILOT_ENABLE=true`, `RALPH_REVIEW_MODE` unset (defaults to `interactive`)
- **Invocation**: `/ralph-hero:autopilot`

> **R3-critical regression test, complementary to Scenario 12.** Validates the In-Review filter against a mixed backlog where the human-gated PR coexists with fresh actionable work. Autopilot must never pick the in-review issue, must process the two XS issues to completion (PR landed), and must list the prior in-review issue as "awaiting human merge" in the final summary — not as "processed".

### Expected Behavior

1. Tick 1: Step 2 calls `next_actions` → returns 3 candidates (priority/phase ordered). Step 2.5 filters out the prior in-review issue. Top remaining candidate is one of the two fresh XS issues.
2. Tick 1 dispatches hero on that XS issue → PR lands → `outcome=pr_landed`. Schedule tick 2 at 60s.
3. Tick 2: `next_actions` returns 3 candidates again (now: 1 fresh XS + 2 in-review). Step 2.5 filters out the 2 in-review issues. Top remaining candidate is the second fresh XS issue.
4. Tick 2 dispatches hero → PR lands → `outcome=pr_landed`. Schedule tick 3 at 60s.
5. Tick 3: `next_actions` returns 3 candidates (now all 3 are in-review). Step 2.5 filters all of them. No remaining candidates → STOP with `outcome=backlog_empty`.
6. Final report: 2 PRs landed this run; 3 in-review PRs awaiting human merge (the 2 just landed + the 1 prior session).

### Assertions (R3 critical)

- [ ] The prior in-review issue is NEVER dispatched to hero across all ticks (no `Skill("ralph-hero:hero", args="<prior-in-review-number>")` call observed)
- [ ] The prior in-review issue's workflow state remains `In Review` at end of run (unchanged)
- [ ] The prior in-review issue does NOT accumulate a no-progress streak in the audit log
- [ ] The prior in-review issue is NOT escalated to `Human Needed`
- [ ] Audit log: ticks 1 and 2 have `outcome=pr_landed`; tick 3 has `outcome=backlog_empty`
- [ ] Final report distinguishes "processed" (2 issues, with PR URLs) from "awaiting human merge" (3 issues, including the prior in-review one)
- [ ] At end of run: 3 issues are in `In Review` with open PRs (the 2 newly landed + the 1 prior session)
- [ ] Total tick count is exactly 3
- [ ] `iteration` field in audit log: 1, 2, 3 (monotonic)

---

## Grading Rubric

| Dimension | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 |
|-----------|---|---|---|---|---|---|---|---|---|----|----|----|----|
| Hero dispatched | No | Yes (1×) | Yes (3×) | Yes (2×) | Yes (2×) | Yes (3×) | No | Yes (1×) | No | No | varies | Yes (1×) | Yes (2×) |
| `ScheduleWakeup` called | No | Yes (1×) | Yes (3×) | Yes (1×) | Yes (1×) | Yes (2×) | No | Yes (1×) | No | No | varies | Yes (1×) | Yes (2×) |
| Final outcome | backlog_empty | backlog_empty | backlog_empty | escalated | max_iter | escalated (streak) | refused | backlog_empty | dry_run | escalated (worktree) | varies | backlog_empty | backlog_empty |
| Issues escalated to Human Needed | 0 | 0 | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 1 | 0 | **0 (R3)** | **0 (R3)** |
| `delaySeconds=300` ever | No | No | No | No | No | No | No | No | No | No | No | No | No |
| In-Review issues filtered | N/A | Yes (tick 2) | Yes (tick 4) | N/A | N/A | N/A | N/A | N/A | N/A | N/A | varies | **Yes (tick 2)** | **Yes (every tick)** |

A run is graded **PASS** if all `[ ]` assertions for its scenario hold. **FAIL** otherwise.

Scenarios 12 and 13 are **R3 hard gates** — both MUST pass before the autopilot skill is considered feature-complete. They are the regression canaries for the In-Review filter (Step 2.5).

## Anti-Patterns to Watch For

1. **`delaySeconds=300` ever appears in a `ScheduleWakeup` call** — the cache-window anti-pattern. The hook gate (`autopilot-wakeup-gate.sh`) should block this; if it slips through, audit log will show the value. Inspect with `jq -r '.next_delay_seconds' ~/.ralph-hero/autopilot.jsonl | sort -u` — expected set is `{60, 1200, null}`.
2. **In-Review issue re-dispatched to hero** — Step 2.5 regression. The single most important defect for this skill (R3-critical). Detected by Scenarios 12 and 13.
3. **False no-progress streak escalation on a healthy in-review PR** — downstream consequence of (2). If Scenario 12 ever shows `no_progress_streak >= 1` for the in-review issue, the In-Review filter has regressed.
4. **`next_action=stop` with `next_delay_seconds != null`** — invariant violation. When the loop terminates, the audit log MUST record `next_delay_seconds=null` (not `0`, not absent). Detected by `jq 'select(.next_action == "stop" and .next_delay_seconds != null)' ~/.ralph-hero/autopilot.jsonl`.
5. **`ScheduleWakeup` call with a prompt that does not start with `/ralph-hero:autopilot`** — the hook gate should block this. If observed in audit log or task list, the gate has regressed.
6. **Cross-tick state sourced from the audit log instead of `--state=BASE64`** — design violation. The audit log is forensic, not a state channel (per Tick Isolation §Key design decision in the parent plan). If autopilot ever reads `~/.ralph-hero/autopilot.jsonl` to recover `iteration` or `no_progress_streak`, that's a regression.
7. **`RALPH_AUTOPILOT_ENABLE` check bypassed** — Step 0 safety gate must short-circuit before any GitHub API call. If Scenario 7 shows any `next_actions` or `get_issue` invocation, the safety check has regressed.
8. **Worktree gate skipped** — Scenario 10 must escalate without dispatching. If hero is invoked despite a pre-existing `worktrees/GH-N/` directory, the Step 3 worktree-liveness check has regressed and risks worktree collisions.
9. **Auto-merge In-Review filter bypassed without a structured signal** — per parent plan §Phase 1 Step 2.5, the In-Review filter stays ON regardless of `--auto-merge` for MVP. Tracking auto-merge In-Review handling as follow-up work (parent plan §Follow-up Work). If a future change relaxes this, scenarios 12 and 13 must be updated in lock-step.
