#!/bin/bash
# ralph/hooks/scripts/split-estimate-gate.sh
# Dual-event hook for ralph_hero__get_issue under /ralph:plan --mode epic's
# atomic-split path (GH-1605; formerly caretake's split mode):
#   - PreToolUse: surface a context message reminding the agent of the M/L/XL
#     requirement.
#   - PostToolUse: parse the get_issue response and BLOCK if the fetched issue's
#     estimate is XS or S.
#
# GH-1605: scoped to the plan skill via RALPH_COMMAND, narrowed further by an
# RALPH_SUBCOMMAND check (epic-split only — the atomic-split re-export from
# decomposition.md § Atomic split; the plan-of-plans path stays at the Step 0
# `epic` value and early-exits here). Pipeline-heavy jq stages append `|| true`
# so the no-match path under `set -euo pipefail` flows to a controlled decision
# rather than an uncaught abort.
#
# FAIL CLOSED once in scope. Out of scope (wrong verb / wrong subcommand) this
# hook exits 0 without reading anything. But once the epic-split scope has armed
# it, an estimate the hook cannot READ is not a reason to allow: warn-and-allow
# on a missing/unparsable estimate let an unestimated parent walk into atomic
# split despite the M/L/XL contract — the same defect class this epic is removing
# from state-gate.sh. Unreadable ⇒ block, with recovery instructions.
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
#   0 - Allowed (PreToolUse passthrough, PostToolUse confirmed M/L/XL, or out of scope)
#   2 - Blocked (PostToolUse: fetched issue is XS/S — too small to split, OR the
#       estimate could not be read from the response — fail closed)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

if [[ "${RALPH_COMMAND:-}" != "plan" ]]; then
  allow
fi
if [[ "${RALPH_SUBCOMMAND:-}" != "epic-split" ]]; then
  allow
fi

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
  allow_with_context "Split command requires ticket estimate of $allowed. Estimate will be re-checked after fetch."
fi

# ---- PostToolUse path: inspect response and enforce ---------------------------
if [[ "$event_name" != "PostToolUse" ]]; then
  warn "split-estimate-gate.sh invoked for unexpected event '$event_name'; allowing."
fi

response_text=$(get_field '.tool_response.content[0].text')

if [[ -z "$response_text" ]]; then
  block "Split blocked: parent estimate unreadable

The get_issue response carried no .content[0].text, so the parent's estimate
could not be read at all. The atomic-split path only operates on M/L/XL parents
(required: one of $allowed, RALPH_MIN_ESTIMATE=$min_estimate), and an estimate
this gate cannot read is not an estimate it can clear.

Recovery options:
  1. Re-run get_issue for the parent and confirm the tool returned a payload
     (an empty response usually means an API/network error, not a real issue).
  2. If the parent genuinely has no estimate, run /ralph:caretake --mode triage
     with action RE-ESTIMATE to set one before retrying the split."
fi

# Parse inner JSON. The `|| true`/`|| echo ""` shapes keep the pipeline alive
# under set -euo pipefail when jq returns nothing.
estimate=$(echo "$response_text" | jq -r '.estimate // empty' 2>/dev/null || echo "")
issue_number=$(echo "$response_text" | jq -r '.number // empty' 2>/dev/null || echo "")
issue_title=$(echo "$response_text" | jq -r '.title // empty' 2>/dev/null || echo "")

if [[ -z "$estimate" ]]; then
  block "Split blocked: parent estimate missing or unparsable

Issue:    #${issue_number:-unknown} — ${issue_title:-unknown}
Estimate: (none read from the response)
Required: one of $allowed (RALPH_MIN_ESTIMATE=$min_estimate)

Either the parent carries no Estimate field value, or the response body did not
parse as JSON. Both are 'the estimate cannot be read' — this gate fails closed
rather than letting an unestimated parent into atomic split.

Recovery options:
  1. Set the estimate: /ralph:caretake --mode triage with action RE-ESTIMATE
     (M+ for a split), then retry.
  2. If the payload looked malformed, re-run get_issue and confirm it returns
     a well-formed issue JSON before retrying.
  3. If the ticket really is small, dispatch /ralph:impl instead of splitting."
fi

if validate_state "$estimate" "$allowed"; then
  echo "split-estimate-gate.sh: #${issue_number} estimate=$estimate (allowed: $allowed) — split may proceed"
  allow
fi

block "Split blocked: ticket too small

Issue:    #${issue_number} — ${issue_title}
Estimate: $estimate
Required: one of $allowed (RALPH_MIN_ESTIMATE=$min_estimate)

The split mode only operates on M/L/XL issues. For XS/S tickets, send the
work to /ralph:impl directly — splitting an already-atomic ticket produces
trivial children and wastes orchestrator turns.

Recovery options:
  1. If the estimate is wrong, run /ralph:caretake --mode triage with action
     RE-ESTIMATE to bump it to M+ before retrying split.
  2. If the ticket really is small, dispatch /ralph:impl instead.
  3. If you need to bypass this gate for a special case, set
     RALPH_FORCE_STOP=true (not recommended — leaves audit trail unclean)."
