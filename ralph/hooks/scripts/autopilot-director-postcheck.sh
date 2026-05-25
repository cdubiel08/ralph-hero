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
#   autoloop  — armed when we observe Skill("loop", "…--mode classify…"), the
#               --mode auto launch. Gates the Stop hook so one-shot
#               `--mode classify` and `--mode default` runs are never blocked.
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

# Arm the watcher when the auto loop launches: Skill("loop", "…--mode classify…").
# `--mode auto` wraps `--mode classify` inside /loop, so the classify token in
# the loop args uniquely identifies the auto watcher (vs. --mode watch, which
# wraps `--mode watch`, or a bare one-shot classify with no loop wrapper).
loop_started=0
if [[ "$skill_bare" == "loop" ]] && printf '%s' "$skill_args" | grep -q -- '--mode classify'; then
  touch -- "$autoloop" 2>/dev/null || true
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

# Every productive tick owes a wakeup. Under the never-terminate contract BOTH
# classify result lines (`Dispatched #…` and `Queue empty.`) require one — the
# latter backs off to the 1h ceiling rather than stopping. Mark pending when the
# loop launches OR when either classify result line appears, so the guard holds
# whether the next tick re-fires Skill("loop") or re-runs classify directly.
if [[ "$loop_started" -eq 1 ]] || printf '%s' "$result_line" | grep -qE 'Dispatched #|Queue empty'; then
  printf '%s\n' "${result_line:-loop launch}" > "$pending" 2>/dev/null || true
fi

exit 0
