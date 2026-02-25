#!/bin/bash
# ralph-hero/hooks/scripts/val-postcondition.sh
# Stop: Ensure ralph-val produced a verdict before allowing stop
set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

INPUT=$(cat)
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then
  exit 0
fi

echo "Ensure you have produced a VALIDATION PASS or VALIDATION FAIL verdict with specific check results before stopping." >&2
exit 2
