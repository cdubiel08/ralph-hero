#!/bin/bash
# ralph-hero/hooks/scripts/team-teammate-idle.sh
# TeammateIdle: Guide team lead when a teammate goes idle
#
# Workers go idle when no tasks match their role. This is normal
# if upstream stages haven't completed yet. The Stop hook will
# block shutdown if matching tasks exist in TaskList. Only act if
# the pipeline has drained and new GitHub issues need pulling.
#
# Exit codes:
#   0 - Always (guidance only, never blocks)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

INPUT=$(cat)

TEAMMATE=$(echo "$INPUT" | jq -r '.teammate_name // "unknown"')

cat >&2 <<EOF
$TEAMMATE is idle.
This is NORMAL if upstream pipeline stages haven't completed yet.
Stop hook will block shutdown if matching tasks appear in TaskList.
ACTION: Only intervene if TaskList shows NO pending/in-progress tasks at all.
If pipeline is drained: use pick_actionable_issue to find new GitHub work.
EOF
exit 0
