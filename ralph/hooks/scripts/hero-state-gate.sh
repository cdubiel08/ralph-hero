#!/usr/bin/env bash
# Plan 8: Validate state transitions issued by /ralph:hero.
# Mirrors impl-state-gate.sh:
#   - RALPH_COMMAND scope guard (no-op outside /ralph:hero)
#   - is_semantic_intent passthrough (let __LOCK__, __COMPLETE__, __ESCALATE__,
#     __CLOSE__, __CANCEL__ flow to state-resolution)
#   - valid state allowlist for hero orchestration transitions
#
# Exit codes:
#   0 - Allowed (out of scope, semantic intent, or valid state)
#   2 - Blocked (workflowState not in allowlist)

set -euo pipefail

source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Scope guard — no-op outside /ralph:hero
[[ "${RALPH_COMMAND:-}" == "hero" ]] || exit 0

# save_issue uses `workflowState`; advance_issue uses `targetState`. Try both
# so the hook gates BOTH MCP tools it's registered against (PR #1391 review).
target_state=$(get_field '.tool_input.workflowState')
if [[ -z "$target_state" ]]; then
  target_state=$(get_field '.tool_input.targetState')
fi

# No state change — allow (label-only save_issue, advance_issue without targetState, etc.)
[[ -z "$target_state" ]] && exit 0

# Semantic-intent passthrough — state-resolution.ts handles these
if is_semantic_intent "$target_state"; then
  exit 0
fi

# Valid state allowlist for hero orchestration. Matches the workflow phases
# the orchestrator legitimately drives issues through.
valid_states=(
  "Research Needed"
  "Research in Progress"
  "Ready for Plan"
  "Plan in Progress"
  "Plan in Review"
  "In Progress"
  "In Review"
  "Done"
  "Human Needed"
)

for s in "${valid_states[@]}"; do
  [[ "$target_state" == "$s" ]] && exit 0
done

cat >&2 <<EOF
═══════════════════════════════════════════════════════════════
 [hero-state-gate] BLOCKED

 workflowState='$target_state' is not a valid transition for
 /ralph:hero. Use a semantic intent (__LOCK__, __COMPLETE__,
 __ESCALATE__, __CLOSE__, __CANCEL__) or one of:

 ${valid_states[*]}
═══════════════════════════════════════════════════════════════
EOF
exit 2
