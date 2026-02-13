#!/bin/bash
# ralph-hero/hooks/scripts/research-state-gate.sh
# PreToolUse (ralph_hero__update_workflow_state): Validate research state transitions
#
# Environment:
#   RALPH_VALID_INPUT_STATES - Valid source states (comma-separated)
#   RALPH_VALID_OUTPUT_STATES - Valid target states (comma-separated)
#
# Exit codes:
#   0 - Valid transition
#   2 - Invalid transition, block with guidance

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

new_state=$(get_field '.tool_input.state')
if [[ -z "$new_state" ]]; then
  allow  # Not a state update
fi

valid_input="${RALPH_VALID_INPUT_STATES:-Research Needed}"
valid_output="${RALPH_VALID_OUTPUT_STATES:-Ready for Plan,Human Needed}"

# Allow lock state (Research in Progress)
if [[ "$new_state" == "Research in Progress" ]]; then
  allow_with_context "Acquiring lock state: Research in Progress. You now have exclusive ownership of this ticket."
fi

if ! validate_state "$new_state" "$valid_output"; then
  block "Invalid state transition

Command: ${RALPH_COMMAND:-research}
Attempted state: $new_state
Valid output states: $valid_output

This command can only transition to: $valid_output"
fi

allow
