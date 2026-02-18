#!/bin/bash
# ralph-hero/hooks/scripts/impl-postcondition.sh
# Stop: Verify implementation made progress in a worktree
#
# Exit codes:
#   0 - Postconditions met (work done in worktree)
#   2 - No worktree work detected (blocks session end)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Only enforce for impl command
if [[ "${RALPH_COMMAND:-}" != "impl" ]]; then
  allow
fi

ticket_id="${RALPH_TICKET_ID:-}"
if [[ -z "$ticket_id" ]]; then
  current_dir="$(pwd)"
  ticket_id=$(echo "$current_dir" | grep -oE 'GH-[0-9]+' | head -1)
fi

# If we can't determine the ticket, allow (may be early exit)
if [[ -z "$ticket_id" ]]; then
  allow
fi

# Resolve the main repo root (works correctly inside worktrees)
GIT_COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "")
if [[ -n "$GIT_COMMON_DIR" && "$GIT_COMMON_DIR" != ".git" ]]; then
  PROJECT_ROOT=$(dirname "$GIT_COMMON_DIR")
else
  PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "$(pwd)")
fi

worktree_path="$PROJECT_ROOT/worktrees/$ticket_id"

if [[ ! -d "$worktree_path" ]]; then
  block "Implementation postcondition failed: No worktree found

Expected worktree at: $worktree_path
Ticket: $ticket_id

Implementation must create and work in a worktree.
Run: ./scripts/create-worktree.sh $ticket_id"
fi

# Check that the feature branch has commits ahead of main
branch_name="feature/$ticket_id"
if git -C "$worktree_path" rev-parse --verify "$branch_name" >/dev/null 2>&1; then
  commit_count=$(git -C "$worktree_path" rev-list --count "main..$branch_name" 2>/dev/null || echo "0")
  if [[ "$commit_count" == "0" ]]; then
    warn "Worktree exists but branch $branch_name has no commits ahead of main. Phase may not have completed."
  else
    echo "Implementation postcondition passed: $commit_count commit(s) on $branch_name"
  fi
fi

allow
