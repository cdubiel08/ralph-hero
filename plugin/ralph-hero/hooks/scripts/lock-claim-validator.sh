#!/bin/bash
# ralph-hero/hooks/scripts/lock-claim-validator.sh
# PreToolUse (ralph_hero__save_issue): Prevent claiming an issue already in a lock state
#
# When a skill tries to set a lock state (Research in Progress, Plan in Progress, In Progress)
# this hook checks RALPH_CURRENT_STATE to ensure the issue is not already locked by another agent.
#
# Requires: RALPH_CURRENT_STATE env var (set by skill after calling get_issue)
#
# Exit codes:
#   0 - Allowed (not a lock state, or current state is not already locked)
#   2 - Blocked (issue is already in a lock state)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"

STATE_MACHINE="$SCRIPT_DIR/ralph-state-machine.json"

read_input > /dev/null

tool_name=$(get_tool_name)
if [[ "$tool_name" != "ralph_hero__save_issue" ]]; then
  allow
fi

if [[ ! -f "$STATE_MACHINE" ]]; then
  allow
fi

target_state=$(get_field '.tool_input.workflowState')
if [[ -z "$target_state" ]]; then
  allow  # Not a state change
fi

# Check if target is a lock state
is_lock_target=$(jq -r --arg state "$target_state" '.states[$state].is_lock_state // false' "$STATE_MACHINE")
if [[ "$is_lock_target" != "true" ]]; then
  allow  # Not trying to acquire a lock
fi

# Check if the issue is already in a lock state (via RALPH_CURRENT_STATE)
current_state="${RALPH_CURRENT_STATE:-}"
if [[ -z "$current_state" ]]; then
  allow  # Can't validate without current state
fi

is_currently_locked=$(jq -r --arg state "$current_state" '.states[$state].is_lock_state // false' "$STATE_MACHINE")
if [[ "$is_currently_locked" == "true" ]]; then
  issue_number=$(get_field '.tool_input.issueNumber')
  lock_states=$(jq -r '.lock_states.states | join(", ")' "$STATE_MACHINE")
  block "Lock claim conflict for issue #${issue_number:-unknown}

Target lock state: $target_state
Current state: $current_state (already locked by another agent)

Issue is already in a lock state — another agent has exclusive ownership.
Do NOT claim or modify this issue. Skip it and process a different ticket.

Lock states: $lock_states"
fi

allow
