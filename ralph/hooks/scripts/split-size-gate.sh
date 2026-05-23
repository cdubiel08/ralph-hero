#!/bin/bash
# ralph/hooks/scripts/split-size-gate.sh
# PreToolUse (ralph_hero__create_issue): Validate that sub-tickets created
# by /ralph:caretake --mode split are XS/S only.
#
# Plan 6 hardening: scope-guarded (caretake + split). Larger estimates would
# undermine the atomic-decomposition contract — block them at the MCP boundary.
#
# Environment:
#   RALPH_VALID_SUB_ESTIMATES - Valid estimates for sub-tickets (default: XS,S)
#
# Exit codes:
#   0 - Sub-ticket estimate is valid (or out of scope)
#   2 - Sub-ticket too large, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

if [[ "${RALPH_COMMAND:-}" != "caretake" ]]; then
  allow
fi
if [[ "${RALPH_SUBCOMMAND:-}" != "split" ]]; then
  allow
fi

read_input > /dev/null

valid_estimates="${RALPH_VALID_SUB_ESTIMATES:-XS,S}"

estimate=$(get_field '.tool_input.estimate')
if [[ -z "$estimate" ]]; then
  allow  # No estimate specified, allow (command should set one)
fi

if ! validate_state "$estimate" "$valid_estimates"; then
  block "Sub-ticket estimate too large

Attempted estimate: $estimate
Valid estimates: $valid_estimates

/ralph:caretake --mode split must create XS or S sub-tickets only.
If the work is larger, consider further decomposition."
fi

allow_with_context "Creating sub-ticket with estimate $estimate (valid: $valid_estimates)"
