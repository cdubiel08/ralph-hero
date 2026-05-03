#!/usr/bin/env bash
# record-activity.sh — single-purpose activity log writer.
# Called by hooks. Reads event metadata from env vars, appends one
# JSON line to the activity log. Exits 0 unconditionally.
#
# Usage: record-activity.sh <kind>
#   kind: tool_called | skill_invoked | agent_spawned | agent_completed | session_start | session_stop

set -u  # NOT -e: we never want to propagate errors to the harness

KIND="${1:-unknown}"
TS=$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || echo "")
ACTIVITY_ROOT="${RALPH_ACTIVITY_DIR:-$HOME/.ralph-hero/activity}"
TODAY_DIR="$ACTIVITY_ROOT/$(date -u +%Y/%m 2>/dev/null)"
TODAY_FILE="$TODAY_DIR/$(date -u +%d 2>/dev/null).jsonl"

mkdir -p "$TODAY_DIR" 2>/dev/null || exit 0

# Minimal event for now — fields filled in subsequent tasks
EVENT=$(printf '{"ts":"%s","kind":"%s","category":"meta"}' "$TS" "$KIND")

echo "$EVENT" >> "$TODAY_FILE" 2>/dev/null || true

exit 0
