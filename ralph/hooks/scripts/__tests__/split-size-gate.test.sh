#!/usr/bin/env bash
# ralph/hooks/scripts/__tests__/split-size-gate.test.sh
# split-size-gate.sh must enforce each decomposition path's child-estimate
# contract for both the scalar create_issue payload AND the batch
# create_sub_issues payload (GH-1565: children[].estimate array), while staying
# out of scope for anything outside /ralph:plan --mode epic.
#
# GH-1603: the scope guard is no longer RALPH_SUBCOMMAND (a bare skill-prose
# `export` that never reaches a hook subprocess). It is RALPH_COMMAND=plan plus
# the path classification the hook makes for itself — atomic ceiling {XS,S} by
# default, plan-of-plans ceiling {S,M} once this session has already written a
# thoughts/shared/plans/ doc. Path-arming behavior is covered in depth by
# split-hooks-plan-scope.test.sh; this file covers the estimate rules.

set -euo pipefail

HOOK="$(cd "$(dirname "$0")/.." && pwd)/split-size-gate.sh"

SBX="$(mktemp -d)"
trap 'rm -rf "$SBX"' EXIT
mkdir -p "$SBX/tmp"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# seed_plan_of_plans <session-id> [ticket-number] — record a
# thoughts/shared/plans/ write for that session the way
# artifact-write-tracker.sh does, putting the hook on the plan-of-plans path
# FOR THAT TICKET. The doc name carries the parent number because that is what
# decomposition.md prescribes on both paths (`YYYY-MM-DD-GH-NNNN-...`) and what
# the gate's per-parent scoping keys on (GH-1603 round 9).
seed_plan_of_plans() {
  local sid="$1" ticket="${2:-100}" dir doc
  dir="$SBX/tmp/ralph-session-$sid"
  mkdir -p "$dir" "$SBX/thoughts/shared/plans"
  doc="$SBX/thoughts/shared/plans/2026-07-27-GH-${ticket}-epic-plan-of-plans.md"
  : > "$doc"
  printf '%s\n' "$doc" > "$dir/artifacts.list"
}

# run_case <desc> <expected_exit> <tool_input_json> [ENV=val ...]
# Optional: SESSION_ID env of this function scopes the hook's session ledger.
#
# Exit-code capture uses an if/else around the invocation rather than toggling
# `set +e`/`set -e` (ast-grep set-plus-e-error-masking-bash), matching the
# sibling split-hooks-plan-scope.test.sh harness: $? is captured in both
# branches without ever disabling errexit for the rest of the script.
run_case() {
  local desc="$1" expected="$2" tool_input="$3"; shift 3
  local json actual sid="${SESSION_ID:-case-$((PASS + FAIL))}"
  json=$(jq -n --arg sid "$sid" --argjson ti "$tool_input" '{session_id: $sid, tool_input: $ti}')
  # -u first so the runner's own shell profile (which may export RALPH_*
  # vars — observed RALPH_REVIEW_PLAN on this machine) can't leak into the
  # "unset"/default cases; per-case overrides in "$@" re-set what's needed.
  # TMPDIR is redirected so the session ledger these hooks write lands in the
  # sandbox, not the developer's real temp dir.
  if env -u RALPH_COMMAND -u RALPH_SUBCOMMAND -u RALPH_VALID_SUB_ESTIMATES \
    -u RALPH_VALID_FEATURE_ESTIMATES -u RALPH_MIN_ESTIMATE \
    TMPDIR="$SBX/tmp" RALPH_HOOK_INPUT= "$@" bash "$HOOK" <<<"$json" >/dev/null 2>&1; then
    actual=0
  else
    actual=$?
  fi
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc (exit $actual)"
  else
    fail "$desc — expected exit $expected, got $actual"
  fi
}

# stderr_case <desc> <tool_input_json> <expected-substring> [ENV=val ...]
stderr_case() {
  local desc="$1" tool_input="$2" needle="$3"; shift 3
  local json out sid="msg-$((PASS + FAIL))"
  json=$(jq -n --arg sid "$sid" --argjson ti "$tool_input" '{session_id: $sid, tool_input: $ti}')
  # The hook exits 2 on every case this helper drives (it asserts on BLOCK
  # text), so the assignment is guarded with `|| true` instead of set +e —
  # stderr is what is being asserted, and the exit code is checked by run_case.
  out=$(env -u RALPH_COMMAND -u RALPH_SUBCOMMAND -u RALPH_VALID_SUB_ESTIMATES \
    -u RALPH_VALID_FEATURE_ESTIMATES -u RALPH_MIN_ESTIMATE \
    TMPDIR="$SBX/tmp" RALPH_HOOK_INPUT= "$@" bash "$HOOK" <<<"$json" 2>&1 >/dev/null) || true
  if [[ "$out" == *"$needle"* ]]; then
    pass "$desc"
  else
    fail "$desc — stderr did not contain '$needle'"
  fi
}

echo "=== split-size-gate tests ==="
echo ""

# --- Scope guards ------------------------------------------------------------
run_case "out-of-scope RALPH_COMMAND allows anything" 0 '{"estimate":"XL"}'
run_case "old caretake+split key fully retired (allows)" 0 '{"estimate":"XL"}' \
  RALPH_COMMAND=caretake RALPH_SUBCOMMAND=split
# GH-1603: RALPH_SUBCOMMAND=epic used to DISARM the gate entirely. It must not
# any more — an env var the plan skill cannot actually set is not a waiver.
run_case "stale RALPH_SUBCOMMAND=epic no longer disarms the gate" 2 '{"estimate":"XL"}' \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic

