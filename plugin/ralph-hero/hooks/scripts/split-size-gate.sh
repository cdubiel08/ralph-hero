#!/bin/bash
# ralph-hero/hooks/scripts/split-size-gate.sh
# PreToolUse (ralph_hero__create_issue): Validate sub-tickets are XS/S
#
# Ensures split command only creates appropriately small sub-tickets.
#
# Environment:
#   RALPH_VALID_SUB_ESTIMATES - Valid estimates for sub-tickets (default: XS,S)
#
# Exit codes:
#   0 - Sub-ticket estimate is valid
#   2 - Sub-ticket too large, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

valid_estimates="${RALPH_VALID_SUB_ESTIMATES:-XS,S}"

# Extract estimate from create_issue call
estimate=$(get_field '.tool_input.estimate')
if [[ -z "$estimate" ]]; then
  allow  # No estimate specified, allow (command should set one)
fi

# Validate estimate is in allowed set
if ! validate_state "$estimate" "$valid_estimates"; then
  block "Sub-ticket estimate too large

Attempted estimate: $estimate
Valid estimates: $valid_estimates

Split command must create XS or S sub-tickets only.
If the work is larger, consider further decomposition."
fi

allow_with_context "Creating sub-ticket with estimate $estimate (valid: $valid_estimates)"
