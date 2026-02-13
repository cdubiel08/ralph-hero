#!/bin/bash
# ralph-hero/hooks/scripts/branch-gate.sh
# PreToolUse: Block if not on required branch
#
# Environment:
#   RALPH_REQUIRED_BRANCH - Branch that must be active (default: main)
#
# Exit codes:
#   0 - On correct branch
#   2 - Wrong branch (blocks with instructions)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Cache input for both command extraction and potential check_branch use
read_input > /dev/null

# Get required branch and bash command
required_branch="${RALPH_REQUIRED_BRANCH:-main}"
command=$(get_field '.tool_input.command')

# Allow git checkout/switch commands that target the required branch
if [[ -n "$command" ]]; then
  if [[ "$command" =~ ^[[:space:]]*git[[:space:]]+(checkout|switch)[[:space:]].*${required_branch}([[:space:]]|$|\"|\') ]]; then
    allow
  fi
fi

# For all other commands, enforce branch requirement
check_branch
allow
