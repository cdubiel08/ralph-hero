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
  cat >&2 <<EOF
Review task completed by $TEAMMATE: "$TASK_SUBJECT"
Consider checking the verdict via TaskGet:
- APPROVED: peer handoff will wake builder. Verify worker exists.
- NEEDS_ITERATION: Create revision task with "Plan" in subject for builder.
EOF
else
  cat >&2 <<EOF
Task completed by $TEAMMATE: "$TASK_SUBJECT"
Consider checking pipeline convergence via detect_pipeline_position.
If the phase has converged, create next-bough tasks (Section 4.2).
If not converged, no action needed -- wait for remaining tasks.
EOF
fi
exit 0
