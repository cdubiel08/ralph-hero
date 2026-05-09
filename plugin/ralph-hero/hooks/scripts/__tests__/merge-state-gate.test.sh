#!/usr/bin/env bash
# Tests for merge-state-gate.sh
# Run: bash plugin/ralph-hero/hooks/scripts/__tests__/merge-state-gate.test.sh

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/merge-state-gate.sh"
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

echo "Testing $SCRIPT"

echo
echo "Test case 1: workflowState='Done' -> exit 0 (happy default)"
INPUT='{"tool_input":{"workflowState":"Done"}}'
echo "$INPUT" | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "Done: exit 0"

echo
echo "Test case 2: workflowState='Human Needed' -> exit 0 (happy default)"
INPUT='{"tool_input":{"workflowState":"Human Needed"}}'
echo "$INPUT" | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "Human Needed: exit 0"

echo
echo "Test case 3: workflowState='In Review' -> exit 2 (block — not allowed for merge)"
INPUT='{"tool_input":{"workflowState":"In Review"}}'
echo "$INPUT" | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "2" "$EXIT_CODE" "In Review: exit 2"

echo
echo "Test case 4: empty input (no state field) -> exit 0 (short-circuit)"
INPUT='{"tool_input":{}}'
echo "$INPUT" | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "empty state: exit 0"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
