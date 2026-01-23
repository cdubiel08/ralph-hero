#!/bin/bash
# Remove a git worktree
#
# Usage: ./scripts/remove-worktree.sh TICKET-ID

set -e

TICKET_ID="${1:?Usage: $0 TICKET_ID}"

# Load worktree base from config or use default
if [ -f ".ralph/config.json" ] && command -v jq &> /dev/null; then
    WORKTREE_BASE=$(jq -r '.paths.worktreeBase // "../worktrees"' .ralph/config.json)
else
    WORKTREE_BASE="../worktrees"
fi

WORKTREE_PATH="$WORKTREE_BASE/$TICKET_ID"

if [ -d "$WORKTREE_PATH" ]; then
    git worktree remove "$WORKTREE_PATH"
    echo "Removed worktree: $WORKTREE_PATH"
else
    echo "Worktree not found: $WORKTREE_PATH"
    exit 1
fi
