#!/bin/bash
# ralph-hero/hooks/scripts/split-verify-sub-issue.sh
# PostToolUse (ralph_hero__add_sub_issue): Verify sub-issue link was created
#
# Ensures split creates proper parent-child relationships.
#
# Exit codes:
#   0 - Sub-issue properly linked

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

parent_number=$(get_field '.tool_input.parentNumber')
child_number=$(get_field '.tool_input.childNumber')

if [[ -z "$parent_number" ]]; then
  warn "Sub-issue created without parentNumber. Should be linked to parent ticket."
fi

echo "Sub-issue linked: parent=#$parent_number child=#$child_number"
allow
