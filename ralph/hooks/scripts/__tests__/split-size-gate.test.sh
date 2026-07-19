#!/usr/bin/env bash
# ralph/hooks/scripts/__tests__/split-size-gate.test.sh
# split-size-gate.sh must block M/L/XL sub-ticket estimates for both the
# scalar create_issue payload AND the batch create_sub_issues payload
# (GH-1565: children[].estimate array), while staying out of scope for
# anything outside caretake --mode split.

set -euo pipefail

HOOK="$(cd "$(dirname "$0")/.." && pwd)/split-size-gate.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# run_case <desc> <expected_exit> <tool_input_json> [ENV=val ...]
run_case() {
  local desc="$1" expected="$2" tool_input="$3"; shift 3
  local json actual
  json=$(jq -n --argjson ti "$tool_input" '{tool_input: $ti}')
  set +e
  # -u first so the runner's own shell profile (which may export RALPH_*
  # vars — observed RALPH_REVIEW_PLAN on this machine) can't leak into the
  # "unset"/default cases; per-case overrides in "$@" re-set what's needed.
  env -u RALPH_COMMAND -u RALPH_SUBCOMMAND -u RALPH_VALID_SUB_ESTIMATES \
    RALPH_HOOK_INPUT= "$@" bash "$HOOK" <<<"$json" >/dev/null 2>&1
  actual=$?
  set -e
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc (exit $actual)"
  else
    fail "$desc — expected exit $expected, got $actual"
  fi
}

echo "=== split-size-gate tests ==="
echo ""

# --- Scope guards ------------------------------------------------------------
run_case "out-of-scope RALPH_COMMAND allows anything" 0 '{"estimate":"XL"}'
run_case "wrong RALPH_SUBCOMMAND allows anything" 0 '{"estimate":"XL"}' \
  RALPH_COMMAND=caretake RALPH_SUBCOMMAND=hygiene

# --- Scalar path (create_issue) ----------------------------------------------
run_case "scalar: XS allowed" 0 '{"estimate":"XS"}' \
  RALPH_COMMAND=caretake RALPH_SUBCOMMAND=split
run_case "scalar: S allowed" 0 '{"estimate":"S"}' \
  RALPH_COMMAND=caretake RALPH_SUBCOMMAND=split
run_case "scalar: M blocked" 2 '{"estimate":"M"}' \
  RALPH_COMMAND=caretake RALPH_SUBCOMMAND=split
run_case "scalar: L blocked" 2 '{"estimate":"L"}' \
  RALPH_COMMAND=caretake RALPH_SUBCOMMAND=split
run_case "scalar: XL blocked" 2 '{"estimate":"XL"}' \
  RALPH_COMMAND=caretake RALPH_SUBCOMMAND=split
run_case "scalar: no estimate allows" 0 '{}' \
  RALPH_COMMAND=caretake RALPH_SUBCOMMAND=split
run_case "scalar: custom valid-estimates env honored" 0 '{"estimate":"M"}' \
  RALPH_COMMAND=caretake RALPH_SUBCOMMAND=split RALPH_VALID_SUB_ESTIMATES=XS,S,M

# --- Batch path (create_sub_issues) ------------------------------------------
run_case "batch: all XS/S allowed" 0 \
  '{"parentNumber":100,"children":[{"title":"a","estimate":"XS"},{"title":"b","estimate":"S"}]}' \
  RALPH_COMMAND=caretake RALPH_SUBCOMMAND=split
run_case "batch: one M child blocked" 2 \
  '{"parentNumber":100,"children":[{"title":"a","estimate":"XS"},{"title":"b","estimate":"M"}]}' \
  RALPH_COMMAND=caretake RALPH_SUBCOMMAND=split
run_case "batch: trailing L child blocked" 2 \
  '{"parentNumber":100,"children":[{"title":"a","estimate":"S"},{"title":"b","estimate":"S"},{"title":"c","estimate":"L"}]}' \
  RALPH_COMMAND=caretake RALPH_SUBCOMMAND=split
run_case "batch: child with no estimate allowed alongside valid siblings" 0 \
  '{"parentNumber":100,"children":[{"title":"a"},{"title":"b","estimate":"XS"}]}' \
  RALPH_COMMAND=caretake RALPH_SUBCOMMAND=split
run_case "batch: empty children array allows" 0 \
  '{"parentNumber":100,"children":[]}' \
  RALPH_COMMAND=caretake RALPH_SUBCOMMAND=split
run_case "batch: out-of-scope allows even with M child" 0 \
  '{"parentNumber":100,"children":[{"title":"a","estimate":"M"}]}'
run_case "batch: whitespace in RALPH_VALID_SUB_ESTIMATES tokens trimmed" 0 \
  '{"parentNumber":100,"children":[{"title":"a","estimate":"S"}]}' \
  RALPH_COMMAND=caretake RALPH_SUBCOMMAND=split "RALPH_VALID_SUB_ESTIMATES=XS, S"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
