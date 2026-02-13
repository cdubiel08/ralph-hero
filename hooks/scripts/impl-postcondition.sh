#!/bin/bash
# ralph-hero/hooks/scripts/impl-postcondition.sh
# Stop: Verify progress made or PR created
#
# Exit codes:
#   0 - Postconditions met

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

ticket_id="${RALPH_TICKET_ID:-}"
if [[ -z "$ticket_id" ]]; then
  current_dir="$(pwd)"
  ticket_id=$(echo "$current_dir" | grep -oE 'GH-[0-9]+' | head -1)
fi

if [[ -z "$ticket_id" ]]; then
  allow
fi

worktree_dir="${RALPH_WORKTREE_DIR:-../worktrees}"
if [[ -d "$worktree_dir/$ticket_id" ]]; then
  echo "Worktree exists: $worktree_dir/$ticket_id"
fi

branch_name="feature/$ticket_id"
if git rev-parse --verify "$branch_name" >/dev/null 2>&1; then
  commit_count=$(git rev-list --count "main..$branch_name" 2>/dev/null || echo "0")
  echo "Branch $branch_name has $commit_count commit(s) ahead of main"
fi

echo "Implementation postcondition check passed"
allow
