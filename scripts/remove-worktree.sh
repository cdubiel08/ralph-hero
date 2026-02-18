#!/bin/bash
# Remove a git worktree
#
# Usage: ./scripts/remove-worktree.sh TICKET-ID

set -e

TICKET_ID="${1:?Usage: $0 TICKET_ID}"

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [[ -z "$PROJECT_ROOT" ]]; then
  echo "Error: Not in a git repository"
  exit 1
fi

WORKTREE_PATH="$PROJECT_ROOT/worktrees/$TICKET_ID"

if [ ! -d "$WORKTREE_PATH" ]; then
  echo "No worktree found at: $WORKTREE_PATH"
  exit 0
fi

cd "$PROJECT_ROOT"

echo "Removing worktree: $WORKTREE_PATH"
git worktree remove "$WORKTREE_PATH" --force
echo "Worktree removed: $TICKET_ID"
