#!/usr/bin/env bash
# Tests for record-activity.sh
# Run: bash plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/record-activity.sh"
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

assert_file_exists() {
  local path="$1"
  local msg="$2"
  if [ -f "$path" ]; then
    PASS=$((PASS + 1))
    echo "  PASS: $msg"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $msg (file missing: $path)"
  fi
}

echo "Testing $SCRIPT"
echo "Test dir: $TEST_DIR"

# Tests will be added in subsequent tasks

echo
echo "Test: writes one valid JSON line"
export RALPH_ACTIVITY_DIR="$TEST_DIR/activity"
CLAUDE_HOOK_EVENT="PostToolUse" CLAUDE_TOOL_NAME="ralph_hero__get_issue" "$SCRIPT" tool_called >/dev/null 2>&1
TODAY=$(date -u +%Y/%m/%d)
LOG_FILE="$RALPH_ACTIVITY_DIR/$TODAY.jsonl"
assert_file_exists "$LOG_FILE" "log file created at expected path"
LINE_COUNT=$(wc -l < "$LOG_FILE" 2>/dev/null | tr -d ' ' || echo 0)
assert_eq "1" "$LINE_COUNT" "exactly one event written"
LINE=$(head -1 "$LOG_FILE" 2>/dev/null)
JSON_VALID=$(echo "$LINE" | jq -e . >/dev/null 2>&1 && echo "yes" || echo "no")
assert_eq "yes" "$JSON_VALID" "line is valid JSON"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
