#!/bin/bash
# ralph-hero/hooks/scripts/artifact-metadata-validator.sh
# PostToolUse: Validate filename and frontmatter for thought artifacts
#
# Validates files written to thoughts/shared/{research,plans,reviews,reports}/
# - Filename must match the naming pattern for the artifact type
# - YAML frontmatter must include all required fields with valid values
#
# Exit codes:
#   0 - Allowed
#   2 - Blocked (validation failed)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"

read_input > /dev/null

# Only handle Write tool
TOOL_NAME=$(get_field '.tool_name')
if [[ "$TOOL_NAME" != "Write" ]]; then
  allow
fi

FILE_PATH=$(get_field '.tool_input.file_path')

if [[ -z "$FILE_PATH" ]]; then
  allow
fi

# Only validate files under thoughts/shared/{research,plans,reviews,reports}/
if [[ ! "$FILE_PATH" =~ thoughts/shared/(research|plans|reviews|reports)/ ]]; then
  allow
fi

FILENAME=$(basename "$FILE_PATH")

# Determine directory type
if [[ "$FILE_PATH" =~ thoughts/shared/research/ ]]; then
  DIR_TYPE="research"
elif [[ "$FILE_PATH" =~ thoughts/shared/plans/ ]]; then
  DIR_TYPE="plans"
elif [[ "$FILE_PATH" =~ thoughts/shared/reviews/ ]]; then
  DIR_TYPE="reviews"
elif [[ "$FILE_PATH" =~ thoughts/shared/reports/ ]]; then
  DIR_TYPE="reports"
else
  allow
fi

# ─── Filename validation ───────────────────────────────────────────────────────
FILENAME_VALID=true
FILENAME_ERROR=""
PLAN_TYPE=""

case "$DIR_TYPE" in
  research)
    if [[ ! "$FILENAME" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-GH-[0-9]{4}-[a-z0-9-]+\.md$ ]]; then
      FILENAME_VALID=false
      FILENAME_ERROR="Expected: YYYY-MM-DD-GH-{NNNN}-{slug}.md (4-digit zero-padded issue number, lowercase slug)"
    fi
    ;;
  plans)
    if [[ "$FILENAME" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-group-GH-[0-9]{4}-[a-z0-9-]+\.md$ ]]; then
      PLAN_TYPE="group"
    elif [[ "$FILENAME" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-stream-GH-[0-9]+-[0-9]+-[a-z0-9-]+\.md$ ]]; then
      PLAN_TYPE="stream"
    elif [[ "$FILENAME" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-GH-[0-9]{4}-[a-z0-9-]+\.md$ ]]; then
      PLAN_TYPE="single"
    else
      FILENAME_VALID=false
      FILENAME_ERROR="Expected one of:
  Single: YYYY-MM-DD-GH-{NNNN}-{slug}.md
  Group:  YYYY-MM-DD-group-GH-{NNNN}-{slug}.md
  Stream: YYYY-MM-DD-stream-GH-{NNN}-{NNN}-{slug}.md"
    fi
    ;;
  reviews)
    if [[ ! "$FILENAME" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-GH-[0-9]{4}-critique\.md$ ]]; then
      FILENAME_VALID=false
      FILENAME_ERROR="Expected: YYYY-MM-DD-GH-{NNNN}-critique.md (4-digit zero-padded issue number)"
    fi
    ;;
  reports)
    if [[ ! "$FILENAME" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+\.md$ ]]; then
      FILENAME_VALID=false
      FILENAME_ERROR="Expected: YYYY-MM-DD-{slug}.md (lowercase slug)"
    fi
    ;;
esac

if [[ "$FILENAME_VALID" == "false" ]]; then
  block "Artifact naming violation

File: $FILE_PATH
Type: $DIR_TYPE

$FILENAME_ERROR

See specs/artifact-metadata.md for naming conventions."
fi

# ─── Frontmatter validation ────────────────────────────────────────────────────
CONTENT=$(get_field '.tool_input.content')

if [[ -z "$CONTENT" ]]; then
  allow
fi

# Extract YAML frontmatter between the first two --- delimiters
FRONTMATTER=$(printf '%s' "$CONTENT" | awk '
  /^---[[:space:]]*$/ {
    if (in_fm == 0) { in_fm = 1; next }
    if (in_fm == 1) { exit }
  }
  in_fm == 1 { print }
')

if [[ -z "$FRONTMATTER" ]]; then
  block "Artifact frontmatter missing

File: $FILE_PATH

All artifacts must begin with a YAML frontmatter block:
---
date: YYYY-MM-DD
...
---

See specs/artifact-metadata.md for required fields."
fi

# Frontmatter helper functions
has_field() {
  local field="$1"
  if echo "$FRONTMATTER" | grep -qE "^${field}:"; then
    return 0
  else
    return 1
  fi
}

get_fm_value() {
  local field="$1"
  echo "$FRONTMATTER" | grep -E "^${field}:" | head -1 | sed "s/^${field}:[[:space:]]*//" | xargs 2>/dev/null || true
}

ERRORS=()

require_field() {
  local field="$1"
  local desc="${2:-$field}"
  if ! has_field "$field"; then
    ERRORS+=("Missing required field: $desc")
  fi
}

validate_value() {
  local field="$1"
  local pattern="$2"
  local desc="${3:-$field}"
  if has_field "$field"; then
    local value
    value=$(get_fm_value "$field")
    if ! echo "$value" | grep -qE "^(${pattern})$"; then
      ERRORS+=("Invalid $desc: '$value' (expected: $pattern)")
    fi
  fi
}

# Validate required frontmatter fields per artifact type
case "$DIR_TYPE" in
  research)
    require_field "date"
    require_field "github_issue" "github_issue (integer)"
    validate_value "github_issue" "[0-9]+" "github_issue"
    require_field "github_url"
    require_field "status"
    validate_value "status" "draft|complete" "status"
    require_field "type"
    validate_value "type" "research" "type"
    ;;
  plans)
    # single and group plans share the same required fields
    require_field "date"
    require_field "status"
    require_field "github_issues" "github_issues (array)"
    require_field "github_urls" "github_urls (array)"
    require_field "primary_issue"
    ;;
  reviews)
    require_field "date"
    require_field "github_issue"
    require_field "status"
    validate_value "status" "approved|needs-iteration" "status"
    require_field "type"
    validate_value "type" "critique" "type"
    ;;
  reports)
    # No required frontmatter fields for reports per spec
    ;;
esac

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  ERROR_LIST=$(printf '  - %s\n' "${ERRORS[@]}")
  block "Artifact frontmatter violation

File: $FILE_PATH
Type: $DIR_TYPE${PLAN_TYPE:+ ($PLAN_TYPE plan)}

Required fields missing or invalid:
$ERROR_LIST
See specs/artifact-metadata.md for the required frontmatter schema."
fi

allow
