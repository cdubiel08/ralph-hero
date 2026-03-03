#!/bin/bash
# ralph-hero/hooks/scripts/artifact-comment-validator.sh
# PostToolUse (ralph_hero__create_comment): Validate artifact comment format
#
# Checks that artifact comments with standardized headers include a URL
# on the line immediately after the header.
#
# Exit codes:
#   0 - Valid comment or not an artifact comment
#   2 - Artifact comment missing URL, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Extract comment body from tool input
body=$(get_field '.tool_input.body')
if [[ -z "$body" ]]; then
  allow
fi

# Artifact headers that require a URL on the following line
artifact_headers=(
  "## Research Document"
  "## Implementation Plan"
  "## Plan Critique"
)

for header in "${artifact_headers[@]}"; do
  if echo "$body" | grep -qF "$header"; then
    # Check that a URL appears within 3 lines after the header
    url_line=$(echo "$body" | grep -A3 -F "$header" | grep -E "^https?://" | head -1)
    if [[ -z "$url_line" ]]; then
      block "Artifact comment missing URL after header

Header: '${header}'
Expected: A URL (https://...) within 3 lines after the header
Found: None

Artifact comments must follow the Artifact Comment Protocol:

  ${header}

  https://github.com/OWNER/REPO/blob/main/thoughts/shared/...

See specs/artifact-metadata.md for the required format."
    fi
  fi
done

allow
