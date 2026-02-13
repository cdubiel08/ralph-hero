#!/bin/bash
# ralph-hero/hooks/scripts/plan-research-required.sh
# PreToolUse (Write): Block plan creation if no research doc
#
# Environment:
#   RALPH_REQUIRES_RESEARCH - Whether research is required (default: true)
#
# Exit codes:
#   0 - Research exists or not required
#   2 - Research missing, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null
file_path=$(get_field '.tool_input.file_path')

if [[ "$file_path" != *"/plans/"* ]]; then
  allow
fi

if [[ "${RALPH_REQUIRES_RESEARCH:-true}" != "true" ]]; then
  allow
fi

ticket_id=$(echo "$file_path" | grep -oE 'GH-[0-9]+' | head -1)
if [[ -z "$ticket_id" ]]; then
  allow
fi

research_dir="$(get_project_root)/thoughts/shared/research"
research_doc=$(find_existing_artifact "$research_dir" "$ticket_id")

if [[ -z "$research_doc" ]]; then
  block "Research required before planning

Ticket: $ticket_id
Expected: Research document in $research_dir
Found: None

The planning command requires a research document.
Run /ralph-research $ticket_id first."
fi

allow
