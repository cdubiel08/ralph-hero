#!/bin/bash
# ralph/hooks/scripts/split-size-gate.sh
# PreToolUse (ralph_hero__create_issue | ralph_hero__create_sub_issues): Validate
# that sub-tickets created by /ralph:plan --mode epic's atomic-split path
# (GH-1605; formerly caretake's split mode) are XS/S only.
#
# GH-1605: scope-guarded (plan + epic-split — the atomic-split re-export from
# decomposition.md § Atomic split; the plan-of-plans path stays at the Step 0
# `epic` value and early-exits here, letting S/M feature children pass per
# decomposition.md § Plan-of-plans shape). Larger estimates would undermine
# the atomic-decomposition contract — block them at the MCP boundary.
#
# GH-1565: create_sub_issues batches N children in a single call, each with
# its own optional .estimate — there is no single scalar estimate to read, so
# this hook branches on whether the payload carries a `children` array and,
# if so, validates every child's estimate instead of the top-level scalar.
#
# Environment:
#   RALPH_VALID_SUB_ESTIMATES - Valid estimates for sub-tickets (default: XS,S)
#
# Exit codes:
#   0 - Sub-ticket estimate(s) valid (or out of scope)
#   2 - Sub-ticket too large, OR missing an estimate entirely, block. A missing
#       estimate is refused rather than waved through: the XS/S ceiling must not
#       be bypassable by omitting the field. Matches GH-1618's server-side rule
#       (create_sub_issues refuses estimate-less children whenever
#       `maxChildEstimate` is armed explicitly, which the atomic-split path does).

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

if [[ "${RALPH_COMMAND:-}" != "plan" ]]; then
  allow
fi
if [[ "${RALPH_SUBCOMMAND:-}" != "epic-split" ]]; then
  allow
fi

read_input > /dev/null

valid_estimates="${RALPH_VALID_SUB_ESTIMATES:-XS,S}"

has_children=$(echo "$RALPH_HOOK_INPUT" | jq -r '(.tool_input.children | type) == "array"')

if [[ "$has_children" == "true" ]]; then
  # Batch path (create_sub_issues): one estimate per child, array-shaped.
  # A missing/empty estimate is NOT a pass — under the atomic-split scope the
  # XS/S ceiling must not be bypassable by simply omitting the field (GH-1618
  # makes the same call server-side: an explicitly armed `maxChildEstimate`
  # refuses estimate-less children up front, and this path arms it to "S").
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

/ralph:plan --mode epic (atomic-split path) must create XS or S sub-tickets only.
If the work is larger, consider further decomposition."
  fi

  unestimated=$(echo "$RALPH_HOOK_INPUT" | jq -r '
    [.tool_input.children[]
      | select((.estimate // "" | gsub("^\\s+|\\s+$"; "")) == "")
      | .title // "untitled"]
    | join(", ")
  ')

  if [[ -n "$unestimated" ]]; then
    block "Sub-ticket estimate missing

Children with no estimate: $unestimated
Valid estimates: $valid_estimates

/ralph:plan --mode epic (atomic-split path) must give EVERY child an explicit
XS or S estimate — an omitted estimate is not a waiver of the ceiling. Set one
per child in the same create_sub_issues call (and pass maxChildEstimate: \"S\"
so the server enforces the same contract)."
  fi

  child_count=$(echo "$RALPH_HOOK_INPUT" | jq -r '.tool_input.children | length')
  allow_with_context "Creating sub-ticket batch ($child_count children) — all estimates within $valid_estimates"
fi

# Scalar path (create_issue). Same rule as the batch path above: inside the
# atomic-split scope an omitted estimate is a refusal, not a free pass.
estimate=$(get_field '.tool_input.estimate')
if [[ -z "$estimate" ]]; then
  block "Sub-ticket estimate missing

Valid estimates: $valid_estimates

/ralph:plan --mode epic (atomic-split path) must give EVERY sub-ticket an
explicit XS or S estimate — an omitted estimate is not a waiver of the ceiling."
fi

if ! validate_state "$estimate" "$valid_estimates"; then
  block "Sub-ticket estimate too large

Attempted estimate: $estimate
Valid estimates: $valid_estimates

/ralph:plan --mode epic (atomic-split path) must create XS or S sub-tickets only.
If the work is larger, consider further decomposition."
fi

allow_with_context "Creating sub-ticket with estimate $estimate (valid: $valid_estimates)"
