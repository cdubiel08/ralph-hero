#!/bin/bash
# ralph-hero/hooks/scripts/review-no-dup.sh
# PreToolUse (Write): Prevent duplicate critique documents
#
# Exit codes:
#   0 - No duplicate, allow
#   2 - Duplicate exists, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

file_path=$(get_field '.tool_input.file_path')

if [[ ! "$file_path" =~ thoughts/shared/reviews/ ]]; then
  allow
fi

ticket_id=$(echo "$file_path" | grep -oE 'GH-[0-9]+' | head -1)

if [[ -z "$ticket_id" ]]; then
  allow
fi

project_root=$(get_project_root)
existing=$(find "$project_root/thoughts/shared/reviews" -name "*${ticket_id}*" -type f 2>/dev/null | head -1)

if [[ -n "$existing" ]]; then
  block "DUPLICATE CRITIQUE BLOCKED

A critique document for $ticket_id already exists:
  $existing

Actions:
1. If updating existing critique: Use Edit tool instead of Write
2. If re-reviewing: Delete existing critique first
3. If different review: Use unique filename suffix"
fi

allow_with_context "No existing critique for $ticket_id. Proceeding with creation."
