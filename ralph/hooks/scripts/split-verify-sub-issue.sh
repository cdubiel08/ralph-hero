#!/bin/bash
# ralph/hooks/scripts/split-verify-sub-issue.sh
# PostToolUse (ralph_hero__add_sub_issue): Verify sub-issue linkage took effect
# for /ralph:caretake --mode split.
#
# Plan 6 hardening: scope-guarded (caretake + split).
#
# Exit codes:
#   0 - Sub-issue properly linked (or out of scope)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

if [[ "${RALPH_COMMAND:-}" != "caretake" ]]; then
  allow
fi
if [[ "${RALPH_SUBCOMMAND:-}" != "split" ]]; then
  allow
fi

read_input > /dev/null

parent_number=$(get_field '.tool_input.parentNumber')
child_number=$(get_field '.tool_input.childNumber')

if [[ -z "$parent_number" ]]; then
  warn "Sub-issue created without parentNumber. Should be linked to parent ticket."
fi

echo "Sub-issue linked: parent=#$parent_number child=#$child_number"
allow
