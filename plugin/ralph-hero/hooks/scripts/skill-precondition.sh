#!/bin/bash
# ralph-hero/hooks/scripts/skill-precondition.sh
# PreToolUse: Validate skill has the context it needs
#
# Runs on first MCP tool call (ralph_hero__get_issue, ralph_hero__list_issues).
# Validates:
# 1. RALPH_COMMAND is set (identifies which skill is running)
# 2. Required env vars are set (RALPH_GH_OWNER, RALPH_GH_REPO, RALPH_GH_PROJECT_NUMBER)
#
# Environment:
#   RALPH_COMMAND - Current command name
#   RALPH_GH_OWNER, RALPH_GH_REPO - Required GitHub config
#   RALPH_GH_PROJECT_NUMBER - Required project number
#
# Exit codes:
#   0 - Preconditions met
#   2 - Missing required context (blocks with instructions)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Validate environment
command="${RALPH_COMMAND:-}"
if [[ -z "$command" ]]; then
  block "Skill precondition failed: RALPH_COMMAND not set

This hook validates that skills have required context.
Ensure the skill has a SessionStart hook that calls set-skill-env.sh with RALPH_COMMAND."
fi

owner="${RALPH_GH_OWNER:-}"
repo="${RALPH_GH_REPO:-}"
if [[ -z "$owner" ]] || [[ -z "$repo" ]]; then
  block "Skill precondition failed: GitHub config missing

RALPH_GH_OWNER: ${owner:-NOT SET}
RALPH_GH_REPO: ${repo:-NOT SET}

Set these in .claude/settings.local.json or .claude/ralph-hero.local.md"
fi

project="${RALPH_GH_PROJECT_NUMBER:-}"
if [[ -z "$project" ]]; then
  block "Skill precondition failed: Project number missing

RALPH_GH_PROJECT_NUMBER: NOT SET

Set this in .claude/settings.local.json"
fi

allow
