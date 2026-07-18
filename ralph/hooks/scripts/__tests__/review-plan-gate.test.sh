#!/usr/bin/env bash
# ralph/hooks/scripts/__tests__/review-plan-gate.test.sh
# The gate must block ONLY the plan-review verdict picker under
# RALPH_REVIEW_PLAN=auto — not every AskUserQuestion in the session.
# Regression: iterate-mode's confirm-approach prompt was blocked whenever a
# hero-dispatched session carried RALPH_REVIEW_PLAN=auto (2026-07-04).

set -euo pipefail

HOOK="$(cd "$(dirname "$0")/.." && pwd)/review-plan-gate.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# run_case <desc> <expected_exit> <questions_json> [ENV=val ...]
run_case() {
  local desc="$1" expected="$2" questions="$3"; shift 3
  local json actual
  json=$(jq -n --argjson q "$questions" '{tool_input: {questions: $q}}')
  set +e
  # -u first so the runner's own environment (which may export
  # RALPH_REVIEW_PLAN) can't leak into the "unset" case; per-case
  # overrides in "$@" re-set it afterwards.
  env -u RALPH_REVIEW_PLAN RALPH_HOOK_INPUT= "$@" bash "$HOOK" <<<"$json" >/dev/null 2>&1
  actual=$?
  set -e
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc (exit $actual)"
  else
    fail "$desc — expected exit $expected, got $actual"
  fi
}

REVIEW_PICKER='[{"question":"Plan review verdict for #123?","header":"Plan Review","options":[{"label":"Approve"},{"label":"Approve with edits"},{"label":"Request changes"},{"label":"Open in editor"}]}]'
ITERATE_PROMPT='[{"question":"Apply the surgical edit to Phase 2?","header":"Approach","options":[{"label":"Yes, edit Phase 2"},{"label":"No, add a new phase"}]}]'
HEADERLESS_PICKER='[{"question":"Verdict?","header":"Verdict","options":[{"label":"Approve"},{"label":"Request changes"}]}]'
# Decisions-picker naming contract (GH-1544): Decision:-prefixed header, no
# Approve/Request-changes label pair — must pass untouched under auto.
DECISION_PICKER='[{"question":"Where should plans awaiting a decision park?","header":"Decision: park location","options":[{"label":"Plan in Review + comment"},{"label":"Human Needed escalation"}]}]'
CONFIRM_PICKER='[{"question":"Plan review verdict for #123?","header":"Plan Review","options":[{"label":"Approve"},{"label":"Request changes"},{"label":"Open in editor"}]}]'

echo "=== review-plan-gate tests ==="
echo ""

run_case "unset RALPH_REVIEW_PLAN allows the review picker" 0 "$REVIEW_PICKER"
run_case "interactive mode allows the review picker" 0 "$REVIEW_PICKER" RALPH_REVIEW_PLAN=interactive
run_case "auto mode blocks the review picker (header match)" 2 "$REVIEW_PICKER" RALPH_REVIEW_PLAN=auto
run_case "auto mode blocks an Approve/Request-changes picker without the header" 2 "$HEADERLESS_PICKER" RALPH_REVIEW_PLAN=auto
run_case "auto mode ALLOWS an unrelated question (iterate confirm-approach)" 0 "$ITERATE_PROMPT" RALPH_REVIEW_PLAN=auto
run_case "auto mode ALLOWS a Decision:-header picker (naming contract)" 0 "$DECISION_PICKER" RALPH_REVIEW_PLAN=auto
run_case "auto mode blocks the 3-option confirm picker (Plan Review header)" 2 "$CONFIRM_PICKER" RALPH_REVIEW_PLAN=auto
run_case "unset RALPH_REVIEW_PLAN allows the decision picker too" 0 "$DECISION_PICKER"

# Malformed input fails open
set +e
env -u RALPH_REVIEW_PLAN RALPH_HOOK_INPUT= RALPH_REVIEW_PLAN=auto bash "$HOOK" <<<'{"tool_input":{}}' >/dev/null 2>&1
ec=$?
set -e
[[ "$ec" == "0" ]] && pass "auto mode with no questions payload allows (fails open)" \
  || fail "no questions payload — expected 0, got $ec"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
