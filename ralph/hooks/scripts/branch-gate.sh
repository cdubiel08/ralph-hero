#!/bin/bash
# ralph-hero/hooks/scripts/branch-gate.sh
# PreToolUse: Block if not on required branch
#
# Environment:
#   RALPH_REQUIRED_BRANCH - Branch that must be active. UNSET = no-op (allow all).
#     Differs from the source ralph-hero copy, which defaulted to "main". The
#     slim plugin keeps this gate inert in interactive + prove modes so feature
#     branches don't trip every Bash call. The autonomous workflow exports
#     RALPH_REQUIRED_BRANCH=main explicitly when it needs the gate active.
#
# Exit codes:
#   0 - On correct branch (or env unset)
#   2 - Wrong branch (blocks with instructions)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Cache input for both command extraction and potential check_branch use
read_input > /dev/null

# No-op when RALPH_REQUIRED_BRANCH is unset.
if [[ -z "${RALPH_REQUIRED_BRANCH:-}" ]]; then
  allow
fi

required_branch="$RALPH_REQUIRED_BRANCH"
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
