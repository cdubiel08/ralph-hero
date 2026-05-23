#!/bin/bash
# ralph-hero/hooks/scripts/plan-state-gate.sh
# PreToolUse (ralph_hero__save_issue): Validate plan state transitions
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

new_state=$(get_field '.tool_input.workflowState')
if [[ -z "$new_state" ]]; then
  allow  # Not a state update
fi

# Slim-plugin /ralph:plan covers 5 modes (default + auto + epic + iterate + review).
# The union of legitimate target states across all modes:
#   - "Plan in Progress" — lock for auto/epic; also NEEDS_ITERATION target from review
#   - "Plan in Review"   — default/auto/epic advance after write
#   - "In Progress"      — review-mode APPROVED transition
#   - "Ready for Plan"   — auto-mode unlock on failure
#   - "Human Needed"     — escalation in any mode
# This is broader than the source plugin's per-skill gate; mode-specific narrowing
# happens in workflow body / SKILL.md, not at the gate.
valid_output="${RALPH_VALID_OUTPUT_STATES:-Plan in Progress,Plan in Review,In Progress,Ready for Plan,Human Needed}"

# Allow lock state (Plan in Progress) with a context-attached note for auto/epic locks
if [[ "$new_state" == "Plan in Progress" ]]; then
  allow_with_context "Plan in Progress transition allowed. (Lock acquisition for auto/epic, or NEEDS_ITERATION rollback for review.)"
fi

if ! validate_state "$new_state" "$valid_output"; then
  block "Invalid plan state transition

Command: ${RALPH_COMMAND:-plan}
Attempted state: $new_state
Valid output states: $valid_output

This command can only transition to: $valid_output"
fi

allow
