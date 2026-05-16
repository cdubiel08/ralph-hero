---
description: Autonomous backlog clearer. Delegates to /loop in dynamic mode, running /ralph-hero:director against the next-most-important event per iteration. Director classifies each event and dispatches the correct team (builders / watchers / scouts / memorykeepers / caretakers). Drains the queue end-to-end.
argument-hint: ""
context: inline
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=autopilot"
  PreToolUse:
    - matcher: "Skill"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/autopilot-enable-gate.sh"
allowed-tools:
  - Skill
  - ScheduleWakeup
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
---

## Configuration

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`
- Review mode (inherited by hero): !`echo ${RALPH_REVIEW_MODE:-interactive}`
- Director skill: /ralph-hero:director

# Ralph Autopilot — Backlog Clearer

Autopilot is a thin wrapper around `/loop /ralph-hero:director`. It hands all wakeup cadence to `/loop`'s dynamic mode (model self-paces via `ScheduleWakeup`) and trusts Director for every per-event classification and team dispatch decision — including escalation to `Human Needed` when a team hits operational ambiguity.

**Opt-in is enforced by hook**, not by you. If `RALPH_AUTOPILOT_ENABLE` is not set, the `Skill` call below will be blocked with a deterministic message. Don't write your own opt-in check.

## Action

Invoke `/loop` in dynamic mode (no interval) with the prompt below. That's the entire skill.

```
Skill("loop", args="Run /ralph-hero:director on the next-most-important event on the project queue. Director classifies the event and dispatches the correct team (builders / watchers / scouts / memorykeepers / caretakers). You have full autonomy to do your best work using the Skills at your disposal.

Director reads next_actions and picks the top-ranked event automatically — do not pre-filter the queue yourself. Director handles all routing decisions including trigger:<team> label consumption and team dispatch.

Continuation rule: after each Director dispatch, re-check the queue by invoking Director again. If Director emits 'result: Queue empty', end the loop (return without calling ScheduleWakeup). Otherwise, call ScheduleWakeup with a delay you judge appropriate for the prior outcome — short (60-270s) when Director made forward progress and fresh follow-on work is likely, longer (1200-1800s) when the queue has only stuck or in-review items that need time before retry. Avoid 300s (the cache-window anti-pattern).

Trust Director's classification and team dispatch decisions. When a team moves an issue to Human Needed, the issue is filtered out of the next pick automatically — Director will skip it on the next tick. Run /ralph-hero:ralph-unblock or /ralph-hero:unblock in a separate loop to drain Human Needed work.")
```

That is all. Do not maintain your own iteration counter, audit log, cooldown table, or termination gate — `/loop` and `/ralph-hero:director` own that machinery. Do not call `ScheduleWakeup` directly from this skill body. Do not parse `$ARGUMENTS` for `--state`, `--dry-run`, or `--max-iterations` — those flags no longer exist.

## Why this design

- **One source of truth for wakeup cadence**: `/loop` already implements dynamic self-paced wakeups with prompt-cache awareness. Re-implementing that logic in autopilot was duplication and introduced hardcoded delays that overrode the runtime's judgment.
- **Director owns routing**: Director classifies events via the taxonomy table in `event-classes.md` and dispatches the correct team. Autopilot does not need to know which team handles which event — that knowledge lives in Director.
- **Opt-in gate is deterministic**: a hook that exits 2 with a fixed message is faster, more reliable, and more auditable than asking the model to read an env var and decide whether to stop.
- **No special handling for the worktree-collision case**: hero/impl-agent already enforces worktree safety via `impl-worktree-gate.sh`. If a team hits a stale worktree, the team escalates the issue to `Human Needed` and Director skips it on the next tick.

## What the user sees

- `RALPH_AUTOPILOT_ENABLE` unset → hook blocks immediately with the deterministic message; no LLM output.
- `RALPH_AUTOPILOT_ENABLE=true` → `/loop` takes over; the user sees `/loop`'s tick summaries and Director's per-event classification output.
- Queue empty → Director emits `result: Queue empty`, `/loop` ends naturally (no `ScheduleWakeup`); the conversation returns control.

## Cancellation

To stop an in-flight autopilot run, use `/tasks` to find the pending wakeup and delete it via the cron tools. Same as cancelling any other `/loop` dynamic-mode run.
