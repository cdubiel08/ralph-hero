#!/bin/bash
# ralph-hero/hooks/scripts/state-gate.sh
# PreToolUse: Validate ticket is in expected state before allowing state transition
#
# Runs on: ralph_hero__handoff_ticket
#
# Environment:
#   RALPH_VALID_FROM_STATES - Comma-separated list of valid source states
#   RALPH_LOCK_STATE - If set, this is the lock state we're acquiring
#
# Exit codes:
#   0 - Valid transition (with context)
#   2 - Invalid transition (blocks with guidance)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_MACHINE="$SCRIPT_DIR/ralph-state-machine.json"

# Read hook input
INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')

# Only validate workflow state update calls
if [[ "$TOOL_NAME" != "ralph_hero__handoff_ticket" ]]; then
  exit 0
fi

NEW_STATE=$(echo "$INPUT" | jq -r '.tool_input.state // empty')
ISSUE_NUMBER=$(echo "$INPUT" | jq -r '.tool_input.number // "unknown"')

# If no state change, allow
if [[ -z "$NEW_STATE" ]]; then
  exit 0
fi

# Check if this is a lock state acquisition
if [[ -f "$STATE_MACHINE" ]]; then
  IS_LOCK=$(jq -r --arg state "$NEW_STATE" '.states[$state].is_lock_state // false' "$STATE_MACHINE")

  if [[ "$IS_LOCK" == "true" ]]; then
    VALID_FROM=$(jq -r --arg state "$NEW_STATE" '
      [.states | to_entries[] | select(.value.allowed_transitions | index($state)) | .key] | join(" or ")
    ' "$STATE_MACHINE")

    cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "LOCK ACQUISITION: Transitioning #$ISSUE_NUMBER to '$NEW_STATE'.\n\nThis is a LOCK STATE - you now have exclusive ownership.\nValid source states: $VALID_FROM\n\nIMPORTANT: You MUST release this lock by completing the command or escalating to Human Needed."
  }
}
EOF
    exit 0
  fi

  # Check valid transitions TO this state
  VALID_FROM=$(jq -r --arg state "$NEW_STATE" '
    [.states | to_entries[] | select(.value.allowed_transitions | index($state)) | .key] | join(", ")
  ' "$STATE_MACHINE")

  if [[ -z "$VALID_FROM" ]]; then
    cat >&2 <<EOF
INVALID STATE TRANSITION

Target state '$NEW_STATE' is not reachable from any state.
This may be a typo or unsupported state.

Valid states: $(jq -r '.states | keys | join(", ")' "$STATE_MACHINE")
EOF
    exit 2
  fi
fi

# Valid transition - provide next steps
if [[ -f "$STATE_MACHINE" ]]; then
  NEXT_STATES=$(jq -r --arg state "$NEW_STATE" '.states[$state].allowed_transitions // [] | join(", ")' "$STATE_MACHINE")
  REQUIRES_HUMAN=$(jq -r --arg state "$NEW_STATE" '.states[$state].requires_human_action // false' "$STATE_MACHINE")

  CONTEXT="Transitioning #$ISSUE_NUMBER to '$NEW_STATE'."
  if [[ "$REQUIRES_HUMAN" == "true" ]]; then
    CONTEXT+="\n\nNOTE: This state requires human action before further transitions."
  fi
  if [[ -n "$NEXT_STATES" ]]; then
    CONTEXT+="\nNext possible states: $NEXT_STATES"
  fi

  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "$CONTEXT"
  }
}
EOF
fi

exit 0
