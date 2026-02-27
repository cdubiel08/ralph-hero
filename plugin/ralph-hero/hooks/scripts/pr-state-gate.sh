#!/usr/bin/env bash
# State gate for ralph-pr skill.
# Allows: In Review, Human Needed
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"
read_input

new_state=$(get_field ".tool_input.state" 2>/dev/null || get_field ".tool_input.targetState" 2>/dev/null || echo "")
if [[ -z "$new_state" ]]; then
  allow
fi

valid="${RALPH_VALID_OUTPUT_STATES:-In Review,Human Needed}"
if validate_state "$new_state" "$valid"; then
  allow_with_context "PR state transition to '$new_state' is valid."
fi

block "Invalid state transition for PR creation: '$new_state'
Valid output states: $valid"
