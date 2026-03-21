#!/usr/bin/env bash
# validate-primitive-io.sh — Validate YAML artifacts against ralph-playwright schemas
# Called by hooks.json as PreToolUse/PostToolUse hooks
#
# Input: JSON payload on stdin from Claude Code hook system
#   { tool_name, tool_input: { file_path, ... }, ... }
#
# Environment:
#   CLAUDE_PLUGIN_ROOT — path to plugin/ralph-playwright
#
# Exit 0: validation passes (or no artifact to validate)
# Exit 1: validation fails (blocks downstream primitive)

set -euo pipefail

SCHEMA_DIR="${CLAUDE_PLUGIN_ROOT}/schemas"

# Read hook input from stdin (standard Claude Code hook protocol)
INPUT=$(cat)

# Extract the file path being written/read from tool input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null || true)

if [[ -z "$FILE_PATH" ]]; then
  exit 0  # No file path — not a primitive IO operation
fi

# Determine which schema to validate against based on filename patterns
SCHEMA=""
case "$FILE_PATH" in
  *journey-trace*.yaml|*journey-trace*.yml)
    SCHEMA="journey-trace.schema.yaml"
    ;;
  *signal-report*.yaml|*signal-report*.yml)
    SCHEMA="signal-report.schema.yaml"
    ;;
  *action-log*.yaml|*action-log*.yml)
    SCHEMA="action-log.schema.yaml"
    ;;
  *execute-input*.yaml|*execute-input*.yml)
    SCHEMA="execute-input.schema.yaml"
    ;;
esac

if [[ -z "$SCHEMA" ]]; then
  exit 0  # Not a primitive artifact — skip validation
fi

SCHEMA_FILE="${SCHEMA_DIR}/${SCHEMA}"

if [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "WARN: Schema not found: ${SCHEMA_FILE}" >&2
  exit 0  # Schema missing — don't block, just warn
fi

if [[ ! -f "$FILE_PATH" ]]; then
  echo "WARN: Artifact not found: ${FILE_PATH}" >&2
  exit 0  # File doesn't exist yet (pre-validation) — skip
fi

# Validate required top-level fields
REQUIRED_FIELDS=$(yq '.required[]' "$SCHEMA_FILE" 2>/dev/null || true)

if [[ -n "$REQUIRED_FIELDS" ]]; then
  MISSING=""
  while IFS= read -r field; do
    val=$(yq ".${field}" "$FILE_PATH" 2>/dev/null) || {
      echo "ERROR: Failed to parse ${FILE_PATH} as YAML" >&2
      exit 1
    }
    if [[ -z "$val" || "$val" == "null" ]]; then
      MISSING="${MISSING}  - ${field}\n"
    fi
  done <<< "$REQUIRED_FIELDS"

  if [[ -n "$MISSING" ]]; then
    echo "ERROR: Artifact ${FILE_PATH} missing required fields for ${SCHEMA}:" >&2
    echo -e "$MISSING" >&2
    exit 1
  fi
fi

# Validate enum fields where specified
# (Validates step outcomes, signal types, signal severities, action types)
if [[ "$SCHEMA" == "journey-trace.schema.yaml" ]]; then
  INVALID_OUTCOMES=$(yq '.steps[].outcome' "$FILE_PATH" 2>/dev/null | grep -v -E '^(pass|fail|skip)$' || true)
  if [[ -n "$INVALID_OUTCOMES" ]]; then
    echo "ERROR: Invalid step outcomes in ${FILE_PATH}: ${INVALID_OUTCOMES}" >&2
    exit 1
  fi
fi

if [[ "$SCHEMA" == "signal-report.schema.yaml" ]]; then
  INVALID_TYPES=$(yq '.signals[].type' "$FILE_PATH" 2>/dev/null | grep -v -E '^(anomaly|regression|a11y_violation|ux_issue|error)$' || true)
  if [[ -n "$INVALID_TYPES" ]]; then
    echo "ERROR: Invalid signal types in ${FILE_PATH}: ${INVALID_TYPES}" >&2
    exit 1
  fi
  INVALID_SEVS=$(yq '.signals[].severity' "$FILE_PATH" 2>/dev/null | grep -v -E '^(critical|high|medium|low)$' || true)
  if [[ -n "$INVALID_SEVS" ]]; then
    echo "ERROR: Invalid signal severities in ${FILE_PATH}: ${INVALID_SEVS}" >&2
    exit 1
  fi
fi

if [[ "$SCHEMA" == "action-log.schema.yaml" ]]; then
  INVALID_TYPES=$(yq '.actions[].type' "$FILE_PATH" 2>/dev/null | grep -v -E '^(issue_created|note_written|screenshot_promoted|status_update)$' || true)
  if [[ -n "$INVALID_TYPES" ]]; then
    echo "ERROR: Invalid action types in ${FILE_PATH}: ${INVALID_TYPES}" >&2
    exit 1
  fi
fi

exit 0
