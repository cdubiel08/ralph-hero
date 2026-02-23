#!/bin/bash
# ralph-hero/hooks/scripts/debug-hook-counter.sh
# Lightweight PostToolUse hook for counting tool calls when RALPH_DEBUG=true.
# Appends hook events to the current session JSONL log.

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Skip when debug mode is not enabled
if [[ "${RALPH_DEBUG:-}" != "true" ]]; then
  exit 0
fi

# Read input from stdin
read_input >/dev/null

TOOL_NAME=$(get_tool_name)
LOG_DIR="${HOME}/.ralph-hero/logs"

# Find the most recent session log
LATEST_LOG=$(ls -t "$LOG_DIR"/session-*.jsonl 2>/dev/null | head -1)
if [[ -z "$LATEST_LOG" ]]; then
  exit 0
fi

# Append hook event
TS=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
echo "{\"ts\":\"$TS\",\"cat\":\"hook\",\"hook\":\"PostToolUse\",\"tool\":\"$TOOL_NAME\"}" >> "$LATEST_LOG"
