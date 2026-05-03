#!/usr/bin/env bash
# record-activity.sh — single-purpose activity log writer.
# Called by hooks. Reads event metadata from stdin JSON (Claude Code hook
# contract), appends one JSON line to the activity log. Exits 0 unconditionally.
#
# Usage: record-activity.sh <kind>
#   kind: tool_called | skill_invoked | agent_spawned | agent_completed | session_start | session_stop
#
# Stdin JSON field map (extracted via jq):
#   tool_name   -> target.tool (for kind=tool_called); also drives categorization
#   skill_name  -> target.skill (for kind=skill_invoked; not surfaced by harness in production)
#   agent_name  -> target.agent (for kind=agent_spawned/agent_completed; not surfaced today)
#   agent_type  -> actor (sub-agent attribution; "ralph-hero:impl-agent" -> "impl-agent")
#   cwd         -> project (basename only)
#   session_id  -> session_id
#
# We deliberately do NOT source hook-utils.sh: its `set -euo pipefail` and
# block/warn helpers would break our "exit 0 always" guarantee.

set -u  # NOT -e: we never want to propagate errors to the harness

KIND="${1:-unknown}"
TS=$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || echo "")
ACTIVITY_ROOT="${RALPH_ACTIVITY_DIR:-$HOME/.ralph-hero/activity}"
TODAY_DIR="$ACTIVITY_ROOT/$(date -u +%Y/%m 2>/dev/null)"
TODAY_FILE="$TODAY_DIR/$(date -u +%d 2>/dev/null).jsonl"

mkdir -p "$TODAY_DIR" 2>/dev/null || exit 0

# Read stdin JSON payload. Empty stdin must not break extraction —
# default to "{}" so jq has a valid object to query against.
INPUT=$(cat 2>/dev/null || echo "")
if [ -z "$INPUT" ]; then
  INPUT="{}"
fi

# Extract a field via jq, falling back to a default on any error
# (missing jq, invalid JSON, missing field). Survives empty $INPUT
# because $INPUT was forced to "{}" above.
extract() {
  local query="$1"
  local default="$2"
  local result
  result=$(echo "$INPUT" | jq -r "$query // \"$default\"" 2>/dev/null)
  if [ -z "$result" ] || [ "$result" = "null" ]; then
    echo "$default"
  else
    echo "$result"
  fi
}

# Sub-agent attribution: agent_type comes through as "ralph-hero:impl-agent".
# Strip everything up to and including the last ":" (mirrors hook-utils.sh::get_agent_type).
RAW_AGENT_TYPE=$(extract '.agent_type' "")
ACTOR="${RAW_AGENT_TYPE##*:}"
if [ -z "$ACTOR" ]; then
  ACTOR="claude"
fi

# Project: basename of cwd, or "unknown" if absent.
RAW_CWD=$(extract '.cwd' "")
if [ -n "$RAW_CWD" ]; then
  PROJECT=$(basename "$RAW_CWD" 2>/dev/null || echo "unknown")
else
  PROJECT="unknown"
fi

SESSION_ID=$(extract '.session_id' "")

# Stdin-derived subject names used both for categorization and target object construction.
TOOL_NAME=$(extract '.tool_name' "")
SKILL_NAME=$(extract '.skill_name' "")
AGENT_NAME=$(extract '.agent_name' "")

# Categorize event as "work" (state-changing or intent-declaring) or "meta"
# (read-only / observational). Used by consumers to filter noise.
categorize() {
  local kind="$1"
  local subject="$2"  # tool name, skill name, or empty

  case "$kind" in
    skill_invoked|agent_spawned|agent_completed)
      echo "work"
      return
      ;;
    session_start|session_stop)
      echo "meta"
      return
      ;;
    tool_called)
      # State-mutating MCP tools are work; everything else is meta.
      case "$subject" in
        ralph_hero__save_issue|\
        ralph_hero__create_issue|\
        ralph_hero__create_draft_issue|\
        ralph_hero__update_draft_issue|\
        ralph_hero__convert_draft_issue|\
        ralph_hero__add_dependency|\
        ralph_hero__remove_dependency|\
        ralph_hero__add_sub_issue|\
        ralph_hero__advance_issue|\
        ralph_hero__archive_items|\
        ralph_hero__batch_update|\
        ralph_hero__create_comment|\
        ralph_hero__create_status_update|\
        ralph_hero__sync_plan_graph|\
        ralph_hero__decompose_feature|\
        ralph_hero__setup_project|\
        ralph_hero__create_views|\
        Write|Edit|NotebookEdit)
          echo "work"
          ;;
        *)
          echo "meta"
          ;;
      esac
      return
      ;;
  esac
  echo "meta"
}

# Pick subject for categorization based on event kind.
case "$KIND" in
  tool_called)
    CAT_SUBJECT="$TOOL_NAME"
    ;;
  skill_invoked)
    CAT_SUBJECT="$SKILL_NAME"
    ;;
  *)
    CAT_SUBJECT=""
    ;;
esac
CATEGORY=$(categorize "$KIND" "$CAT_SUBJECT")

# Build target object based on event kind
case "$KIND" in
  tool_called)
    TARGET=$(printf '{"tool":"%s"}' "${TOOL_NAME:-unknown}")
    ;;
  skill_invoked)
    TARGET=$(printf '{"skill":"%s"}' "${SKILL_NAME:-unknown}")
    ;;
  agent_spawned|agent_completed)
    TARGET=$(printf '{"agent":"%s"}' "${AGENT_NAME:-unknown}")
    ;;
  session_start|session_stop)
    TARGET="{}"
    ;;
  *)
    TARGET="{}"
    ;;
esac

# Construct event with optional session_id
if [ -n "$SESSION_ID" ]; then
  EVENT=$(printf '{"ts":"%s","kind":"%s","category":"%s","actor":"%s","target":%s,"project":"%s","session_id":"%s"}' \
    "$TS" "$KIND" "$CATEGORY" "$ACTOR" "$TARGET" "$PROJECT" "$SESSION_ID")
else
  EVENT=$(printf '{"ts":"%s","kind":"%s","category":"%s","actor":"%s","target":%s,"project":"%s"}' \
    "$TS" "$KIND" "$CATEGORY" "$ACTOR" "$TARGET" "$PROJECT")
fi

echo "$EVENT" >> "$TODAY_FILE" 2>/dev/null || true

exit 0
