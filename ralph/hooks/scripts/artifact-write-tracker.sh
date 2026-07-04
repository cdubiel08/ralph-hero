#!/bin/bash
# ralph/hooks/scripts/artifact-write-tracker.sh
# PostToolUse (Write|Edit): record thoughts/shared/{research,plans,reviews}
# writes in a per-session list (hook-utils.sh::session_artifact_list) so
# Stop hooks can validate exactly the docs THIS session produced.
#
# Why: the previous discovery mechanism ("freshest today-dated doc by mtime")
# raced against concurrent sessions sharing thoughts/shared/ — a Stop hook
# would block on another session's in-progress doc. Session-keyed tracking
# eliminates the race; PostToolUse fires for sub-agent tool calls too, so
# docs written by dispatched agents are also captured.
#
# Never blocks (exit 0 always). Consumers: doc-structure-validator.sh,
# plan-postcondition.sh, research-postcondition.sh.

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

file_path=$(get_field '.tool_input.file_path')
[[ -n "$file_path" ]] || allow

case "$file_path" in
  *thoughts/shared/research/*.md | *thoughts/shared/plans/*.md | *thoughts/shared/reviews/*.md) ;;
  *) allow ;;
esac

# Normalize relative paths so Stop-hook readers can -f check them from any cwd.
if [[ "$file_path" != /* ]]; then
  file_path="$(get_project_root)/$file_path"
fi

list=$(session_artifact_list)
if ! grep -qxF -- "$file_path" "$list" 2>/dev/null; then
  printf '%s\n' "$file_path" >> "$list"
fi

allow
