#!/bin/bash
# ralph-hero/hooks/scripts/impl-verify-pr.sh
# PostToolUse (Bash): Verify PR created (final phase)
#
# Exit codes:
#   0 - PR created or not a PR command

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

command=$(get_field '.tool_input.command')
if [[ -z "$command" ]]; then
  allow
fi

if [[ "$command" != *"gh pr create"* ]]; then
  allow
fi

tool_output=$(get_field '.tool_output // ""')

if [[ "$tool_output" == *"https://github.com"* ]] && [[ "$tool_output" == *"/pull/"* ]]; then
  echo "PR created successfully"
  allow
fi

if [[ "$tool_output" == *"already exists"* ]]; then
  warn "PR already exists for this branch. Check existing PR."
fi

if [[ "$tool_output" == *"error"* ]] || [[ "$tool_output" == *"failed"* ]]; then
  warn "PR creation may have failed. Check command output for details."
fi

allow
