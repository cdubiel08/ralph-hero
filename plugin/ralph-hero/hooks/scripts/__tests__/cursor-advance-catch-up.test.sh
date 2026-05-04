#!/usr/bin/env bash
# Tests for cursor-advance-catch-up.sh
# Run: bash plugin/ralph-hero/hooks/scripts/__tests__/cursor-advance-catch-up.test.sh

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/cursor-advance-catch-up.sh"
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

assert_file_missing() {
  local path="$1"
  local msg="$2"
  if [ ! -e "$path" ]; then
    PASS=$((PASS + 1))
    echo "  PASS: $msg"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $msg (file unexpectedly exists: $path)"
  fi
}

echo "Testing $SCRIPT"
echo "Test dir: $TEST_DIR"

echo
echo "Test case 1: non-null cursor written"
export RALPH_CURSOR_DIR="$TEST_DIR/cursors"
rm -rf "$RALPH_CURSOR_DIR"
echo '{"tool_name":"ralph_hero__recent_activity","tool_response":{"cursor_advanced_to":"2026-05-03T10:00:00.000Z","events":[],"skipped_lines":0}}' \
  | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
CURSOR_FILE="$RALPH_CURSOR_DIR/catch-up.json"
assert_eq "0" "$EXIT_CODE" "non-null cursor: exit 0"
assert_file_exists "$CURSOR_FILE" "non-null cursor: file created"
TS_VALUE=$(jq -r '.last_event_ts' < "$CURSOR_FILE" 2>/dev/null || echo "")
assert_eq "2026-05-03T10:00:00.000Z" "$TS_VALUE" "non-null cursor: last_event_ts persisted verbatim"

echo
echo "Test case 2: null cursor skipped"
export RALPH_CURSOR_DIR="$TEST_DIR/cursors2"
rm -rf "$RALPH_CURSOR_DIR"
echo '{"tool_name":"ralph_hero__recent_activity","tool_response":{"cursor_advanced_to":null,"events":[],"skipped_lines":0}}' \
  | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
CURSOR_FILE="$RALPH_CURSOR_DIR/catch-up.json"
assert_eq "0" "$EXIT_CODE" "null cursor: exit 0"
assert_file_missing "$CURSOR_FILE" "null cursor: no file written"

echo
echo "Test case 3: missing parent dir auto-created"
export RALPH_CURSOR_DIR="$TEST_DIR/deeply/nested/cursors"
rm -rf "$TEST_DIR/deeply"
# Sanity-check the parent does not exist before invocation
assert_file_missing "$TEST_DIR/deeply" "deep parent dir absent before invocation"
echo '{"tool_name":"ralph_hero__recent_activity","tool_response":{"cursor_advanced_to":"2026-05-04T01:23:45.678Z"}}' \
  | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
CURSOR_FILE="$RALPH_CURSOR_DIR/catch-up.json"
assert_eq "0" "$EXIT_CODE" "missing parent dir: exit 0"
DIR_EXISTS="no"
[ -d "$RALPH_CURSOR_DIR" ] && DIR_EXISTS="yes"
assert_eq "yes" "$DIR_EXISTS" "missing parent dir: directory created"
assert_file_exists "$CURSOR_FILE" "missing parent dir: cursor file written"
TS_VALUE=$(jq -r '.last_event_ts' < "$CURSOR_FILE" 2>/dev/null || echo "")
assert_eq "2026-05-04T01:23:45.678Z" "$TS_VALUE" "missing parent dir: last_event_ts persisted"

echo
echo "Test case 4: malformed stdin doesn't crash"
export RALPH_CURSOR_DIR="$TEST_DIR/cursors4"
rm -rf "$RALPH_CURSOR_DIR"

# 4a: literal non-JSON input
echo "not json at all" | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "malformed stdin (literal text): exit 0"
assert_file_missing "$RALPH_CURSOR_DIR/catch-up.json" "malformed stdin (literal text): no cursor written"

# 4b: empty stdin
printf '' | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "malformed stdin (empty): exit 0"
assert_file_missing "$RALPH_CURSOR_DIR/catch-up.json" "malformed stdin (empty): no cursor written"

# 4c: valid JSON, no fields
echo '{}' | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "malformed stdin ({}): exit 0"
assert_file_missing "$RALPH_CURSOR_DIR/catch-up.json" "malformed stdin ({}): no cursor written"

echo
echo "Bonus case: cursor_advanced_to field missing entirely"
export RALPH_CURSOR_DIR="$TEST_DIR/cursors5"
rm -rf "$RALPH_CURSOR_DIR"
echo '{"tool_name":"ralph_hero__recent_activity","tool_response":{"events":[]}}' \
  | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "missing cursor field: exit 0"
assert_file_missing "$RALPH_CURSOR_DIR/catch-up.json" "missing cursor field: no cursor written"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
