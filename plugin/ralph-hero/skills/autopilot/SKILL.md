---
description: Autonomous backlog clearer. Wraps /ralph-hero:hero in a self-paced ScheduleWakeup loop, picking the next non-terminal, non-Human-Needed issue per tick until the queue drains. Approximation of `/loop /hero` — works through every issue and PR end-to-end, trusting hero to escalate ambiguity to Human Needed.
argument-hint: "[--dry-run] [--state=BASE64]"
context: inline
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=autopilot"
  PreToolUse:
    - matcher: "ScheduleWakeup"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/autopilot-wakeup-gate.sh"
allowed-tools:
  - Read
  - Write
  - Bash
  - Skill
  - Agent
  - ScheduleWakeup
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`
- Autopilot enabled: !`echo ${RALPH_AUTOPILOT_ENABLE:-false}`
- Review mode (inherited by hero): !`echo ${RALPH_REVIEW_MODE:-interactive}`
- Audit log: ~/.ralph-hero/autopilot.jsonl

# Ralph Autopilot — Backlog Clearer

You are the autopilot orchestrator. One invocation = one tick. Each tick: decode-state -> pick -> worktree-check -> dispatch hero -> diff -> record -> schedule-or-stop.

**Mental model**: this skill is `/loop /hero` with a smarter stop condition. It picks the next non-terminal, non-`Human Needed` issue, dispatches `/hero` against it, and reschedules itself. Hero owns the per-issue state machine — including escalation to `Human Needed` when it hits operational ambiguity. Autopilot trusts hero: it never escalates an issue itself except for the worktree-collision safety case (Step 3). Whatever review mode hero is configured for via `RALPH_REVIEW_MODE` is what autopilot inherits — set it to `auto` (with the matching env vars) for true ticket → RPI → review → merge end-to-end runs.

## Step 0: Safety check

If `RALPH_AUTOPILOT_ENABLE` is not exactly the string `"true"`, STOP immediately with this message and do NOT proceed:

> Autopilot is opt-in. To enable: `export RALPH_AUTOPILOT_ENABLE=true`

## Step 1: Argument parsing + state decode

Parse the following flags from `$ARGUMENTS`:

- `--dry-run` — default false (skip dispatch, report intent only)
- `--state=BASE64` — cross-tick state, absent on first tick

**Equals-form parsing rule**: split each arg on the **first** `=` only. Everything after that first `=` is the value, including any additional `=` characters introduced by base64 padding. Example: `--state=eyJpdGVyYXRpb24iOjF9==` parses as flag `--state` with value `eyJpdGVyYXRpb24iOjF9==`.

If `--state` is **present**: base64-decode the value, then JSON-parse. Expected shape:

```json
{
  "iteration": 3,
  "started_at": "2026-05-09T03:00:00Z",
  "history": [{"issue": 1234, "outcome": "pr_landed"}],
  "cooldowns": {"1235": 5}
}
```

`cooldowns` maps `issue_number -> iteration_at_which_eligible_again`. Used by Step 2's filter to skip issues that produced `no_progress` in a recent tick (avoids tight loops on a stuck issue without escalating it; hero owns escalation).

If `--state` is **absent** (first tick): initialize state to:

```json
{
  "iteration": 1,
  "started_at": "<current ISO-8601 UTC timestamp>",
  "history": [],
  "cooldowns": {}
}
```

## Step 2: Pick the next actionable issue

Call `list_issues({})` with no filters — fetches all project items. <!-- internal: list_issues does a full project scan, so we see every issue regardless of position. -->

Apply filters in order:

1. **Drop terminal/escalated states**: keep only issues whose `workflowState` is NOT one of `Done`, `Canceled`, `Human Needed`. These are the states autopilot must never re-pick.
2. **Drop cooldown-skipped issues**: drop any candidate where `state.cooldowns[issue.number] > state.iteration`.

Sort the remaining candidates by:
1. `priority` (P0 < P1 < P2 < P3, missing last)
2. `updatedAt` ascending (oldest activity first — get unstuck items moving)

If the list is **empty** after filters, STOP with `outcome=backlog_empty`. Emit the final report (Step 10). Do NOT call `ScheduleWakeup`.

Otherwise, the top candidate is `<picked>`. Continue to Step 3.

## Step 3: Worktree liveness check

Before dispatching hero, scan for a stale worktree at the canonical path for `<picked>`. A pre-existing worktree at `worktrees/GH-<picked>/` means a prior tick was interrupted mid-implement and there may be uncommitted in-progress work autopilot must not clobber.

Run via Bash:

```bash
git worktree list
```

Inspect the output for any line whose path matches `worktrees/GH-<picked-number>/`.

**On collision**:

1. ESCALATE the picked issue: `save_issue(number=<picked>, workflowState="__ESCALATE__", command="ralph_impl")`.
2. Post a comment via `create_comment`:

   > Autopilot detected a stale worktree at `<path>` from a prior tick. Autopilot will not auto-clean worktrees because doing so risks destroying in-progress work. Please review `<path>`, commit or discard pending changes, run `./scripts/remove-worktree.sh GH-<picked>`, then re-enable autopilot.

3. Record `outcome=escalated` in the audit log. STOP. Do NOT call `ScheduleWakeup`. Do NOT proceed to Step 4.

**On no collision**: proceed to Step 4.

## Step 4: Capture pre-state

Call `get_issue(number=<picked>, includePipeline=true)` and capture into a local `pre`:

- `pre.workflowState`
- `pre.phase` (from the `pipeline` payload)
- `pre.subIssueCount` (from `subIssuesSummary.total`)
- `pre.linkedPRs` (PR-linkage fields on the response)

## Step 5: Dispatch hero

**Dry-run branch** (`--dry-run` set):

- Skip dispatch. Mark `outcome=dry_run`. Emit `"Would dispatch hero for #<picked> (<title>) — skipped due to --dry-run"`. Skip Step 6 entirely.

**Real dispatch branch**:

```
Skill("ralph-hero:hero", args="<picked>")
```

Capture hero's text output to a local `hero_output` for the audit log only — never used for control flow. Outcome derivation is purely from Step 6's `get_issue` diff.

**Important**: autopilot does NOT override `RALPH_REVIEW_MODE` or any other hero env var. Whatever is set in the user's environment is what hero sees. For end-to-end runs (ticket → RPI → review → merge), the user must set `RALPH_REVIEW_MODE=auto` and any additional env hero/finish/merge require for fully unattended completion. Autopilot's job is to keep dispatching hero until the queue drains, not to configure hero.

After hero returns, proceed to Step 6.

## Step 6: Capture post-state and derive outcome

Call `get_issue(number=<picked>, includePipeline=true)` again. Build `post` with the same four fields as `pre`.

Apply this 8-row diff table top-to-bottom — **first matching row wins**:

| Pre-state | Post-state | Derived outcome | Made progress? |
|---|---|---|---|
| any | `Done` | `completed` | yes |
| any | `Human Needed` | `escalated` (capture last comment for `escalation_reason`) | no |
| `Backlog`/`Research Needed` | `Ready for Plan`/`Plan in Review`/`In Progress` | `advanced` | yes |
| `Ready for Plan`/`Plan in Review` | `In Progress`/`In Review` | `advanced` | yes |
| `In Progress` | `In Review` (PR linked) | `pr_landed` | yes |
| any | unchanged AND `pre.subIssueCount < post.subIssueCount` | `advanced` (split happened) | yes |
| any | unchanged | `no_progress` | no |
| any | different from pre, not matched above (catch-all) | `other_change` | yes |

When `outcome=escalated`: capture the most recent comment text into `escalation_reason` from the `comments` array on the post-state response.

## Step 7: Update tick counters

After Step 6 derives `<outcome>`:

1. **Increment iteration**: `state.iteration += 1`.
2. **On `no_progress`**: set `state.cooldowns[<picked>] = state.iteration + 3`. Issue becomes eligible again in 3 ticks. <!-- internal: cooldown is the substitute for the old streak-escalation; lets hero retry later instead of escalating, but prevents tight loops in this run. -->
3. **Append to history**: push `{issue: <picked>, outcome: <derived>}` onto `state.history`.
4. **Audit-log write happens in Step 8.5 below** (after Step 8 resolves STOP-or-CONTINUE).

## Step 8: Termination conditions

Check in priority order — first match wins:

| # | Condition | Stop? |
|---|---|---|
| 1 | `outcome == "escalated"` (worktree collision OR hero escalated) | YES |
| 2 | `outcome == "dry_run"` | YES |
| 3 | re-running Step 2's filter (with updated `state.cooldowns` and `state.history`) yields 0 candidates | YES (`outcome=backlog_empty`) |
| 4 | (else) | NO — continue to Step 9 |

There is **no max-iterations cap and no streak-escalation**. Autopilot runs until the filtered queue is empty. Hero owns escalation.

**Backlog re-check rule (row 3)**: re-run `list_issues({})` with the same filters as Step 2 (now using the post-tick `state.cooldowns`). If no candidates remain, STOP.

| Step 8 result | Step 9 action |
|---|---|
| any STOP (rows 1-3) | call Step 10 (final report); do NOT call `ScheduleWakeup` |
| CONTINUE (row 4) | call Step 9 (`ScheduleWakeup` once); skip Step 10 |

Exactly one branch fires per tick. Two `ScheduleWakeup` calls in one tick is a bug. Zero `ScheduleWakeup` AND zero final reports is a bug.

## Step 8.5: Audit log entry

After Step 8's branch is decided but before the side-effecting `ScheduleWakeup` (Step 9) or final-report (Step 10), append one JSON line to `~/.ralph-hero/autopilot.jsonl`. This ensures the row is captured even if subsequent steps fail.

Canonical entry shape:

```json
{
  "ts": "2026-05-09T03:14:15Z",
  "iteration": 3,
  "issue_number": 1234,
  "issue_url": "https://github.com/...",
  "pre_state": "Ready for Plan",
  "post_state": "In Review",
  "outcome": "pr_landed",
  "pr_url": "https://github.com/.../pull/5678",
  "duration_ms": 487211,
  "next_delay_seconds": 60,
  "next_action": "schedule",
  "args": {"dry_run": false}
}
```

Per-outcome variations:

- `escalated`: add `escalation_reason="<from last comment>"`, `next_action="stop"`, `next_delay_seconds=null`
- `dry_run`: `next_action="stop"`, `next_delay_seconds=null`
- `backlog_empty`: `next_action="stop"`, `next_delay_seconds=null`, `issue_number=null`

**STOP / null rule**: whenever `next_action == "stop"`, `next_delay_seconds` MUST be JSON literal `null` (not `0`, not absent, not the string `"null"`).

**Append pattern**:

```bash
mkdir -p ~/.ralph-hero
jq -nc \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson iteration "$ITER" \
  --argjson issue_number "$ISSUE_NUMBER" \
  --arg issue_url "$ISSUE_URL" \
  --arg pre_state "$PRE_STATE" \
  --arg post_state "$POST_STATE" \
  --arg outcome "$OUTCOME" \
  --arg pr_url "$PR_URL" \
  --argjson duration_ms "$DURATION_MS" \
  --argjson next_delay_seconds "$NEXT_DELAY" \
  --arg next_action "$NEXT_ACTION" \
  --argjson args "$ARGS_JSON" \
  '{ts:$ts, iteration:$iteration, issue_number:$issue_number, issue_url:$issue_url, pre_state:$pre_state, post_state:$post_state, outcome:$outcome, pr_url:$pr_url, duration_ms:$duration_ms, next_delay_seconds:$next_delay_seconds, next_action:$next_action, args:$args}' \
  >> ~/.ralph-hero/autopilot.jsonl
