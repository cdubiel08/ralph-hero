#!/bin/bash
# ralph-hero/hooks/scripts/hook-utils.sh
# Common utilities for ralph-hero hooks
#
# This file provides shared functions for all ralph workflow hooks.
# Source it at the beginning of each hook script.

set -euo pipefail

# Read JSON input from stdin (call once, cache result)
read_input() {
  if [[ -z "${RALPH_HOOK_INPUT:-}" ]]; then
    export RALPH_HOOK_INPUT=$(cat)
  fi
  echo "$RALPH_HOOK_INPUT"
}

# Extract field from input JSON
get_field() {
  local field="$1"
  echo "$RALPH_HOOK_INPUT" | jq -r "$field // empty"
}

# Extract tool name
get_tool_name() {
  get_field '.tool_name'
}

# Extract tool input
get_tool_input() {
  get_field '.tool_input'
}

# Get project root
get_project_root() {
  echo "${CLAUDE_PROJECT_DIR:-$(pwd)}"
}

# Block with error message (exit 2)
block() {
  local message="$1"
  cat >&2 <<EOF
═══════════════════════════════════════════════════════════════
 HOOK BLOCKED: ${RALPH_COMMAND:-unknown}
═══════════════════════════════════════════════════════════════
$message
═══════════════════════════════════════════════════════════════
EOF
  exit 2
}

# Warn but allow (exit 0 with message)
warn() {
  local message="$1"
  echo "WARNING: $message" >&2
  exit 0
}

# Success (exit 0 silently)
allow() {
  exit 0
}

# Check if on required branch
check_branch() {
  local required="${RALPH_REQUIRED_BRANCH:-main}"
  local current=$(cd "$(get_project_root)" && git branch --show-current 2>/dev/null || echo "unknown")

  if [[ "$current" != "$required" ]]; then
    block "Branch gate failed

Current branch: $current
Required branch: $required

To fix:
  git checkout $required

This command requires '$required' branch to ensure:
- Artifacts commit to correct branch
- No accidental commits to feature branches"
  fi
}

# Check ticket exists and extract ID
get_ticket_id() {
  # Try environment variable first
  if [[ -n "${RALPH_TICKET_ID:-}" ]]; then
    echo "$RALPH_TICKET_ID"
    return
  fi

  # Try to extract from GitHub MCP tool input
  local input=$(get_tool_input)
  # GitHub tools use .number or .issueNumber for issue identification
  local number=$(echo "$input" | jq -r '.number // .issueNumber // .parentNumber // .childNumber // empty' 2>/dev/null | head -1)
  if [[ -n "$number" ]]; then
    echo "GH-$number"
    return
  fi

  # Fallback: try to extract GH-NNN from any string context
  echo "$input" | grep -oE 'GH-[0-9]+' 2>/dev/null | head -1
}

# Validate state is in allowed list
validate_state() {
  local current_state="$1"
  local valid_states="$2"  # comma-separated

  IFS=',' read -ra states <<< "$valid_states"
  for state in "${states[@]}"; do
    # Trim whitespace
    state=$(echo "$state" | xargs)
    if [[ "$current_state" == "$state" ]]; then
      return 0
    fi
  done
  return 1
}

# Check if file exists matching ticket pattern
find_existing_artifact() {
  local artifact_dir="$1"
  local ticket_id="$2"

  if [[ -z "$ticket_id" ]]; then
    return 1
  fi

  find "$artifact_dir" -name "*${ticket_id}*" -type f 2>/dev/null | head -1
}

# Output JSON response for allowing with context
allow_with_context() {
  local context="$1"
  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "$context"
  }
}
EOF
  exit 0
}

# Check if state is a semantic intent
is_semantic_intent() {
  local state="$1"
  case "$state" in
    __LOCK__|__COMPLETE__|__ESCALATE__|__CLOSE__|__CANCEL__)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# Get valid output states for command
get_valid_output_states() {
  local command="$1"
  local state_machine="${2:-$SCRIPT_DIR/ralph-state-machine.json}"
  jq -r --arg cmd "$command" '.commands[$cmd].valid_output_states | join(",")' "$state_machine"
}
