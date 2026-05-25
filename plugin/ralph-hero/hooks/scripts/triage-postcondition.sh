#!/bin/bash
# ralph-hero/hooks/scripts/triage-postcondition.sh
# Stop: Verify triage completed successfully
#
# Checks that the triage skill took a meaningful action on the ticket.
#
# Environment:
#   RALPH_TICKET_ID - Ticket being triaged
#   RALPH_TRIAGE_ACTION - Action taken (set by skill). Structured verdicts (#1417):
#     CLOSE-done, CLOSE-canceled, SPLIT, PROMOTE-research, PROMOTE-plan,
#     WAIT-pr[=NNN], WAIT-upstream[=URL], WAIT-decision.
#     Legacy (still accepted): RESEARCH, CLOSE, HUMAN, CANCEL, RE-ESTIMATE. Bare KEEP is REJECTED (Phase 6 / #1410).
#   RALPH_FORCE_STOP - If "true", allow stop even if postconditions fail (escape hatch)
#
# Exit codes:
#   0 - Postconditions met (or escape hatch active)
#   2 - No triage action taken, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Escape hatch to prevent infinite loops
if [[ "${RALPH_FORCE_STOP:-}" == "true" ]]; then
  warn "RALPH_FORCE_STOP=true - bypassing triage postcondition check"
fi

ticket_id="${RALPH_TICKET_ID:-}"
if [[ -z "$ticket_id" ]]; then
  allow
fi

# Check if the skill recorded its action
triage_action="${RALPH_TRIAGE_ACTION:-}"

if [[ -n "$triage_action" ]]; then
  case "$triage_action" in
    # Structured verdicts (#1417). WAIT-pr/WAIT-upstream accept an optional =NNN/=URL suffix.
    CLOSE-done|CLOSE-canceled|SPLIT|PROMOTE-research|PROMOTE-plan|WAIT-pr|WAIT-pr=*|WAIT-upstream|WAIT-upstream=*|WAIT-decision)
      echo "Triage postcondition passed: $ticket_id -> $triage_action"
      allow
      ;;
    # Legacy palette (KEEP removed in Phase 6 / #1410 — see explicit reject below).
    RESEARCH|CLOSE|HUMAN|CANCEL|RE-ESTIMATE)
      echo "Triage postcondition passed: $ticket_id -> $triage_action (legacy)"
      allow
      ;;
    # Phase 6 (#1410): bare KEEP is the dead-end the structured verdicts replace — reject it (exit 2).
    KEEP)
      block "Bare KEEP is deprecated. Pick a structured verdict — CLOSE-done, CLOSE-canceled, SPLIT, PROMOTE-research, PROMOTE-plan, WAIT-pr=NNN, WAIT-upstream=URL, or WAIT-decision."
      ;;
    *)
      warn "Unknown triage action '$triage_action' for $ticket_id (allowing)"
      ;;
  esac
fi

# No action recorded - block
block "Triage postcondition failed: no action taken

Ticket: $ticket_id
Expected: RALPH_TRIAGE_ACTION set to one of the structured verdicts —
  CLOSE-done, CLOSE-canceled, SPLIT, PROMOTE-research, PROMOTE-plan,
  WAIT-pr[=NNN], WAIT-upstream[=URL], WAIT-decision —
  or a still-accepted legacy value (RESEARCH, CLOSE, HUMAN, CANCEL, RE-ESTIMATE). Bare KEEP is rejected (Phase 6 / #1410).
Found: RALPH_TRIAGE_ACTION not set

The triage skill must take an action (route to research, split, close, etc.) before completing.
If this is a false positive, re-run with RALPH_FORCE_STOP=true to bypass this check."
