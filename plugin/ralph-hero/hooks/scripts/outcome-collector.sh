#!/bin/bash
# ralph-hero/hooks/scripts/outcome-collector.sh
# PostToolUse + TaskCompleted: Capture pipeline outcome events into knowledge.db
#
# Registered on:
#   PostToolUse(ralph_hero__save_issue) — state transitions
#   PostToolUse(Write)                 — plan/research doc enrichment
#   TaskCompleted                      — task-level events (team skill only)
#
# Stateless: each invocation is a standalone INSERT. No state between firings.
# Best-effort: sqlite3 failures are logged and ignored (exit 0 always).
#
# Does NOT source hook-utils.sh — this is a PostToolUse/TaskCompleted observer
# that reads stdin directly, following the pattern of post-github-validator.sh.
#
# Exit codes:
#   0 - Always (never blocks pipeline)

set -euo pipefail

# Resolve DB path and ensure directory exists
DB_PATH="${RALPH_KNOWLEDGE_DB:-${HOME}/.ralph-hero/knowledge.db}"
mkdir -p "$(dirname "$DB_PATH")" 2>/dev/null || true

# Read hook input
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')

# Ensure table and pragmas
ensure_table() {
  sqlite3 "$DB_PATH" <<'SQL' 2>/dev/null || true
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=3000;
CREATE TABLE IF NOT EXISTS outcome_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  session_id TEXT,
  timestamp TEXT NOT NULL,
  duration_ms INTEGER,
  verdict TEXT,
  component_area TEXT,
  estimate TEXT,
  drift_count INTEGER,
  model TEXT,
  agent_type TEXT,
  iteration_count INTEGER,
  payload TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_oe_type ON outcome_events(event_type);
CREATE INDEX IF NOT EXISTS idx_oe_issue ON outcome_events(issue_number);
CREATE INDEX IF NOT EXISTS idx_oe_component ON outcome_events(component_area);
CREATE INDEX IF NOT EXISTS idx_oe_timestamp ON outcome_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_oe_session ON outcome_events(session_id);
CREATE INDEX IF NOT EXISTS idx_oe_type_component ON outcome_events(event_type, component_area);
SQL
}

# SQL helpers — escape single quotes to prevent injection
sql_escape() { echo "${1//\'/\'\'}"; }
sql_str() { if [[ -n "$1" ]]; then echo "'$(sql_escape "$1")'"; else echo "NULL"; fi; }
sql_int() { if [[ -n "$1" && "$1" =~ ^[0-9]+$ ]]; then echo "$1"; else echo "NULL"; fi; }

# Insert an outcome event
insert_event() {
  local event_type="$1"
  local issue_number="$2"
  local session_id="${3:-}"
  local verdict="${4:-}"
  local component_area="${5:-}"
  local estimate="${6:-}"
  local drift_count="${7:-}"
  local model="${8:-}"
  local agent_type="${9:-}"
  local iteration_count="${10:-}"
  local payload="${11:-{}}"

  local id
  id=$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]' || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "oe-$(date +%s%N)")
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Escape all string values for SQL safety
  local e_event_type e_payload
  e_event_type=$(sql_escape "$event_type")
  e_payload=$(sql_escape "$payload")

  sqlite3 "$DB_PATH" <<SQL 2>/dev/null || { echo "WARNING: outcome-collector failed to write event" >&2; return 0; }
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=3000;
INSERT INTO outcome_events (id, event_type, issue_number, session_id, timestamp,
  verdict, component_area, estimate, drift_count, model, agent_type, iteration_count, payload)
VALUES (
  '${id}', '${e_event_type}', $(sql_int "$issue_number"), $(sql_str "$session_id"), '${ts}',
  $(sql_str "$verdict"), $(sql_str "$component_area"), $(sql_str "$estimate"),
  $(sql_int "$drift_count"), $(sql_str "$model"), $(sql_str "$agent_type"),
  $(sql_int "$iteration_count"), '${e_payload}'
);
SQL
}

# ─── Branch: PostToolUse(ralph_hero__save_issue) ───
handle_save_issue() {
  local tool_input tool_response command workflow_state issue_number
  tool_input=$(echo "$INPUT" | jq -r '.tool_input // {}')
  tool_response=$(echo "$INPUT" | jq -r '.tool_response // {}')

  command=$(echo "$tool_input" | jq -r '.command // empty')
  workflow_state=$(echo "$tool_input" | jq -r '.workflowState // empty')
  issue_number=$(echo "$tool_response" | jq -r '.number // empty')

  # Need command, state, and issue number
  if [[ -z "$command" || -z "$workflow_state" || -z "$issue_number" ]]; then
    exit 0
  fi

  local event_type=""
  case "${command}:${workflow_state}" in
    ralph_research:__LOCK__)     event_type="research_started" ;;
    ralph_research:__COMPLETE__) event_type="research_completed" ;;
    ralph_plan:__LOCK__)         event_type="plan_started" ;;
    ralph_plan:__COMPLETE__)     event_type="plan_completed" ;;
    ralph_review:*)              event_type="review_completed" ;;
    ralph_impl:__LOCK__)         event_type="phase_started" ;;
    ralph_impl:__COMPLETE__)     event_type="phase_completed" ;;
    ralph_val:*)                 event_type="validation_completed" ;;
    ralph_pr:__COMPLETE__)       event_type="pr_completed" ;;
    ralph_merge:__COMPLETE__)    event_type="merge_completed" ;;
    *)                           exit 0 ;;
  esac

  # Extract available promoted columns from tool input/response
  local verdict component_area estimate drift_count model agent_type iteration_count
  verdict=$(echo "$tool_input" | jq -r '.verdict // empty')
  component_area=$(echo "$tool_input" | jq -r '.componentArea // empty')
  estimate=$(echo "$tool_input" | jq -r '.estimate // empty')
  drift_count=$(echo "$tool_input" | jq -r '.driftCount // empty')
  model=$(echo "$tool_input" | jq -r '.model // empty')
  agent_type=$(echo "$tool_input" | jq -r '.agentType // empty')
  iteration_count=$(echo "$tool_input" | jq -r '.iterationCount // empty')
  local session_id="${RALPH_SESSION_ID:-}"

  # Build payload from tool_input extras
  local payload
  payload=$(echo "$tool_input" | jq -c '{} + (del(.command, .workflowState, .number, .verdict, .componentArea, .estimate, .driftCount, .model, .agentType, .iterationCount) | to_entries | map(select(.value != null and .value != "")) | from_entries)' 2>/dev/null || echo '{}')

  ensure_table
  insert_event "$event_type" "$issue_number" "$session_id" "$verdict" \
    "$component_area" "$estimate" "$drift_count" "$model" "$agent_type" \
    "$iteration_count" "$payload"
}

