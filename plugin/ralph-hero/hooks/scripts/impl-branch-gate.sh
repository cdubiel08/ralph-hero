#!/bin/bash
# ralph-hero/hooks/scripts/impl-branch-gate.sh
# PreToolUse (Bash): Block git operations on main during implementation
#
# Inverse of branch-gate.sh - impl must NOT be on main for git commit/push.
# Research/plan skills require main; impl requires a feature branch.
#
# Exit codes:
#   0 - Allowed (on feature branch or non-git command)
#   2 - Blocked (on main during impl git operation)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Only enforce for impl command
if [[ "${RALPH_COMMAND:-}" != "impl" ]]; then
  allow
fi

command=$(get_field '.tool_input.command')
if [[ -z "$command" ]]; then
  allow
fi

# Only check git commit/push/add operations
if [[ "$command" != *"git commit"* ]] && [[ "$command" != *"git push"* ]] && [[ "$command" != *"git add"* ]]; then
  allow
fi

# Allow git checkout/switch commands (agent may be switching TO a worktree)
if [[ "$command" =~ ^[[:space:]]*git[[:space:]]+(checkout|switch) ]]; then
  allow
fi

# Check current branch
current_branch=$(git branch --show-current 2>/dev/null || echo "unknown")

if [[ "$current_branch" == "main" ]] || [[ "$current_branch" == "master" ]]; then
  block "Implementation git operations blocked on main branch

Current branch: $current_branch
Command: $command

Implementation must commit to a feature branch, not main.

To fix:
1. Create worktree: ./scripts/create-worktree.sh GH-NNN
2. cd worktrees/GH-NNN/
3. Then run your git commands

Never commit implementation changes to main."
fi

allow
