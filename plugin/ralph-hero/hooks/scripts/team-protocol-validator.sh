#!/bin/bash
# ralph-hero/hooks/scripts/team-protocol-validator.sh
# PreToolUse: Validate team protocol for TeamCreate, Agent, and TaskCreate
#
# Enforces:
#   - TeamCreate MUST happen before TaskCreate
#   - Worker names MUST use a role prefix (analyst*, builder*, integrator*)
#   - Agent spawns MUST include team_name
#
# Only active when RALPH_COMMAND=team.
#
# Exit codes:
#   0 - Allow
#   2 - Block with violation message

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Only enforce for team command
if [[ "${RALPH_COMMAND:-}" != "team" ]]; then
  exit 0
fi

read_input > /dev/null
TOOL=$(get_tool_name)

# Marker file keyed to this shell session ($$)
TEAM_MARKER="/tmp/ralph-team-created-$$"

case "$TOOL" in
  TeamCreate)
    # Track team creation for this session
    touch "$TEAM_MARKER"
    exit 0
    ;;

  TaskCreate)
    # Ensure TeamCreate was called before any TaskCreate
    if [[ ! -f "$TEAM_MARKER" ]]; then
      block "TeamCreate MUST be called before TaskCreate

The team must exist before tasks are created.
Call TeamCreate() first, then TaskCreate()."
    fi
    exit 0
    ;;

  Agent)
    # Validate worker name uses a role prefix
    WORKER_NAME=$(get_field '.tool_input.name // empty')
    if [[ -n "$WORKER_NAME" ]]; then
      if ! echo "$WORKER_NAME" | grep -qE '^(analyst|builder|integrator)'; then
        block "Worker name MUST use role prefix (analyst*, builder*, integrator*)

Provided name: \"$WORKER_NAME\"

Valid examples: analyst, analyst-2, builder, builder-primary, integrator
Invalid examples: worker-1, agent, lead

Worker names must begin with the role prefix so the stop gate can
match keyword patterns for remaining task detection."
      fi
    fi

    # Validate team_name is set for team binding
    TEAM_NAME=$(get_field '.tool_input.team_name // empty')
    if [[ -z "$TEAM_NAME" ]]; then
      block "team_name MUST be set for team binding

Worker spawns during a team session must include team_name to bind
the worker to the team's TaskList scope.

Example:
  Agent(subagent_type=\"ralph-builder\", team_name=\"my-team\", name=\"builder\", ...)"
    fi

    exit 0
    ;;

  *)
    exit 0
    ;;
esac
