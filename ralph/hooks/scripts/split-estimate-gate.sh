#!/bin/bash
# ralph/hooks/scripts/split-estimate-gate.sh
# Dual-event hook for ralph_hero__get_issue under /ralph:plan --mode epic's
# atomic-split path (GH-1605; formerly caretake's split mode):
#   - PreToolUse: surface a context message reminding the agent of the M/L/XL
#     requirement (only once the atomic scope is armed — see below).
#   - PostToolUse: parse the get_issue response, RECORD the fetched issue's
#     estimate in the session split ledger, and BLOCK if the atomic scope is
#     armed and that estimate is XS or S.
#
# GH-1603 scope rework. The previous version keyed enforcement on
# `RALPH_SUBCOMMAND=epic-split`, armed by a bare `export` in decomposition.md.
# That export never reaches a hook subprocess (only SessionStart
# CLAUDE_ENV_FILE writes do — set-skill-env.sh; the same finding
# autopilot-enable-gate.sh records), so the gate was dead in production. The
# scope now comes from facts hooks observe themselves:
#
#   * RALPH_COMMAND=plan — set at SessionStart via CLAUDE_ENV_FILE, the one
#     env signal hooks can trust.
#   * The session split ledger (hook-utils.sh) — split-size-gate.sh writes
#     `atomic` when it classifies a child-creation call as an atomic split.
#   * RALPH_SUBCOMMAND=epic-split — kept as an ADDITIVE arming signal for
#     environments where an operator exports it before launching. It can only
#     ADD scope, never remove it.
#
# The get_issue PAYLOAD itself carries no field that separates the atomic-split
# fetch from the plan-of-plans fetch (or from --mode auto's XS/S picker), so
# this hook cannot classify the path on its own. What it CAN do unconditionally
# in plan scope is record the estimate it just read; split-size-gate.sh then
# enforces the M/L/XL parent rule at the create boundary, where the path IS
# classifiable and where blocking happens before any child exists. That moves
# the enforcement point later but makes it real — the previous, earlier point
# never fired at all.
#
# FAIL CLOSED once the atomic scope is armed. An estimate the hook cannot READ
# is not a reason to allow: warn-and-allow on a missing/unparsable estimate let
# an unestimated parent walk into atomic split despite the M/L/XL contract —
# the same defect class this epic removed from state-gate.sh.
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
#   0 - Allowed (PreToolUse passthrough, PostToolUse confirmed M/L/XL, recorded
#       an estimate without the atomic scope armed, or out of scope)
#   2 - Blocked (PostToolUse, atomic scope armed: fetched issue is XS/S — too
#       small to split, OR the estimate could not be read — fail closed)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

if [[ "${RALPH_COMMAND:-}" != "plan" ]]; then
  allow
fi

read_input > /dev/null

min_estimate="${RALPH_MIN_ESTIMATE:-M}"

# Allowed parent-estimate set, shared with split-size-gate.sh's parent rule via
# hook-utils.sh so the two enforcement points can never drift.
allowed=$(split_min_estimate_set)

# Armed = this session is known to be on the atomic-split path. Ledger fact
# first (written by split-size-gate.sh from a real create payload), env var
# second (additive only).
armed=0
if [[ "$(split_ledger_get atomic)" == "1" ]]; then
  armed=1
elif [[ "${RALPH_SUBCOMMAND:-}" == "epic-split" ]]; then
  armed=1
fi

# ---- Event discrimination (GH-1603 F3) ----------------------------------------
# Never trust `.hook_event_name` alone: an empty/absent value used to fall into
# the PreToolUse arm, so an S-estimate parent walked straight through the
# enforcement pass. Discriminate on payload SHAPE — `.tool_response` is present
# only on PostToolUse — and treat ambiguity as PostToolUse (the enforcing side).
event_name=$(get_field '.hook_event_name')
has_response=$(echo "$RALPH_HOOK_INPUT" | jq -r 'has("tool_response")' 2>/dev/null || echo "false")

if [[ "$has_response" == "true" ]] || [[ "$event_name" == "PostToolUse" ]]; then
  event="PostToolUse"
elif [[ "$event_name" == "PreToolUse" ]]; then
  event="PreToolUse"
else
  # Unknown event, no response payload to inspect. Nothing to enforce and
  # nothing to record — pass through rather than block a shape we cannot read.
  warn "split-estimate-gate.sh invoked for unrecognized event '${event_name:-<empty>}' with no tool_response; allowing."
fi

# ---- PreToolUse path: passthrough, with context only when armed ---------------
if [[ "$event" == "PreToolUse" ]]; then
  if [[ "$armed" -eq 1 ]]; then
    allow_with_context "Split command requires ticket estimate of $allowed. Estimate will be re-checked after fetch."
  fi
  allow
fi

# ---- PostToolUse path: record, then enforce when armed ------------------------
response_text=$(get_field '.tool_response.content[0].text')

if [[ -z "$response_text" ]]; then
  if [[ "$armed" -eq 0 ]]; then
    allow
  fi
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

# Record what we read, armed or not. split-size-gate.sh reads this back at the
# create boundary to enforce the M/L/XL parent rule on the atomic path — the
# only place in the flow where that path is identifiable from a payload.
# Numeric guard: the key becomes a filename under the session ledger dir, and
# `.number` is attacker-shaped data from a tool response.
if [[ "$issue_number" =~ ^[0-9]+$ ]]; then
  split_ledger_put "parent-${issue_number}" "${estimate:-}"
fi

if [[ "$armed" -eq 0 ]]; then
  allow
fi

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
