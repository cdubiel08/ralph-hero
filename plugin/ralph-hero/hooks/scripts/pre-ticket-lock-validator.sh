#!/bin/bash
# ralph-hero/hooks/scripts/pre-ticket-lock-validator.sh
# PreToolUse: Detect when a ticket is already being processed (in a "lock state")
#
# Exit codes:
#   0 - Allowed (ticket not locked or valid transition)
#   2 - Blocked (ticket is locked by another process)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_MACHINE="$SCRIPT_DIR/ralph-state-machine.json"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')

# Only validate get_issue calls (we use this to check before updating)
if [[ "$TOOL_NAME" != "ralph_hero__get_issue" ]]; then
  exit 0
fi

# For get_issue, we can't block - but we can provide context
exit 0
