#!/bin/bash
# ralph-hero/hooks/scripts/post-blocker-reminder.sh
# PostToolUse: Remind Claude to verify blockedBy status
#
# GitHub retains dependency relationships even after blocking issues
# are closed. This hook detects dependencies in get_issue responses
# and injects context reminding Claude to verify each blocker's status.
#
# Exit codes:
#   0 - Always (PostToolUse hooks cannot block)

set -euo pipefail

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')

# Only process get_issue responses
if [[ "$TOOL_NAME" != "ralph_hero__get_issue" ]]; then
  exit 0
fi

TOOL_RESPONSE=$(echo "$INPUT" | jq -r '.tool_response // "{}"')

# Check for non-empty blockedBy in response
BLOCKED_BY=$(echo "$TOOL_RESPONSE" | jq -r '
  .blockedBySummary // [] |
  map("#" + (.number | tostring)) |
  if length > 0 then join(", ") else empty end
' 2>/dev/null)

if [[ -z "$BLOCKED_BY" ]]; then
  exit 0
fi

BLOCKED_COUNT=$(echo "$TOOL_RESPONSE" | jq '.blockedBySummary | length' 2>/dev/null)
ISSUE_NUMBER=$(echo "$TOOL_RESPONSE" | jq -r '.number // "unknown"' 2>/dev/null)

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "BLOCKER VERIFICATION REQUIRED for #$ISSUE_NUMBER: This issue has $BLOCKED_COUNT blockedBy relation(s): [$BLOCKED_BY]. GitHub does NOT auto-remove dependencies when blockers close. You MUST check each blocker's actual status. Only blockers with state other than Done or Canceled are truly active. If all blockers are Done/Canceled, treat this ticket as UNBLOCKED."
  }
}
EOF
exit 0
