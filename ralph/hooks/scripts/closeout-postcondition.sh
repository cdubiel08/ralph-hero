#!/bin/bash
# ralph/hooks/scripts/closeout-postcondition.sh
# Stop: Ensure /ralph:review emitted a terminal verdict before allowing stop.
#
# Mode-discriminated by tool-input shape (Plan 4 lesson: no mid-flow env flipping).
# Scans the transcript for any of the four modes' terminal verdict tokens:
#
#   val mode    — VALIDATION PASS | VALIDATION FIX | VALIDATION FAIL
#   code mode   — CODE REVIEW PASSED | CODE REVIEW ESCALATED | CODE REVIEW BLOCKED
#   merge mode  — MERGED | MERGE BLOCKED | MERGE NOT READY
#   default     — FINISHED | FINISH BLOCKED
#   any mode    — Queue empty. (no-work short-circuit)
#
# Also ports the val-postcondition.sh silent-main-fallback check: if VALIDATION PASS
# appears alongside "Merged to main" but NO worktrees/GH- path token, block — the
# agent fabricated a "validate against main" fallback when the worktree was missing.
#
# Scope: no-op when RALPH_COMMAND != "review" (so this hook doesn't fire from other
# skills' Stop events even if cross-registered).
#
# Exit codes:
#   0 - Terminal verdict found (or stop_hook_active short-circuit, or scope no-op)
#   2 - No recognized verdict in transcript, block stop

set -euo pipefail

INPUT=$(cat)

# Scope: only enforce when invoked from /ralph:review
if [[ "${RALPH_COMMAND:-}" != "review" ]]; then
  exit 0
fi

STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then
  exit 0
fi

TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [[ -z "$TRANSCRIPT_PATH" || ! -f "$TRANSCRIPT_PATH" ]]; then
  echo "closeout-postcondition: transcript not readable; allowing stop conservatively." >&2
  exit 0
fi

VERDICT_TOKENS='VALIDATION PASS|VALIDATION FIX|VALIDATION FAIL|CODE REVIEW PASSED|CODE REVIEW ESCALATED|CODE REVIEW BLOCKED|MERGED|MERGE BLOCKED|MERGE NOT READY|FINISHED|FINISH BLOCKED|Queue empty\.'

if ! grep -qE "$VERDICT_TOKENS" "$TRANSCRIPT_PATH"; then
  cat >&2 <<'EOF'
/ralph:review must emit a terminal verdict before stopping. Expected one of:

  val mode    — VALIDATION PASS | VALIDATION FIX | VALIDATION FAIL
  code mode   — CODE REVIEW PASSED | CODE REVIEW ESCALATED | CODE REVIEW BLOCKED
  merge mode  — MERGED | MERGE BLOCKED | MERGE NOT READY
  default     — FINISHED | FINISH BLOCKED
  any mode    — Queue empty.

Emit the verdict block (with specific check results / fix counts / PR URL) before stopping.
EOF
  exit 2
fi

# Silent-main-fallback check (ported from val-postcondition.sh).
# Specific to val-mode: if VALIDATION PASS appears with "Merged to main" and no
# worktree path, the agent fabricated a fallback when the worktree was missing.
# Per /ralph:review --mode val (plan-vs-impl-rubric.md §Worktree-or-fail), the only
# correct verdict in that case is VALIDATION FAIL.
if grep -q 'VALIDATION PASS' "$TRANSCRIPT_PATH" \
   && grep -q 'Merged to main' "$TRANSCRIPT_PATH" \
   && ! grep -q 'worktrees/GH-' "$TRANSCRIPT_PATH"; then
  cat >&2 <<'EOF'
Detected silent main fallback: VALIDATION PASS emitted with "Merged to main" and no worktree path.

This is a contract violation per plan-vs-impl-rubric.md §Worktree-or-fail.
Emit VALIDATION FAIL with "No worktree found at worktrees/GH-NNN" instead.
EOF
  exit 2
fi

exit 0
