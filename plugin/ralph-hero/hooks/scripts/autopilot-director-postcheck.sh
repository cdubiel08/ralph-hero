#!/bin/bash
# ralph-hero/hooks/scripts/autopilot-director-postcheck.sh
# PostToolUse:Skill — when Director returns inside an autopilot /loop turn,
# write or clear a sentinel file that the Stop hook reads to detect the
# silent-drop failure mode (non-terminal Director result + omitted
# ScheduleWakeup → /loop interprets absent wakeup as "task complete").
#
# See GH-1346 and thoughts/shared/research/2026-05-21-autopilot-loop-handoff.md
# for the failure mode this guards against.
#
# Self-discriminates on RALPH_COMMAND=autopilot — passes through silently
# for any other skill that uses Skill().
#
# Exit codes:
#   0 - Always (observer, never blocks)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Pass through for non-autopilot sessions.
[[ "${RALPH_COMMAND:-}" == "autopilot" ]] || exit 0

# Only act on the Director skill. Skill name may carry the plugin namespace
# prefix (ralph-hero:director) or be bare (director); accept either.
skill_name=$(get_field '.tool_input.skill')
case "${skill_name##*:}" in
  director) ;;
  *) exit 0 ;;
esac

# Sentinel path is session-scoped. session_id is part of the standard hook
# payload; fall back to PPID if missing so the hook still functions in tests.
session_id=$(get_field '.session_id')
sentinel_dir="${TMPDIR:-/tmp}"
sentinel="${sentinel_dir%/}/ralph-autopilot-pending-wakeup-${session_id:-$PPID}"

# Skill returns the model's final synthesis from the inner skill run.
# Shape varies: MCP-style { content: [{ text }] } for some tools, plain string
# for the built-in Skill tool. Use a single defensive jq expression that
# handles both without crashing on type mismatch.
response_text=$(printf '%s' "$RALPH_HOOK_INPUT" | jq -r '
  .tool_response
  | if type == "object" then (.content // [{}])[0].text // ""
    elif type == "string" then .
    else . | tostring
    end // ""
' 2>/dev/null || echo "")

# Extract the last line beginning with `result:` (Director can emit several
# intermediate lines; the final `result:` is the operative one).
result_line=$(printf '%s\n' "$response_text" | grep -E '^result:' | tail -n 1 || true)

if [[ -z "$result_line" ]]; then
  # No `result:` line found — response wasn't from Director (maybe an error
  # or a non-director Skill call we don't recognize). Leave the sentinel
  # alone; the next valid Director response will resolve it.
  exit 0
fi

if printf '%s' "$result_line" | grep -qE 'Queue empty'; then
  # Terminal — autopilot is allowed to end without a ScheduleWakeup call.
  rm -f -- "$sentinel" 2>/dev/null || true
else
  # Non-terminal — Director returned forward-progress, skip, or classification
  # text. Autopilot's contract requires a follow-up ScheduleWakeup. Record the
  # pending state; the wakeup-clear hook will rm it if ScheduleWakeup fires,
  # otherwise the Stop hook will surface the omission.
  printf '%s\n' "$result_line" > "$sentinel" 2>/dev/null || true
fi

exit 0
