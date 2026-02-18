#!/bin/bash
# ralph-hero/hooks/scripts/team-task-completed.sh
# TaskCompleted: Guide team lead after a teammate completes a task
#
# Peer-to-peer handoffs handle routine pipeline progression.
# Lead only needs to act on exceptions (review rejections) or
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
ACTION: TaskGet the completed task. Check verdict:
- APPROVED: peer handoff will wake builder. Verify worker exists.
- NEEDS_ITERATION: Create revision task with "Plan" in subject for builder.
EOF
else
  cat >&2 <<EOF
Task completed by $TEAMMATE: "$TASK_SUBJECT"
Peer handoff handles routine pipeline progression.
CHECK: Are there idle workers with no unblocked tasks? If so, pull new GitHub issues.
EOF
fi
exit 0
