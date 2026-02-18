#!/bin/bash
# ralph-hero/hooks/scripts/impl-worktree-gate.sh
# PreToolUse (Write|Edit): Block writes outside worktree during implementation
#
# Environment:
#   RALPH_COMMAND - Current command (only enforced for "impl")
#
# Exit codes:
#   0 - Allowed (in worktree or non-impl command)
#   2 - Blocked (impl writes outside worktree)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Only enforce for impl command
if [[ "${RALPH_COMMAND:-}" != "impl" ]]; then
  allow
fi

file_path=$(get_field '.tool_input.file_path')

# Allow writes to thoughts/ and docs/ (research artifacts go on main)
if [[ "$file_path" == *"/thoughts/"* ]] || [[ "$file_path" == *"/docs/"* ]]; then
  allow
fi

# Resolve the main repo root (works correctly inside worktrees)
GIT_COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "")
if [[ -n "$GIT_COMMON_DIR" && "$GIT_COMMON_DIR" != ".git" ]]; then
  PROJECT_ROOT=$(dirname "$GIT_COMMON_DIR")
else
  PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "$(pwd)")
fi

# Check if file_path is inside a worktree
if [[ -n "$PROJECT_ROOT" ]]; then
  WORKTREE_BASE="$PROJECT_ROOT/worktrees"
  if [[ "$file_path" == "$WORKTREE_BASE/"* ]]; then
    allow
  fi
fi

# Check if CWD is in a worktree (agent may use relative paths)
current_dir="$(pwd)"
if [[ "$current_dir" == *"/worktrees/"* ]]; then
  allow
fi

block "Implementation writes must be in a worktree

File: $file_path
Current directory: $current_dir

To fix:
1. Create worktree: ./scripts/create-worktree.sh GH-NNN
2. Change to worktree: cd worktrees/GH-NNN/
3. Then make your changes

Implementation requires branch isolation to prevent changes on main."
