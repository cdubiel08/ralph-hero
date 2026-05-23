#!/usr/bin/env bash
# State gate for /ralph:review merge-mode.
# Allows: Done, Human Needed (concrete states) + any semantic intent (__LOCK__,
# __ESCALATE__, __CLOSE__, etc.) which the MCP server resolves server-side.
#
# Scope: only fires when invoked from /ralph:review (RALPH_COMMAND=review). Other
# skills' save_issue / advance_issue calls are passed through. This mirrors the
# scope-guard pattern from impl-state-gate.sh (Plan 5 / Plan 3 scope-fix lesson).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"

# Slim-plugin scope: only activate for /ralph:review.
if [[ "${RALPH_COMMAND:-}" != "review" ]]; then
  allow
fi

read_input

new_state=$(get_field ".tool_input.workflowState" 2>/dev/null || get_field ".tool_input.targetState" 2>/dev/null || echo "")
if [[ -z "$new_state" ]]; then
  allow
fi

# Semantic-intent transitions (__LOCK__, __ESCALATE__, __CLOSE__, __CANCEL__,
# __COMPLETE__) are resolved by the MCP save_issue tool to concrete workflow
# states; the gate MUST NOT block them at the intent layer. This is the path
# used by code-mode escalation (__ESCALATE__) and merge-mode completion
# (__CLOSE__), both invoked directly from the /ralph:review skill body.
if is_semantic_intent "$new_state"; then
  allow_with_context "Semantic intent '$new_state' is resolved server-side; merge-state-gate defers to MCP."
fi

valid="${RALPH_VALID_OUTPUT_STATES:-Done,Human Needed}"
if validate_state "$new_state" "$valid"; then
  allow_with_context "Merge state transition to '$new_state' is valid."
fi

block "Invalid state transition for /ralph:review (merge-mode): '$new_state'
Valid output states: $valid
Valid semantic intents: __LOCK__, __COMPLETE__, __ESCALATE__, __CLOSE__, __CANCEL__"
