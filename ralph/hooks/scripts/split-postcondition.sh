#!/bin/bash
# ralph/hooks/scripts/split-postcondition.sh
# Stop: Verify /ralph:plan --mode epic's atomic-split path (GH-1605; formerly
# caretake's split mode) created ≥2 sub-issues.
#
# ---- Scope (GH-1603) ---------------------------------------------------------
# The previous version armed on `RALPH_SUBCOMMAND=epic-split` and read the count
# from `RALPH_SPLIT_COUNT`. Both were bare `export`s in skill prose, and a bare
# export inside a Bash tool call never reaches a hook subprocess (only
# SessionStart CLAUDE_ENV_FILE writes do — set-skill-env.sh). The gate was dead
# in production. Arming and counting now come from the session split ledger
# (hook-utils.sh), written by split-size-gate.sh from the real create payload
# and the tool's own per-child status report:
#
#   split-attempted = 1  -> an atomic `create_sub_issues` batch was PERMITTED
#                           by split-size-gate.sh (blocked batches, the
#                           plan-of-plans path, and the single-child
#                           create_issue path deliberately do not set it)
#   split-count     = N  -> children reporting created AND linked AND
#                           edgesWired AND no error in that call (the
#                           full-success conjunction; see split-size-gate.sh)
#   split-parent    = #  -> parentNumber from the create payload (for messaging)
#
# No creation attempt recorded ⇒ nothing to verify ⇒ allow. That is what lets
# the documented graceful no-ops finish: `SPLIT SKIPPED already-atomic`, "no
# natural boundary", "parent already fully split", and `Queue empty.` all stop
# before any create call, so they never arm this gate.
#
# Once armed, a MISSING count is a block, not a pass: "a split was attempted and
# this hook cannot tell how many children it produced" is exactly the state the
# postcondition exists to catch.
#
# Environment (additive / legacy only — never required):
#   RALPH_SUBCOMMAND=epic-split - arms the gate when an operator exports it
#   RALPH_SPLIT_COUNT           - count override when the ledger has none
#   RALPH_TICKET_ID             - parent ticket, for the failure message
#   RALPH_FORCE_STOP            - If "true", allow stop even if postconditions fail
#
# Exit codes:
#   0 - Postconditions met (or out of scope, or escape hatch active)
#   2 - Missing sub-issues / unverifiable count, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

if [[ "${RALPH_COMMAND:-}" != "plan" ]]; then
  allow
fi

read_input > /dev/null
check_stop_hook_active

# Escape hatch. `warn` (hook-utils.sh) prints to stderr and EXITS 0 — it is a
# terminal call, not a fall-through, so control never reaches the block() below.
# Spelled out because "warn then keep going" is the natural reading and would be
# a silent fail-closed if someone ever changed warn() to return.
# Pinned by __tests__/split-hooks-plan-scope.test.sh (RALPH_FORCE_STOP case).
if [[ "${RALPH_FORCE_STOP:-}" == "true" ]]; then
  warn "RALPH_FORCE_STOP=true - bypassing split postcondition check"
fi

# ---- Arming ------------------------------------------------------------------
armed=0
if [[ "$(split_ledger_get attempted)" == "1" ]]; then
  armed=1
elif [[ "${RALPH_SUBCOMMAND:-}" == "epic-split" ]]; then
  armed=1
fi

if [[ "$armed" -eq 0 ]]; then
  allow
fi

ticket_id="${RALPH_TICKET_ID:-}"
if [[ -z "$ticket_id" ]]; then
  parent=$(split_ledger_get parent)
  ticket_id="${parent:+GH-$parent}"
fi
ticket_id="${ticket_id:-<unknown parent>}"

# ---- Count -------------------------------------------------------------------
# Ledger first (recorded by split-size-gate.sh's PostToolUse pass from the
# create_sub_issues per-child status report), env second.
split_count=$(split_ledger_get count)
if [[ -z "$split_count" ]]; then
  split_count="${RALPH_SPLIT_COUNT:-}"
fi

# A non-numeric or absent count must not reach `[[ ... -ge 2 ]]`: under
# `set -euo pipefail` an arithmetic comparison against a non-integer aborts the
# hook with rc=1 (non-blocking) instead of blocking. Validate first (GH-1603 F4).
if [[ ! "$split_count" =~ ^[0-9]+$ ]]; then
  block "Split postcondition failed: sub-issue count could not be verified

Ticket: $ticket_id
Found:  ${split_count:-(no count recorded)}

An atomic create_sub_issues batch was permitted in this session, but no
usable created-count reached this gate — neither the ledger written from the
create_sub_issues response nor RALPH_SPLIT_COUNT. 'Cannot verify' is not
'verified': the /ralph:plan --mode epic atomic-split path must create ≥2
sub-issues before completing (decomposition.md § Atomic split, \"SPLIT <N>\"
requires N ≥ 2).

Recovery options:
  1. Re-run the create_sub_issues call and confirm its response reports
     created + linked + edgesWired (and no error) for at least 2 children.
  2. If the children genuinely exist but were created outside this session,
     re-run with RALPH_FORCE_STOP=true to bypass this check."
fi

if [[ "$split_count" -ge 2 ]]; then
  echo "Split postcondition passed: $split_count sub-issues created for $ticket_id"
  echo "  Parent $ticket_id should remain in Backlog (preserved as epic)"
  allow
fi

block "Split postcondition failed: fewer than 2 sub-issues verified

Ticket: $ticket_id
Expected: At least 2 sub-issues created in one ralph_hero__create_sub_issues
         call (count the children reporting created AND linked AND
         edgesWired AND no error in its per-child status report; a one-child
         split — or a two-child split where one is unlinked/unwired — is a
         re-estimate, not a decomposition)
Found: $split_count

The /ralph:plan --mode epic atomic-split path must create ≥2 sub-issues before
completing — see ralph/skills/plan/decomposition.md § Atomic split (\"SPLIT <N>\"
requires N ≥ 2).
If this is a false positive (sub-issues were created but not tracked),
re-run with RALPH_FORCE_STOP=true to bypass this check."
