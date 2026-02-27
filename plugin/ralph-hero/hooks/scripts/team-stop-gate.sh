#!/bin/bash
# ralph-hero/hooks/scripts/team-stop-gate.sh
# Stop: Prevent team lead from shutting down while processable issues exist
#
# Reads stdin JSON and checks for processable GitHub issues across all
# pipeline stages. If work exists, blocks stop (exit 2) with dispatch
# guidance. Uses stop_hook_active field for re-entry safety to prevent
# infinite loops.
#
# Exit codes:
#   0 - No work found or re-entry, allow stop
#   2 - Work exists, block stop with guidance

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

INPUT=$(cat)

# Safety: prevent infinite loop. If we already nudged once and the lead
# still wants to stop, it means it genuinely found no work. Allow it.
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then
  exit 0
fi

# Check GitHub for processable issues across all pipeline stages
STATES=("Backlog" "Research Needed" "Ready for Plan" "Plan in Review" "In Progress" "In Review")
TOTAL_FOUND=0
SUMMARY=""

for state in "${STATES[@]}"; do
  COUNT=$(gh issue list --repo "${RALPH_GH_OWNER:-}/${RALPH_GH_REPO:-}" \
    --label "$state" --json number --jq 'length' 2>/dev/null || echo "0")
  if [[ "$COUNT" -gt 0 ]]; then
    TOTAL_FOUND=$((TOTAL_FOUND + COUNT))
    SUMMARY="${SUMMARY}\n  - ${state}: ${COUNT} issues"
  fi
done

if [[ "$TOTAL_FOUND" -gt 0 ]]; then
  cat >&2 <<EOF
GitHub has $TOTAL_FOUND processable issues that may need attention:
$(echo -e "$SUMMARY")

Consider checking TaskList for unblocked tasks or spawning workers for available roles.
EOF
  exit 2
fi

exit 0