```

For STOP rows pass `--argjson next_delay_seconds null`. For CONTINUE rows pass `60` or `1200` per Step 9.

## Step 9: Schedule next tick

Runs only when Step 8 resolved CONTINUE.

1. **Build the next-tick state**: serialize `{iteration, started_at, history, cooldowns}` to JSON, base64-encode to `<BASE64>`.

2. **Choose `delaySeconds`** — live set is exactly `{60, 1200}`:

   - `outcome` is `pr_landed`, `advanced`, `completed`, or `other_change` -> `60` (stay in prompt-cache window for fast continuation)
   - `outcome` is `no_progress` -> `1200` (cache-miss cooldown — nothing changed, give the system breathing room before retrying a different issue)

   Forbidden: `300` (cache-window anti-pattern; the wakeup-gate hook enforces).

3. **Build the prompt**: re-invoke autopilot with the carried-forward flags plus new state:

   ```
   /ralph-hero:autopilot [--dry-run] --state=<BASE64>
   ```

4. **Call `ScheduleWakeup` exactly once**:

   ```
   ScheduleWakeup(
     delaySeconds = <chosen>,
     reason = "autopilot tick <iteration>: continuing after #<picked> <outcome>",
     prompt = "/ralph-hero:autopilot --state=<BASE64>"
   )
   ```

5. **Emit a brief tick summary** AFTER the wakeup call: `"Tick N complete: dispatched #X, outcome=Y, next tick in Zs"`. Then STOP this turn.

Step 10 is NOT called when Step 9 fires.

## Step 10: Final report (terminal turn only)

Runs only when Step 8 STOPped (rows 1-3).

Emit a markdown summary:

- **Total ticks run**: `state.iteration`.
- **Wall-clock elapsed**: `now - state.started_at`.
- **Issues processed**: from `state.history`, each with outcome (`#1234 -> pr_landed`, `#1235 -> completed`, `#1236 -> escalated`, etc.).
- **Completed (merged to Done)**: count of `outcome == "completed"` in history.
- **PRs created**: count of `outcome == "pr_landed"` in history.
- **Escalations**: count + reasons (these were hero's calls; autopilot trusts them).
- **Cooldowns at exit**: any `state.cooldowns` entries — these issues hit `no_progress` and were skipped this run; they remain in the queue for the next invocation.
- **Audit log path**: `~/.ralph-hero/autopilot.jsonl`.

**Run unblock separately**: if any issues escalated to `Human Needed` this run (or in prior runs), invoke `/ralph-hero:ralph-unblock` (autonomous) or `/ralph-hero:unblock` (interactive) in a separate loop to surface blocking questions and route them back into the pipeline. The unblock loop and the autopilot loop are designed to run side-by-side — autopilot drains forward-progress work, unblock drains human-context work.

The report ends the autopilot run for this invocation.
