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

ACTOR="${CLAUDE_SKILL_NAME:-${CLAUDE_AGENT_NAME:-claude}}"
PROJECT="${CLAUDE_PROJECT:-unknown}"
SESSION_ID="${CLAUDE_SESSION_ID:-}"

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

CATEGORY=$(categorize "$KIND" "${CLAUDE_TOOL_NAME:-${CLAUDE_SKILL_NAME:-}}")

# Build target object based on event kind
case "$KIND" in
  tool_called)
    TARGET=$(printf '{"tool":"%s"}' "${CLAUDE_TOOL_NAME:-unknown}")
    ;;
  skill_invoked)
    TARGET=$(printf '{"skill":"%s"}' "${CLAUDE_SKILL_NAME:-unknown}")
    ;;
  agent_spawned|agent_completed)
    TARGET=$(printf '{"agent":"%s"}' "${CLAUDE_AGENT_NAME:-unknown}")
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
