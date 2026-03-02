#!/bin/bash
# Create a git worktree for isolated feature development
#
# Usage: ./scripts/create-worktree.sh TICKET-ID [branch-name] [base-branch-override]
#
# Examples:
#   ./scripts/create-worktree.sh GH-42
#   ./scripts/create-worktree.sh GH-42 my-custom-branch
#   ./scripts/create-worktree.sh GH-43 "" feature/GH-42  # Stack on GH-42's branch

set -e

TICKET_ID="${1:?Usage: $0 TICKET_ID [BRANCH_NAME]}"
BRANCH_NAME="${2:-feature/$TICKET_ID}"
BASE_BRANCH_OVERRIDE="${3:-}"

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
git fetch origin "$BRANCH_NAME" 2>/dev/null || true

BASE_BRANCH="origin/main"
if ! git rev-parse --verify "$BASE_BRANCH" &>/dev/null; then
  BASE_BRANCH="origin/master"
  if ! git rev-parse --verify "$BASE_BRANCH" &>/dev/null; then
    echo "Error: Could not find origin/main or origin/master"
    exit 1
  fi
fi

# Apply base branch override if specified (for stacked branches)
if [[ -n "$BASE_BRANCH_OVERRIDE" ]]; then
  echo "Using base branch override: $BASE_BRANCH_OVERRIDE"
  git fetch origin "$BASE_BRANCH_OVERRIDE" 2>/dev/null || true
  if git rev-parse --verify "origin/$BASE_BRANCH_OVERRIDE" &>/dev/null; then
    BASE_BRANCH="origin/$BASE_BRANCH_OVERRIDE"
  elif git rev-parse --verify "$BASE_BRANCH_OVERRIDE" &>/dev/null; then
    BASE_BRANCH="$BASE_BRANCH_OVERRIDE"
  else
    echo "Warning: Base branch override '$BASE_BRANCH_OVERRIDE' not found, using $BASE_BRANCH"
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
  echo "Branch $BRANCH_NAME exists locally, checking out..."
  git worktree add "$WORKTREE_PATH" "$BRANCH_NAME"
elif git show-ref --verify --quiet "refs/remotes/origin/$BRANCH_NAME"; then
  echo "Branch $BRANCH_NAME exists on remote, creating local tracking branch..."
  git worktree add --track -b "$BRANCH_NAME" "$WORKTREE_PATH" "origin/$BRANCH_NAME"
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
echo ""
echo "To remove this worktree:"
echo "  ./scripts/remove-worktree.sh $TICKET_ID"
