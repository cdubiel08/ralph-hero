#!/bin/bash
# ralph-hero/hooks/scripts/unblock-state-gate.sh
# PostToolUse (ralph_hero__save_issue): Validate ralph-unblock state transitions
#
# The interactive `ralph-hero:unblock` skill closes the escalation loop by
# transitioning a Human Needed issue back into the pipeline. The only valid
# re-entry states (per ralph-state-machine.json) are:
#
#   Backlog, Research Needed, Ready for Plan, In Progress
#
# `Human Needed` is also allowed so the skill can make no-op saves (e.g.
# label-only updates) without state-resolution churn. Anything else
# (Done, Canceled, Plan in Review, etc.) is blocked.
#
# Exit codes:
#   0 - Valid transition target, allow
#   2 - Invalid transition target, block
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hook-utils.sh
source "$SCRIPT_DIR/hook-utils.sh"

read_input > /dev/null

tool_name=$(get_tool_name)
if [[ "$tool_name" != "ralph_hero__save_issue" ]]; then
  allow
fi

target_state=$(get_field '.tool_input.workflowState')
if [[ -z "$target_state" ]]; then
  allow  # Not a state update (e.g. label-only save)
fi

case "$target_state" in
  "Backlog"|"Research Needed"|"Ready for Plan"|"In Progress"|"Human Needed")
    allow
    ;;
  *)
    block "Invalid ralph-unblock state transition

Command: ${RALPH_COMMAND:-unblock}
Attempted state: $target_state
Valid output states: Backlog, Research Needed, Ready for Plan, In Progress, Human Needed

ralph-unblock can only route Human Needed issues to one of the 4 valid
re-entry states (Backlog, Research Needed, Ready for Plan, In Progress).
Human Needed itself is allowed only for no-op saves (e.g. label updates).

Note: Plan in Review is intentionally NOT a re-entry state. Issues that need
re-review must route through Ready for Plan."
    ;;
esac
