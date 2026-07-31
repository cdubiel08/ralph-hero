#!/bin/bash
# ralph/hooks/scripts/unblock-state-gate.sh
# PostToolUse (ralph_hero__save_issue): Validate /ralph:caretake --mode unblock
# state transitions.
#
# Two sub-modes (Plan 5's interactive+autonomous fold pattern):
#   - interactive (default): closes the escalation loop by routing a Human
#     Needed issue back into the pipeline. Valid targets: Backlog, Research
#     Needed, Ready for Plan, In Progress, Human Needed (no-op label saves).
#   - autonomous (--question): must NOT transition state. The body only posts a
#     ## Unblock Request comment and STOPS. Any workflowState write from this
#     path is a bug and gets blocked.
#
# Scope guards + is_semantic_intent passthrough.
#
# Exit codes:
#   0 - Valid transition target (or out of scope)
#   2 - Invalid transition, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

if [[ "${RALPH_COMMAND:-}" != "caretake" ]]; then
  allow
fi
if [[ "${RALPH_SUBCOMMAND:-}" != "unblock" ]]; then
  allow
fi

read_input > /dev/null

target_state=$(get_field '.tool_input.workflowState')
if [[ -z "$target_state" ]]; then
  allow  # Not a state update (e.g. label-only save)
fi

# Semantic intents resolved server-side; defer to MCP.
if is_semantic_intent "$target_state"; then
  allow_with_context "Semantic intent '$target_state' is resolved server-side; unblock-state-gate defers to MCP."
fi

variant="${RALPH_SUBCOMMAND_VARIANT:-interactive}"

if [[ "$variant" == "autonomous" ]]; then
  # Autonomous path: state mutation is a bug.
  block "Invalid --mode unblock --question state transition

The autonomous (--question) sub-mode posts a ## Unblock Request comment and
STOPS. It must NOT call save_issue with a workflowState change.

Attempted state: $target_state
Variant:         autonomous (--question)

If the issue legitimately needs a state change (e.g. routing back into the
pipeline), use the interactive sub-mode (default) which transitions state
after collecting AskUserQuestion answers."
fi

# Interactive path: route-back to one of the valid re-entry states.
case "$target_state" in
  "Backlog"|"Research Needed"|"Ready for Plan"|"In Progress"|"Human Needed")
    allow
    ;;
  *)
    block "Invalid /ralph:caretake --mode unblock state transition

Command: /ralph:caretake --mode unblock (interactive)
Attempted state: $target_state
Valid output states: Backlog, Research Needed, Ready for Plan, In Progress, Human Needed

Interactive unblock can only route Human Needed issues to one of the 4 valid
re-entry states. Human Needed itself is allowed only for no-op saves (e.g.
label updates).

Note: Plan in Review is intentionally NOT a re-entry state. Issues that need
re-review must route through Ready for Plan."
    ;;
esac
