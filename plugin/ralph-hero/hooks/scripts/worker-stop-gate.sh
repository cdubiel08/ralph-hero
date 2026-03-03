#!/bin/bash
# ralph-hero/hooks/scripts/worker-stop-gate.sh
# Stop: Prevent agent workers from stopping while matching tasks remain
#
# Matches the $TEAMMATE environment variable prefix to a role, then
# checks if any tasks exist matching that role's keywords. If so, blocks
# stop (exit 2) to prompt the agent to check TaskList.
#
# Role keyword mapping:
#   analyst*    -> Triage, Split, Research, Plan
#   builder*    -> Review, Implement
#   integrator* -> Validate, Create PR, Merge, Integrate
#
# Uses stop_hook_active field for re-entry safety (like team-stop-gate.sh).
#
# Exit codes:
#   0 - No matching work found, or re-entry, or not a known worker role
#   2 - Matching tasks likely exist, block with guidance

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

INPUT=$(cat)

# Safety: if already nudged once, allow stop to prevent infinite loop
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then
  exit 0
fi

# Determine role from $TEAMMATE env var prefix
TEAMMATE="${TEAMMATE:-}"

if [[ -z "$TEAMMATE" ]]; then
  exit 0
fi

KEYWORDS=""
ROLE=""

if echo "$TEAMMATE" | grep -qE '^analyst'; then
  ROLE="analyst"
  KEYWORDS="Triage|Split|Research|Plan"
elif echo "$TEAMMATE" | grep -qE '^builder'; then
  ROLE="builder"
  KEYWORDS="Review|Implement"
elif echo "$TEAMMATE" | grep -qE '^integrator'; then
  ROLE="integrator"
  KEYWORDS="Validate|Create PR|Merge|Integrate"
else
  # Not a recognized team worker role; allow stop
  exit 0
fi

cat >&2 <<EOF
Remaining tasks for your role may exist. Check TaskList.

You are a ${ROLE} worker (TEAMMATE=${TEAMMATE}).
Before stopping, verify there are no unblocked tasks matching: ${KEYWORDS}

Run TaskList to check for pending tasks matching your role keywords.
If no unblocked tasks exist, you may stop.
EOF

exit 2
