#!/bin/bash
# ralph-hero/hooks/scripts/val-postcondition.sh
# Stop: Ensure ralph-val produced a verdict before allowing stop
#
# Accepts as terminal output any of:
#   - "VALIDATION PASS"   — clean run with all checks passing
#   - "VALIDATION FIX"    — only mechanical failures (auto-fixable, e.g. lint/format)
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
# we only care whether any of the four marker phrases appears anywhere.
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [[ -n "$TRANSCRIPT_PATH" && -f "$TRANSCRIPT_PATH" ]]; then
  if grep -qE 'VALIDATION PASS|VALIDATION FIX|VALIDATION FAIL|Queue empty' "$TRANSCRIPT_PATH"; then
    # Silent-fallback detection (Step 4 contract violation):
    # If the transcript contains VALIDATION PASS AND "Merged to main" AND does NOT
    # contain a worktrees/GH- path token, the agent fabricated a "validate against
    # main" fallback when the worktree was missing. Per ralph-val SKILL.md Step 4,
    # the only correct verdict in that case is VALIDATION FAIL with
    # "No worktree found at worktrees/GH-NNN". Block stop so the agent re-emits
    # the correct verdict.
    if grep -q 'VALIDATION PASS' "$TRANSCRIPT_PATH" \
       && grep -q 'Merged to main' "$TRANSCRIPT_PATH" \
       && ! grep -q 'worktrees/GH-' "$TRANSCRIPT_PATH"; then
      echo 'Detected silent main fallback: VALIDATION PASS emitted with "Merged to main" and no worktree path. This is a Step 4 contract violation. Emit VALIDATION FAIL with "No worktree found at worktrees/GH-NNN".' >&2
      exit 2
    fi
    exit 0
  fi
fi

echo "Ensure you have produced a VALIDATION PASS, VALIDATION FIX, VALIDATION FAIL, or Queue empty verdict with specific check results before stopping." >&2
exit 2
