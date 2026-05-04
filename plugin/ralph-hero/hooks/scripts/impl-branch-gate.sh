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

# Only enforce for impl command or impl-agent
if [[ "${RALPH_COMMAND:-}" != "impl" ]]; then
  agent_type=$(get_agent_type 2>/dev/null || echo "")
  if [[ "$agent_type" != "impl-agent" ]]; then
    allow
  fi
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

# Resolve the target branch the command will actually run on.
#
# Three-tier resolution:
#   1. Parse leading `cd <path>` from $command and query that directory.
#   2. Scan RALPH_WORKTREE_PATHS for a substring match in $command.
#   3. Echo empty string (ambiguous) — caller falls back to current cwd
#      with warn-not-block semantics.
#
# No `eval` of the command string. The path is extracted via regex,
# tildes are expanded via ${HOME} substitution, and relative paths are
# resolved against ${CLAUDE_PROJECT_DIR:-$(pwd)}.
resolve_target_branch() {
  local cmd="$1"
  local cd_path=""
  local resolved_path=""

  # Tier 1: leading `cd <path>` parse.
  # Anchor at the start of the command (allowing leading whitespace), capture
  # the first whitespace-delimited token after `cd` that does not contain
  # &, ;, |, or whitespace.
  if [[ "$cmd" =~ ^[[:space:]]*cd[[:space:]]+([^\&\;\|[:space:]]+) ]]; then
    cd_path="${BASH_REMATCH[1]}"
    # Strip surrounding single or double quotes if present.
    if [[ "$cd_path" =~ ^\"(.*)\"$ ]] || [[ "$cd_path" =~ ^\'(.*)\'$ ]]; then
      cd_path="${BASH_REMATCH[1]}"
    fi
    # Expand leading tilde via ${HOME} substitution (no eval).
    if [[ "$cd_path" == "~" ]]; then
      cd_path="${HOME}"
    elif [[ "$cd_path" == "~/"* ]]; then
      cd_path="${HOME}/${cd_path#~/}"
    fi
    # Resolve relative paths against CLAUDE_PROJECT_DIR (or pwd).
    if [[ "$cd_path" != /* ]]; then
      resolved_path="${CLAUDE_PROJECT_DIR:-$(pwd)}/$cd_path"
    else
      resolved_path="$cd_path"
    fi
    if [[ -d "$resolved_path" ]] && git -C "$resolved_path" rev-parse --git-dir >/dev/null 2>&1; then
      git -C "$resolved_path" branch --show-current 2>/dev/null || true
      return 0
    fi
  fi

  # Tier 2: RALPH_WORKTREE_PATHS substring scan.
  if [[ -n "${RALPH_WORKTREE_PATHS:-}" ]]; then
    local IFS=':'
    local wt_path
    for wt_path in ${RALPH_WORKTREE_PATHS}; do
      if [[ -z "$wt_path" ]]; then
        continue
      fi
      if [[ "$cmd" == *"$wt_path"* ]] && git -C "$wt_path" rev-parse --git-dir >/dev/null 2>&1; then
        git -C "$wt_path" branch --show-current 2>/dev/null || true
        return 0
      fi
    done
  fi

  # Tier 3: ambiguous — echo empty string, caller decides.
  echo ""
}

# Determine the target branch via the helper. If the helper succeeded
# (non-empty), treat its result as authoritative. If empty (ambiguous),
# fall back to the current cwd's branch and use warn-not-block semantics
# on main/master to avoid false-positive blocks.
resolved_branch=$(resolve_target_branch "$command")

if [[ -n "$resolved_branch" ]]; then
  current_branch="$resolved_branch"
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
else
  # Ambiguous: neither cd-prefix parse nor RALPH_WORKTREE_PATHS scan yielded
  # a branch. Fall back to the current cwd's branch and warn-not-block on
  # main/master to avoid false-positive blocks when detection cannot
  # identify the command's actual target directory.
  current_branch=$(git branch --show-current 2>/dev/null || echo "unknown")
  if [[ "$current_branch" == "main" ]] || [[ "$current_branch" == "master" ]]; then
    warn "impl-branch-gate could not determine target branch from command; allowing with warning. Command: $command"
  fi
fi

allow
