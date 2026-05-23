#!/bin/bash
# ralph/hooks/scripts/triage-state-gate.sh
# PostToolUse (ralph_hero__save_issue): Validate triage state transitions for
# /ralph:caretake --mode triage.
#
# Plan 6 hardening checklist applied:
#   - RALPH_COMMAND scope guard (no-op unless invoked from /ralph:caretake).
#   - RALPH_SUBCOMMAND scope check (no-op unless --mode triage active).
#   - is_semantic_intent passthrough (__LOCK__, __ESCALATE__, __CLOSE__, etc.
#     resolved server-side by the MCP save_issue tool).
#
# Environment:
#   RALPH_VALID_OUTPUT_STATES - Valid target states
#
# Exit codes:
#   0 - Valid transition (or out of scope)
#   2 - Invalid transition, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Slim-plugin scope: only activate for /ralph:caretake.
if [[ "${RALPH_COMMAND:-}" != "caretake" ]]; then
  allow
fi

# Mode scope: only activate for --mode triage. Other modes (hygiene, unblock,
# split, etc.) have their own state-transition rules and run their own gates.
if [[ "${RALPH_SUBCOMMAND:-}" != "triage" ]]; then
  allow
fi

read_input > /dev/null

new_state=$(get_field '.tool_input.workflowState')
if [[ -z "$new_state" ]]; then
  allow  # Not a state update (e.g. label-only save)
fi

# Semantic-intent transitions resolved server-side by MCP.
if is_semantic_intent "$new_state"; then
  allow_with_context "Semantic intent '$new_state' is resolved server-side; triage-state-gate defers to MCP."
fi

valid_output="${RALPH_VALID_OUTPUT_STATES:-Research Needed,Ready for Plan,Done,Canceled,Human Needed,Backlog}"

if ! validate_state "$new_state" "$valid_output"; then
  block "Invalid triage state transition

Command: /ralph:caretake --mode triage
Attempted state: $new_state
Valid output states: $valid_output

Triage can move tickets to: $valid_output"
fi

allow
