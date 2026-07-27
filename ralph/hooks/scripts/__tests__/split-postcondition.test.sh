#!/usr/bin/env bash
# ralph/hooks/scripts/__tests__/split-postcondition.test.sh
# GH-1605 (arming) + GH-1619 (trim). This test used to cover three hooks —
# split-size-gate.sh, split-estimate-gate.sh, and split-postcondition.sh —
# under the plan-scope re-keying (`RALPH_COMMAND=plan` +
# `RALPH_SUBCOMMAND=epic|epic-split`). GH-1619 deleted the first two: the
# child-estimate ceiling they enforced moved server-side into
# `create_sub_issues(maxChildEstimate)` (GH-1618, covered by
# `mcp-server/src/__tests__/tree-tools.test.ts`), and the parent-estimate
# precondition stays a workflow-level judgment call with no technical gate
# (GH-1592 What We're NOT Doing #4). `split-postcondition.sh` (the
# ≥2-children Stop check) is the one hook that survives demotion, still
# registered in `ralph/skills/plan/SKILL.md`'s Stop chain — this file keeps
# exercising it under the real env the plan skill produces, so it fails if
# either side of the arming (the hook's own scope guard, or the skill's
# RALPH_SUBCOMMAND export) drifts.

set -uo pipefail

PASS=0
FAIL=0

# Locate repo root from this script's location (ralph/hooks/scripts/__tests__)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HOOKS_DIR="${REPO_ROOT}/ralph/hooks/scripts"
POSTCONDITION="${HOOKS_DIR}/split-postcondition.sh"

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

if [[ ! -f "$POSTCONDITION" ]]; then
  echo "FATAL: hook not found at $POSTCONDITION"
  exit 1
fi

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

echo "=== split-postcondition plan-scope tests (GH-1605, trimmed GH-1619) ==="
echo ""

json_stop='{"hook_event_name":"Stop","stop_hook_active":false}'

# --- Case 1: pure plan-of-plans session cannot be blocked by postcondition ----
run_hook "1: epic + RALPH_TICKET_ID set, no RALPH_SPLIT_COUNT -> exit 0" 0 \
  "$POSTCONDITION" "$json_stop" \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic RALPH_TICKET_ID=GH-1

# --- Case 2: atomic postcondition blocks below the ≥2 threshold --------------
run_hook "2: epic-split + RALPH_SPLIT_COUNT=1 -> exit 2" 2 \
  "$POSTCONDITION" "$json_stop" \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split RALPH_TICKET_ID=GH-1 RALPH_SPLIT_COUNT=1

# --- Case 3: atomic postcondition passes at exactly the ≥2 threshold ---------
run_hook "3: epic-split + RALPH_SPLIT_COUNT=2 -> exit 0" 0 \
  "$POSTCONDITION" "$json_stop" \
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split RALPH_TICKET_ID=GH-1 RALPH_SPLIT_COUNT=2

# --- Case 4: old caretake+split key fully retired (GH-1605) ------------------
run_hook "4: old caretake+split key -> exit 0 (fully retired, hook scope-guards on plan)" 0 \
  "$POSTCONDITION" "$json_stop" \
  RALPH_COMMAND=caretake RALPH_SUBCOMMAND=split RALPH_TICKET_ID=GH-1 RALPH_SPLIT_COUNT=1

echo ""

# --- Static arming assertion --------------------------------------------------
# Extract the required RALPH_SUBCOMMAND value from the hook's own guard
# literal (anchored on REPO_ROOT so this test is runnable from any CWD), then
# assert the plan skill actually exports it somewhere. This is the check that
# fails the moment the Step 0 case export / decomposition.md re-export is
# removed.
required=$(sed -n 's/.*RALPH_SUBCOMMAND:-}" != "\([a-z-]*\)".*/\1/p' "$POSTCONDITION" | head -1)
if [[ -z "$required" ]]; then
  fail "extracted required RALPH_SUBCOMMAND value from split-postcondition.sh"
else
  pass "extracted required RALPH_SUBCOMMAND value from split-postcondition.sh: ${required}"
  if grep -rq "export RALPH_SUBCOMMAND=${required}" "${REPO_ROOT}/ralph/skills/plan/"; then
    pass "plan skill exports RALPH_SUBCOMMAND=${required} somewhere under ralph/skills/plan/"
  else
    fail "split-postcondition is not armed in plan context (no 'export RALPH_SUBCOMMAND=${required}' under ralph/skills/plan/)"
  fi
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
if [[ "$FAIL" -eq 0 ]]; then
  exit 0
else
  exit 1
fi
