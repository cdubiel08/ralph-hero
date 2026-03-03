#!/bin/bash
# ralph-hero/hooks/scripts/human-needed-outbound-block.sh
# PreToolUse (ralph_hero__save_issue): Block automated transitions out of Human Needed
#
# Human Needed is a state that requires human intervention. Automated skills MUST NOT
# transition issues out of Human Needed — only humans may do so.
#
# Requires: RALPH_CURRENT_STATE env var (set by skill after calling get_issue)
#
# Exit codes:
#   0 - Allowed (not in Human Needed, or no skill context)
#   2 - Blocked (automated skill trying to transition out of Human Needed)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"

read_input > /dev/null

tool_name=$(get_tool_name)
if [[ "$tool_name" != "ralph_hero__save_issue" ]]; then
  allow
fi

# Only block if we're in an automated skill context
command="${RALPH_COMMAND:-}"
if [[ -z "$command" ]]; then
  allow  # No skill active — could be a human calling save_issue directly
fi

# Check current state (set by skill after fetching issue)
current_state="${RALPH_CURRENT_STATE:-}"
if [[ -z "$current_state" ]]; then
  allow  # Can't validate without current state
fi

if [[ "$current_state" != "Human Needed" ]]; then
  allow  # Not in Human Needed state
fi

# We are in Human Needed and an automated skill is trying to change state
target_state=$(get_field '.tool_input.workflowState')
issue_number=$(get_field '.tool_input.issueNumber')

block "Automated transition out of Human Needed is blocked for issue #${issue_number:-unknown}

Current state: Human Needed
Attempted transition to: ${target_state:-unknown}
Active skill: $command

Human Needed requires human intervention before any automated processing.
Only a human may transition this issue out of Human Needed.

To unblock: Have a human manually update the issue state via the GitHub Projects board."
