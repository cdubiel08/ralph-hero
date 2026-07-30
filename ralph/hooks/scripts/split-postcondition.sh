#!/bin/bash
# ralph/hooks/scripts/split-postcondition.sh
# Stop: Verify /ralph:plan --mode epic's atomic-split path (GH-1605; formerly
# caretake's split mode) created ≥2 sub-issues.
#
# GH-1605: scope-guarded (plan + epic-split — the atomic-split re-export from
# decomposition.md § Atomic split; a pure plan-of-plans session stays at the
# Step 0 `epic` value and early-exits here, so it can never be blocked by
# this postcondition).
#
# Environment:
#   RALPH_TICKET_ID   - Parent ticket being split
#   RALPH_SPLIT_COUNT - Number of sub-issues created (set by mode body)
#   RALPH_FORCE_STOP  - If "true", allow stop even if postconditions fail
#
# Exit codes:
#   0 - Postconditions met (or out of scope, or escape hatch active)
#   2 - Missing sub-issues, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

if [[ "${RALPH_COMMAND:-}" != "plan" ]]; then
  allow
fi
if [[ "${RALPH_SUBCOMMAND:-}" != "epic-split" ]]; then
  allow
fi

read_input > /dev/null
check_stop_hook_active

if [[ "${RALPH_FORCE_STOP:-}" == "true" ]]; then
  warn "RALPH_FORCE_STOP=true - bypassing split postcondition check"
fi

ticket_id="${RALPH_TICKET_ID:-}"
if [[ -z "$ticket_id" ]]; then
  allow
fi

split_count="${RALPH_SPLIT_COUNT:-0}"

if [[ "$split_count" -ge 2 ]]; then
  echo "Split postcondition passed: $split_count sub-issues created for $ticket_id"
  echo "  Parent $ticket_id should remain in Backlog (preserved as epic)"
  allow
fi

block "Split postcondition failed: fewer than 2 sub-issues verified

Ticket: $ticket_id
Expected: At least 2 sub-issues created in one ralph_hero__create_sub_issues
         call (count the children reporting created:true in its per-child
         status report; a one-child split is a re-estimate, not a decomposition)
Found: RALPH_SPLIT_COUNT=${split_count}

The /ralph:plan --mode epic atomic-split path must create ≥2 sub-issues before
completing — see ralph/skills/plan/decomposition.md § Atomic split (\"SPLIT <N>\"
requires N ≥ 2).
If this is a false positive (sub-issues were created but not tracked),
re-run with RALPH_FORCE_STOP=true to bypass this check."
