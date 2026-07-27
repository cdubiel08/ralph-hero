#!/usr/bin/env bash
# ralph/hooks/scripts/__tests__/split-hooks-plan-scope.test.sh
# GH-1605 — closes the F1 verification defect from
# thoughts/shared/reviews/2026-07-26-GH-1590-critique.md: the phase's other
# checks (grep counts, re-keyed fixtures that set their own env) all pass
# even when the split-* guards are never armed in plan context. This test
# drives each hook with the ENV the plan skill actually produces
# (RALPH_COMMAND=plan + RALPH_SUBCOMMAND=epic|epic-split, per
# ralph/skills/plan/SKILL.md Step 0 + ralph/skills/plan/decomposition.md
# § Atomic split's re-export), so it fails if either side of the arming
# drifts.
#
# Cases 1, 2, 5, and the static arming assertion are the ones that fail in
# the states the critique identified (guards dead / plan-of-plans regressed).

set -uo pipefail

PASS=0
FAIL=0

# Locate repo root from this script's location (ralph/hooks/scripts/__tests__)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HOOKS_DIR="${REPO_ROOT}/ralph/hooks/scripts"
SIZE_GATE="${HOOKS_DIR}/split-size-gate.sh"
ESTIMATE_GATE="${HOOKS_DIR}/split-estimate-gate.sh"
POSTCONDITION="${HOOKS_DIR}/split-postcondition.sh"

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

for f in "$SIZE_GATE" "$ESTIMATE_GATE" "$POSTCONDITION"; do
  if [[ ! -f "$f" ]]; then
    echo "FATAL: hook not found at $f"
    exit 1
  fi
done

# run_hook <desc> <expected_exit> <hook> <json> [ENV=val ...]
run_hook() {
  local desc="$1" expected="$2" hook="$3" json="$4"; shift 4
  local actual
  set +e
  env -u RALPH_COMMAND -u RALPH_SUBCOMMAND -u RALPH_TICKET_ID -u RALPH_SPLIT_COUNT \
    RALPH_HOOK_INPUT= "$@" bash "$hook" <<<"$json" >/dev/null 2>&1
  actual=$?
  set -e
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc (exit $actual)"
  else
    fail "$desc — expected exit $expected, got $actual"
  fi
}

echo "=== split-hooks-plan-scope tests (GH-1605) ==="
echo ""

# --- Case 1: atomic guard armed — epic-split + M child -> blocked --------------
json_m_child='{"tool_input":{"parentNumber":100,"children":[{"title":"a","estimate":"M"}]}}'
run_hook "1: epic-split + M child -> exit 2 (atomic guard armed)" 2 \
  "$SIZE_GATE" "$json_m_child" \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split

# --- Case 2: plan-of-plans M children unregressed (F2) -------------------------
run_hook "2: epic + M child -> exit 0 (plan-of-plans M children unregressed)" 0 \
  "$SIZE_GATE" "$json_m_child" \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic

# --- Case 3: atomic path allows XS/S ---------------------------------------------
json_xs_s='{"tool_input":{"parentNumber":100,"children":[{"title":"a","estimate":"S"},{"title":"b","estimate":"XS"}]}}'
run_hook "3: epic-split + S/XS children -> exit 0" 0 \
  "$SIZE_GATE" "$json_xs_s" \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split

# --- Case 4: old key fully retired ------------------------------------------------
run_hook "4: old caretake+split key -> exit 0 (fully retired)" 0 \
  "$SIZE_GATE" "$json_m_child" \
  RALPH_COMMAND=caretake RALPH_SUBCOMMAND=split

# --- Case 5: pure plan-of-plans session cannot be blocked by postcondition -----
json_stop='{"hook_event_name":"Stop","stop_hook_active":false}'
run_hook "5: epic + RALPH_TICKET_ID set, no RALPH_SPLIT_COUNT -> exit 0" 0 \
  "$POSTCONDITION" "$json_stop" \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic RALPH_TICKET_ID=GH-1

# --- Case 6: atomic postcondition blocks below the ≥2 threshold ----------------
run_hook "6: epic-split + RALPH_SPLIT_COUNT=1 -> exit 2" 2 \
  "$POSTCONDITION" "$json_stop" \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split RALPH_TICKET_ID=GH-1 RALPH_SPLIT_COUNT=1

# --- Case 7: atomic estimate gate blocks a too-small parent --------------------
json_get_issue_small=$(jq -n '{
  hook_event_name: "PostToolUse",
  tool_response: { content: [ { text: (({number:1,title:"tiny",estimate:"S"}) | tojson) } ] }
}')
run_hook "7: epic-split + parent estimate S -> exit 2 (too small)" 2 \
  "$ESTIMATE_GATE" "$json_get_issue_small" \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split

echo ""

# --- Static arming assertion ----------------------------------------------------
# Extract the required RALPH_SUBCOMMAND value from the hook's own guard
# literal (anchored on REPO_ROOT so this test is runnable from any CWD), then
# assert the plan skill actually exports it somewhere. This is the check that
# fails the moment the Step 0 case export / decomposition.md re-export is
# removed — the exact F1 state.
required=$(sed -n 's/.*RALPH_SUBCOMMAND:-}" != "\([a-z-]*\)".*/\1/p' "$SIZE_GATE" | head -1)
if [[ -z "$required" ]]; then
  fail "extracted required RALPH_SUBCOMMAND value from split-size-gate.sh"
else
  pass "extracted required RALPH_SUBCOMMAND value from split-size-gate.sh: ${required}"
  if grep -rq "export RALPH_SUBCOMMAND=${required}" "${REPO_ROOT}/ralph/skills/plan/"; then
    pass "plan skill exports RALPH_SUBCOMMAND=${required} somewhere under ralph/skills/plan/"
  else
    fail "split guards are not armed in plan context (no 'export RALPH_SUBCOMMAND=${required}' under ralph/skills/plan/)"
  fi
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
if [[ "$FAIL" -eq 0 ]]; then
  exit 0
else
  exit 1
fi
