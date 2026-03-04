#!/bin/bash
# ralph-hero/hooks/scripts/plan-postcondition.sh
# Stop: Verify plan completed successfully
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

plans_dir="$(get_project_root)/thoughts/shared/plans"
doc=$(find "$plans_dir" -name "*${ticket_id}*" -type f -mmin -30 2>/dev/null | head -1)

if [[ -z "$doc" ]]; then
  block "Plan postcondition failed

Expected: Plan document for $ticket_id
Found: None in $plans_dir

The plan command must create a plan document.
Check the command output for errors."
fi

if ! git log --oneline -1 --all -- "$doc" 2>/dev/null | grep -q .; then
  warn "Plan doc exists but may not be committed: $doc"
fi

# Check for artifact comment marker (Gap 3: discovery sequence)
marker_dir="/tmp/ralph-artifact-markers"
issue_number=$(echo "$ticket_id" | grep -oE '[0-9]+' | head -1)
if [[ -n "$issue_number" ]] && [[ ! -f "$marker_dir/artifact-comment-${issue_number}" ]]; then
  echo "WARNING: Artifact comment marker absent for #${issue_number} — '## Implementation Plan' comment may not have been posted." >&2
fi

echo "Plan postcondition passed: $doc"
allow
