#!/bin/bash
# PreToolUse:AskUserQuestion — Blocks human prompts when RALPH_REVIEW_PLAN=auto.
#
# When the plan review mode is "auto", the pipeline should use the review-agent
# and escalation protocol instead of prompting the human. This hook enforces that.
#
# If RALPH_REVIEW_PLAN is unset, allows (skill hasn't declared a review plan mode).
#
# Exit codes:
#   0 - Allowed (not set, or interactive mode)
#   2 - Blocked (auto mode — should not prompt human)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

review_plan="${RALPH_REVIEW_PLAN:-}"

# If not set, allow (skill hasn't declared a review plan mode)
[[ -n "$review_plan" ]] || { allow; }

if [[ "$review_plan" == "auto" ]]; then
  block "Review plan gate: plan review is auto — use automated review, not human prompts.

If this is an escalation (architecture, permissions, scope), use the escalation protocol instead:
  ralph_hero__save_issue(number=N, workflowState=\"__ESCALATE__\", command=\"...\")

If you need to report results to the user, use text output instead of AskUserQuestion."
fi

allow
