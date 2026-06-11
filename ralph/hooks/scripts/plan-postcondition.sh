#!/bin/bash
# ralph-hero/hooks/scripts/plan-postcondition.sh
# Stop: Verify plan completed successfully
#
# Exit codes:
#   0 - Postconditions met
#   2 - Postconditions failed, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

# Cache stdin into RALPH_HOOK_INPUT so check_stop_hook_active and get_field
# below can read it. Must NOT use command substitution (`INPUT=$(read_input)`)
# because read_input's `export` would run in a subshell and not persist —
# every other hook in this directory uses the `read_input > /dev/null` form.
read_input > /dev/null
check_stop_hook_active

# Accept PLAN REUSED as a non-error terminal state so ralph-plan can short-
# circuit child plan generation when the parent plan already covers the
# phase (Step 3.5 in ralph-plan/SKILL.md). Mirrors impl-postcondition.sh:25-37
# transcript-inspection pattern — read transcript_path from stdin JSON, grep
# the raw transcript for the marker. Runs BEFORE the ticket/plan-doc check
# so a REUSED early-exit (which does NOT write a plan file) does not trip the
# missing-plan-doc block.
TRANSCRIPT_PATH=$(get_field '.transcript_path')
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

# Path-discriminated mode mutex: if a fresh critique doc exists for this
# ticket under thoughts/shared/reviews/, /ralph:plan was invoked in
# --mode review (not default / auto / epic / iterate). The sibling
# review-postcondition.sh owns that verdict; this hook must no-op so it
# does not hard-block on a missing plan doc when the artifact correctly
# landed in reviews/ instead.
#
# Mirrors review-postcondition.sh's mode-discrimination block. Together
# they form a path-based mutex that does not depend on env-var
# propagation (which the Bash tool's per-call subshell breaks).
project_root=$(get_project_root)
reviews_dir="$project_root/thoughts/shared/reviews"
if [[ -d "$reviews_dir" ]]; then
  critique=$(find "$reviews_dir" -name "*${ticket_id}*" -type f -mmin -30 2>/dev/null | head -1 || true)
  if [[ -z "$critique" ]]; then
    alt_ticket_id=$(ticket_id_alt_form "$ticket_id")
    if [[ -n "$alt_ticket_id" ]]; then
      critique=$(find "$reviews_dir" -name "*${alt_ticket_id}*" -type f -mmin -30 2>/dev/null | head -1 || true)
    fi
  fi
  if [[ -n "$critique" ]]; then
    echo "plan-postcondition: deferring to review-postcondition (fresh critique at $critique)"
    exit 0
  fi
fi

plans_dir="$project_root/thoughts/shared/plans"
# `|| true`: a missing plans dir must mean "no doc" (block below), not a
# pipefail+set-e silent crash. Same guard as the reviews find above.
doc=$(find "$plans_dir" -name "*${ticket_id}*" -type f -mmin -30 2>/dev/null | head -1 || true)

if [[ -z "$doc" ]]; then
  alt_ticket_id=$(ticket_id_alt_form "$ticket_id")
  if [[ -n "$alt_ticket_id" ]]; then
    doc=$(find "$plans_dir" -name "*${alt_ticket_id}*" -type f -mmin -30 2>/dev/null | head -1 || true)
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
