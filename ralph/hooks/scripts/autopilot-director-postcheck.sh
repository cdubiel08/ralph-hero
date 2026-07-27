#!/bin/bash
# ralph-hero/hooks/scripts/autopilot-director-postcheck.sh
# PostToolUse:Skill — arms the never-terminate enforcement for the slim
# `ralph:hero --mode auto` watcher and marks each loop tick as owing a
# follow-up ScheduleWakeup. The Stop hook (autopilot-stop-gate.sh) reads the
# sentinels written here to catch the silent-drop failure mode: a tick returns
# without scheduling the next wakeup → /loop reads the absent wakeup as "task
# complete" and the watcher dies silently.
#
# `ralph:hero --mode auto` is a NEVER-TERMINATING adaptive watcher. Every tick
# must call ScheduleWakeup — tight 60-270s while the queue produces work, 3600s
# flat when it is idle. `result: Queue empty.` is an idle backoff signal, NOT a
# terminal stop; the loop only ends when the user cancels via /tasks.
#
# Two session-scoped sentinels:
#   autoloop  — armed when we observe Skill("loop", …) carrying the hero
#               `--tick` inner command (see the grep below), the --mode auto
#               launch. Gates the Stop hook so one-shot `--tick` and
#               `--mode default` runs are never blocked.
#   pending   — set on every tick that still owes a ScheduleWakeup; cleared by
#               autopilot-wakeup-clear.sh when the call fires.
#
# Discrimination is keyed to RALPH_COMMAND=hero (set reliably via
# CLAUDE_ENV_FILE at SessionStart) plus the Skill payload — NOT RALPH_SUBCOMMAND
# (a plain Step-0 export that does not propagate to hook processes). The legacy
# ralph-hero plugin / Director-dispatch path is deprecated and uses its own
# hook copies under plugin/ralph-hero/.
#
# See GH-1346 and thoughts/shared/research/2026-05-21-autopilot-loop-handoff.md.
#
# Exit codes:
#   0 - Always (observer, never blocks)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Only the slim hero verb. RALPH_COMMAND is set via CLAUDE_ENV_FILE and is the
# one env signal hooks can trust.
[[ "${RALPH_COMMAND:-}" == "hero" ]] || exit 0

session_id=$(get_field '.session_id')
sentinel_dir="${TMPDIR:-/tmp}"
autoloop="${sentinel_dir%/}/ralph-hero-autoloop-${session_id:-$PPID}"
pending="${sentinel_dir%/}/ralph-hero-pending-wakeup-${session_id:-$PPID}"

skill_name=$(get_field '.tool_input.skill')
skill_bare="${skill_name##*:}"
skill_args=$(get_field '.tool_input.args')

# Arm the watcher when the auto loop launches: Skill("loop", "…") wrapping the
# hero tick inner command below. `--mode auto` wraps the internal `--tick` step
# inside /loop, so this token uniquely identifies the auto watcher (vs.
# --mode watch, which wraps `--mode watch`, or a bare one-shot `--tick` with
# no loop wrapper).
#
# Matched on a TOKEN boundary (`--tick` followed by whitespace or end-of-line),
# not as a loose substring: a bare `grep -F '/ralph:hero --tick'` also fires on
# `/ralph:hero --tickle` or on documentation text quoting the command inside an
# unrelated loop prompt, arming `autoloop`+`pending` for a non-auto loop and
# blocking session exit. `--mode auto` emits
# `Run /ralph:hero --tick on the next-most-important event …` (auto-tick.md),
# which still matches byte-for-byte.
loop_started=0
if [[ "$skill_bare" == "loop" ]] \
   && printf '%s' "$skill_args" | grep -qE -- '/ralph:hero --tick([[:space:]]|$)'; then
  if ! touch -- "$autoloop" 2>/dev/null; then
    # GH-1603 F9: `|| true` here swallowed the exact failure this pair exists
    # to catch. An unwritable sentinel leaves the Stop gate disarmed, so the
    # watcher can die silently on the very next tick — the observer must not
    # block, but it must not be silent either.
    printf '%s\n' "autopilot-director-postcheck.sh: WARNING could not write autoloop sentinel '$autoloop' — the never-terminate Stop gate is DISARMED for this session." >&2
  fi
  loop_started=1
fi

# Outside the armed watcher we never mark a pending wakeup → Stop is never gated.
[[ -f "$autoloop" ]] || exit 0

# Extract the operative `result:` line from this Skill's response. Shape varies:
# MCP-style { content: [{ text }] } or a plain string for the built-in Skill
# tool. Defensive jq handles both without crashing on a type mismatch.
response_text=$(printf '%s' "$RALPH_HOOK_INPUT" | jq -r '
  .tool_response
  | if type == "object" then (.content // [{}])[0].text // ""
    elif type == "string" then .
    else . | tostring
    end // ""
' 2>/dev/null || echo "")
result_line=$(printf '%s\n' "$response_text" | grep -E '^result:' | tail -n 1 || true)

# Every tick owes a wakeup. Under the never-terminate contract ALL THREE tick
# result lines require one:
#   `Dispatched #…`    -> busy, tight cadence
#   `Queue empty.`     -> idle backoff to the 1h ceiling, NOT a stop
#   `Dispatch failed …` -> the dispatch errored / was refused / was skipped.
#                          auto-tick.md step 5 deliberately PRESERVES the trigger
#                          label on this path so the event is retried — but the
#                          retry only happens if the loop re-fires. Without this
#                          third pattern the tick ended, Stop was never gated,
#                          /loop read the absent wakeup as "task complete", and
#                          the preserved label was never re-surfaced: the failure
#                          silently dropped the event it was trying to save.
# Mark pending when the loop launches OR when any tick result line appears, so
# the guard holds whether the next tick re-fires Skill("loop") or re-runs the
# tick directly.
if [[ "$loop_started" -eq 1 ]] || printf '%s' "$result_line" | grep -qE 'Dispatched #|Queue empty|Dispatch failed'; then
  if ! printf '%s\n' "${result_line:-loop launch}" > "$pending" 2>/dev/null; then
    # Same reasoning as the autoloop sentinel above: a pending marker that never
    # lands means autopilot-stop-gate.sh sees no owed wakeup and lets the tick
    # stop, which is the silent watcher death this pair was built to detect.
    printf '%s\n' "autopilot-director-postcheck.sh: WARNING could not write pending-wakeup sentinel '$pending' — this tick's owed ScheduleWakeup is UNGUARDED." >&2
  fi
fi

exit 0
