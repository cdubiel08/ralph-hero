#!/bin/bash
# ralph-hero/hooks/scripts/autopilot-wakeup-clear.sh
# PreToolUse:ScheduleWakeup — validate the wakeup call and clear the sentinel
# that autopilot-director-postcheck.sh wrote after a non-terminal Director
# result. Combines the GH-1140 anti-pattern checks (delaySeconds != 300,
# autopilot-shaped prompt) with the post-GH-1267 sentinel-clear behavior.
#
# See GH-1346 and thoughts/shared/research/2026-05-21-autopilot-loop-handoff.md.
#
# Self-discriminates on RALPH_COMMAND=autopilot — passes through silently
# for any other skill that uses ScheduleWakeup().
#
# Exit codes:
#   0 - Allowed (sentinel cleared)
#   2 - Blocked (delaySeconds=300 cache-window anti-pattern)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Pass through for non-autopilot sessions.
[[ "${RALPH_COMMAND:-}" == "autopilot" ]] || exit 0

delay_seconds=$(get_field '.tool_input.delaySeconds')

# Cache-window anti-pattern: 300s falls outside both the warm-cache window
# (<=270s) and the cost-amortized committed window (>=1200s). Reject loudly.
if [[ "$delay_seconds" == "300" ]]; then
  cat >&2 <<'EOF'
═══════════════════════════════════════════════════════════════
 Autopilot ScheduleWakeup blocked: delaySeconds=300

 300s is the 5-minute cache-window anti-pattern — it pays the
 prompt-cache miss without amortizing the cost across a longer
 idle period.

 Pick <=270s (warm-cache continuation, work likely to resume) or
 >=1200s (committed idle wait, cache miss amortized).
═══════════════════════════════════════════════════════════════
EOF
  exit 2
fi

# The wakeup is going through. Clear the sentinel so the Stop hook lets the
# session end cleanly. Sentinel path mirrors autopilot-director-postcheck.sh.
session_id=$(get_field '.session_id')
sentinel_dir="${TMPDIR:-/tmp}"
sentinel="${sentinel_dir%/}/ralph-autopilot-pending-wakeup-${session_id:-$PPID}"
rm -f -- "$sentinel" 2>/dev/null || true

exit 0
