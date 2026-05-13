#!/usr/bin/env bash
# Tests for impl-postcondition.sh
# Run: bash plugin/ralph-hero/hooks/scripts/__tests__/impl-postcondition.test.sh

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/impl-postcondition.sh"
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
echo "Test case 1: RALPH_COMMAND unset -> exit 0 (short-circuit)"
( unset RALPH_COMMAND RALPH_TICKET_ID; echo '{}' | "$SCRIPT" >/dev/null 2>&1 )
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "RALPH_COMMAND unset: exit 0"

echo
echo "Test case 2: non-impl command short-circuits regardless of other env"
echo '{}' | RALPH_COMMAND=research RALPH_TICKET_ID=GH-99999 "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "non-impl command: exit 0"

echo
echo "Test case 3: RALPH_COMMAND=impl + RALPH_TICKET_ID=GH-99999 with no matching worktree -> exit 2 (block)"
# cwd is TEST_DIR (not a git repo) so PROJECT_ROOT falls back to cwd; no worktrees/GH-99999 dir.
( cd "$TEST_DIR" && echo '{}' | RALPH_COMMAND=impl RALPH_TICKET_ID=GH-99999 "$SCRIPT" >/dev/null 2>&1 )
EXIT_CODE=$?
assert_eq "2" "$EXIT_CODE" "no matching worktree: exit 2"

echo
echo "Test case 4: RALPH_COMMAND=impl + worktree dir exists -> exit 0 (allow)"
mkdir -p "$TEST_DIR/worktrees/GH-99999"
( cd "$TEST_DIR" && echo '{}' | RALPH_COMMAND=impl RALPH_TICKET_ID=GH-99999 "$SCRIPT" >/dev/null 2>&1 )
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "worktree exists: exit 0"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
