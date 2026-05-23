#!/bin/bash
# ralph/hooks/scripts/split-postcondition.sh
# Stop: Verify /ralph:caretake --mode split created ≥2 sub-issues.
#
# Plan 6 hardening: scope-guarded (caretake + split).
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

if [[ "${RALPH_COMMAND:-}" != "caretake" ]]; then
  allow
fi
if [[ "${RALPH_SUBCOMMAND:-}" != "split" ]]; then
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
Expected: At least 2 sub-issues created via ralph_hero__add_sub_issue
         (a one-child split is a re-estimate, not a decomposition)
Found: RALPH_SPLIT_COUNT=${split_count}

The /ralph:caretake --mode split body must create ≥2 sub-issues before
completing — see ralph/skills/caretake/outcome-tokens.md (\"SPLIT <N>\" requires
N ≥ 2) and ralph/skills/caretake/split-decomposition.md.
If this is a false positive (sub-issues were created but not tracked),
re-run with RALPH_FORCE_STOP=true to bypass this check."
