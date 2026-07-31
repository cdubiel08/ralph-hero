#!/bin/bash
# ralph-hero/hooks/scripts/autopilot-wakeup-clear.sh
# PreToolUse:ScheduleWakeup — validate the wakeup call and clear the
# pending-wakeup sentinel that autopilot-director-postcheck.sh wrote for the
# current `ralph:hero --mode auto` tick. Also rejects the delaySeconds=300
# anti-pattern.
#
# Keyed to RALPH_COMMAND=hero (set reliably via CLAUDE_ENV_FILE); passes through
# for any other session that uses ScheduleWakeup().
#
# Exit codes:
#   0 - Allowed (pending mark cleared)
#   2 - Blocked (delaySeconds=300 cache-window anti-pattern)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Only the hero verb.
[[ "${RALPH_COMMAND:-}" == "hero" ]] || exit 0

delay_seconds=$(get_field '.tool_input.delaySeconds')

# Cache-window anti-pattern: 300s falls outside both the warm-cache window
# (<=270s) and the committed idle window. Reject loudly.
if [[ "$delay_seconds" == "300" ]]; then
  cat >&2 <<'EOF'
═══════════════════════════════════════════════════════════════
 hero --mode auto ScheduleWakeup blocked: delaySeconds=300

 300s is the 5-minute cache-window anti-pattern — it pays the
 prompt-cache miss without amortizing the cost across a longer
 idle period.

 Pick <=270s (warm-cache continuation, work likely to resume) or
 3600s (the 1h idle ceiling when the queue is empty).
═══════════════════════════════════════════════════════════════
EOF
  exit 2
fi

# The wakeup is going through — this tick has met its obligation. Clear the
# pending mark so the Stop hook lets the turn end (the scheduled wakeup keeps
# the watcher alive). The autoloop sentinel is intentionally left in place so
# enforcement persists across ticks for the lifetime of the session.
session_id=$(get_field '.session_id')
sentinel_dir="${TMPDIR:-/tmp}"
pending="${sentinel_dir%/}/ralph-hero-pending-wakeup-${session_id:-$PPID}"
rm -f -- "$pending" 2>/dev/null || true

exit 0
