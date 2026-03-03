#!/bin/bash
# ralph-hero/hooks/scripts/pre-ticket-lock-validator.sh
# PreToolUse (ralph_hero__get_issue): Detect when a ticket is already being processed (in a "lock state")
#
# Exit codes:
#   0 - Allowed (with or without context)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"

STATE_MACHINE="$SCRIPT_DIR/ralph-state-machine.json"

read_input > /dev/null

tool_name=$(get_tool_name)
if [[ "$tool_name" != "ralph_hero__get_issue" ]]; then
  allow
fi

if [[ ! -f "$STATE_MACHINE" ]]; then
  allow
fi

lock_states=$(jq -r '.lock_states.states | join(", ")' "$STATE_MACHINE")

issue_number=$(get_field '.tool_input.issueNumber')
if [[ -z "$issue_number" ]]; then
  allow
fi

allow_with_context "Fetching issue #${issue_number}.

Lock states (indicate exclusive ownership by another agent): ${lock_states}.

If the fetched issue is in a lock state, do NOT claim or modify it — another agent has exclusive ownership. Skip it and process a different ticket."
