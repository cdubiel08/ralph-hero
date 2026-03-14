#!/bin/bash
# ralph-hero/hooks/scripts/superpowers-bridge.sh
# PostToolUse: Detect superpowers artifacts and suggest ralph-hero integration
#
# When a file is written to docs/superpowers/{specs,plans}/, inject advisory
# context with the equivalent ralph-hero path and frontmatter template.
#
# Non-blocking — purely advisory. Superpowers artifacts are left in place.

set -euo pipefail

# Skip entirely if superpowers bridge is not active (set by SessionStart hook)
[[ "${RALPH_SUPERPOWERS_BRIDGE:-}" == "true" ]] || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"

read_input > /dev/null

# Check that the write actually succeeded before advising
EXIT_CODE=$(echo "$RALPH_HOOK_INPUT" | jq -r '.tool_response.exitCode // 0')
[[ "$EXIT_CODE" == "0" ]] || exit 0

FILE_PATH=$(echo "$RALPH_HOOK_INPUT" | jq -r '.tool_input.file_path // ""')

# Only act on superpowers artifact paths
case "$FILE_PATH" in
  *docs/superpowers/specs/*)
    ARTIFACT_TYPE="research"
    RALPH_DIR="thoughts/shared/research"
    ;;
  *docs/superpowers/plans/*)
    ARTIFACT_TYPE="plan"
    RALPH_DIR="thoughts/shared/plans"
    ;;
  *)
    exit 0
    ;;
esac

# Extract date and description from superpowers filename
# Pattern: YYYY-MM-DD-<description>-design.md or YYYY-MM-DD-<description>.md
BASENAME=$(basename "$FILE_PATH" .md)
DATE_PART=$(echo "$BASENAME" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}' || echo "$(date +%Y-%m-%d)")
DESC_PART=$(echo "$BASENAME" | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}-//' | sed 's/-design$//')

RALPH_FILENAME="${DATE_PART}-${DESC_PART}.md"
RALPH_PATH="${RALPH_DIR}/${RALPH_FILENAME}"

# Build frontmatter template
if [[ "$ARTIFACT_TYPE" == "plan" ]]; then
  FRONTMATTER="---
date: ${DATE_PART}
status: draft
type: plan
tags: []
# github_issue: NNN        # add when linking to an issue
# github_issues: [NNN]
# primary_issue: NNN
---"
else
  FRONTMATTER="---
date: ${DATE_PART}
status: complete
type: research
tags: []
# github_issue: NNN        # add when linking to an issue
---"
fi

# Build advisory context using jq for safe JSON construction
CONTEXT=$(jq -n \
  --arg type "$ARTIFACT_TYPE" \
  --arg src "$FILE_PATH" \
  --arg dst "$RALPH_PATH" \
  --arg fm "$FRONTMATTER" \
  '"SUPERPOWERS BRIDGE: A superpowers " + $type + " artifact was saved to " + $src + ".\n\nTo integrate with ralph-hero project management:\n1. Save a copy to: " + $dst + "\n2. Add this frontmatter at the top:\n" + $fm + "\n3. Optionally link to a GitHub issue with: ralph_hero__create_comment(number=NNN, ...)\n\nOr use /ralph-hero:bridge-artifact " + $src + " to migrate automatically."')

# Output JSON with jq-constructed context (already a JSON string with quotes)
jq -n --argjson ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $ctx
  }
}'
exit 0
