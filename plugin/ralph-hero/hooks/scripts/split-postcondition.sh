#!/bin/bash
# ralph-hero/hooks/scripts/split-postcondition.sh
# Stop: Verify split completed successfully
#
# Checks that sub-issues were actually created for the parent ticket.
#
# Environment:
#   RALPH_TICKET_ID - Parent ticket being split
#   RALPH_SPLIT_COUNT - Number of sub-issues created (set by skill)
#   RALPH_FORCE_STOP - If "true", allow stop even if postconditions fail (escape hatch)
#
# Exit codes:
#   0 - Postconditions met (or escape hatch active)
#   2 - Missing sub-issues, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Escape hatch to prevent infinite loops
if [[ "${RALPH_FORCE_STOP:-}" == "true" ]]; then
  warn "RALPH_FORCE_STOP=true - bypassing split postcondition check"
fi

ticket_id="${RALPH_TICKET_ID:-}"
if [[ -z "$ticket_id" ]]; then
  allow
fi

# Check if the skill recorded its split count
split_count="${RALPH_SPLIT_COUNT:-0}"

if [[ "$split_count" -gt 0 ]]; then
  echo "Split postcondition passed: $split_count sub-issues created for $ticket_id"
  echo "  Parent $ticket_id should remain in Backlog (preserved as epic)"
  allow
fi

# No sub-issues verified - block
block "Split postcondition failed: no sub-issues verified

Ticket: $ticket_id
Expected: At least 1 sub-issue created via ralph_hero__add_sub_issue
Found: RALPH_SPLIT_COUNT=${split_count}

The split skill must create sub-issues before completing.
If this is a false positive (sub-issues were created but not tracked),
re-run with RALPH_FORCE_STOP=true to bypass this check."
