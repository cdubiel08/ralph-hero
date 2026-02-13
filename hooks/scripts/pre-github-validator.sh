#!/bin/bash
# ralph-hero/hooks/scripts/pre-github-validator.sh
# PreToolUse: Validate state transitions before GitHub workflow state updates
#
# Exit codes:
#   0 - Allowed (with optional context)
#   2 - Blocked (stderr contains reason shown to Claude)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_MACHINE="$SCRIPT_DIR/ralph-state-machine.json"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // {}')

# Only validate workflow state update calls
if [[ "$TOOL_NAME" != "ralph_hero__update_workflow_state" ]]; then
  exit 0
fi

ISSUE_NUMBER=$(echo "$TOOL_INPUT" | jq -r '.number // "unknown"')
NEW_STATE=$(echo "$TOOL_INPUT" | jq -r '.state // null')

if [[ "$NEW_STATE" == "null" ]]; then
  exit 0
fi

if [[ ! -f "$STATE_MACHINE" ]]; then
  echo "Warning: State machine not found at $STATE_MACHINE" >&2
  exit 0
fi

STATE_EXISTS=$(jq -r --arg state "$NEW_STATE" '.states[$state] // "not_found"' "$STATE_MACHINE")
if [[ "$STATE_EXISTS" == "not_found" ]]; then
  echo "ERROR: Unknown state '$NEW_STATE'. Valid states are:" >&2
  jq -r '.states | keys | .[]' "$STATE_MACHINE" | sed 's/^/  - /' >&2
  exit 2
fi

IS_LOCK_STATE=$(jq -r --arg state "$NEW_STATE" '.states[$state].is_lock_state // false' "$STATE_MACHINE")

VALID_FROM_STATES=$(jq -r --arg target "$NEW_STATE" '
  [.states | to_entries[] | select(.value.allowed_transitions | index($target)) | .key] | join(", ")
' "$STATE_MACHINE")

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "GitHub workflow state change to '$NEW_STATE' for #$ISSUE_NUMBER.\n\nValid source states for this transition: $VALID_FROM_STATES\n\nNote: $(if [[ "$IS_LOCK_STATE" == "true" ]]; then echo "This is a LOCK STATE - ticket is now claimed exclusively."; else echo "Standard state transition."; fi)"
  }
}
EOF
exit 0
