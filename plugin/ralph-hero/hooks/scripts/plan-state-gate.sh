#!/bin/bash
# ralph-hero/hooks/scripts/plan-state-gate.sh
# PreToolUse (ralph_hero__handoff_ticket): Validate plan state transitions
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

valid_output="${RALPH_VALID_OUTPUT_STATES:-Plan in Review,Human Needed}"

# Allow lock state (Plan in Progress)
if [[ "$new_state" == "Plan in Progress" ]]; then
  allow_with_context "Acquiring lock state: Plan in Progress. You now have exclusive ownership of this ticket."
fi

if ! validate_state "$new_state" "$valid_output"; then
  block "Invalid plan state transition

Command: ${RALPH_COMMAND:-plan}
Attempted state: $new_state
Valid output states: $valid_output

This command can only transition to: $valid_output"
fi

allow
