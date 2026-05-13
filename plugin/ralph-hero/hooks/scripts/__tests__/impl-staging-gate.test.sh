#!/usr/bin/env bash
# Tests for impl-staging-gate.sh
# Run: bash plugin/ralph-hero/hooks/scripts/__tests__/impl-staging-gate.test.sh

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/impl-staging-gate.sh"
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
  local cmd="$1"
  jq -nc --arg c "$cmd" '{tool_input:{command:$c}}'
}

echo "Testing $SCRIPT"

echo
echo "Test case 1: RALPH_COMMAND=impl + 'git add path/to/file.ts' -> exit 0 (happy)"
INPUT="$(make_input 'git add path/to/file.ts')"
echo "$INPUT" | env RALPH_COMMAND=impl "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "specific file staging: exit 0"

echo
echo "Test case 2: RALPH_COMMAND=impl + 'git add -A' -> exit 2 (block)"
INPUT="$(make_input 'git add -A')"
echo "$INPUT" | env RALPH_COMMAND=impl "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "2" "$EXIT_CODE" "git add -A: exit 2"

echo
echo "Test case 3: RALPH_COMMAND=impl + 'git add .' -> exit 2 (block)"
INPUT="$(make_input 'git add .')"
echo "$INPUT" | env RALPH_COMMAND=impl "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "2" "$EXIT_CODE" "git add .: exit 2"

echo
echo "Test case 4: RALPH_COMMAND unset + 'git add -A' -> exit 0 (short-circuit)"
INPUT="$(make_input 'git add -A')"
echo "$INPUT" | env -u RALPH_COMMAND "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "non-impl short-circuit: exit 0"

echo
echo "Test case 5: RALPH_COMMAND=impl + 'git add -u' -> exit 0 (allowed flag)"
INPUT="$(make_input 'git add -u')"
echo "$INPUT" | env RALPH_COMMAND=impl "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "git add -u: exit 0"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
