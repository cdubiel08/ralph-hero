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
echo "Test: includes actor and target fields"
rm -rf "$TEST_DIR/activity"
CLAUDE_HOOK_EVENT="PostToolUse" \
  CLAUDE_TOOL_NAME="ralph_hero__save_issue" \
  CLAUDE_PROJECT="ralph-hero" \
  "$SCRIPT" tool_called >/dev/null 2>&1
TODAY=$(date -u +%Y/%m/%d)
LOG_FILE="$TEST_DIR/activity/$TODAY.jsonl"
LINE=$(head -1 "$LOG_FILE" 2>/dev/null)
ACTOR=$(echo "$LINE" | jq -r '.actor // "missing"' 2>/dev/null)
TARGET_TOOL=$(echo "$LINE" | jq -r '.target.tool // "missing"' 2>/dev/null)
PROJECT=$(echo "$LINE" | jq -r '.project // "missing"' 2>/dev/null)
assert_eq "ralph_hero__save_issue" "$TARGET_TOOL" "target.tool populated from CLAUDE_TOOL_NAME"
assert_eq "ralph-hero" "$PROJECT" "project field populated from CLAUDE_PROJECT"

echo
echo "Test: categorization rules"
rm -rf "$TEST_DIR/activity"

# Work: state-mutating tool
CLAUDE_HOOK_EVENT="PostToolUse" CLAUDE_TOOL_NAME="ralph_hero__save_issue" "$SCRIPT" tool_called >/dev/null 2>&1
# Meta: read-only tool
CLAUDE_HOOK_EVENT="PostToolUse" CLAUDE_TOOL_NAME="ralph_hero__get_issue" "$SCRIPT" tool_called >/dev/null 2>&1
# Meta: recent_activity (the canonical example)
CLAUDE_HOOK_EVENT="PostToolUse" CLAUDE_TOOL_NAME="ralph_hero__recent_activity" "$SCRIPT" tool_called >/dev/null 2>&1
# Work: skill invocation
CLAUDE_HOOK_EVENT="PostSkillInvoke" CLAUDE_SKILL_NAME="ralph-hero:hello" "$SCRIPT" skill_invoked >/dev/null 2>&1
# Meta: session boundary
CLAUDE_HOOK_EVENT="SessionStart" "$SCRIPT" session_start >/dev/null 2>&1

TODAY=$(date -u +%Y/%m/%d)
LOG_FILE="$TEST_DIR/activity/$TODAY.jsonl"

CAT_SAVE=$(sed -n '1p' "$LOG_FILE" | jq -r '.category')
CAT_GET=$(sed -n '2p' "$LOG_FILE" | jq -r '.category')
CAT_ACTIVITY=$(sed -n '3p' "$LOG_FILE" | jq -r '.category')
CAT_SKILL=$(sed -n '4p' "$LOG_FILE" | jq -r '.category')
CAT_SESSION=$(sed -n '5p' "$LOG_FILE" | jq -r '.category')

assert_eq "work" "$CAT_SAVE" "save_issue categorized as work"
assert_eq "meta" "$CAT_GET" "get_issue categorized as meta"
assert_eq "meta" "$CAT_ACTIVITY" "recent_activity categorized as meta"
assert_eq "work" "$CAT_SKILL" "skill_invoked categorized as work"
assert_eq "meta" "$CAT_SESSION" "session_start categorized as meta"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
