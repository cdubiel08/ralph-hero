#!/bin/bash
# ralph/hooks/scripts/review-postcondition.sh
# Stop: Verify /ralph:plan --mode review wrote a critique doc.
#
# Exit codes:
#   0 - Postconditions met (or not in review mode — no-op)
#   2 - Postconditions failed, block

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null
check_stop_hook_active

# --- Mode discrimination (path-based, NOT env-var based) ---
#
# Originally this hook was gated by RALPH_SUBCOMMAND=review set in the
# /ralph:plan --mode review body via Bash export. Claude Code's Bash tool
# runs each invocation in a fresh subshell, so the export does NOT
# reliably propagate to the Stop hook subprocess (see doc-structure-
# validator.sh:18-22 for the original lesson). The fix: discriminate by
# whether a fresh critique doc was actually written under
# thoughts/shared/reviews/ for this ticket. If yes → this was a review-
# mode run, validate. If no → some other plan mode (default / auto / epic
# / iterate) is active, no-op.
#
# The sibling plan-postcondition.sh applies the mirror pattern: it no-ops
# when a fresh critique exists (i.e. when WE are responsible for the
# postcondition check). The two hooks form a path-based mode mutex.
#
# "Fresh" = modified within the last 30 minutes (matches plan-postcondition's
# -mmin -30 window).

TICKET_ID="${RALPH_TICKET_ID:-}"
ARTIFACT_DIR="${RALPH_ARTIFACT_DIR:-thoughts/shared/reviews}"
project_root=$(get_project_root)
reviews_dir="$project_root/$ARTIFACT_DIR"

# Resolve a "did review-mode actually write something" signal by looking
# for a recent critique file. Append `|| true` so an empty/missing dir or
# any other find failure under pipefail does not crash the hook.
critique=""
if [[ -n "$TICKET_ID" && -d "$reviews_dir" ]]; then
  critique=$(find "$reviews_dir" -name "*${TICKET_ID}*" -type f -mmin -30 2>/dev/null | head -1 || true)
  if [[ -z "$critique" ]]; then
    alt_ticket_id=$(ticket_id_alt_form "$TICKET_ID")
    if [[ -n "$alt_ticket_id" ]]; then
      critique=$(find "$reviews_dir" -name "*${alt_ticket_id}*" -type f -mmin -30 2>/dev/null | head -1 || true)
    fi
  fi
fi

# Plan-mode parallel artifact check: if a fresh plan doc exists for this
# ticket but NO fresh critique, we're in plan-mode (default/auto/epic/
# iterate) — no-op and let plan-postcondition own the verdict.
plans_dir="$project_root/thoughts/shared/plans"
plan_doc=""
if [[ -n "$TICKET_ID" && -d "$plans_dir" ]]; then
  plan_doc=$(find "$plans_dir" -name "*${TICKET_ID}*" -type f -mmin -30 2>/dev/null | head -1 || true)
fi

# Discriminate:
#   - critique present → review-mode → validate (below).
#   - no critique, but plan doc present → plan-mode → no-op (let plan-postcondition handle).
#   - neither → no-op (e.g. /ralph:plan was invoked without a ticket, or
#     this hook is firing in a non-plan context). plan-postcondition has
#     its own missing-doc block.
if [[ -z "$critique" ]]; then
  exit 0
fi

# --- Review-mode validation ---
#
# At this point we know a fresh critique exists in $reviews_dir. Verify
# the rest of the postcondition: critique is non-empty, committed, no
# uncommitted noise in the artifact dir.

# REVIEW_PLAN default mirrors /ralph:plan SKILL.md Step 4 picker default
# (interactive). Source-plugin default was 'auto' but the slim-plugin
# review-mode picker biases toward AskUserQuestion when unset — so an
# unset env var should NOT demand a critique doc (which the picker may
# legitimately skip on a 'Need more info' exit). Critique-doc requirement
# is now conditioned on critique presence above, not on REVIEW_PLAN.
REVIEW_PLAN="${RALPH_REVIEW_PLAN:-interactive}"

PASSED=()
FAILED=()
WARNINGS=()

PASSED+=("Critique document found: $critique")

# Verify the critique is committed (or warn if not).
uncommitted=$(cd "$project_root" && git status --porcelain "$ARTIFACT_DIR" 2>/dev/null | head -5 || true)
if [[ -n "$uncommitted" ]]; then
  WARNINGS+=("Uncommitted changes in $ARTIFACT_DIR — commit before stopping for graph snapshot accuracy")
fi

echo "==================================================================="
echo "              /ralph:plan --mode review Postcondition Check"
echo "==================================================================="
echo ""
echo "Ticket: ${TICKET_ID:-unknown}"
echo "Mode: $REVIEW_PLAN"
echo "Critique: $critique"
echo ""

if [[ ${#PASSED[@]} -gt 0 ]]; then
  echo "PASSED:"
  for item in "${PASSED[@]}"; do
    echo "  [OK] $item"
  done
  echo ""
fi

if [[ ${#WARNINGS[@]} -gt 0 ]]; then
  echo "WARNINGS:"
  for item in "${WARNINGS[@]}"; do
    echo "  [WARN] $item"
  done
  echo ""
fi

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "FAILED:" >&2
  for item in "${FAILED[@]}"; do
    echo "  [FAIL] $item" >&2
  done
  echo "" >&2
  echo "ACTION REQUIRED: Address failures before completing." >&2
  echo "==================================================================" >&2
  exit 2
fi

echo "==================================================================="
exit 0
