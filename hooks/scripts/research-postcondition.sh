#!/bin/bash
# ralph-hero/hooks/scripts/research-postcondition.sh
# Stop: Verify research completed successfully
#
# Exit codes:
#   0 - Postconditions met
#   2 - Postconditions failed, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

ticket_id="${RALPH_TICKET_ID:-}"
if [[ -z "$ticket_id" ]]; then
  allow
fi

research_dir="$(get_project_root)/thoughts/shared/research"
doc=$(find "$research_dir" -name "*${ticket_id}*" -type f -mmin -30 2>/dev/null | head -1)

if [[ -z "$doc" ]]; then
  block "Research postcondition failed

Expected: Research document for $ticket_id
Found: None in $research_dir

The research command must create a research document.
Check the command output for errors."
fi

if ! git log --oneline -1 --all -- "$doc" 2>/dev/null | grep -q .; then
  warn "Research doc exists but may not be committed: $doc"
fi

echo "Research postcondition passed: $doc"
allow
