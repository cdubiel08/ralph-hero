#!/bin/bash
# ralph-hero/hooks/scripts/task-schema-validator.sh
# PreToolUse: Validate TaskCreate/TaskUpdate schema in team/hero mode
#
# Enforces required fields, subject naming conventions, and completion
# metadata when RALPH_COMMAND is "team" or "hero".
#
# Exit codes:
#   0 - Allowed
#   2 - Blocked (validation failure)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Only validate in team/hero command context
COMMAND="${RALPH_COMMAND:-}"
if [[ "$COMMAND" != "team" && "$COMMAND" != "hero" ]]; then
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')

# Only handle TaskCreate and TaskUpdate
if [[ "$TOOL_NAME" != "TaskCreate" && "$TOOL_NAME" != "TaskUpdate" ]]; then
  exit 0
fi

TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')

if [[ "$TOOL_NAME" == "TaskCreate" ]]; then
  SUBJECT=$(echo "$TOOL_INPUT" | jq -r '.subject // ""')
  DESCRIPTION=$(echo "$TOOL_INPUT" | jq -r '.description // ""')
  ACTIVE_FORM=$(echo "$TOOL_INPUT" | jq -r '.activeForm // ""')
  METADATA_TYPE=$(echo "$TOOL_INPUT" | jq -r '(.metadata | type)')

  # Validate required text fields
  if [[ -z "$SUBJECT" ]]; then
    block "TaskCreate missing required field: subject

All tasks must have a non-empty subject in imperative form (e.g., \"Research GH-468: title\")."
  fi

  if [[ -z "$DESCRIPTION" ]]; then
    block "TaskCreate missing required field: description

Task: \"$SUBJECT\"

All tasks must have a non-empty description with issue context and worker instructions."
  fi

  if [[ -z "$ACTIVE_FORM" ]]; then
    block "TaskCreate missing required field: activeForm

Task: \"$SUBJECT\"

All tasks must include activeForm in present continuous form (e.g., \"Researching GH-468\")."
  fi

  # Validate metadata is a non-null object
  if [[ "$METADATA_TYPE" == "null" ]]; then
    block "TaskCreate missing required field: metadata

Task: \"$SUBJECT\"

All tasks must include a metadata object.
Required keys: issue_number, issue_url, command, phase, estimate"
  fi

  if [[ "$METADATA_TYPE" != "object" ]]; then
    block "TaskCreate metadata must be a JSON object (got: $METADATA_TYPE)

Task: \"$SUBJECT\"

Expected: { \"issue_number\": 123, \"issue_url\": \"...\", \"command\": \"...\", \"phase\": \"...\", \"estimate\": \"XS\" }"
  fi

  # Validate subject contains issue number (GH-NNN or #NNN)
  if ! echo "$SUBJECT" | grep -qE '(GH-[0-9]+|#[0-9]+)'; then
    block "TaskCreate subject missing issue number

Subject: \"$SUBJECT\"

Task subjects must include the issue number in GH-NNN or #NNN format.
Examples:
  - \"Research GH-468: Scaffold specs\"
  - \"Implement #42: Add auth flow\""
  fi

  # Validate subject contains a role keyword
  if ! echo "$SUBJECT" | grep -qiE '(Triage|Split|Research|Plan|Review|Implement|Validate|Create PR|Merge)'; then
    block "TaskCreate subject missing role keyword

Subject: \"$SUBJECT\"

Task subjects must include a role keyword for stop-gate matching.
Valid keywords: Triage, Split, Research, Plan, Review, Implement, Validate, Create PR, Merge"
  fi

  # Validate required metadata keys
  METADATA=$(echo "$TOOL_INPUT" | jq -c '.metadata')
  for KEY in issue_number issue_url command phase estimate; do
    VALUE=$(echo "$METADATA" | jq -r --arg k "$KEY" '.[$k] // empty')
    if [[ -z "$VALUE" ]]; then
      block "TaskCreate metadata missing required key: $KEY

Task: \"$SUBJECT\"

Required metadata keys: issue_number, issue_url, command, phase, estimate"
    fi
  done

elif [[ "$TOOL_NAME" == "TaskUpdate" ]]; then
  STATUS=$(echo "$TOOL_INPUT" | jq -r '.status // ""')

  # Only validate completion transitions
  if [[ "$STATUS" != "completed" ]]; then
    exit 0
  fi

  DESCRIPTION=$(echo "$TOOL_INPUT" | jq -r '.description // ""')
  METADATA_TYPE=$(echo "$TOOL_INPUT" | jq -r '(.metadata | type)')

  if [[ -z "$DESCRIPTION" ]]; then
    block "TaskUpdate(status=completed) missing description

Workers MUST include a meaningful description summarizing results when completing a task.
The description is the primary result-reporting channel to the team lead."
  fi

  if [[ "$METADATA_TYPE" == "null" ]]; then
    block "TaskUpdate(status=completed) missing metadata

Workers MUST set phase-appropriate metadata keys when completing a task.
See specs/task-schema.md for required keys per phase (e.g., artifact_path, workflow_state, result)."
  fi
fi

exit 0
