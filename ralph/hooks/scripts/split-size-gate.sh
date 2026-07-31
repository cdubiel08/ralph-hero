#!/bin/bash
# ralph/hooks/scripts/split-size-gate.sh
# PreToolUse (ralph_hero__create_issue | ralph_hero__create_sub_issues): Validate
# that sub-tickets created by /ralph:caretake --mode split are XS/S only.
#
# Scope-guarded (caretake + split). Larger estimates would undermine the
# atomic-decomposition contract — block them at the MCP boundary.
#
# create_sub_issues batches N children in a single call, each with
# its own optional .estimate — there is no single scalar estimate to read, so
# this hook branches on whether the payload carries a `children` array and,
# if so, validates every child's estimate instead of the top-level scalar.
#
# Environment:
#   RALPH_VALID_SUB_ESTIMATES - Valid estimates for sub-tickets (default: XS,S)
#
# Exit codes:
#   0 - Sub-ticket estimate(s) valid (or out of scope)
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

has_children=$(echo "$RALPH_HOOK_INPUT" | jq -r '(.tool_input.children | type) == "array"')

if [[ "$has_children" == "true" ]]; then
  # Batch path (create_sub_issues): one estimate per child, array-shaped.
  offending=$(echo "$RALPH_HOOK_INPUT" | jq -r --arg valid "$valid_estimates" '
    ($valid | split(",") | map(gsub("^\\s+|\\s+$"; ""))) as $ok
    | [.tool_input.children[]
        | select(.estimate != null
                 and (((.estimate | gsub("^\\s+|\\s+$"; "")) as $e | $ok | index($e)) == null))
        | "\(.title // "untitled"): \(.estimate)"]
    | join(", ")
  ')

  if [[ -n "$offending" ]]; then
    block "Sub-ticket estimate too large

Offending children: $offending
Valid estimates: $valid_estimates

/ralph:caretake --mode split must create XS or S sub-tickets only.
If the work is larger, consider further decomposition."
  fi

  child_count=$(echo "$RALPH_HOOK_INPUT" | jq -r '.tool_input.children | length')
  allow_with_context "Creating sub-ticket batch ($child_count children) — all estimates within $valid_estimates"
fi

# Scalar path (create_issue).
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
