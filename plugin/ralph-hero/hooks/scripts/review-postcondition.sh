#!/bin/bash
# ralph-hero/hooks/scripts/review-postcondition.sh
# Stop: Verify ralph-review completed successfully
#
# Exit codes:
#   0 - Postconditions met
#   2 - Postconditions failed, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

COMMAND="${RALPH_COMMAND:-review}"
TICKET_ID="${RALPH_TICKET_ID:-}"
INTERACTIVE="${RALPH_INTERACTIVE:-false}"
ARTIFACT_DIR="${RALPH_ARTIFACT_DIR:-thoughts/shared/reviews}"

PASSED=()
FAILED=()
WARNINGS=()

if [[ -z "$TICKET_ID" ]]; then
  WARNINGS+=("No ticket ID tracked - cannot verify postconditions")
else
  if [[ "$INTERACTIVE" != "true" ]]; then
    project_root=$(get_project_root)
    critique=$(find "$project_root/$ARTIFACT_DIR" -name "*${TICKET_ID}*" -type f 2>/dev/null | head -1)
    if [[ -n "$critique" ]]; then
      PASSED+=("Critique document created: $critique")
    else
      FAILED+=("AUTO mode requires critique document - none found for $TICKET_ID")
    fi
  else
    PASSED+=("INTERACTIVE mode - no critique document required")
  fi
fi

project_root=$(get_project_root)
uncommitted=$(cd "$project_root" && git status --porcelain "$ARTIFACT_DIR" 2>/dev/null | head -5)
if [[ -n "$uncommitted" ]]; then
  WARNINGS+=("Uncommitted changes in $ARTIFACT_DIR")
fi

echo "==================================================================="
echo "              ralph-review Postcondition Check"
echo "==================================================================="
echo ""
echo "Ticket: ${TICKET_ID:-unknown}"
echo "Mode: $([ "$INTERACTIVE" = "true" ] && echo "INTERACTIVE" || echo "AUTO")"
echo ""

if [[ ${#PASSED[@]} -gt 0 ]]; then
  echo "PASSED:"
  for item in "${PASSED[@]}"; do
    echo "  [OK] $item"
  done
  echo ""
fi

if [[ ${#WARNINGS[@]} -gt 0 ]]; then
  echo "WARNINGS:"
  for item in "${WARNINGS[@]}"; do
    echo "  [WARN] $item"
  done
  echo ""
fi

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "FAILED:" >&2
  for item in "${FAILED[@]}"; do
    echo "  [FAIL] $item" >&2
  done
  echo "" >&2
  echo "ACTION REQUIRED: Address failures before completing." >&2
  echo "==================================================================" >&2
  exit 2
fi

echo "==================================================================="
exit 0
