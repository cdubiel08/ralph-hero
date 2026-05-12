---
description: Autonomous backlog clearer. Delegates to /loop in dynamic mode, running /ralph-hero:hero against the next-most-important non-terminal issue per iteration. Drains the queue end-to-end. Trusts hero for all per-issue decisions including escalation to Human Needed.
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

# Ralph Autopilot — Backlog Clearer

Autopilot is a thin wrapper around `/loop /ralph-hero:hero`. It hands all wakeup cadence to `/loop`'s dynamic mode (model self-paces via `ScheduleWakeup`) and trusts hero for every per-issue decision — including escalation to `Human Needed` when hero hits operational ambiguity.

**Opt-in is enforced by hook**, not by you. If `RALPH_AUTOPILOT_ENABLE` is not set, the `Skill` call below will be blocked with a deterministic message. Don't write your own opt-in check.

## Action

Invoke `/loop` in dynamic mode (no interval) with the prompt below. That's the entire skill.

```
Skill("loop", args="Run /ralph-hero:hero on the next-most-important issue on the project queue. You have full autonomy to do your best work using the Skills at your disposal. The hero instructions cover moving tickets through the queue to completion or marking as Human Needed when blocked.

Pick the next issue by calling list_issues({}) and filtering out workflow states `Done`, `Canceled`, and `Human Needed`. Sort by priority (P0 first), then by oldest updatedAt. Dispatch hero against the top result.

Continuation rule: after each hero dispatch, re-check the filtered queue. If it is empty, end the loop (return without calling ScheduleWakeup). Otherwise, call ScheduleWakeup with a delay you judge appropriate for the prior outcome — short (60-270s) when hero made forward progress and fresh follow-on work is likely, longer (1200-1800s) when the queue has only stuck or in-review items that need time before retry. Avoid 300s (the cache-window anti-pattern).

Trust hero's escalation decisions. When hero moves an issue to Human Needed, the issue is filtered out of the next pick automatically — keep going with the next candidate. Run /ralph-hero:ralph-unblock or /ralph-hero:unblock in a separate loop to drain Human Needed work.")
```

That is all. Do not maintain your own iteration counter, audit log, cooldown table, or termination gate — `/loop` and `/ralph-hero:hero` own that machinery. Do not call `ScheduleWakeup` directly from this skill body. Do not parse `$ARGUMENTS` for `--state`, `--dry-run`, or `--max-iterations` — those flags no longer exist.

## Why this design

- **One source of truth for wakeup cadence**: `/loop` already implements dynamic self-paced wakeups with prompt-cache awareness. Re-implementing that logic in autopilot was duplication and introduced hardcoded delays that overrode the runtime's judgment.
- **Hero owns escalation**: hero already classifies operational ambiguity and moves issues to `Human Needed`. Autopilot bookkeeping that re-derived "stuck" outcomes from a pre/post `get_issue` diff was redundant and produced false positives (e.g., escalating healthy in-review PRs after three ticks).
- **Opt-in gate is deterministic**: a hook that exits 2 with a fixed message is faster, more reliable, and more auditable than asking the model to read an env var and decide whether to stop.
- **No special handling for the worktree-collision case**: hero/impl-agent already enforces worktree safety via `impl-worktree-gate.sh`. If hero hits a stale worktree, hero escalates the issue to `Human Needed` and the loop continues with the next candidate.

## What the user sees

- `RALPH_AUTOPILOT_ENABLE` unset → hook blocks immediately with the deterministic message; no LLM output.
- `RALPH_AUTOPILOT_ENABLE=true` → `/loop` takes over; the user sees `/loop`'s tick summaries and hero's per-issue output.
- Queue empty → `/loop` ends naturally (no `ScheduleWakeup`); the conversation returns control.

## Cancellation

To stop an in-flight autopilot run, use `/tasks` to find the pending wakeup and delete it via the cron tools. Same as cancelling any other `/loop` dynamic-mode run.
