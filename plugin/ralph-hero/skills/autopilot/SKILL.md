---
description: Autonomous backlog clearer. Runs /hero in a self-paced loop via ScheduleWakeup, picking the next-most-important XS/S issue per tick, escalating to Human Needed when stuck, stopping cleanly when the queue is empty. Single-command shorthand for "go clear the backlog while I'm away."
argument-hint: "[--max-iterations N] [--auto-merge] [--dry-run] [--state=BASE64]"
context: inline
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=autopilot"
allowed-tools:
  - Read
  - Write
  - Bash
  - Skill
  - Agent
  - ScheduleWakeup
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__next_actions
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
- Max iterations: !`echo ${RALPH_AUTOPILOT_MAX_ITERATIONS:-20}`
- Audit log: ~/.ralph-hero/autopilot.jsonl

Use these resolved values when constructing GitHub URLs or referencing the repository. The audit log path is informational in this phase — the file itself is created in a later phase.

# Ralph Autopilot — Backlog Clearer

You are the autopilot orchestrator. One invocation = one tick. Each tick: decode-state -> pick -> check-worktrees -> dispatch -> diff -> record -> schedule-or-stop.

This phase implements only the prefix of that flow: safety check, argument parsing + state decode, pick-next-actionable, and the In-Review filter. Subsequent phases (#1138, #1139, #1140) append the worktree check, hero dispatch, pre/post diff, loop scheduling, termination conditions, and audit log writes.

## Step 0: Safety check

If `RALPH_AUTOPILOT_ENABLE` is not exactly the string `"true"`, STOP immediately with this message and do NOT proceed to Step 1:

> Autopilot is opt-in. To enable: `export RALPH_AUTOPILOT_ENABLE=true`

(Hard opt-in for unattended automation. Refuse cleanly so the user can re-invoke with the env var set. No fallthrough — terminate the skill body here.)

## Step 1: Argument parsing + state decode

Parse the following flags from `$ARGUMENTS`:

- `--max-iterations N` — default `${RALPH_AUTOPILOT_MAX_ITERATIONS:-20}`
- `--auto-merge` — default false (passes `--review-mode auto` to hero in later phases)
- `--dry-run` — default false (skip dispatch in later phases; report intent only)
- `--state=BASE64` — cross-tick state, absent on first tick. **Equals-form** is required to handle base64 padding (`=` chars).

**Equals-form parsing rule**: split each arg on the **first** `=` only. Everything after that first `=` is the value, including any additional `=` characters introduced by base64 padding. Do NOT split on every `=`.

Example: `--state=eyJpdGVyYXRpb24iOjF9==` parses as flag `--state` with value `eyJpdGVyYXRpb24iOjF9==` (two trailing `=` preserved).

If `--state` is **present**: base64-decode the value, then JSON-parse. Expected shape:

```json
{
  "iteration": 3,
  "no_progress_streak": 0,
  "started_at": "2026-05-07T03:00:00Z",
  "history": [{"issue": 1234, "outcome": "pr_landed"}]
}
```

If `--state` is **absent** (first tick): initialize state to:

```json
{
  "iteration": 1,
  "no_progress_streak": 0,
  "started_at": "<current ISO-8601 UTC timestamp>",
  "history": []
}
```

The `state` object is referenced in Step 2.5 (history filter) and will be re-encoded into the next tick's `--state` argument by Phase 3's loop machinery (not in this phase).

## Step 2: Pick the next actionable issue

Call `next_actions(audience="agent", limit=10)`. The limit is raised from the default 5 to give Step 2.5's filter enough headroom to skip past human-gated candidates without exhausting the list.

Inspect the result:

- If `items` is empty -> backlog clear -> STOP. Report "Backlog empty" with a brief final summary. Do NOT call `ScheduleWakeup` (loop scheduling is added in Phase 3, but even there the empty-backlog branch terminates cleanly without rescheduling).
- Filter to `kind == "issue"` only. Skip PR-kind, lock-stale, and tree-continue directions — those are handled by other skills, not autopilot's per-issue dispatch.
- If no `kind == "issue"` candidate remains after the filter -> STOP, same as empty backlog.
- Otherwise: the top issue-kind direction is the candidate `<picked>`. Pass it to Step 2.5.

## Step 2.5: Skip "human-gated" candidates (In-Review filter)

This filter prevents a false-positive escalation loop. **Background**: in `RALPH_REVIEW_MODE=interactive` (the default), hero lands a PR and stops; the issue's workflow state becomes `"In Review"`. But `"In Review"` is in `ACTIONABLE_PHASES` (verified at `plugin/ralph-hero/mcp-server/src/lib/directions.ts:180-185`), so `next_actions` will keep returning the just-PR'd issue. Without this filter, autopilot would re-pick the same issue, hero would detect "phase=INTEGRATE, interactive mode, stop", outcome would be `no_progress`, and after 3 ticks autopilot would *escalate a perfectly healthy in-review PR to Human Needed*.

Apply both filter rules to the candidate list returned by Step 2:

1. **Exclude `In Review` outright** — these are human-gated by design in interactive mode. Skip without dispatching:

   ```
   candidates = candidates.filter(c => c.workflowState !== "In Review")
   ```

2. **Exclude issues already PR'd this loop** — even if their state somehow regressed, don't re-pick what we already shipped this run:

   ```
   candidates = candidates.filter(c => !state.history.some(h => h.issue === c.issue && h.outcome === "pr_landed"))
   ```

**`--auto-merge` carve-out**: For MVP, the In-Review filter remains **ON regardless** of `--auto-merge`. Users who want autopilot to push past code review can re-invoke after merge. Auto-merge In-Review handling (running code-review + merge against in-review PRs without re-escalation) is tracked as follow-up work.

After filtering:

- If no candidates remain -> STOP with `outcome=backlog_empty`. The human-gated PRs and shipped issues count as "done from autopilot's perspective". The final report should mention any in-review PRs awaiting human merge so the user knows what's still queued for them.
- Otherwise: the top remaining candidate is the picked issue `<picked>`. Subsequent steps (worktree liveness check, pre-state capture, hero dispatch, post-state diff, audit log, loop scheduling) are added in later phases — the skill body ends here for Phase 1.

For Phase 1 only: report the picked issue (number, title, workflow state) and STOP. Do not dispatch hero, do not call `ScheduleWakeup`, do not write to the audit log — those are Phase 2/3/4 work.

<!-- Steps 3+ added in subsequent phases (GH-1138, GH-1139, GH-1140) -->
