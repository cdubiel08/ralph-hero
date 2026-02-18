#!/bin/bash
# ORPHANED: not registered in any skill frontmatter or hooks.json.
# Created for PostToolUse (Write) in ralph-plan but never wired up.
# ralph-hero/hooks/scripts/plan-verify-doc.sh
# PostToolUse (Write): Verify plan has phases and success criteria
#
# Exit codes:
#   0 - Document valid (or not a plan doc)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null
file_path=$(get_field '.tool_input.file_path')

if [[ "$file_path" != *"/plans/"* ]]; then
  allow
fi

if [[ ! -f "$file_path" ]]; then
  warn "Plan document was not written: $file_path"
fi

if ! grep -q "## Phase" "$file_path" 2>/dev/null; then
  warn "Plan doc missing phase sections (## Phase N:)"
fi

if ! grep -q "Success Criteria" "$file_path" 2>/dev/null; then
  warn "Plan doc missing Success Criteria section"
fi

if ! head -20 "$file_path" | grep -q "^status:"; then
  warn "Plan doc missing status in frontmatter"
fi

allow
