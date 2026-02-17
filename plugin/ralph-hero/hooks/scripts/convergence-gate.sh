#!/bin/bash
# ralph-hero/hooks/scripts/convergence-gate.sh
# PreToolUse (ralph_hero__handoff_ticket): Warn on planning transitions
# without convergence verification
#
# Fires on: ralph_hero__handoff_ticket
# Warns: Transitions to "Plan in Progress" if RALPH_CONVERGENCE_VERIFIED not set
#
# Hooks cannot call MCP tools, so full convergence verification must happen
# in the orchestrator via ralph_hero__check_convergence. This hook provides
# a safety reminder when convergence wasn't explicitly verified.
#
# Environment:
#   RALPH_CONVERGENCE_VERIFIED - Set by orchestrator after check_convergence call
#
# Exit codes:
#   0 - Allow (with optional warning)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"

read_input > /dev/null

# Only check transitions TO planning lock state
requested_state=$(get_field '.tool_input.state')

# Handle semantic intents - __LOCK__ for ralph_plan resolves to "Plan in Progress"
if [[ "$requested_state" != "Plan in Progress" && "$requested_state" != "__LOCK__" ]]; then
  allow
fi

# If command is not ralph_plan, __LOCK__ won't resolve to Plan in Progress
if [[ "$requested_state" == "__LOCK__" && "${RALPH_COMMAND:-}" != "plan" ]]; then
  allow
fi

# Get the issue number being transitioned
issue_number=$(get_field '.tool_input.number')
if [[ -z "$issue_number" ]]; then
  allow  # Can't check without issue number
fi

# If orchestrator already verified convergence via MCP tool, allow silently
if [[ -n "${RALPH_CONVERGENCE_VERIFIED:-}" ]]; then
  allow
fi

# No verification flag - warn but don't block
allow_with_context "WARNING: Planning transition to 'Plan in Progress' for #$issue_number. Ensure convergence was verified via ralph_hero__check_convergence before proceeding. If not, check that ALL group members are in 'Ready for Plan' state."
