#!/usr/bin/env bash
# Tests for lock-claim-validator.sh
# Run: bash plugin/ralph-hero/hooks/scripts/__tests__/lock-claim-validator.test.sh

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/lock-claim-validator.sh"
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
echo "Test case 1: tool_name='Bash' -> exit 0 (allow non-save-issue)"
INPUT='{"tool_name":"Bash","tool_input":{"workflowState":"In Progress"}}'
echo "$INPUT" | RALPH_CURRENT_STATE="In Progress" "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "non-save-issue tool: exit 0"

echo
echo "Test case 2: save_issue + non-lock target 'In Review' -> exit 0 (allow)"
INPUT='{"tool_name":"ralph_hero__save_issue","tool_input":{"workflowState":"In Review"}}'
echo "$INPUT" | RALPH_CURRENT_STATE="In Progress" "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "non-lock target: exit 0"

echo
echo "Test case 3: save_issue + lock target + already locked -> exit 2 (block double-lock)"
INPUT='{"tool_name":"ralph_hero__save_issue","tool_input":{"workflowState":"In Progress","issueNumber":42}}'
echo "$INPUT" | RALPH_CURRENT_STATE="In Progress" "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "2" "$EXIT_CODE" "double-lock: exit 2"

echo
echo "Test case 4: save_issue + lock target + non-lock current state -> exit 0 (allow first-claim)"
INPUT='{"tool_name":"ralph_hero__save_issue","tool_input":{"workflowState":"In Progress","issueNumber":42}}'
echo "$INPUT" | RALPH_CURRENT_STATE="Ready for Plan" "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "first-claim: exit 0"

echo
echo "Test case 5: save_issue + lock target + RALPH_CURRENT_STATE unset -> exit 0 (cannot validate)"
INPUT='{"tool_name":"ralph_hero__save_issue","tool_input":{"workflowState":"In Progress"}}'
echo "$INPUT" | env -u RALPH_CURRENT_STATE "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "current state unset: exit 0"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
