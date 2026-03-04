#!/bin/bash
# ralph-hero/hooks/scripts/artifact-discovery.sh
# PreToolUse (ralph_hero__save_issue): Verify required artifacts exist on disk
#
# Checks that prior-phase artifacts are present before allowing state
# transitions that depend on them.
#
# Environment:
#   RALPH_COMMAND - Current command
#   RALPH_REQUIRES_RESEARCH - If "true", research doc required
#   RALPH_REQUIRES_PLAN - If "true", plan doc required
#
# Note: RALPH_ARTIFACT_CACHE was removed — this hook uses direct filesystem checks
# only (no API calls), making session-scoped caching unnecessary.
#
# Exit codes:
#   0 - Required artifacts found (or no requirements for this command)
#   2 - Missing required artifact (blocks with instructions)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Only check state transition calls
tool_name=$(get_tool_name)
if [[ "$tool_name" != "ralph_hero__save_issue" ]]; then
  allow
fi

# Check if this command requires prior artifacts
requires_research="${RALPH_REQUIRES_RESEARCH:-false}"
requires_plan="${RALPH_REQUIRES_PLAN:-false}"

if [[ "$requires_research" != "true" ]] && [[ "$requires_plan" != "true" ]]; then
  allow
fi

# Extract issue number from tool input
number=$(get_field '.tool_input.number')
if [[ -z "$number" ]]; then
  allow  # Can't validate without issue number
fi

project_root="$(get_project_root)"
padded=$(printf '%04d' "$number")

if [[ "$requires_research" == "true" ]]; then
  research_dir="$project_root/thoughts/shared/research"
  research_doc=$(find_existing_artifact "$research_dir" "GH-${padded}")
  if [[ -z "$research_doc" ]]; then
    research_doc=$(find_existing_artifact "$research_dir" "GH-${number}")
  fi
  if [[ -z "$research_doc" ]]; then
    block "Missing research document for issue #$number

Expected: Research document in $research_dir
Search patterns: *GH-${padded}* or *GH-${number}*
Found: None

The planning command requires a research document before transitioning state.
Run /ralph-research $number first."
  fi
fi

if [[ "$requires_plan" == "true" ]]; then
  plans_dir="$project_root/thoughts/shared/plans"
  plan_doc=$(find_existing_artifact "$plans_dir" "GH-${padded}")
  if [[ -z "$plan_doc" ]]; then
    plan_doc=$(find_existing_artifact "$plans_dir" "GH-${number}")
  fi
  if [[ -z "$plan_doc" ]]; then
    block "Missing plan document for issue #$number

Expected: Plan document in $plans_dir
Search patterns: *GH-${padded}* or *GH-${number}*
Found: None

The review command requires a plan document before transitioning state.
Run /ralph-plan $number first."
  fi
fi

allow
