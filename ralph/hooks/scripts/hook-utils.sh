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

# Extract agent_type from hook input (present when firing inside a sub-agent)
# Strips plugin namespace prefix (e.g., "ralph:impl-agent" → "impl-agent")
get_agent_type() {
  local raw
  raw=$(get_field '.agent_type')
  echo "${raw##*:}"
}

# Get project root
get_project_root() {
  echo "${CLAUDE_PROJECT_DIR:-$(pwd)}"
}

# Walk up from a file path to the nearest ancestor containing a .git entry
# (file or directory — linked worktrees use a .git FILE, not a directory).
# Only absolute paths are walked: a relative path has no walkable ancestry
# (dirname bottoms out at ".", a fixed point that would loop forever), so
# relative and empty targets fall back to get_project_root() — the exact
# pre-helper behavior. The walk uses parameter expansion, not dirname, to
# avoid a subprocess per ancestor; "$dir" empties at the filesystem root,
# which (like the old "/" bound) is deliberately not checked for .git.
resolve_root_from_path() {
  local target="${1:-}"
  if [[ "$target" == /* ]]; then
    local dir="${target%/*}"
    while [[ -n "$dir" ]]; do
      if [[ -e "$dir/.git" ]]; then
        echo "$dir"
        return
      fi
      dir="${dir%/*}"
    done
  fi
  get_project_root
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

# Short-circuit a Stop hook when the harness is already inside a stop_hook_active
# pass. Requires read_input to have been called first (so RALPH_HOOK_INPUT is set).
# Promoted here so every Stop hook can opt in with a single call instead of
# copy-pasting the four-liner.
check_stop_hook_active() {
  local stop_active
  stop_active=$(get_field '.stop_hook_active')
  if [[ "$stop_active" == "true" ]]; then
    exit 0
  fi
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

# --- Session-scoped state ---------------------------------------------------
# Concurrent Claude sessions share thoughts/shared/ and /tmp, so "which doc
# did this skill run just write" must never be answered by directory mtime
# (see doc-structure-validator.sh history: a Stop hook once blocked on a doc
# a DIFFERENT session was mid-writing). These helpers key state by the
# harness-provided .session_id from the hook input instead.

# Directory for state private to the current session. Requires read_input to
# have been called (get_field reads RALPH_HOOK_INPUT). Falls back to PPID
# keying when .session_id is absent so a missing field degrades to
# per-parent-process, not global.
ralph_session_dir() {
  local sid
  sid=$(get_field '.session_id')
  [[ -n "$sid" ]] || sid="ppid-$PPID"
  local dir="${TMPDIR:-/tmp}/ralph-session-${sid}"
  mkdir -p "$dir" 2>/dev/null || true
  echo "$dir"
}

# Path of the per-session list of thoughts/shared artifacts, appended by
# artifact-write-tracker.sh (PostToolUse on Write|Edit).
session_artifact_list() {
  echo "$(ralph_session_dir)/artifacts.list"
}

# Print artifacts THIS session wrote, in write order (last line = most
# recent), optionally filtered by a path substring and/or a ticket id
# (padding-tolerant). Skips entries whose file no longer exists. Prints
# nothing when the tracker never recorded a matching write.
session_artifacts() {
  local dir_filter="${1:-}" ticket="${2:-}"
  local list
  list=$(session_artifact_list)
  [[ -f "$list" ]] || return 0
  local alt=""
  [[ -n "$ticket" ]] && alt=$(ticket_id_alt_form "$ticket")
  local path
  while IFS= read -r path; do
    [[ -n "$path" && -f "$path" ]] || continue
    if [[ -n "$dir_filter" && "$path" != *"$dir_filter"* ]]; then
      continue
    fi
    if [[ -n "$ticket" ]]; then
      if [[ "$path" != *"$ticket"* ]] && { [[ -z "$alt" ]] || [[ "$path" != *"$alt"* ]]; }; then
        continue
      fi
    fi
    printf '%s\n' "$path"
  done < "$list"
}

# find_existing_artifact plus a freshness window (minutes, default 30).
# Fallback for postconditions when the session artifact list has no entry
# (e.g. the doc was written by a dispatched sub-agent in a context where
# the tracker hook was not registered).
find_fresh_artifact() {
  local artifact_dir="$1" ticket_id="$2" mmin="${3:-30}"
  if [[ -z "$ticket_id" ]]; then
    return 1
  fi
  # `|| true`: find exits 1 on a missing dir; under callers' set -euo
  # pipefail that would abort the hook with rc=1 and nothing on stderr.
  local result
  result=$(find "$artifact_dir" -name "*${ticket_id}*" -type f -mmin "-${mmin}" 2>/dev/null | head -1 || true)
  if [[ -n "$result" ]]; then
    echo "$result"
    return 0
  fi
  local alt
  alt=$(ticket_id_alt_form "$ticket_id")
  if [[ -n "$alt" ]]; then
    find "$artifact_dir" -name "*${alt}*" -type f -mmin "-${mmin}" 2>/dev/null | head -1 || true
  fi
}

# Returns the zero-padded 4-digit form of a ticket ID (GH-NNN -> GH-0NNN),
# or empty if the input is already padded or doesn't parse.
# Used by callers that need to search for artifacts whose filename uses the
# padded form while the ticket_id was derived from a worktree dir (unpadded).
ticket_id_alt_form() {
  local ticket_id="$1"
  if [[ "$ticket_id" =~ ^GH-0*([0-9]+)$ ]]; then
    local candidate
    candidate=$(printf "GH-%04d" "${BASH_REMATCH[1]}")
    if [[ "$candidate" != "$ticket_id" ]]; then
      echo "$candidate"
    fi
  fi
}

# Check if file exists matching ticket pattern. Tolerates padding asymmetry
# between unpadded ticket IDs (worktree dirs) and the zero-padded form used
# in artifact filenames.
find_existing_artifact() {
  local artifact_dir="$1"
  local ticket_id="$2"

  if [[ -z "$ticket_id" ]]; then
    return 1
  fi

  # `|| true`: find exits 1 on a missing artifact dir; under the callers'
  # `set -euo pipefail` an unguarded failure here would abort the hook with
  # rc=1 and nothing on stderr. Missing dir means "no artifact", not a crash.
  local result
  result=$(find "$artifact_dir" -name "*${ticket_id}*" -type f 2>/dev/null | head -1 || true)
  if [[ -n "$result" ]]; then
    echo "$result"
    return 0
  fi

  local alt
  alt=$(ticket_id_alt_form "$ticket_id")
  if [[ -n "$alt" ]]; then
    find "$artifact_dir" -name "*${alt}*" -type f 2>/dev/null | head -1 || true
  fi
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

