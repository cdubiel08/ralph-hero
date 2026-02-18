#!/bin/bash
# ralph-hero/hooks/scripts/pre-worktree-validator.sh
# PreToolUse: Detect worktree collisions before Bash commands that create worktrees
#
# Exit codes:
#   0 - Allowed (with context about existing worktree if any)
#   2 - Blocked (worktree exists and is in use by another process)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

TOOL_NAME=$(get_field '.tool_name')

if [[ "$TOOL_NAME" != "Bash" ]]; then
  allow
fi

COMMAND=$(get_field '.tool_input.command')

if [[ ! "$COMMAND" =~ create-worktree\.sh ]]; then
  allow
fi

TICKET_ID=$(echo "$COMMAND" | grep -oE 'GH-[0-9]+' | head -1)

if [[ -z "$TICKET_ID" ]]; then
  allow
fi

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
WORKTREE_BASE="$PROJECT_ROOT/worktrees"
WORKTREE_PATH="$WORKTREE_BASE/$TICKET_ID"

if [[ -d "$WORKTREE_PATH" ]]; then
  if lsof +D "$WORKTREE_PATH" &>/dev/null; then
    block "WORKTREE COLLISION DETECTED

Worktree for $TICKET_ID already exists and is IN USE:
  $WORKTREE_PATH

Another process is actively using this worktree.

Actions:
1. Wait for the other process to complete
2. Check if another /ralph-impl or /ralph-hero is running on this ticket
3. If the process is stuck, manually clean up: git worktree remove $WORKTREE_PATH

Do NOT create a new worktree while another process is using it."
  fi

  CURRENT_BRANCH=$(cd "$WORKTREE_PATH" && git branch --show-current 2>/dev/null || echo "unknown")

  allow_with_context "Worktree for $TICKET_ID already exists at $WORKTREE_PATH. Current branch: $CURRENT_BRANCH. RECOMMENDED: Reuse the existing worktree instead of creating a new one. Change your command to: cd $WORKTREE_PATH"
fi

allow_with_context "No existing worktree for $TICKET_ID. Creating new worktree at $WORKTREE_PATH."
