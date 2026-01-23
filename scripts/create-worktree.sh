#!/bin/bash
# Create a git worktree for isolated feature development
#
# Usage: ./scripts/create-worktree.sh TICKET-ID [branch-name]
#
# Creates a worktree at [WORKTREE_BASE]/TICKET-ID/

set -e

TICKET_ID="${1:?Usage: $0 TICKET_ID [BRANCH_NAME]}"
BRANCH_NAME="${2:-feature/$TICKET_ID}"

# Load worktree base from config or use default
if [ -f ".ralph/config.json" ] && command -v jq &> /dev/null; then
    WORKTREE_BASE=$(jq -r '.paths.worktreeBase // "../worktrees"' .ralph/config.json)
else
    WORKTREE_BASE="../worktrees"
fi

WORKTREE_PATH="$WORKTREE_BASE/$TICKET_ID"

# Ensure we're in the repo root
cd "$(git rev-parse --show-toplevel)"

# Create worktree directory
mkdir -p "$WORKTREE_BASE"

# Fetch latest main
git fetch origin main

# Check if branch exists
if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
    echo "Branch $BRANCH_NAME exists, checking out..."
    git worktree add "$WORKTREE_PATH" "$BRANCH_NAME"
else
    echo "Creating new branch $BRANCH_NAME from origin/main..."
    git worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" origin/main
fi

echo ""
echo "Worktree created at: $WORKTREE_PATH"
echo "Branch: $BRANCH_NAME"
echo ""
echo "To work in this worktree:"
echo "  cd $WORKTREE_PATH"
echo ""
echo "To remove when done:"
echo "  ./scripts/remove-worktree.sh $TICKET_ID"
