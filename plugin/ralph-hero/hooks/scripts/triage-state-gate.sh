#!/bin/bash
# ralph-hero/hooks/scripts/triage-state-gate.sh
# PreToolUse (ralph_hero__update_workflow_state): Validate triage state transitions
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

valid_output="${RALPH_VALID_OUTPUT_STATES:-Research Needed,Ready for Plan,Done,Canceled,Human Needed}"

if ! validate_state "$new_state" "$valid_output"; then
  block "Invalid triage state transition

Command: ${RALPH_COMMAND:-triage}
Attempted state: $new_state
Valid output states: $valid_output

Triage can move tickets to: $valid_output"
fi

allow
