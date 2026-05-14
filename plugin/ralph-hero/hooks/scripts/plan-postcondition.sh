#!/bin/bash
# ralph-hero/hooks/scripts/plan-postcondition.sh
# Stop: Verify plan completed successfully
#
# Exit codes:
#   0 - Postconditions met
#   2 - Postconditions failed, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Capture the input JSON (rather than discarding) so we can inspect the
# transcript for a "PLAN REUSED" verdict prefix below. read_input caches
# its result via RALPH_HOOK_INPUT, so subsequent get_field calls (if any are
# added later) still work.
INPUT=$(read_input)

# Accept PLAN REUSED as a non-error terminal state so ralph-plan can short-
# circuit child plan generation when the parent plan already covers the
# phase (Step 3.5 in ralph-plan/SKILL.md). Mirrors impl-postcondition.sh:25-37
# transcript-inspection pattern — read transcript_path from stdin JSON, grep
# the raw transcript for the marker. Runs BEFORE the ticket/plan-doc check
# so a REUSED early-exit (which does NOT write a plan file) does not trip the
# missing-plan-doc block.
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
if [[ -n "$TRANSCRIPT_PATH" && -f "$TRANSCRIPT_PATH" ]]; then
  # Match the marker anywhere in the transcript file (mirrors
  # impl-postcondition.sh:33 which also greps the JSONL transcript without
  # anchoring — the marker appears inside a JSON "text":"..." content field,
  # never at column 0, so a "^PLAN REUSED " anchor would never fire).
  if grep -qE 'PLAN REUSED ' "$TRANSCRIPT_PATH"; then
    echo "plan-postcondition: PLAN REUSED terminal accepted (no new plan file written)"
    exit 0
  fi
fi

ticket_id="${RALPH_TICKET_ID:-}"
if [[ -z "$ticket_id" ]]; then
  allow
fi

plans_dir="$(get_project_root)/thoughts/shared/plans"
doc=$(find "$plans_dir" -name "*${ticket_id}*" -type f -mmin -30 2>/dev/null | head -1)

if [[ -z "$doc" ]]; then
  alt_ticket_id=$(ticket_id_alt_form "$ticket_id")
  if [[ -n "$alt_ticket_id" ]]; then
    doc=$(find "$plans_dir" -name "*${alt_ticket_id}*" -type f -mmin -30 2>/dev/null | head -1)
  fi
fi

if [[ -z "$doc" ]]; then
  block "Plan postcondition failed

Expected: Plan document for $ticket_id
Found: None in $plans_dir

The plan command must create a plan document.
Check the command output for errors."
fi

if ! git log --oneline -1 --all -- "$doc" 2>/dev/null | grep -q .; then
  warn "Plan doc exists but may not be committed: $doc"
fi

# Check for artifact comment marker (Gap 3: discovery sequence)
marker_dir="/tmp/ralph-artifact-markers"
issue_number=$(echo "$ticket_id" | grep -oE '[0-9]+' | head -1)
if [[ -n "$issue_number" ]] && [[ ! -f "$marker_dir/artifact-comment-${issue_number}" ]]; then
  echo "WARNING: Artifact comment marker absent for #${issue_number} — '## Implementation Plan' comment may not have been posted." >&2
fi

# --- Dependency graph sync check ---
# If the plan has depends_on annotations, verify sync_plan_graph was called.
# We check for a marker file that the sync_plan_graph tool creates on success,
# since the hook runs in bash without MCP access.
if grep -q 'depends_on.*\[' "$doc" 2>/dev/null; then
  log_file="/tmp/ralph-plan-sync-${ticket_id}"
  if [[ ! -f "$log_file" ]]; then
    echo "WARNING: Plan has depends_on annotations but sync_plan_graph may not have been called." >&2
    echo "   Run: ralph_hero__sync_plan_graph({ planPath: \"$doc\" })" >&2
    # Non-blocking warning for now — upgrade to block once proven reliable
  fi
fi

echo "Plan postcondition passed: $doc"
allow
