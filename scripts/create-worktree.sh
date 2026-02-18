#!/bin/bash
# Create a git worktree for isolated feature development
#
# Usage: ./scripts/create-worktree.sh TICKET-ID [branch-name]
#
# Examples:
#   ./scripts/create-worktree.sh GH-42
#   ./scripts/create-worktree.sh GH-42 my-custom-branch

set -e

TICKET_ID="${1:?Usage: $0 TICKET_ID [BRANCH_NAME]}"
BRANCH_NAME="${2:-feature/$TICKET_ID}"

# Always resolve from git root to handle being called from any directory
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [[ -z "$PROJECT_ROOT" ]]; then
  echo "Error: Not in a git repository"
  exit 1
fi

WORKTREE_BASE="$PROJECT_ROOT/worktrees"
WORKTREE_PATH="$WORKTREE_BASE/$TICKET_ID"

cd "$PROJECT_ROOT"

mkdir -p "$WORKTREE_BASE"

echo "Fetching latest from origin..."
git fetch origin main 2>/dev/null || git fetch origin master 2>/dev/null || echo "Warning: Could not fetch from origin"

BASE_BRANCH="origin/main"
if ! git rev-parse --verify "$BASE_BRANCH" &>/dev/null; then
  BASE_BRANCH="origin/master"
  if ! git rev-parse --verify "$BASE_BRANCH" &>/dev/null; then
    echo "Error: Could not find origin/main or origin/master"
    exit 1
  fi
fi

if [ -d "$WORKTREE_PATH" ]; then
  echo "Worktree already exists at: $WORKTREE_PATH"
  CURRENT_BRANCH=$(cd "$WORKTREE_PATH" && git branch --show-current 2>/dev/null || echo "unknown")
  echo "Current branch: $CURRENT_BRANCH"
  echo "Use: cd $WORKTREE_PATH"
  exit 0
fi

if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
  echo "Branch $BRANCH_NAME exists, checking out..."
  git worktree add "$WORKTREE_PATH" "$BRANCH_NAME"
else
  echo "Creating new branch $BRANCH_NAME from $BASE_BRANCH..."
  git worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" "$BASE_BRANCH"
fi

echo ""
echo "Worktree created successfully!"
echo "  Path: $WORKTREE_PATH"
echo "  Branch: $BRANCH_NAME"
echo ""
echo "To work in this worktree:"
echo "  cd $WORKTREE_PATH"
