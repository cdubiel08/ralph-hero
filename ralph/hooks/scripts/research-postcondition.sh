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
# Session-scoped discovery first (artifact-write-tracker.sh): immune to
# concurrent sessions writing the same ticket's docs and to sessions that
# outlive a freshness window. find_fresh_artifact is the fallback for docs
# written where the tracker wasn't registered.
doc=$(session_artifacts "thoughts/shared/research" "$ticket_id" | tail -1)
if [[ -z "$doc" ]]; then
  doc=$(find_fresh_artifact "$research_dir" "$ticket_id" 30)
fi

if [[ -z "$doc" ]]; then
  block "Research postcondition failed

Expected: Research document for $ticket_id
Found: None in $research_dir

The research command must create a research document.
Check the command output for errors."
fi

if ! grep -q "## Files Affected" "$doc"; then
  block "Research postcondition failed

Expected: '## Files Affected' section in research document
Found: Section missing in $doc

The research document must include a '## Files Affected' section with
'### Will Modify' and '### Will Read (Dependencies)' subsections.
See the research skill SKILL.md for the required format."
fi

if ! git log --oneline -1 --all -- "$doc" 2>/dev/null | grep -q .; then
  warn "Research doc exists but may not be committed: $doc"
fi

echo "Research postcondition passed: $doc"
allow
