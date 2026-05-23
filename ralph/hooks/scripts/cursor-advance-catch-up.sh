#!/bin/bash
# ralph-hero/hooks/scripts/cursor-advance-catch-up.sh
# PostToolUse(ralph_hero__recent_activity): persist catch-up cursor.
#
# Replaces the LLM-driven Write call previously emitted by Step 5 of the
# catch-up skill. Reads tool_response.cursor_advanced_to from stdin and
# writes ~/.ralph-hero/cursors/catch-up.json when the value is non-null.
#
# Honors RALPH_CURSOR_DIR env-var override so tests can redirect the write
# target away from the real ~/.ralph-hero. Best-effort: any failure exits 0
# without surfacing errors to the user (pattern: outcome-collector.sh:88).
#
# Exit codes:
#   0 - Always (never blocks pipeline)

set -euo pipefail

# Read full hook input from stdin (matches outcome-collector.sh:26 pattern).
INPUT=$(cat)

# Resolve cursor dir / file. Tests override via RALPH_CURSOR_DIR.
CURSOR_DIR="${RALPH_CURSOR_DIR:-${HOME}/.ralph-hero/cursors}"
CURSOR_FILE="$CURSOR_DIR/catch-up.json"

# Extract cursor value. The `// empty` idiom emits empty-string for
# null/missing/malformed input — same pattern as outcome-collector.sh:108-110.
cursor=$(echo "$INPUT" | jq -r '.tool_response.cursor_advanced_to // empty' 2>/dev/null || echo "")

# Empty (null cursor or malformed stdin) — nothing to persist.
if [[ -z "$cursor" ]]; then
  exit 0
fi

# Ensure parent dir exists, then write {"last_event_ts":"<value>"}.
mkdir -p "$CURSOR_DIR" 2>/dev/null || true
jq -n --arg ts "$cursor" '{last_event_ts: $ts}' > "$CURSOR_FILE" \
  || { echo "WARNING: cursor-advance-catch-up failed to write cursor" >&2; exit 0; }

exit 0
