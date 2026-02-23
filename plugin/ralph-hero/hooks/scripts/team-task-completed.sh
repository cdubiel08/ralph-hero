#!/bin/bash
# ralph-hero/hooks/scripts/team-task-completed.sh
# TaskCompleted: Guide team lead after a teammate completes a task
#
# Bough advancement: lead checks convergence and creates next-phase tasks.
# Lead also acts on exceptions (review rejections) and
# pipeline drain (intake of new GitHub issues).
#
# Exit codes:
#   0 - Always (guidance only, never blocks)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

INPUT=$(cat)

TASK_SUBJECT=$(echo "$INPUT" | jq -r '.task_subject // "unknown"')
TEAMMATE=$(echo "$INPUT" | jq -r '.teammate_name // "unknown"')

# Check if this is a review task (may need exception handling)
if echo "$TASK_SUBJECT" | grep -qi "review"; then
  echo "Task completed by $TEAMMATE: \"$TASK_SUBJECT\" (review task)" >&2
else
  echo "Task completed by $TEAMMATE: \"$TASK_SUBJECT\"" >&2
fi
exit 0
