#!/bin/bash
# ralph-hero/hooks/scripts/pre-artifact-validator.sh
# PreToolUse: Prevent creation of duplicate artifacts (research docs, plan docs)
#
# Exit codes:
#   0 - Allowed
#   2 - Blocked (artifact already exists)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')

if [[ "$TOOL_NAME" != "Write" ]]; then
  exit 0
fi

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

if [[ ! "$FILE_PATH" =~ thoughts/shared/(research|plans)/ ]]; then
  exit 0
fi

TICKET_ID=$(echo "$FILE_PATH" | grep -oE 'GH-[0-9]+' | head -1)

if [[ -z "$TICKET_ID" ]]; then
  exit 0
fi

if [[ "$FILE_PATH" =~ thoughts/shared/research/ ]]; then
  ARTIFACT_TYPE="research"
  SEARCH_DIR="$PROJECT_ROOT/thoughts/shared/research"
elif [[ "$FILE_PATH" =~ thoughts/shared/plans/ ]]; then
  ARTIFACT_TYPE="plan"
  SEARCH_DIR="$PROJECT_ROOT/thoughts/shared/plans"
else
  exit 0
fi

EXISTING=$(find "$SEARCH_DIR" -maxdepth 1 -name "*$TICKET_ID*" -type f 2>/dev/null | head -1)

if [[ -n "$EXISTING" ]]; then
  cat >&2 <<EOF
A $ARTIFACT_TYPE document for $TICKET_ID already exists:
  $EXISTING

If updating the existing document, use the Edit tool instead of Write.
If this is a different artifact, use a unique filename suffix.
EOF
  exit 2
fi

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "Creating new $ARTIFACT_TYPE document for $TICKET_ID. No existing document found."
  }
}
EOF
exit 0
