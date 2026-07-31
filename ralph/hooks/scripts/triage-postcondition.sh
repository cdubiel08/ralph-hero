#!/bin/bash
# ralph/hooks/scripts/triage-postcondition.sh
# Stop: Verify /ralph:caretake --mode triage emitted a terminal token.
#
# Scope-guarded so non-triage caretake modes (hygiene, unblock,
# split, postmortem, retro, trends, debug) pass through cleanly. Reads the
# JSONL transcript for one of the documented TRIAGED tokens or `Queue empty.`
# (see ralph/skills/caretake/outcome-tokens.md). The grep pipeline appends
# `|| true` so the missing-match case under `set -euo pipefail` flows to the
# conservative block path instead of hard-erroring.
#
# Environment:
#   RALPH_FORCE_STOP - If "true", allow stop even if postconditions fail
#
# Exit codes:
#   0 - Postconditions met (or out of scope, or escape hatch active)
#   2 - No triage terminal token emitted, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Scope: /ralph:caretake --mode triage only.
if [[ "${RALPH_COMMAND:-}" != "caretake" ]]; then
  allow
fi
if [[ "${RALPH_SUBCOMMAND:-}" != "triage" ]]; then
  allow
fi

read_input > /dev/null
check_stop_hook_active

# Escape hatch to prevent infinite loops
if [[ "${RALPH_FORCE_STOP:-}" == "true" ]]; then
  warn "RALPH_FORCE_STOP=true - bypassing triage postcondition check"
fi

transcript_path=$(get_field '.transcript_path')
if [[ -z "$transcript_path" ]] || [[ ! -f "$transcript_path" ]]; then
  warn "triage-postcondition: no transcript_path available; allowing"
fi

# Extract assistant text from the JSONL transcript. The grep + jq pipeline is
# pipeline-heavy under set -euo pipefail; append `|| true`.
transcript_text=$(jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text' "$transcript_path" 2>/dev/null || true)

# Match any of the documented terminal tokens. The structured verdicts
# are matched verbatim; the legacy alternations (routed/duplicate/canceled/…) are
# retained for back-compat so older transcripts and the parallel plugin surface
# don't regress. WAIT-pr requires a literal "=NNN" numeric suffix (PR numbers are
# integers) so the branch can't over-match prose or a non-numeric suffix.
if echo "$transcript_text" | grep -qE '^TRIAGED (routed (→ )?.+|duplicate|canceled|needs-split|escalated|re-estimated|skipped|CLOSE-done|CLOSE-canceled|SPLIT|PROMOTE-research|PROMOTE-plan|WAIT-pr=[0-9]+|WAIT-upstream|WAIT-issue=[0-9]+|WAIT-decision)|^Queue empty\.' ; then
  echo "Triage postcondition passed: terminal token found in transcript"
  allow
fi

block "Triage postcondition failed: no terminal token emitted

Expected one of the 9 verdict tokens:
  TRIAGED CLOSE-done                 (closed as done/implemented/duplicate)
  TRIAGED CLOSE-canceled             (closed not_planned)
  TRIAGED SPLIT                      (children created; stays in Backlog)
  TRIAGED PROMOTE-research           (routed to Research Needed)
  TRIAGED PROMOTE-plan               (routed to Ready for Plan)
  TRIAGED WAIT-pr=NNN                (parked in Backlog; blocked:pr-NNN)
  TRIAGED WAIT-upstream              (parked in Backlog; blocked:upstream)
  TRIAGED WAIT-issue=NNN             (moved to Human Needed; add_dependency edge; blocked by OPEN issue)
  TRIAGED WAIT-decision              (escalated to Human Needed)
  Queue empty.                       (no untriaged Backlog issues)

Legacy tokens still accepted: TRIAGED routed → … / duplicate / canceled /
  needs-split / escalated / re-estimated / skipped …

The /ralph:caretake --mode triage body must end by emitting one of these tokens.
See ralph/skills/caretake/outcome-tokens.md for the full contract.

If this is a false positive, re-run with RALPH_FORCE_STOP=true to bypass."
