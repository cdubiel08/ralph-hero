#!/bin/bash
# ralph-hero/hooks/scripts/plan-tier-validator.sh
# PreToolUse (ralph_hero__save_issue): Validate plan type matches issue tier
#
# Environment:
#   RALPH_COMMAND - Must be "plan" or "plan_epic" for this hook to activate
#   RALPH_PLAN_TYPE - "plan" or "plan-of-plans" (set by planning skill)
#
# Exit codes:
#   0 - Valid or not applicable
#   2 - Plan type mismatch, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Only activate for planning commands
case "${RALPH_COMMAND:-}" in
  plan|plan_epic) ;;
  *) allow ;;
esac

read_input > /dev/null

plan_type="${RALPH_PLAN_TYPE:-}"
if [[ -z "$plan_type" ]]; then
  allow  # Can't validate without plan type
fi

# Validate: ralph_plan_epic should produce plan-of-plans, ralph_plan should produce plan
case "${RALPH_COMMAND}" in
  plan_epic)
    if [[ "$plan_type" != "plan-of-plans" ]]; then
      block "Plan type mismatch: ralph_plan_epic should produce type 'plan-of-plans', not '$plan_type'"
    fi
    ;;
  plan)
    if [[ "$plan_type" == "plan-of-plans" ]]; then
      block "Plan type mismatch: ralph_plan should produce type 'plan', not 'plan-of-plans'. Use ralph_plan_epic for plan-of-plans."
    fi
    ;;
esac

allow
