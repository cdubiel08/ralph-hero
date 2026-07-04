#!/bin/bash
# ralph-hero/hooks/scripts/plan-postcondition.sh
# Stop: Verify /ralph:plan completed successfully — in ANY mode.
#
# Mode discrimination is by artifact path, not env var (Bash-tool exports
# don't propagate to hook subprocesses):
#   - critique doc written under thoughts/shared/reviews/  → review-mode run
#   - plan doc written under thoughts/shared/plans/        → plan-mode run
# Both branches live in THIS script. (Historically they were two scripts —
# plan-postcondition.sh + review-postcondition.sh — coordinating via a
# mirror-image "path mutex"; merging them made the mutex an if/else.)
#
# Artifact discovery is session-scoped first (artifact-write-tracker.sh via
# hook-utils.sh::session_artifacts) so concurrent sessions sharing
# thoughts/shared/ can't cross-trigger, and long sessions don't fall out of
# a freshness window. find_fresh_artifact remains as fallback for docs
# written where the tracker wasn't registered.
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
# phase (Step 3.5 in the plan skill). Mirrors impl-postcondition.sh's
# transcript-inspection pattern — the marker appears inside a JSON
# "text":"..." content field, never at column 0, so no anchor.
TRANSCRIPT_PATH=$(get_field '.transcript_path')
if [[ -n "$TRANSCRIPT_PATH" && -f "$TRANSCRIPT_PATH" ]]; then
  if grep -qE 'PLAN REUSED ' "$TRANSCRIPT_PATH"; then
    echo "plan-postcondition: PLAN REUSED terminal accepted (no new plan file written)"
    exit 0
  fi
fi

ticket_id="${RALPH_TICKET_ID:-}"
if [[ -z "$ticket_id" ]]; then
  allow
fi

project_root=$(get_project_root)
reviews_dir="$project_root/${RALPH_ARTIFACT_DIR:-thoughts/shared/reviews}"
plans_dir="$project_root/thoughts/shared/plans"

# --- Review-mode branch: fresh critique for this ticket ---------------------
critique=$(session_artifacts "thoughts/shared/reviews" "$ticket_id" | tail -1)
if [[ -z "$critique" ]]; then
  critique=$(find_fresh_artifact "$reviews_dir" "$ticket_id" 30)
fi

if [[ -n "$critique" ]]; then
  echo "plan-postcondition (review mode): critique found: $critique"
  uncommitted=$(cd "$project_root" && git status --porcelain "${RALPH_ARTIFACT_DIR:-thoughts/shared/reviews}" 2>/dev/null | head -5 || true)
  if [[ -n "$uncommitted" ]]; then
    echo "WARNING: Uncommitted changes in reviews dir — commit before stopping for graph snapshot accuracy" >&2
  fi
  exit 0
fi

# --- Plan-mode branch --------------------------------------------------------
doc=$(session_artifacts "thoughts/shared/plans" "$ticket_id" | tail -1)
if [[ -z "$doc" ]]; then
  doc=$(find_fresh_artifact "$plans_dir" "$ticket_id" 30)
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

echo "Plan postcondition passed: $doc"
allow
