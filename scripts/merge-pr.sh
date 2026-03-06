#!/bin/bash
# Merge a PR with deterministic worktree cleanup
#
# Usage: ./scripts/merge-pr.sh PR_NUMBER [WORKTREE_ID]
#
# Removes the associated worktree BEFORE merging so --delete-branch succeeds.
# WORKTREE_ID defaults to GH-$PR_NUMBER. Pass explicitly for group/epic worktrees.

set -euo pipefail

PR_NUMBER="${1:?Usage: $0 PR_NUMBER [WORKTREE_ID]}"
WORKTREE_ID="${2:-}"

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [[ -z "$PROJECT_ROOT" ]]; then
  echo "Error: Not in a git repository" >&2
  exit 1
fi

# Determine worktree ID from PR's head branch if not provided
if [[ -z "$WORKTREE_ID" ]]; then
  HEAD_BRANCH=$(gh pr view "$PR_NUMBER" --json headRefName --jq '.headRefName' 2>/dev/null || echo "")
  if [[ "$HEAD_BRANCH" == feature/GH-* ]]; then
    WORKTREE_ID="${HEAD_BRANCH#feature/}"
  fi
fi

# Step 1: Remove worktree (if it exists)
if [[ -n "$WORKTREE_ID" ]]; then
  WORKTREE_PATH="$PROJECT_ROOT/worktrees/$WORKTREE_ID"
  if [[ -d "$WORKTREE_PATH" ]]; then
    echo "Removing worktree: $WORKTREE_PATH"
    cd "$PROJECT_ROOT"
    git worktree remove "$WORKTREE_PATH" --force 2>/dev/null || {
      echo "Warning: git worktree remove failed, forcing cleanup" >&2
      rm -rf "$WORKTREE_PATH"
      git worktree prune
    }
    echo "Worktree removed: $WORKTREE_ID"
  fi
fi

# Step 2: Merge PR with branch deletion
echo "Merging PR #$PR_NUMBER..."
gh pr merge "$PR_NUMBER" --merge --delete-branch

echo "PR #$PR_NUMBER merged successfully."
