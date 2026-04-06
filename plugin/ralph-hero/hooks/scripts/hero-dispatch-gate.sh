#!/bin/bash
# PreToolUse:Skill — Ensures hero passes --review-plan to child skills that need it.
#
# Only fires when RALPH_COMMAND=hero. Checks Skill() calls to ralph-plan,
# ralph-plan-epic, and ralph-review for the required --review-plan argument.
#
# Exit codes:
#   0 - Allowed (not hero, or arg present, or skill doesn't need it)
#   2 - Blocked (hero dispatching a plan/review skill without --review-plan)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Only applies when RALPH_COMMAND=hero
[[ "${RALPH_COMMAND:-}" == "hero" ]] || { allow; }

tool_input=$(get_tool_input)
skill_name=$(echo "$tool_input" | jq -r '.skill // empty')
args=$(echo "$tool_input" | jq -r '.args // empty')

# Skills that need --review-plan context
case "$skill_name" in
  ralph-hero:ralph-plan|ralph-hero:ralph-plan-epic|ralph-hero:ralph-review)
    if ! echo "$args" | grep -q -- '--review-plan'; then
      block "Hero dispatch gate: $skill_name requires --review-plan argument.

Add --review-plan to the Skill() args, e.g.:
  Skill(\"$skill_name\", args=\"NNN --review-plan auto\")"
    fi
    ;;
esac

allow
