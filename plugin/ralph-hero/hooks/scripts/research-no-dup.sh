#!/bin/bash
# ORPHANED: not registered in any skill frontmatter or hooks.json.
# Overlaps with pre-artifact-validator.sh (registered in hooks.json on Write) which already
# blocks duplicate research docs globally. Do not register both.
# ralph-hero/hooks/scripts/research-no-dup.sh
# PreToolUse (Write): Block if research doc already exists
#
# Exit codes:
#   0 - No duplicate found, allow write
#   2 - Duplicate exists, block with guidance

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null
file_path=$(get_field '.tool_input.file_path')

if [[ "$file_path" != *"/research/"* ]]; then
  allow
fi

ticket_id=$(echo "$file_path" | grep -oE 'GH-[0-9]+' | head -1)
if [[ -z "$ticket_id" ]]; then
  allow
fi

research_dir="$(get_project_root)/thoughts/shared/research"
existing=$(find_existing_artifact "$research_dir" "$ticket_id")

if [[ -n "$existing" ]]; then
  block "Duplicate research document detected

Ticket: $ticket_id
Existing: $existing
Attempted: $file_path

Actions:
1. If updating existing: Use Edit tool instead of Write
2. If this is a retry: Document already created
3. If different scope: Use unique filename suffix"
fi

allow
