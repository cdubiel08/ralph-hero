#!/bin/bash
# ralph-hero/hooks/scripts/plan-state-gate.sh
# PreToolUse (ralph_hero__save_issue): Validate plan state transitions
#
# Environment:
#   RALPH_VALID_OUTPUT_STATES - Valid target states
#
# Exit codes:
#   0 - Valid transition
#   2 - Invalid transition, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Slim-plugin scope: only activate for /ralph:plan. Without this guard the hook
# stays registered after /ralph:plan hands off (e.g. under /ralph:hero) and fires
# on every subsequent save_issue — including impl/merge transitions it has no
# business adjudicating (GH-1413). Mirrors impl/merge/triage-state-gate.
if [[ "${RALPH_COMMAND:-}" != "plan" ]]; then
  allow
fi

read_input > /dev/null

new_state=$(get_field '.tool_input.workflowState')
if [[ -z "$new_state" ]]; then
  allow  # Not a state update
fi

# Semantic-intent transitions (__LOCK__, __COMPLETE__, __ESCALATE__, etc.) are
# resolved by the MCP save_issue tool to concrete workflow states; the gate must
# not block them at the intent layer. --mode auto/epic lock via __LOCK__ and
# advance via __COMPLETE__, so without this passthrough those legitimate plan
# transitions false-block (GH-1413).
if is_semantic_intent "$new_state"; then
  allow_with_context "Semantic intent '$new_state' is resolved server-side; plan-state-gate defers to MCP."
fi

# Slim-plugin /ralph:plan covers 5 modes (default + auto + epic + iterate + review).
# The union of legitimate target states across all modes:
#   - "Plan in Progress" — lock for auto/epic; also NEEDS_ITERATION target from review
#   - "Plan in Review"   — default/auto/epic advance after write
#   - "In Progress"      — review-mode APPROVED transition
#   - "Ready for Plan"   — auto-mode unlock on failure
#   - "Human Needed"     — escalation in any mode
# This is broader than the source plugin's per-skill gate; mode-specific narrowing
# happens in workflow body / SKILL.md, not at the gate.
valid_output="${RALPH_VALID_OUTPUT_STATES:-Plan in Progress,Plan in Review,In Progress,Ready for Plan,Human Needed}"

# Allow lock state (Plan in Progress) with a context-attached note for auto/epic locks
if [[ "$new_state" == "Plan in Progress" ]]; then
  allow_with_context "Plan in Progress transition allowed. (Lock acquisition for auto/epic, or NEEDS_ITERATION rollback for review.)"
fi

if ! validate_state "$new_state" "$valid_output"; then
  block "Invalid plan state transition

Command: ${RALPH_COMMAND:-plan}
Attempted state: $new_state
Valid output states: $valid_output

This command can only transition to: $valid_output"
fi

allow
