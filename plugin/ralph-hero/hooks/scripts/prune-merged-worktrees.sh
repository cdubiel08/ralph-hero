#!/bin/bash
# SessionStart hook: prune worktrees whose branches are merged to main
#
# Runs silently on every session start. Removes worktrees that are no longer
# needed because their branches have been merged into main.
#
# Safe: only removes worktrees where the branch is confirmed merged.
# Stacked branches that aren't merged yet are left alone.

set -euo pipefail

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
if [[ -z "$PROJECT_ROOT" ]]; then
  exit 0
fi

WORKTREE_DIR="$PROJECT_ROOT/worktrees"
if [[ ! -d "$WORKTREE_DIR" ]]; then
  exit 0
fi

# Fetch latest main to ensure merge checks are accurate
git fetch origin main --quiet 2>/dev/null || exit 0

pruned=0
for wt_path in "$WORKTREE_DIR"/*/; do
  [[ -d "$wt_path" ]] || continue

  wt_name=$(basename "$wt_path")

  # Get the branch checked out in this worktree
  branch=$(cd "$wt_path" && git branch --show-current 2>/dev/null || echo "")
  [[ -n "$branch" ]] || continue

  # Check if branch is merged into origin/main
  if git merge-base --is-ancestor "$branch" origin/main 2>/dev/null; then
    echo "Pruning merged worktree: $wt_name (branch: $branch)" >&2
    cd "$PROJECT_ROOT"
    git worktree remove "$wt_path" --force 2>/dev/null || {
      rm -rf "$wt_path"
    }
    pruned=$((pruned + 1))
  fi
done

# Clean up stale git worktree metadata
if [[ $pruned -gt 0 ]]; then
  git worktree prune 2>/dev/null || true
  echo "Pruned $pruned stale worktree(s)" >&2
fi

exit 0
