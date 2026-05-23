#!/bin/bash
# ralph/hooks/scripts/triage-postcondition.sh
# Stop: Verify /ralph:caretake --mode triage emitted a terminal token.
#
# Plan 6 hardening: scope-guarded so non-triage caretake modes (hygiene, unblock,
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
# pipeline-heavy under set -euo pipefail; append `|| true` per Plan 6 lesson.
transcript_text=$(jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text' "$transcript_path" 2>/dev/null || true)

# Match any of the documented terminal tokens.
if echo "$transcript_text" | grep -qE '^TRIAGED (valid|duplicate|canceled|needs-split)|^Queue empty\.' ; then
  echo "Triage postcondition passed: terminal token found in transcript"
  allow
fi

block "Triage postcondition failed: no terminal token emitted

Expected one of:
  TRIAGED valid         (issue routed to Research Needed / Ready for Plan)
  TRIAGED duplicate     (closed as duplicate)
  TRIAGED canceled      (closed not_planned)
  TRIAGED needs-split   (routed to split queue)
  Queue empty.          (no untriaged Backlog issues)

The /ralph:caretake --mode triage body must end by emitting one of these tokens.
See ralph/skills/caretake/outcome-tokens.md for the full contract.

If this is a false positive, re-run with RALPH_FORCE_STOP=true to bypass."