# ─── Branch: PostToolUse(Write) ───
handle_write() {
  local file_path
  file_path=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

  # Only process thoughts/shared/plans/* and thoughts/shared/research/*
  case "$file_path" in
    */thoughts/shared/plans/*|*/thoughts/shared/research/*) ;;
    *) exit 0 ;;
  esac

  # Extract issue number from GH-NNNN in filename
  local fname issue_number
  fname=$(basename "$file_path")
  issue_number=$(echo "$fname" | grep -oE 'GH-[0-9]+' | head -1 | sed 's/GH-0*//')
  if [[ -z "$issue_number" ]]; then
    exit 0
  fi

  # Extract metadata from file
  local payload='{}'
  if [[ -f "$file_path" ]]; then
    case "$file_path" in
      */plans/*)
        local phase_count file_count
        phase_count=$(grep -c '^## Phase ' "$file_path" 2>/dev/null || echo 0)
        file_count=$(grep -c '^\s*- ' "$file_path" 2>/dev/null || echo 0)
        payload=$(jq -nc --argjson pc "$phase_count" --argjson fc "$file_count" \
          '{phase_count: $pc, file_references: $fc}')
        ;;
      */research/*)
        local will_modify will_read
        will_modify=$(sed -n '/### Will Modify/,/###/{/###/!p}' "$file_path" 2>/dev/null | grep -c '`' || echo 0)
        will_read=$(sed -n '/### Will Read/,/###/{/###/!p}' "$file_path" 2>/dev/null | grep -c '`' || echo 0)
        payload=$(jq -nc --argjson wm "$will_modify" --argjson wr "$will_read" \
          '{files_will_modify_count: $wm, files_will_read_count: $wr}')
        ;;
    esac
  fi

  # UPDATE the most recent *_completed event for this issue, or skip
  ensure_table
  local existing_id
  existing_id=$(sqlite3 "$DB_PATH" "PRAGMA busy_timeout=3000; SELECT id FROM outcome_events WHERE issue_number = $issue_number AND event_type LIKE '%_completed' ORDER BY timestamp DESC LIMIT 1;" 2>/dev/null || echo "")

  if [[ -n "$existing_id" ]]; then
    local merged
    merged=$(sqlite3 "$DB_PATH" "PRAGMA busy_timeout=3000; SELECT payload FROM outcome_events WHERE id = '$(sql_escape "$existing_id")';" 2>/dev/null || echo '{}')
    merged=$(echo "$merged" | jq -c ". + $payload" 2>/dev/null || echo "$payload")
    local e_merged
    e_merged=$(sql_escape "$merged")
    sqlite3 "$DB_PATH" "PRAGMA busy_timeout=3000; UPDATE outcome_events SET payload = '${e_merged}' WHERE id = '$(sql_escape "$existing_id")';" 2>/dev/null || true
  fi
  # If no existing event, skip — enrichment is best-effort
}

# ─── Branch: TaskCompleted ───
handle_task_completed() {
  local task_subject teammate_name agent_type
  task_subject=$(echo "$INPUT" | jq -r '.task_subject // "unknown"')
  teammate_name=$(echo "$INPUT" | jq -r '.teammate_name // "unknown"')

  # Infer agent_type from teammate name
  case "$teammate_name" in
    *analyst*) agent_type="analyst" ;;
    *builder*) agent_type="builder" ;;
    *integrator*) agent_type="integrator" ;;
    *) agent_type="$teammate_name" ;;
  esac

  # Extract issue number from task subject (e.g., "Implement GH-617")
  local issue_number
  issue_number=$(echo "$task_subject" | grep -oE 'GH-[0-9]+' | head -1 | sed 's/GH-0*//')
  if [[ -z "$issue_number" ]]; then
    # Fall back to any number in subject
    issue_number=$(echo "$task_subject" | grep -oE '[0-9]+' | head -1)
  fi
  if [[ -z "$issue_number" ]]; then
    exit 0
  fi

  local payload
  payload=$(jq -nc --arg ts "$task_subject" --arg tn "$teammate_name" \
    '{task_subject: $ts, teammate_name: $tn}')

  local session_id="${RALPH_SESSION_ID:-}"

  ensure_table
  insert_event "task_completed" "$issue_number" "$session_id" "" "" "" "" "" "$agent_type" "" "$payload"
}

# ─── Main dispatch ───
case "$TOOL_NAME" in
  ralph_hero__save_issue)
    handle_save_issue
    ;;
  Write)
    handle_write
    ;;
  *)
    # TaskCompleted — detect by presence of task_subject field
    if echo "$INPUT" | jq -e '.task_subject' >/dev/null 2>&1; then
      handle_task_completed
    fi
    ;;
esac

exit 0
