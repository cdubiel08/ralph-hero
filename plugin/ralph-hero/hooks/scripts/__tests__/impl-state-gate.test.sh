#!/usr/bin/env bash
# Tests for impl-state-gate.sh
# Run: bash plugin/ralph-hero/hooks/scripts/__tests__/impl-state-gate.test.sh

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/impl-state-gate.sh"
TEST_DIR="$(mktemp -d)"
trap "rm -rf $TEST_DIR" EXIT

PASS=0
FAIL=0

assert_eq() {
  local expected="$1"
  local actual="$2"
  local msg="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "  PASS: $msg"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $msg"
    echo "    expected: $expected"
    echo "    actual:   $actual"
  fi
}

make_input() {
  local state="$1"
  if [[ -z "$state" ]]; then
    echo '{"tool_input":{}}'
  else
    jq -nc --arg s "$state" '{tool_input:{workflowState:$s}}'
  fi
}

echo "Testing $SCRIPT"

echo
echo "Test case 1: default valid states + 'In Review' -> exit 0 (happy)"
INPUT="$(make_input 'In Review')"
echo "$INPUT" | env -u RALPH_VALID_OUTPUT_STATES "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "default + In Review: exit 0"

echo
echo "Test case 2: default valid states + 'Done' -> exit 2 (block)"
INPUT="$(make_input 'Done')"
echo "$INPUT" | env -u RALPH_VALID_OUTPUT_STATES "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "2" "$EXIT_CODE" "default + Done: exit 2"

echo
echo "Test case 3: empty workflowState -> exit 0 (short-circuit)"
INPUT="$(make_input '')"
echo "$INPUT" | env -u RALPH_VALID_OUTPUT_STATES "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "empty state: exit 0"

echo
echo "Test case 4: custom override 'Done' + 'Done' -> exit 0 (allow)"
INPUT="$(make_input 'Done')"
echo "$INPUT" | env RALPH_VALID_OUTPUT_STATES="Done" "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "custom override Done: exit 0"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
