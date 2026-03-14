#!/bin/bash
# ralph-hero/hooks/scripts/superpowers-bridge.sh
# PostToolUse: Detect superpowers artifacts and suggest ralph-hero integration
#
# When a file is written to docs/superpowers/{specs,plans}/, inject advisory
# context with the equivalent ralph-hero path and frontmatter template.
#
# Non-blocking — purely advisory. Superpowers artifacts are left in place.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"

read_input > /dev/null

TOOL_NAME=$(get_tool_name)
[[ "$TOOL_NAME" == "Write" ]] || exit 0

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
  STATUS="draft"
  FRONTMATTER="---\ndate: ${DATE_PART}\nstatus: ${STATUS}\ntype: plan\ntags: []\n# github_issue: NNN        # add when linking to an issue\n# github_issues: [NNN]\n# primary_issue: NNN\n---"
else
  STATUS="complete"
  FRONTMATTER="---\ndate: ${DATE_PART}\nstatus: ${STATUS}\ntype: research\ntags: []\n# github_issue: NNN        # add when linking to an issue\n---"
fi

CONTEXT="SUPERPOWERS BRIDGE: A superpowers ${ARTIFACT_TYPE} artifact was saved to ${FILE_PATH}.\\n\\nTo integrate with ralph-hero project management:\\n1. Save a copy to: ${RALPH_PATH}\\n2. Add this frontmatter at the top:\\n${FRONTMATTER}\\n3. Optionally link to a GitHub issue with: ralph_hero__create_comment(number=NNN, body=\\\"## Implementation Plan\\\\n\\\\nhttps://github.com/\${RALPH_GH_OWNER}/\${RALPH_GH_REPO}/blob/main/${RALPH_PATH}\\\")\\n\\nOr use /ralph-hero:bridge-artifact ${FILE_PATH} to migrate automatically."

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "${CONTEXT}"
  }
}
EOF
exit 0
