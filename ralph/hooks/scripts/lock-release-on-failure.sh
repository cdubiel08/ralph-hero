#!/bin/bash
# ralph-hero/hooks/scripts/lock-release-on-failure.sh
# Stop hook: Advise lock release when a skill stops with a lock state active
#
# When a skill that acquired a lock state (Research in Progress, Plan in Progress, In Progress)
# stops unexpectedly, this hook advises releasing the lock back to its pre-lock state.
#
# Requires env vars set by skill:
#   RALPH_COMMAND     - Current skill command (research, plan, impl)
#   RALPH_TICKET_ID   - Issue identifier (GH-NNN or raw number)
#   RALPH_LOCK_STATE  - Lock state acquired by this skill (optional; derived from RALPH_COMMAND if absent)
#
# Lock release mappings (per spec):
#   Research in Progress -> Research Needed
#   Plan in Progress     -> Ready for Plan
#   In Progress          -> stays In Progress (spec: no rollback on impl failure)
#
# Exit codes:
#   0 - No action needed or advisory output provided

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"

STATE_MACHINE="$SCRIPT_DIR/ralph-state-machine.json"

command="${RALPH_COMMAND:-}"
ticket_id="${RALPH_TICKET_ID:-}"

# Only run if we were in a skill context with a known ticket
if [[ -z "$command" ]] || [[ -z "$ticket_id" ]]; then
  exit 0
fi

if [[ ! -f "$STATE_MACHINE" ]]; then
  exit 0
fi

# Determine the expected lock state for this command
lock_state="${RALPH_LOCK_STATE:-}"
if [[ -z "$lock_state" ]]; then
  case "$command" in
    research) lock_state="Research in Progress" ;;
    plan)     lock_state="Plan in Progress" ;;
    impl)     lock_state="In Progress" ;;
    *)        exit 0 ;;
  esac
fi

# Verify lock_state is actually a lock state in the state machine
is_lock=$(jq -r --arg state "$lock_state" '.states[$state].is_lock_state // false' "$STATE_MACHINE")
if [[ "$is_lock" != "true" ]]; then
  exit 0
fi

# Determine the release target state
case "$lock_state" in
  "Research in Progress") release_state="Research Needed" ;;
  "Plan in Progress")     release_state="Ready for Plan" ;;
  "In Progress")
    # Spec: In Progress stays In Progress on failure (no rollback)
    exit 0
    ;;
  *) exit 0 ;;
esac

# Extract issue number from ticket_id (GH-NNN -> NNN)
issue_number=$(echo "$ticket_id" | grep -oE '[0-9]+' | head -1)
if [[ -z "$issue_number" ]]; then
  exit 0
fi

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "additionalContext": "LOCK RELEASE NEEDED: Skill '${command}' stopped while issue ${ticket_id} was in lock state '${lock_state}'. The lock must be released to '${release_state}' to allow other agents to process this ticket.\n\nTo release: call ralph_hero__save_issue with issueNumber=${issue_number} and workflowState='${release_state}'"
  }
}
EOF
exit 0
