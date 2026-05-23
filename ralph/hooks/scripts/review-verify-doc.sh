#!/bin/bash
# ralph-hero/hooks/scripts/review-verify-doc.sh
# PostToolUse (Write): Verify critique document was created correctly
#
# Exit codes:
#   0 - Verified OK
#   2 - Missing frontmatter fields, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

file_path=$(get_field '.tool_input.file_path')

if [[ ! "$file_path" =~ thoughts/shared/reviews/ ]]; then
  exit 0
fi

if [[ ! -f "$file_path" ]]; then
  echo "WARNING: Critique file not found at $file_path" >&2
  exit 0
fi

if ! head -20 "$file_path" | grep -q "^status:"; then
  block "Critique missing 'status' in frontmatter: $file_path"
fi

if ! head -20 "$file_path" | grep -q "^github_issue:"; then
  block "Critique missing 'github_issue' in frontmatter: $file_path"
fi

if ! head -20 "$file_path" | grep -q "^type: review"; then
  block "Review document missing 'type: review' in frontmatter: $file_path"
fi

echo "Critique document verified: $file_path"
exit 0
