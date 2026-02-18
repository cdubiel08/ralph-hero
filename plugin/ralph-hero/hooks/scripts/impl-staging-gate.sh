#!/bin/bash
# ralph-hero/hooks/scripts/impl-staging-gate.sh
# PreToolUse (Bash): Block blanket git staging during implementation
#
# Prevents `git add -A`, `git add .`, `git add --all` which can
# stage files from other agents or prior failed runs.
# Agents must use `git add <specific-files>` instead.
#
# Note: `git add -u` is deliberately NOT blocked. Unlike -A/--all,
# -u only re-stages already-tracked files (no untracked additions)
# and is sometimes legitimately needed for multi-file updates within
# a phase's file ownership scope.
#
# Exit codes:
#   0 - Allowed (specific file staging or non-git-add command)
#   2 - Blocked (blanket staging command detected)

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

# Only check git add operations
if [[ "$command" != *"git add"* ]]; then
  allow
fi

# Extract arguments after "git add" and check each for blanket patterns.
# Checking individual arguments avoids false positives on filenames
# like "file-A.txt" that contain flag-like substrings.
add_args=$(echo "$command" | sed -n 's/.*git[[:space:]]*add[[:space:]]*//p')
for arg in $add_args; do
  case "$arg" in
    -A|--all|.)
      block "Blanket git staging blocked during implementation

Command: $command

Use specific file staging instead:
  git add <file1> <file2> ...

Why: 'git add -A' / 'git add .' can stage files from other agents,
prior failed runs, or editor temp files. Stage only the files you
intentionally modified for this phase.

Tip: Run 'git status --porcelain' first to review all changes,
then stage only files listed in the plan's File Ownership Summary."
      ;;
  esac
done

allow
