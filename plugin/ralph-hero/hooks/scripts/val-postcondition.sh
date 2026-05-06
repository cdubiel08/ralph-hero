#!/bin/bash
# ralph-hero/hooks/scripts/val-postcondition.sh
# Stop: Ensure ralph-val produced a verdict before allowing stop
#
# Accepts as terminal output any of:
#   - "VALIDATION PASS"   — clean run with all checks passing
#   - "VALIDATION FAIL"   — substantive failure(s) found
#   - "Queue empty"       — queue-picking branch found no eligible work
#                           (paired with synthetic "VALIDATION PASS — no work" verdict in skill)
#
# Exit codes:
#   0 - Verdict produced (or stop_hook_active short-circuit)
#   2 - No recognized verdict in transcript, block stop
set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

INPUT=$(cat)
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then
  exit 0
fi

# Read the transcript and look for a recognized verdict marker. The transcript is
# a JSONL stream of message records; grep across the raw file is sufficient since
# we only care whether any of the three marker phrases appears anywhere.
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [[ -n "$TRANSCRIPT_PATH" && -f "$TRANSCRIPT_PATH" ]]; then
  if grep -qE 'VALIDATION PASS|VALIDATION FAIL|Queue empty' "$TRANSCRIPT_PATH"; then
    exit 0
  fi
fi

echo "Ensure you have produced a VALIDATION PASS, VALIDATION FAIL, or Queue empty verdict with specific check results before stopping." >&2
exit 2
