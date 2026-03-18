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

# Check 1: Direct plan
plan_doc=$(find_existing_artifact "$plans_dir" "$ticket_id")

# Check 2: Group plan
if [[ -z "$plan_doc" ]]; then
  plan_doc=$(find "$plans_dir" -name "*group*${ticket_id}*" -type f 2>/dev/null | head -1)
fi

# Check 3: Stream plan
if [[ -z "$plan_doc" ]]; then
  plan_doc=$(find "$plans_dir" -name "*stream*${ticket_id}*" -type f 2>/dev/null | head -1)
fi

# Check 4: Plan Reference (parent-planned atomic issue)
if [[ -z "$plan_doc" ]]; then
  plan_ref="${RALPH_PLAN_REFERENCE:-}"
  if [[ -n "$plan_ref" ]]; then
    local_path=$(echo "$plan_ref" | sed 's|https://github.com/[^/]*/[^/]*/blob/main/||')
    if [[ -f "$(get_project_root)/$local_path" ]]; then
      plan_doc="$(get_project_root)/$local_path"
    fi
  fi
fi

if [[ -z "$plan_doc" ]]; then
  block "Plan required before implementation

Ticket: $ticket_id
Expected: Plan document in $plans_dir or ## Plan Reference comment
Found: None

Implementation requires an approved plan document.
Run /ralph-plan $ticket_id first, or verify ## Plan Reference exists on the issue."
fi

allow_with_context "Plan document found: $plan_doc"
