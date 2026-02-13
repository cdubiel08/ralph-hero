#!/bin/bash
# ralph-hero/hooks/scripts/research-verify-doc.sh
# PostToolUse (Write): Verify research doc has required structure
#
# Exit codes:
#   0 - Document valid (or not a research doc)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null
file_path=$(get_field '.tool_input.file_path')

if [[ "$file_path" != *"/research/"* ]]; then
  allow
fi

if [[ ! -f "$file_path" ]]; then
  warn "Research document was not written: $file_path"
fi

if ! head -20 "$file_path" | grep -q "^github_issue:"; then
  warn "Research doc missing github_issue in frontmatter"
fi

if ! head -20 "$file_path" | grep -q "^status:"; then
  warn "Research doc missing status in frontmatter"
fi

allow
