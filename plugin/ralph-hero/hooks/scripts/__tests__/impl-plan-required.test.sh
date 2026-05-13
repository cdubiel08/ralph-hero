#!/usr/bin/env bash
# Tests for impl-plan-required.sh
# Run: bash plugin/ralph-hero/hooks/scripts/__tests__/impl-plan-required.test.sh

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/impl-plan-required.sh"
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

# Use TEST_DIR as a synthetic project root with no plans, to ensure
# the gate cannot find a plan via find_existing_artifact.
mkdir -p "$TEST_DIR/thoughts/shared/plans"

echo
echo "Test case 1: file_path under /thoughts/ -> exit 0 (allow regardless)"
INPUT="$(make_input '/abs/path/thoughts/shared/plans/foo.md')"
echo "$INPUT" | env CLAUDE_PROJECT_DIR="$TEST_DIR" RALPH_TICKET_ID=GH-99999 "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "thoughts/ path: exit 0"

echo
echo "Test case 2: RALPH_REQUIRES_PLAN=false + src/foo.ts -> exit 0 (opt-out)"
INPUT="$(make_input '/abs/src/foo.ts')"
echo "$INPUT" | env RALPH_REQUIRES_PLAN=false CLAUDE_PROJECT_DIR="$TEST_DIR" RALPH_TICKET_ID=GH-99999 "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "RALPH_REQUIRES_PLAN=false: exit 0"

echo
echo "Test case 3: required + no plan found for ticket -> exit 2 (block)"
INPUT="$(make_input '/abs/src/foo.ts')"
echo "$INPUT" | env -u RALPH_REQUIRES_PLAN -u RALPH_PLAN_REFERENCE \
  CLAUDE_PROJECT_DIR="$TEST_DIR" RALPH_TICKET_ID=GH-99999 "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "2" "$EXIT_CODE" "no plan found: exit 2"

echo
echo "Test case 4: plan exists for ticket -> exit 0 (allow)"
touch "$TEST_DIR/thoughts/shared/plans/2026-05-09-GH-99999-test.md"
INPUT="$(make_input '/abs/src/foo.ts')"
echo "$INPUT" | env -u RALPH_REQUIRES_PLAN -u RALPH_PLAN_REFERENCE \
  CLAUDE_PROJECT_DIR="$TEST_DIR" RALPH_TICKET_ID=GH-99999 "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "plan exists: exit 0"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
