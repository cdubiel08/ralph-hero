#!/bin/bash
# ralph-hero/hooks/scripts/worker-stop-gate.sh
# Stop: Prevent workers from stopping while matching tasks exist
#
# When a worker finishes a task and tries to stop, this hook forces
# one re-check of TaskList before allowing the stop. Uses the same
# re-entry safety pattern as team-stop-gate.sh.
#
# Exit codes:
#   0 - Re-entry (already checked), allow stop
#   2 - First attempt, block stop with guidance

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

INPUT=$(cat)

# Re-entry safety: if the worker already checked and still wants to stop, allow it.
# This prevents infinite loops. Same pattern as team-stop-gate.sh:21-24.
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then
  exit 0
fi

# Map worker name to task subject keywords for role-specific matching
TEAMMATE=$(echo "$INPUT" | jq -r '.teammate_name // "unknown"')
case "$TEAMMATE" in
  analyst*)    KEYWORDS="Triage, Split, Research, or Plan" ;;
  builder*)    KEYWORDS="Review or Implement" ;;
  integrator*) KEYWORDS="Validate, Create PR, Merge, or Integrate" ;;
  *)           exit 0 ;; # Unknown role, allow stop
esac

cat >&2 <<EOF
Before stopping, check TaskList for pending UNBLOCKED tasks matching your role ($KEYWORDS).
Only tasks with empty blockedBy count as available work.
If matching unblocked tasks exist, claim one and process it.
If none are available, you may stop.
EOF
exit 2
