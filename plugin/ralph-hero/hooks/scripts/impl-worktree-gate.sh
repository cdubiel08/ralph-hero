#!/bin/bash
# ralph-hero/hooks/scripts/impl-worktree-gate.sh
# PreToolUse (Write|Edit): Warn if not in worktree
#
# Environment:
#   RALPH_WORKTREE_DIR - Expected worktree directory (default: ../worktrees)
#
# Exit codes:
#   0 - Always allows (warnings only)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null
file_path=$(get_field '.tool_input.file_path')

# Skip checks for non-code files
if [[ "$file_path" == *"/thoughts/"* ]] || [[ "$file_path" == *"/docs/"* ]]; then
  allow
fi

worktree_dir="${RALPH_WORKTREE_DIR:-../worktrees}"
current_dir="$(pwd)"

if [[ "$current_dir" != *"worktrees"* ]] && [[ "$current_dir" != *"$worktree_dir"* ]]; then
  warn "Implementation should run in worktree

Current: $current_dir
Expected: Inside $worktree_dir/GH-NNN/

Worktrees provide isolation for implementation.
Consider running: ./scripts/create-worktree.sh GH-NNN"
fi

allow
