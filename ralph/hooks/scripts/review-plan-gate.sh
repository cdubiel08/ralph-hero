#!/bin/bash
# PreToolUse:AskUserQuestion — Blocks the plan-review verdict picker when
# RALPH_REVIEW_PLAN=auto.
#
# When the plan review mode is "auto", the pipeline should use the review-agent
# and escalation protocol instead of prompting the human for a verdict. This
# hook enforces that — but ONLY for the review-verdict picker itself
# (plan-review.md § Interactive vs auto). Other AskUserQuestion calls in a
# plan session (iterate-mode confirm-approach, epic clarifications) are
# legitimate even when plan review is auto: hero-dispatched sessions default
# RALPH_REVIEW_PLAN=auto for the whole session, and blocking every prompt
# broke iterate mode (2026-07-04 incident).
#
# Picker detection (content-based, from tool_input on stdin):
#   - any question header equals "Plan Review" (case-insensitive), OR
#   - the option labels contain both an "Approve..." and a "Request changes"
#     entry (the primary picker's signature per plan-review.md).
#
# Decisions-picker naming contract (GH-1544): the decision pickers introduced
# by plan-review.md § Interactive vs auto use `Decision:`-prefixed headers and
# never pair "Approve"/"Request changes" labels, so they pass this detection
# untouched — by design, no bypass logic needed here. The contract lives in
# plan-review.md; this hook's detection is intentionally unchanged.
#
# If RALPH_REVIEW_PLAN is unset, allows (skill hasn't declared a review plan mode).
#
# Exit codes:
#   0 - Allowed (not set, interactive mode, or not the review picker)
#   2 - Blocked (auto mode — review verdict must not come from a human prompt)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

review_plan="${RALPH_REVIEW_PLAN:-}"

[[ "$review_plan" == "auto" ]] || allow

# `|| true`: malformed/missing questions must fail open (allow), not crash
# the hook under set -euo pipefail.
labels=$(printf '%s' "$RALPH_HOOK_INPUT" | jq -r '.tool_input.questions[]?.options[]?.label // empty' 2>/dev/null || true)
headers=$(printf '%s' "$RALPH_HOOK_INPUT" | jq -r '.tool_input.questions[]?.header // empty' 2>/dev/null || true)

is_review_picker=false
if grep -qix "plan review" <<<"$headers"; then
  is_review_picker=true
elif grep -qi "^approve" <<<"$labels" && grep -qi "request changes" <<<"$labels"; then
  is_review_picker=true
fi

[[ "$is_review_picker" == "true" ]] || allow

block "Review plan gate: plan review is auto — use automated review, not a human verdict picker.

Decision pickers (\`Decision:\`-prefixed headers) are allowed — see plan-review.md § Interactive vs auto.

If this is an escalation (architecture, permissions, scope), use the escalation protocol instead:
  ralph_hero__save_issue(number=N, workflowState=\"__ESCALATE__\", command=\"...\")

If you need to report results to the user, use text output instead of AskUserQuestion."
