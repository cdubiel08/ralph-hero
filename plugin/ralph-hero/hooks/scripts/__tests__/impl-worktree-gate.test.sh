#!/usr/bin/env bash
# Tests for impl-worktree-gate.sh
# Run: bash plugin/ralph-hero/hooks/scripts/__tests__/impl-worktree-gate.test.sh

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/impl-worktree-gate.sh"
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
  local fp="$1"
  jq -nc --arg p "$fp" '{tool_input:{file_path:$p}}'
}

echo "Testing $SCRIPT"

echo
echo "Test case 1: RALPH_COMMAND unset -> exit 0 (short-circuit)"
INPUT="$(make_input '/anywhere/foo.ts')"
echo "$INPUT" | env -u RALPH_COMMAND "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "non-impl short-circuit: exit 0"

echo
echo "Test case 2: RALPH_COMMAND=impl + thoughts/ path -> exit 0 (allow research artifact)"
INPUT="$(make_input '/abs/thoughts/foo.md')"
echo "$INPUT" | RALPH_COMMAND=impl "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "thoughts/ path: exit 0"

echo
echo "Test case 3: RALPH_COMMAND=impl + file inside RALPH_WORKTREE_PATHS -> exit 0 (allow)"
INPUT="$(make_input '/tmp/wt-1/src/foo.ts')"
echo "$INPUT" | RALPH_COMMAND=impl RALPH_WORKTREE_PATHS=/tmp/wt-1 "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "in-worktree path: exit 0"

echo
echo "Test case 4: RALPH_COMMAND=impl + file outside worktree -> exit 2 (block)"
INPUT="$(make_input '/tmp/other/foo.ts')"
( cd /tmp && echo "$INPUT" | RALPH_COMMAND=impl RALPH_WORKTREE_PATHS=/tmp/wt-1 "$SCRIPT" >/dev/null 2>&1 )
EXIT_CODE=$?
assert_eq "2" "$EXIT_CODE" "out-of-worktree path: exit 2"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
