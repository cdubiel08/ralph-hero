#!/bin/bash
# ralph-hero/hooks/scripts/split-estimate-gate.sh
# Dual-event hook for ralph_hero__get_issue:
#   - PreToolUse: surface a context message reminding the agent of the M/L/XL requirement.
#   - PostToolUse: parse the get_issue response and BLOCK if the fetched issue's
#     estimate is XS or S (or any value outside RALPH_MIN_ESTIMATE/L/XL semantics).
#
# This makes the gate a real enforcement boundary instead of a passthrough. A
# mis-estimated XS/S issue can no longer be silently splitted because the
# PostToolUse pass blocks the agent before it proceeds to Step 5.
#
# Environment:
#   RALPH_MIN_ESTIMATE       - Minimum estimate for splitting (default: M).
#                              The set of allowed estimates is computed from this:
#                                M  -> M, L, XL
#                                L  -> L, XL
#                                XL -> XL
#   RALPH_VALID_SUB_ESTIMATES - Sub-issue estimate set (informational only here)
#
# Exit codes:
#   0 - Allowed (PreToolUse passthrough or PostToolUse confirmed M/L/XL)
#   2 - Blocked (PostToolUse: fetched issue is XS/S — too small to split)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

min_estimate="${RALPH_MIN_ESTIMATE:-M}"

# Compute allowed estimate set from RALPH_MIN_ESTIMATE
case "$min_estimate" in
  XS) allowed="XS,S,M,L,XL" ;;
  S)  allowed="S,M,L,XL" ;;
  M)  allowed="M,L,XL" ;;
  L)  allowed="L,XL" ;;
  XL) allowed="XL" ;;
  *)  allowed="M,L,XL" ;;
esac

event_name=$(get_field '.hook_event_name')

# ---- PreToolUse path: passthrough with context --------------------------------
if [[ "$event_name" == "PreToolUse" ]] || [[ -z "$event_name" ]]; then
  allow_with_context "Split command requires ticket estimate of $allowed. Valid input states: Backlog, Research Needed, Plan in Review. Estimate will be re-checked after fetch."
fi

# ---- PostToolUse path: inspect response and enforce ---------------------------
if [[ "$event_name" != "PostToolUse" ]]; then
  # Unknown event — fail open with a warning rather than blocking unexpectedly.
  warn "split-estimate-gate.sh invoked for unexpected event '$event_name'; allowing."
fi

# Extract the estimate from the get_issue response. MCP tools wrap their JSON
# payload in {content: [{type: "text", text: "<JSON_STRING>"}]}; unwrap it.
response_text=$(get_field '.tool_response.content[0].text')

if [[ -z "$response_text" ]]; then
  # No body — could be an error response or unexpected shape. Allow but warn.
  warn "split-estimate-gate.sh: no tool_response.content[0].text found; allowing."
fi

# Parse the inner JSON for the estimate field.
# Use a here-string so jq sees a clean stdin even if the text contains newlines.
estimate=$(echo "$response_text" | jq -r '.estimate // empty' 2>/dev/null || echo "")

issue_number=$(echo "$response_text" | jq -r '.number // empty' 2>/dev/null || echo "")
issue_title=$(echo "$response_text" | jq -r '.title // empty' 2>/dev/null || echo "")

if [[ -z "$estimate" ]]; then
  # No estimate set on the issue — the skill should re-estimate or escalate
  # rather than splitting blindly. Allow but warn.
  warn "split-estimate-gate.sh: fetched issue #${issue_number:-unknown} has no estimate; agent should set one before proceeding."
fi

# Validate estimate is in the allowed set.
if validate_state "$estimate" "$allowed"; then
  echo "split-estimate-gate.sh: #${issue_number} estimate=$estimate (allowed: $allowed) — split may proceed"
  allow
fi

# Block: estimate is too small.
block "Split blocked: ticket too small

Issue:    #${issue_number} — ${issue_title}
Estimate: $estimate
Required: one of $allowed (RALPH_MIN_ESTIMATE=$min_estimate)

The split skill only operates on M/L/XL issues. For XS/S tickets, send the
work to ralph-impl directly — splitting an already-atomic ticket produces
trivial children and wastes orchestrator turns.

Recovery options:
  1. If the estimate is wrong, run /ralph-triage with action RE-ESTIMATE
     to bump it to M+ before retrying split.
  2. If the ticket really is small, dispatch ralph-impl instead.
  3. If you need to bypass this gate for a special case, set
     RALPH_FORCE_STOP=true (not recommended — leaves audit trail unclean)."
