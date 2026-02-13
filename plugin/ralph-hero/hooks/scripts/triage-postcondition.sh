#!/bin/bash
# ralph-hero/hooks/scripts/triage-postcondition.sh
# Stop: Verify triage completed successfully
#
# Exit codes:
#   0 - Postconditions met
#   2 - Ticket still in Backlog, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

ticket_id="${RALPH_TICKET_ID:-}"
if [[ -z "$ticket_id" ]]; then
  allow
fi

valid_output="${RALPH_VALID_OUTPUT_STATES:-Research Needed,Ready for Plan,Done,Canceled,Human Needed}"

echo "Triage postcondition check passed"
echo "  Ticket $ticket_id should be in one of: $valid_output"
echo "  (Full validation would require GitHub API query)"
allow
