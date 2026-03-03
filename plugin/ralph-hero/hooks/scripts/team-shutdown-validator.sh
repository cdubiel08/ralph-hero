#!/bin/bash
# ralph-hero/hooks/scripts/team-shutdown-validator.sh
# PreToolUse: Block TeamDelete if no post-mortem has been written
#
# Checks for a post-mortem file in thoughts/shared/reports/ matching the
# ralph-team naming pattern. Requires a file newer than the team creation
# marker (if it exists) or written today.
#
# Only active when RALPH_COMMAND=team.
#
# Exit codes:
#   0 - Post-mortem found or not in team command context
#   2 - No post-mortem found, block TeamDelete

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Only enforce for team command
if [[ "${RALPH_COMMAND:-}" != "team" ]]; then
  exit 0
fi

read_input > /dev/null
TOOL=$(get_tool_name)

if [[ "$TOOL" != "TeamDelete" ]]; then
  exit 0
fi

PROJECT_ROOT=$(get_project_root)
REPORTS_DIR="${PROJECT_ROOT}/thoughts/shared/reports"
TEAM_MARKER="/tmp/ralph-team-created-$$"
TODAY=$(date +%Y-%m-%d)

# Check for post-mortem file matching the ralph-team pattern
POSTMORTEM=""

if [[ -d "$REPORTS_DIR" ]]; then
  if [[ -f "$TEAM_MARKER" ]]; then
    # Prefer a file newer than when the team was created
    POSTMORTEM=$(find "$REPORTS_DIR" -name "*ralph-team*" -newer "$TEAM_MARKER" -type f 2>/dev/null | head -1)
  fi

  # Fallback: any ralph-team report written today
  if [[ -z "$POSTMORTEM" ]]; then
    POSTMORTEM=$(find "$REPORTS_DIR" -name "${TODAY}-ralph-team*" -type f 2>/dev/null | head -1)
  fi
fi

if [[ -z "$POSTMORTEM" ]]; then
  block "Post-mortem MUST be written before TeamDelete

No post-mortem report found in thoughts/shared/reports/ for this session.

Required steps before TeamDelete:
  1. Call TaskList and TaskGet to collect session results
  2. Write thoughts/shared/reports/${TODAY}-ralph-team-{team-name}.md
  3. Commit: git commit -m \"docs(report): {team-name} session post-mortem\"
  4. Send shutdown requests to all teammates
  5. Then call TeamDelete()

The post-mortem is the only persistent artifact from the team session.
Task data is ephemeral and will be destroyed by TeamDelete."
fi

exit 0
