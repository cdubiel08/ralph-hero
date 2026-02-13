#!/bin/bash
# ralph-hero/hooks/scripts/plan-verify-commit.sh
# PostToolUse (Bash): Verify git commit succeeded
#
# Exit codes:
#   0 - Git operation successful or not a git command

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

command=$(get_field '.tool_input.command')
if [[ -z "$command" ]]; then
  allow
fi

if [[ "$command" != *"git commit"* ]] && [[ "$command" != *"git push"* ]]; then
  allow
fi

tool_output=$(get_field '.tool_output // ""')

if [[ "$tool_output" == *"nothing to commit"* ]]; then
  warn "Git commit had nothing to commit. Files may not have been staged."
fi

if [[ "$tool_output" == *"rejected"* ]] || [[ "$tool_output" == *"failed to push"* ]]; then
  warn "Git push was rejected. May need to pull first: git pull --rebase origin main"
fi

if [[ "$tool_output" == *"pre-commit hook"* ]] && [[ "$tool_output" == *"failed"* ]]; then
  warn "Pre-commit hook failed. Fix linting/type errors before committing."
fi

allow
