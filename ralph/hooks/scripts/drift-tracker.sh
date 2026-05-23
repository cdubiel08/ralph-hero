#!/bin/bash
# ralph-hero/hooks/scripts/drift-tracker.sh
# PostToolUse (Write|Edit): Track file changes outside task's declared scope
#
# Environment:
#   RALPH_COMMAND - Must be "impl" for this hook to activate
#   RALPH_TASK_FILES - Space-separated list of declared task files
#
# Exit codes:
#   0 always (drift is tracked, not blocked)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Only activate during implementation
if [[ "${RALPH_COMMAND:-}" != "impl" ]]; then
  allow
fi

read_input > /dev/null
file_path=$(get_field '.tool_input.file_path // empty')

if [[ -z "$file_path" ]]; then
  allow
fi

task_files="${RALPH_TASK_FILES:-}"
if [[ -z "$task_files" ]]; then
  allow  # No task file list set — can't track drift
fi

# Normalize file_path to relative
project_root="$(get_project_root)"
rel_path="${file_path#$project_root/}"

# Check if file is in declared task files
if ! echo "$task_files" | grep -qF "$rel_path"; then
  warn "DRIFT DETECTED: '$rel_path' modified but not in current task's declared files.
Task files: $task_files
If intentional, document in commit message with DRIFT: prefix."
fi

allow
