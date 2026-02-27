#!/usr/bin/env bash
# Blocks tool calls that require skill context.
# Used as a PreToolUse hook on worker agent definitions.
#
# When a worker invokes a skill with context: fork, the skill's
# SessionStart hook sets RALPH_COMMAND via set-skill-env.sh.
# If RALPH_COMMAND is empty, the tool call is happening outside
# a skill and should be blocked.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"

read_input

command="${RALPH_COMMAND:-}"
if [[ -n "$command" ]]; then
  allow
fi

tool_name=$(get_field ".tool_name" 2>/dev/null || echo "unknown")
block "This tool requires skill context.

$tool_name cannot be called directly — invoke the appropriate skill instead.
Skills set RALPH_COMMAND via SessionStart hooks, which enables tool access.

Available skills: ralph-triage, ralph-split, ralph-research, ralph-plan,
ralph-review, ralph-impl, ralph-val, ralph-pr, ralph-merge"
