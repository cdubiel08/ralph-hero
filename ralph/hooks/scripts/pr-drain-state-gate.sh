#!/usr/bin/env bash
# Plan 8: Validate state transitions issued by /ralph:hero --mode pr-drain.
# Synth issues (kind:pr-drain label) may only transition to:
#   - "In Progress"  (initial — create_issue sets this directly)
#   - "Done"          (terminal-success classes)
#   - "Human Needed"  (terminal-handoff classes: needs-human / merge-failed)
#
# Exit codes:
#   0 - Allowed (out of scope or valid synth transition or semantic intent)
#   2 - Blocked (target state outside the pr-drain allowlist)

set -euo pipefail

source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Scope guard — only fires for /ralph:hero --mode pr-drain
if [[ "${RALPH_COMMAND:-}" != "hero" || "${RALPH_SUBCOMMAND:-}" != "pr-drain" ]]; then
  exit 0
fi

target_state=$(get_field '.tool_input.workflowState')
[[ -z "$target_state" ]] && exit 0

case "$target_state" in
  "In Progress"|"Done"|"Human Needed")
    exit 0
    ;;
esac

# Semantic-intent passthrough (state-resolution.ts handles these)
if is_semantic_intent "$target_state"; then
  exit 0
fi

cat >&2 <<EOF
═══════════════════════════════════════════════════════════════
 [pr-drain-state-gate] BLOCKED

 workflowState='$target_state' is not allowed in pr-drain mode.
 Synth issues may only move to: In Progress, Done, Human Needed.
═══════════════════════════════════════════════════════════════
EOF
exit 2
