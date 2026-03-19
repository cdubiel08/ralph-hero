#!/bin/bash
# ralph-hero/hooks/scripts/team-postmortem-completeness.sh
# PreToolUse: Validate post-mortem content before TeamDelete
#
# Checks that the post-mortem file contains required frontmatter fields
# and body sections. File existence is checked by team-shutdown-validator.sh
# which runs first — this hook assumes the file exists.
#
# Only active when RALPH_COMMAND=team.
#
# Exit codes:
#   0 - All required content present, or not in team command context
#   2 - Missing required fields/sections, block TeamDelete

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
TEAM_MARKER="/tmp/ralph-team-created-$(echo "$(get_project_root)" | md5sum | cut -d' ' -f1)"
TODAY=$(date +%Y-%m-%d)

# Locate the post-mortem file (same logic as team-shutdown-validator.sh)
POSTMORTEM=""
if [[ -d "$REPORTS_DIR" ]]; then
  if [[ -f "$TEAM_MARKER" ]]; then
    POSTMORTEM=$(find "$REPORTS_DIR" -name "*ralph-team*" -newer "$TEAM_MARKER" -type f 2>/dev/null | head -1)
  fi
  if [[ -z "$POSTMORTEM" ]]; then
    POSTMORTEM=$(find "$REPORTS_DIR" -name "${TODAY}-ralph-team*" -type f 2>/dev/null | head -1)
  fi
fi

# If no file found, team-shutdown-validator.sh will block — exit cleanly here
if [[ -z "$POSTMORTEM" ]]; then
  exit 0
fi

# Check required frontmatter fields
MISSING_FIELDS=()
for field in "type:" "status:" "github_issue:" "team_name:"; do
  if ! grep -q "^${field}" "$POSTMORTEM" 2>/dev/null; then
    MISSING_FIELDS+=("$field")
  fi
done

# Check required body sections
MISSING_SECTIONS=()
for section in "## Artifacts" "## Blockers" "## Impediments" "## Issues Processed" "## Worker Summary"; do
  if ! grep -qF "$section" "$POSTMORTEM" 2>/dev/null; then
    MISSING_SECTIONS+=("$section")
  fi
done

# Build error message if anything is missing using $'\n' for real newlines in Bash
if [[ ${#MISSING_FIELDS[@]} -gt 0 || ${#MISSING_SECTIONS[@]} -gt 0 ]]; then
  MSG="Post-mortem at ${POSTMORTEM} is incomplete."
  if [[ ${#MISSING_FIELDS[@]} -gt 0 ]]; then
    MSG+=$'\n\n'"Missing frontmatter fields:"
    for f in "${MISSING_FIELDS[@]}"; do
      MSG+=$'\n'"  - ${f}"
    done
  fi
  if [[ ${#MISSING_SECTIONS[@]} -gt 0 ]]; then
    MSG+=$'\n\n'"Missing body sections:"
    for s in "${MISSING_SECTIONS[@]}"; do
      MSG+=$'\n'"  - ${s}"
    done
  fi
  MSG+=$'\n\n'"Regenerate using the ralph-hero:ralph-postmortem skill."
  block "$MSG"
fi

exit 0
