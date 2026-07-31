#!/usr/bin/env bash
# funnel-board — courtesy rail (PreToolUse on Bash): raw board mutations get
# redirected to board.ts. NOT enforcement — board.ts invariants + state-guard
# are the guarantees; this just keeps honest sessions on the sanctioned path.
set -euo pipefail

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$CMD" ] || exit 0

BLOCKED_PATTERNS=(
  'gh project item-edit'
  'gh project item-add'
  'gh project item-archive'
  'gh project item-delete'
  'updateProjectV2ItemFieldValue'
  'clearProjectV2ItemFieldValue'
  'addProjectV2ItemById'
  'addSubIssue'
  'removeSubIssue'
  'addBlockedBy'
  'removeBlockedBy'
)

for p in "${BLOCKED_PATTERNS[@]}"; do
  if [[ "$CMD" == *"$p"* && "$CMD" != *"ralph/scripts/board"* ]]; then
    echo "Board mutations go through the CLI: ralph/scripts/board <cmd> (run 'ralph/scripts/board help')." >&2
    exit 2
  fi
done
exit 0
