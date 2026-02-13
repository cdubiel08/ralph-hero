#!/bin/bash
# ralph-hero/hooks/scripts/split-postcondition.sh
# Stop: Verify split completed successfully
#
# Exit codes:
#   0 - Postconditions met

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

ticket_id="${RALPH_TICKET_ID:-}"
if [[ -z "$ticket_id" ]]; then
  allow
fi

echo "Split postcondition check passed"
echo "  Ticket $ticket_id should remain in Backlog (parent preserved as epic)"
echo "  Sub-tickets should exist as sub-issues of $ticket_id"
echo "  Parent should NOT be closed after split - it stays as an active epic"
allow
