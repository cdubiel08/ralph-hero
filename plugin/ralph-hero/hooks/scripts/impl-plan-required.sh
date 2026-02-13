#!/bin/bash
# ralph-hero/hooks/scripts/impl-plan-required.sh
# PreToolUse (Write|Edit): Block if no plan doc attached
#
# Environment:
#   RALPH_REQUIRES_PLAN - Whether plan is required (default: true)
#
# Exit codes:
#   0 - Plan exists or not required
#   2 - Plan missing, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null
file_path=$(get_field '.tool_input.file_path')

# Skip checks for non-code files
if [[ "$file_path" == *"/thoughts/"* ]] || [[ "$file_path" == *"/docs/"* ]]; then
  allow
fi

if [[ "${RALPH_REQUIRES_PLAN:-true}" != "true" ]]; then
  allow
fi

ticket_id="${RALPH_TICKET_ID:-}"
if [[ -z "$ticket_id" ]]; then
  current_dir="$(pwd)"
  ticket_id=$(echo "$current_dir" | grep -oE 'GH-[0-9]+' | head -1)
fi

if [[ -z "$ticket_id" ]]; then
  allow  # Can't validate without ticket ID
fi

plans_dir="$(get_project_root)/thoughts/shared/plans"
plan_doc=$(find_existing_artifact "$plans_dir" "$ticket_id")

if [[ -z "$plan_doc" ]]; then
  block "Plan required before implementation

Ticket: $ticket_id
Expected: Plan document in $plans_dir
Found: None

Implementation requires an approved plan document.
Run /ralph-plan $ticket_id first."
fi

allow_with_context "Plan document found: $plan_doc"
