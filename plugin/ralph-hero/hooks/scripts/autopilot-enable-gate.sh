#!/bin/bash
# ralph-hero/hooks/scripts/autopilot-enable-gate.sh
# PreToolUse:Skill gate for /ralph-hero:autopilot.
#
# Refuses to dispatch the inner /loop /hero unless RALPH_AUTOPILOT_ENABLE=true.
# Deterministic — no LLM in the loop. Invisible on success.
#
# Why a hook (not a Step 0 LLM check):
# - The opt-in gate is a binary precondition; the LLM should never be the one
#   reading the env var and deciding whether to proceed.
# - Failure messages must be deterministic so users get the same instruction
#   every time, not a paraphrase.
#
# Exit codes:
#   0 - Allowed (env var is "true", or this Skill call is not autopilot's
#       /loop dispatch — we pass through silently)
#   2 - Blocked (autopilot active but env var not set)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Only fires for autopilot. Other skills using Skill() pass through.
[[ "${RALPH_COMMAND:-}" == "autopilot" ]] || exit 0

if [[ "${RALPH_AUTOPILOT_ENABLE:-false}" != "true" ]]; then
  cat >&2 <<'EOF'
═══════════════════════════════════════════════════════════════
 Autopilot is opt-in.

 Set RALPH_AUTOPILOT_ENABLE=true before invoking, e.g.:

   export RALPH_AUTOPILOT_ENABLE=true
   /ralph-hero:autopilot

 Unattended automation is opt-in by design.
═══════════════════════════════════════════════════════════════
EOF
  exit 2
fi

exit 0