# --- Scalar path (create_issue), atomic ceiling ------------------------------
run_case "scalar: XS allowed" 0 '{"estimate":"XS"}' RALPH_COMMAND=plan
run_case "scalar: S allowed" 0 '{"estimate":"S"}' RALPH_COMMAND=plan
run_case "scalar: M blocked" 2 '{"estimate":"M"}' RALPH_COMMAND=plan
run_case "scalar: L blocked" 2 '{"estimate":"L"}' RALPH_COMMAND=plan
run_case "scalar: XL blocked" 2 '{"estimate":"XL"}' RALPH_COMMAND=plan
# A missing estimate must NOT slip past the ceiling: omitting the field is not
# a waiver of the contract on either decomposition path.
run_case "scalar: no estimate blocked (omission is not a waiver)" 2 '{}' \
  RALPH_COMMAND=plan
run_case "scalar: custom valid-estimates env honored" 0 '{"estimate":"M"}' \
  RALPH_COMMAND=plan RALPH_VALID_SUB_ESTIMATES=XS,S,M

# --- Batch path (create_sub_issues), atomic ceiling --------------------------
run_case "batch: all XS/S allowed" 0 \
  '{"parentNumber":100,"children":[{"title":"a","estimate":"XS"},{"title":"b","estimate":"S"}]}' \
  RALPH_COMMAND=plan
run_case "batch: one M child blocked" 2 \
  '{"parentNumber":100,"children":[{"title":"a","estimate":"XS"},{"title":"b","estimate":"M"}]}' \
  RALPH_COMMAND=plan
run_case "batch: trailing L child blocked" 2 \
  '{"parentNumber":100,"children":[{"title":"a","estimate":"S"},{"title":"b","estimate":"S"},{"title":"c","estimate":"L"}]}' \
  RALPH_COMMAND=plan
run_case "batch: child with no estimate blocked even alongside valid siblings" 2 \
  '{"parentNumber":100,"children":[{"title":"a"},{"title":"b","estimate":"XS"}]}' \
  RALPH_COMMAND=plan
run_case "batch: child with empty-string estimate blocked" 2 \
  '{"parentNumber":100,"children":[{"title":"a","estimate":""},{"title":"b","estimate":"S"}]}' \
  RALPH_COMMAND=plan
run_case "batch: child with whitespace-only estimate blocked" 2 \
  '{"parentNumber":100,"children":[{"title":"a","estimate":"   "},{"title":"b","estimate":"S"}]}' \
  RALPH_COMMAND=plan
run_case "batch: child with null estimate blocked" 2 \
  '{"parentNumber":100,"children":[{"title":"a","estimate":null},{"title":"b","estimate":"S"}]}' \
  RALPH_COMMAND=plan
run_case "batch: empty children array allows" 0 \
  '{"parentNumber":100,"children":[]}' \
  RALPH_COMMAND=plan
run_case "batch: out-of-scope allows even with M child" 0 \
  '{"parentNumber":100,"children":[{"title":"a","estimate":"M"}]}'
run_case "batch: whitespace in RALPH_VALID_SUB_ESTIMATES tokens trimmed" 0 \
  '{"parentNumber":100,"children":[{"title":"a","estimate":"S"}]}' \
  RALPH_COMMAND=plan "RALPH_VALID_SUB_ESTIMATES=XS, S"

# --- Blank estimates must be named "missing", not "too large" ----------------
# CodeRabbit round 8: `select(.estimate != null ...)` swept "" into the
# oversized bucket, so a blank estimate blocked with the wrong diagnosis. The
# unestimated check now runs first and treats blank/whitespace as missing.
stderr_case "blank estimate is diagnosed as MISSING, not 'too large'" \
  '{"parentNumber":100,"children":[{"title":"blank","estimate":""},{"title":"b","estimate":"S"}]}' \
  "Sub-ticket estimate missing" RALPH_COMMAND=plan
stderr_case "an actually-oversized estimate still says 'too large'" \
  '{"parentNumber":100,"children":[{"title":"big","estimate":"XL"},{"title":"b","estimate":"S"}]}' \
  "Sub-ticket estimate too large" RALPH_COMMAND=plan

# --- Plan-of-plans path (session already wrote its doc) ----------------------
seed_plan_of_plans "pop-batch"
SESSION_ID=pop-batch run_case "plan-of-plans: S/M feature children allowed" 0 \
  '{"parentNumber":100,"children":[{"title":"a","estimate":"S"},{"title":"b","estimate":"M"}]}' \
  RALPH_COMMAND=plan
seed_plan_of_plans "pop-xl"
SESSION_ID=pop-xl run_case "plan-of-plans: XL child still blocked" 2 \
  '{"parentNumber":100,"children":[{"title":"a","estimate":"XL"}]}' \
  RALPH_COMMAND=plan
seed_plan_of_plans "pop-scalar"
SESSION_ID=pop-scalar run_case "plan-of-plans: scalar M allowed" 0 '{"estimate":"M"}' \
  RALPH_COMMAND=plan
seed_plan_of_plans "pop-tighten"
SESSION_ID=pop-tighten run_case "epic-split env can only TIGHTEN, never relax" 2 \
  '{"parentNumber":100,"children":[{"title":"a","estimate":"M"}]}' \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split

# --- Unreadable payload must block, not exit non-blocking (GH-1603 F8) -------
if env -u RALPH_COMMAND -u RALPH_SUBCOMMAND TMPDIR="$SBX/tmp" RALPH_HOOK_INPUT='{"tool_input":' \
  RALPH_COMMAND=plan bash "$HOOK" </dev/null >/dev/null 2>&1; then
  malformed_actual=0
else
  malformed_actual=$?
fi
if [[ "$malformed_actual" == "2" ]]; then
  pass "unparsable hook payload blocks (exit 2), not a non-blocking abort"
else
  fail "unparsable hook payload — expected exit 2, got $malformed_actual"
fi

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
