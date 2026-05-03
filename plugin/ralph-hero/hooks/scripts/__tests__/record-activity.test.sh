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
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
