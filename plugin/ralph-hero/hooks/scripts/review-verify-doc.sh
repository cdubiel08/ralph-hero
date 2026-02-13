#!/bin/bash
# ralph-hero/hooks/scripts/review-verify-doc.sh
# PostToolUse (Write): Verify critique document was created correctly
#
# Exit codes:
#   0 - Always (warnings only, never blocks)

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
  echo "WARNING: Critique missing 'status' in frontmatter" >&2
fi

if ! head -20 "$file_path" | grep -q "^github_issue:"; then
  echo "WARNING: Critique missing 'github_issue' in frontmatter" >&2
fi

if ! head -20 "$file_path" | grep -q "^type: critique"; then
  echo "WARNING: Critique missing 'type: critique' in frontmatter" >&2
fi

echo "Critique document verified: $file_path"
exit 0
