#!/usr/bin/env bash
# State gate for ralph-pr skill.
# Allows: In Review, Human Needed
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"

# Slim-plugin scope: only activate for /ralph:impl (RALPH_COMMAND=impl) when
# the transition targets In Review — additional belt-and-suspenders on top of
# impl-state-gate for the --mode pr surface. No-op for other slim verbs.
if [[ "${RALPH_COMMAND:-}" != "impl" ]]; then
  allow
fi

read_input > /dev/null

new_state=$(get_field ".tool_input.workflowState" 2>/dev/null || get_field ".tool_input.targetState" 2>/dev/null || echo "")
if [[ -z "$new_state" ]]; then
  allow
fi

# Self-limit: only fire when transitioning to In Review (the pr-mode target).
# Other transitions (In Progress, etc.) are handled by impl-state-gate.
if [[ "$new_state" != "In Review" ]]; then
  allow
fi

valid="${RALPH_VALID_OUTPUT_STATES:-In Review,Human Needed}"
if validate_state "$new_state" "$valid"; then
  allow_with_context "PR state transition to '$new_state' is valid."
fi

block "Invalid state transition for PR creation: '$new_state'
Valid output states: $valid"
