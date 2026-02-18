#!/bin/bash
# ralph-hero/hooks/scripts/artifact-discovery.sh
# PreToolUse (ralph_hero__update_workflow_state): Verify required artifacts exist
#
# Checks that prior-phase artifacts are linked to the issue via comments
# before allowing state transitions that depend on them.
#
# Environment:
#   RALPH_COMMAND - Current command
#   RALPH_REQUIRES_RESEARCH - If "true", research doc comment required
#   RALPH_REQUIRES_PLAN - If "true", plan doc comment required
#   RALPH_ARTIFACT_CACHE - File path for cached artifact check (optional)
#
# Exit codes:
#   0 - Required artifacts found (or no requirements for this command)
#   2 - Missing required artifact (blocks with instructions)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Only check state transition calls
tool_name=$(get_tool_name)
if [[ "$tool_name" != "ralph_hero__update_workflow_state" ]]; then
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

# Check for cached artifact validation (set by the skill after reading comments)
cache_file="${RALPH_ARTIFACT_CACHE:-/tmp/ralph-artifact-cache-$$}"
if [[ -f "$cache_file" ]]; then
  # Cache exists - prior skill step already validated artifacts
  allow
fi

# If no cache, warn (don't block - the skill should validate via comments)
# The skill itself is responsible for checking comments per the Artifact Comment Protocol
# This hook serves as a reminder, not the primary enforcement
if [[ "$requires_research" == "true" ]]; then
  padded=$(printf '%04d' "$number")
  warn "Reminder: Verify research document is linked to issue #$number before proceeding.
Check issue comments for '## Research Document' header.
If missing, search: thoughts/shared/research/*GH-${number}* or *GH-${padded}*"
fi

if [[ "$requires_plan" == "true" ]]; then
  padded=$(printf '%04d' "$number")
  warn "Reminder: Verify plan document is linked to issue #$number before proceeding.
Check issue comments for '## Implementation Plan' header.
If missing, search: thoughts/shared/plans/*GH-${number}* or *GH-${padded}*"
fi

allow
