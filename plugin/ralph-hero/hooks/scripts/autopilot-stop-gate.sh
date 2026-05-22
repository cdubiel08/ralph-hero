#!/bin/bash
# ralph-hero/hooks/scripts/autopilot-stop-gate.sh
# Stop — if a sentinel file exists indicating Director emitted a non-terminal
# result without a subsequent ScheduleWakeup, block stop with a loud message
# so the silent-drop failure mode becomes a noisy, recoverable one.
#
# See GH-1346 and thoughts/shared/research/2026-05-21-autopilot-loop-handoff.md.
#
# Self-discriminates on RALPH_COMMAND=autopilot — passes through silently
# for any other skill. Uses stop_hook_active for re-entry safety following
# the pattern in team-stop-gate.sh.
#
# Exit codes:
#   0 - No pending wakeup, allow stop
#   2 - Pending wakeup detected, block stop and surface omission

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Pass through for non-autopilot sessions.
[[ "${RALPH_COMMAND:-}" == "autopilot" ]] || exit 0

# Re-entry safety: if we already fired once and the model still wants to stop,
# we've made our case — let it stop. Otherwise we'd loop forever.
stop_hook_active=$(get_field '.stop_hook_active')
if [[ "$stop_hook_active" == "true" ]]; then
  # Clean up the sentinel so it doesn't bleed into a future autopilot run.
  session_id=$(get_field '.session_id')
  sentinel_dir="${TMPDIR:-/tmp}"
  sentinel="${sentinel_dir%/}/ralph-autopilot-pending-wakeup-${session_id:-$PPID}"
  rm -f -- "$sentinel" 2>/dev/null || true
  exit 0
fi

session_id=$(get_field '.session_id')
sentinel_dir="${TMPDIR:-/tmp}"
sentinel="${sentinel_dir%/}/ralph-autopilot-pending-wakeup-${session_id:-$PPID}"

[[ -f "$sentinel" ]] || exit 0

pending_result=$(cat -- "$sentinel" 2>/dev/null || echo "(unreadable)")

cat >&2 <<EOF
═══════════════════════════════════════════════════════════════
 Autopilot stop blocked: pending ScheduleWakeup not observed

 Director returned a non-terminal result, but no ScheduleWakeup
 call followed. Without one, /loop interprets the absent wakeup
 as "task complete" and the autopilot drops silently.

 Last Director result:
   $pending_result

 Required next action:
   Call ScheduleWakeup with delaySeconds in [60,270] (warm-cache
   continuation, work likely to resume soon) or [1200,1800] (idle
   retry window). Avoid 300s.

   prompt: pass back the same /ralph-hero:autopilot continuation
   prompt or the <<autonomous-loop-dynamic>> sentinel.

 If you genuinely intend to stop (queue is drained, Director just
 hasn't said so), invoke Director once more and confirm it emits
 'result: Queue empty' before exiting.
═══════════════════════════════════════════════════════════════
EOF

exit 2
