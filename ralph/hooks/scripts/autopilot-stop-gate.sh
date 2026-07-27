#!/bin/bash
# ralph-hero/hooks/scripts/autopilot-stop-gate.sh
# Stop — for the slim `ralph:hero --mode auto` never-terminating watcher, block
# session exit when a loop tick returns without scheduling the next wakeup, so
# the silent-drop failure mode becomes a noisy, recoverable one. `--mode auto`
# never self-terminates — the only clean exit is the user cancelling via /tasks.
#
# Gated by TWO sentinels (both written by autopilot-director-postcheck.sh):
#   autoloop  — present only inside the --mode auto watcher, so one-shot
#               `--tick` and `--mode default` runs are NOT blocked.
#   pending   — present when the current tick still owes a ScheduleWakeup
#               (cleared by autopilot-wakeup-clear.sh when one fires).
# Block only when BOTH are present.
#
# Keyed to RALPH_COMMAND=hero (set reliably via CLAUDE_ENV_FILE). The legacy
# ralph-hero plugin / Director path is deprecated. Uses stop_hook_active for
# re-entry safety following the pattern in team-stop-gate.sh.
#
# See GH-1346 and thoughts/shared/research/2026-05-21-autopilot-loop-handoff.md.
#
# Exit codes:
#   0 - Allow stop (not in the watcher, or the tick scheduled its wakeup)
#   2 - Block stop and surface the omitted ScheduleWakeup

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Only the slim hero verb.
[[ "${RALPH_COMMAND:-}" == "hero" ]] || exit 0

session_id=$(get_field '.session_id')
sentinel_dir="${TMPDIR:-/tmp}"
autoloop="${sentinel_dir%/}/ralph-hero-autoloop-${session_id:-$PPID}"
pending="${sentinel_dir%/}/ralph-hero-pending-wakeup-${session_id:-$PPID}"

# Re-entry safety: if we already fired once and the model still wants to stop,
# we've made our case — let it stop and clean up so sentinels don't bleed into
# a later hero run reusing this session id.
stop_hook_active=$(get_field '.stop_hook_active')
if [[ "$stop_hook_active" == "true" ]]; then
  rm -f -- "$pending" "$autoloop" 2>/dev/null || true
  exit 0
fi

# Only the armed --mode auto watcher is gated.
[[ -f "$autoloop" ]] || exit 0

# Watcher armed but this tick already scheduled its wakeup → allow (the
# scheduled wakeup keeps the loop alive; ending this turn is correct).
[[ -f "$pending" ]] || exit 0

pending_result=$(cat -- "$pending" 2>/dev/null || echo "(unreadable)")

cat >&2 <<EOF
═══════════════════════════════════════════════════════════════
 hero --mode auto stop blocked: pending ScheduleWakeup not observed

 /ralph:hero --mode auto is a NEVER-TERMINATING adaptive watcher.
 This tick returned without calling ScheduleWakeup — without one,
 /loop reads the absent wakeup as "task complete" and the watcher
 drops silently.

 Last tick result:
   $pending_result

 Required next action — call ScheduleWakeup with delaySeconds:
   • 60-270s  if the last tick dispatched work (warm cache; more
     work is likely actionable now).
   • 3600s    if the last result was 'Queue empty.' (idle backoff
     to the 1h ceiling — re-check in an hour; do NOT stop).
   Avoid 300s. Pass back the same /ralph:hero --mode auto
   continuation prompt (or the <<autonomous-loop-dynamic>> sentinel).

 To stop the watcher entirely, cancel it via /tasks (delete the
 pending wakeup). There is no clean self-exit — not even on an
 empty queue.
═══════════════════════════════════════════════════════════════
EOF

exit 2
