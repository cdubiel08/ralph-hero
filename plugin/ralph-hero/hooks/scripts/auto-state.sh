#!/bin/bash
# ralph-hero/hooks/scripts/auto-state.sh
# PreToolUse: Auto-inject correct state from semantic intent
#
# Intercepts ralph_hero__handoff_ticket calls and replaces semantic intents
# (__LOCK__, __COMPLETE__, __ESCALATE__, __CLOSE__, __CANCEL__)
# with actual state names from the state machine.
#
# Environment:
#   RALPH_COMMAND - Current command (required)
#   RALPH_AUTO_STATE - Enable auto-injection (default: true)
#
# Exit codes:
#   0 - Allowed (with potentially modified input)
#   2 - Invalid semantic intent or missing command

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"

STATE_MACHINE="$SCRIPT_DIR/ralph-state-machine.json"

read_input > /dev/null

tool_name=$(get_tool_name)
if [[ "$tool_name" != "ralph_hero__handoff_ticket" ]]; then
  allow
fi

if [[ "${RALPH_AUTO_STATE:-true}" != "true" ]]; then
  allow
fi

requested_state=$(get_field '.tool_input.state')
if [[ -z "$requested_state" ]]; then
  allow
fi

case "$requested_state" in
  __LOCK__|__COMPLETE__|__ESCALATE__|__CLOSE__|__CANCEL__)
    ;;
  *)
    allow
    ;;
esac

command="${RALPH_COMMAND:-}"
if [[ -z "$command" ]]; then
  block "Cannot resolve semantic state '$requested_state' without RALPH_COMMAND environment variable"
fi

command_key="ralph_${command#ralph_}"

resolve_semantic_state() {
  local intent="$1"
  local cmd="$2"

  local state=$(jq -r --arg intent "$intent" --arg cmd "$cmd" \
    '.semantic_states[$intent][$cmd] // empty' "$STATE_MACHINE")

  if [[ -z "$state" ]]; then
    state=$(jq -r --arg intent "$intent" \
      '.semantic_states[$intent]["*"] // empty' "$STATE_MACHINE")
  fi

  echo "$state"
}

case "$requested_state" in
  __LOCK__)
    actual_state=$(resolve_semantic_state "__LOCK__" "$command_key")
    if [[ -z "$actual_state" ]]; then
      block "Command '$command_key' has no __LOCK__ mapping in semantic_states"
    fi
    context="Acquiring lock: $actual_state"
    ;;
  __COMPLETE__)
    actual_state=$(resolve_semantic_state "__COMPLETE__" "$command_key")
    if [[ -z "$actual_state" ]]; then
      block "Command '$command_key' has no __COMPLETE__ mapping in semantic_states"
    fi
    context="Completing: $actual_state"
    ;;
  __ESCALATE__)
    actual_state=$(resolve_semantic_state "__ESCALATE__" "$command_key")
    if [[ -z "$actual_state" ]]; then
      actual_state="Human Needed"
    fi
    context="Escalating to Human Needed"
    ;;
  __CLOSE__)
    actual_state=$(resolve_semantic_state "__CLOSE__" "$command_key")
    if [[ -z "$actual_state" ]]; then
      actual_state="Done"
    fi
    context="Closing ticket as Done"
    ;;
  __CANCEL__)
    actual_state=$(resolve_semantic_state "__CANCEL__" "$command_key")
    if [[ -z "$actual_state" ]]; then
      actual_state="Canceled"
    fi
    context="Canceling ticket"
    ;;
esac

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "$context",
    "modifiedInput": {
      "state": "$actual_state"
    }
  }
}
EOF
exit 0
