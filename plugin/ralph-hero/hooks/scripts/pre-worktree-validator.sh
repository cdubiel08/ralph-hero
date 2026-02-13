#!/bin/bash
# ralph-hero/hooks/scripts/pre-worktree-validator.sh
# PreToolUse: Detect worktree collisions before Bash commands that create worktrees
#
# Exit codes:
#   0 - Allowed (with context about existing worktree if any)
#   2 - Blocked (worktree exists and is in use by another process)

set -e

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
WORKTREE_BASE="$PROJECT_ROOT/../worktrees"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')

if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

if [[ ! "$COMMAND" =~ create-worktree\.sh ]]; then
  exit 0
fi

TICKET_ID=$(echo "$COMMAND" | grep -oE 'GH-[0-9]+' | head -1)

if [[ -z "$TICKET_ID" ]]; then
  exit 0
fi

WORKTREE_PATH="$WORKTREE_BASE/$TICKET_ID"

if [[ -d "$WORKTREE_PATH" ]]; then
  if lsof +D "$WORKTREE_PATH" &>/dev/null; then
    cat >&2 <<EOF
WORKTREE COLLISION DETECTED

Worktree for $TICKET_ID already exists and is IN USE:
  $WORKTREE_PATH

Another process is actively using this worktree.

Actions:
1. Wait for the other process to complete
2. Check if another /ralph-impl or /ralph-hero is running on this ticket
3. If the process is stuck, manually clean up: git worktree remove $WORKTREE_PATH

Do NOT create a new worktree while another process is using it.
EOF
    exit 2
  fi

  CURRENT_BRANCH=$(cd "$WORKTREE_PATH" && git branch --show-current 2>/dev/null || echo "unknown")

  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "Worktree for $TICKET_ID already exists at $WORKTREE_PATH.\nCurrent branch: $CURRENT_BRANCH\n\nRECOMMENDED: Reuse the existing worktree instead of creating a new one.\nChange your command to: cd $WORKTREE_PATH"
  }
}
EOF
  exit 0
fi

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "No existing worktree for $TICKET_ID. Creating new worktree at $WORKTREE_PATH."
  }
}
EOF
exit 0
