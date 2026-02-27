#!/usr/bin/env bash
# State gate for ralph-merge skill.
# Allows: Done, Human Needed. advance_parent calls pass through.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"
read_input

tool_name=$(get_field ".tool_name" 2>/dev/null || echo "")
# advance_parent computes target state server-side — allow unconditionally
if [[ "$tool_name" == *"advance_parent"* ]]; then
  allow
fi

new_state=$(get_field ".tool_input.state" 2>/dev/null || get_field ".tool_input.targetState" 2>/dev/null || echo "")
if [[ -z "$new_state" ]]; then
  allow
fi

valid="${RALPH_VALID_OUTPUT_STATES:-Done,Human Needed}"
if validate_state "$new_state" "$valid"; then
  allow_with_context "Merge state transition to '$new_state' is valid."
fi

block "Invalid state transition for merge: '$new_state'
Valid output states: $valid"
