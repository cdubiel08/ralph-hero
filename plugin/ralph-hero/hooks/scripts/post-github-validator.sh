#!/bin/bash
# ralph-hero/hooks/scripts/post-github-validator.sh
# PostToolUse: Verify GitHub workflow state transitions completed successfully
#
# This hook runs AFTER successful GitHub MCP workflow state updates.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_MACHINE="$SCRIPT_DIR/ralph-state-machine.json"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
TOOL_RESPONSE=$(echo "$INPUT" | jq -r '.tool_response // {}')

# Only validate workflow state update responses
if [[ "$TOOL_NAME" != "ralph_hero__handoff_ticket" ]]; then
  exit 0
fi

NEW_STATE=$(echo "$TOOL_RESPONSE" | jq -r '.newState // .workflowState // "unknown"')
ISSUE_NUMBER=$(echo "$TOOL_RESPONSE" | jq -r '.number // "unknown"')

if [[ ! -f "$STATE_MACHINE" ]]; then
  exit 0
fi

NEXT_TRANSITIONS=$(jq -r --arg state "$NEW_STATE" '
  .states[$state].allowed_transitions // [] | join(", ")
' "$STATE_MACHINE")

IS_TERMINAL=$(jq -r --arg state "$NEW_STATE" '
  .states[$state].is_terminal // false
' "$STATE_MACHINE")

REQUIRES_HUMAN=$(jq -r --arg state "$NEW_STATE" '
  .states[$state].requires_human_action // false
' "$STATE_MACHINE")

EXPECTED_BY=$(jq -r --arg state "$NEW_STATE" '
  [.commands | to_entries[] | select(.value.valid_input_states | index($state)) | .key] | join(", ")
' "$STATE_MACHINE")

FEEDBACK="State transition verified: #$ISSUE_NUMBER -> $NEW_STATE"

if [[ "$IS_TERMINAL" == "true" ]]; then
  FEEDBACK="$FEEDBACK\n\nTerminal state reached. No further actions needed for this ticket."
elif [[ "$REQUIRES_HUMAN" == "true" ]]; then
  FEEDBACK="$FEEDBACK\n\nThis state REQUIRES HUMAN ACTION before proceeding."
  FEEDBACK="$FEEDBACK\nNext transitions (after human approval): $NEXT_TRANSITIONS"
else
  FEEDBACK="$FEEDBACK\n\nNext allowed transitions: $NEXT_TRANSITIONS"
  if [[ -n "$EXPECTED_BY" ]]; then
    FEEDBACK="$FEEDBACK\nExpected by commands: $EXPECTED_BY"
  fi
fi

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "$FEEDBACK"
  }
}
EOF
exit 0
