#!/bin/bash
# ralph-hero/hooks/scripts/review-state-gate.sh
# PreToolUse (ralph_hero__update_workflow_state): Validate review state transitions
#
# Environment:
#   RALPH_VALID_OUTPUT_STATES - Valid target states
#
# Exit codes:
#   0 - Valid transition
#   2 - Invalid transition, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

new_state=$(get_field '.tool_input.state')
if [[ -z "$new_state" ]]; then
  allow  # Not a state update
fi

valid_output="${RALPH_VALID_OUTPUT_STATES:-In Progress,Ready for Plan,Human Needed}"

if ! validate_state "$new_state" "$valid_output"; then
  block "Invalid review state transition

Command: ${RALPH_COMMAND:-review}
Attempted state: $new_state
Valid output states: $valid_output

ralph-review can only transition to:
- 'In Progress' (plan approved)
- 'Ready for Plan' (needs iteration)
- 'Human Needed' (escalation)"
fi

allow_with_context "State transition to '$new_state' is valid for ralph-review."
