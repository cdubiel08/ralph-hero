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
echo '{"tool_name":"ralph_hero__get_issue","cwd":"/x","session_id":"S0"}' | "$SCRIPT" tool_called >/dev/null 2>&1
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
echo '{"tool_name":"ralph_hero__save_issue","cwd":"/Users/dubiel/projects/ralph-hero","session_id":"S1"}' \
  | "$SCRIPT" tool_called >/dev/null 2>&1
TODAY=$(date -u +%Y/%m/%d)
LOG_FILE="$TEST_DIR/activity/$TODAY.jsonl"
LINE=$(head -1 "$LOG_FILE" 2>/dev/null)
ACTOR=$(echo "$LINE" | jq -r '.actor // "missing"' 2>/dev/null)
TARGET_TOOL=$(echo "$LINE" | jq -r '.target.tool // "missing"' 2>/dev/null)
PROJECT=$(echo "$LINE" | jq -r '.project // "missing"' 2>/dev/null)
SESSION=$(echo "$LINE" | jq -r '.session_id // "missing"' 2>/dev/null)
assert_eq "ralph_hero__save_issue" "$TARGET_TOOL" "target.tool populated from stdin tool_name"
assert_eq "ralph-hero" "$PROJECT" "project field populated from basename of stdin cwd"
assert_eq "S1" "$SESSION" "session_id populated from stdin session_id"

echo
echo "Test: categorization rules"
rm -rf "$TEST_DIR/activity"

# Work: state-mutating tool
echo '{"tool_name":"ralph_hero__save_issue"}' | "$SCRIPT" tool_called >/dev/null 2>&1
# Meta: read-only tool
echo '{"tool_name":"ralph_hero__get_issue"}' | "$SCRIPT" tool_called >/dev/null 2>&1
# Meta: recent_activity (the canonical example)
echo '{"tool_name":"ralph_hero__recent_activity"}' | "$SCRIPT" tool_called >/dev/null 2>&1
# Work: skill invocation (production never fires this kind, but the test exercises the code path)
echo '{"skill_name":"ralph-hero:hello"}' | "$SCRIPT" skill_invoked >/dev/null 2>&1
# Meta: session boundary
echo '{"hook_event_name":"SessionStart"}' | "$SCRIPT" session_start >/dev/null 2>&1

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
echo "Test: silent failure on read-only path"
RALPH_ACTIVITY_DIR="/dev/null/cannot-create-here" \
  bash -c "echo '{}' | '$SCRIPT' tool_called"
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "script exits 0 even with unwritable path"

echo
echo "Test: missing kind argument"
echo "" | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "script exits 0 even with no args (defaults to unknown)"

echo
echo "Test: concurrent writes don't corrupt file"
rm -rf "$TEST_DIR/activity"
export RALPH_ACTIVITY_DIR="$TEST_DIR/activity"

# Fire 50 parallel writes
for i in $(seq 1 50); do
  echo "{\"tool_name\":\"ralph_hero__test_$i\"}" | "$SCRIPT" tool_called &
done
wait

TODAY=$(date -u +%Y/%m/%d)
LOG_FILE="$RALPH_ACTIVITY_DIR/$TODAY.jsonl"
LINE_COUNT=$(wc -l < "$LOG_FILE" 2>/dev/null | tr -d ' ' || echo 0)
assert_eq "50" "$LINE_COUNT" "all 50 concurrent writes landed"

# Every line must be valid JSON
INVALID=$(grep -v '^$' "$LOG_FILE" | while IFS= read -r line; do
  echo "$line" | jq -e . >/dev/null 2>&1 || echo "BAD"
done | wc -l | tr -d ' ')
assert_eq "0" "$INVALID" "no corrupt lines from concurrent writes"

echo
echo "Test: PostToolUse — target.tool extracted from stdin tool_name"
rm -rf "$TEST_DIR/activity"
echo '{"tool_name":"ralph_hero__save_issue","tool_input":{},"tool_response":{},"hook_event_name":"PostToolUse","cwd":"/tmp/proj","session_id":"sess-A"}' \
  | "$SCRIPT" tool_called >/dev/null 2>&1
TODAY=$(date -u +%Y/%m/%d)
LOG_FILE="$TEST_DIR/activity/$TODAY.jsonl"
LINE=$(head -1 "$LOG_FILE" 2>/dev/null)
PT_TOOL=$(echo "$LINE" | jq -r '.target.tool // "missing"')
PT_PROJECT=$(echo "$LINE" | jq -r '.project // "missing"')
PT_SESSION=$(echo "$LINE" | jq -r '.session_id // "missing"')
PT_CATEGORY=$(echo "$LINE" | jq -r '.category // "missing"')
assert_eq "ralph_hero__save_issue" "$PT_TOOL" "PostToolUse: target.tool from stdin tool_name"
assert_eq "proj" "$PT_PROJECT" "PostToolUse: project from basename of stdin cwd"
assert_eq "sess-A" "$PT_SESSION" "PostToolUse: session_id from stdin"
assert_eq "work" "$PT_CATEGORY" "PostToolUse: save_issue categorized as work"

echo
echo "Test: SessionStart — kind lands with stdin-derived metadata"
rm -rf "$TEST_DIR/activity"
echo '{"hook_event_name":"SessionStart","cwd":"/Users/x/foo-repo","session_id":"sess-B"}' \
  | "$SCRIPT" session_start >/dev/null 2>&1
TODAY=$(date -u +%Y/%m/%d)
LOG_FILE="$TEST_DIR/activity/$TODAY.jsonl"
LINE=$(head -1 "$LOG_FILE" 2>/dev/null)
SS_KIND=$(echo "$LINE" | jq -r '.kind // "missing"')
SS_PROJECT=$(echo "$LINE" | jq -r '.project // "missing"')
SS_SESSION=$(echo "$LINE" | jq -r '.session_id // "missing"')
SS_ACTOR=$(echo "$LINE" | jq -r '.actor // "missing"')
SS_CATEGORY=$(echo "$LINE" | jq -r '.category // "missing"')
assert_eq "session_start" "$SS_KIND" "SessionStart: kind matches"
assert_eq "foo-repo" "$SS_PROJECT" "SessionStart: project from basename of stdin cwd"
assert_eq "sess-B" "$SS_SESSION" "SessionStart: session_id from stdin"
assert_eq "claude" "$SS_ACTOR" "SessionStart: actor defaults to claude (no agent_type)"
assert_eq "meta" "$SS_CATEGORY" "SessionStart: category is meta"

echo
echo "Test: sub-agent — actor strips plugin prefix from agent_type"
rm -rf "$TEST_DIR/activity"
echo '{"tool_name":"Write","agent_type":"ralph-hero:impl-agent","cwd":"/x"}' \
  | "$SCRIPT" tool_called >/dev/null 2>&1
TODAY=$(date -u +%Y/%m/%d)
LOG_FILE="$TEST_DIR/activity/$TODAY.jsonl"
LINE=$(head -1 "$LOG_FILE" 2>/dev/null)
SA_ACTOR=$(echo "$LINE" | jq -r '.actor // "missing"')
SA_TOOL=$(echo "$LINE" | jq -r '.target.tool // "missing"')
SA_CATEGORY=$(echo "$LINE" | jq -r '.category // "missing"')
assert_eq "impl-agent" "$SA_ACTOR" "sub-agent: actor strips ralph-hero: prefix from agent_type"
assert_eq "Write" "$SA_TOOL" "sub-agent: target.tool from stdin"
assert_eq "work" "$SA_CATEGORY" "sub-agent: Write categorized as work"

echo
echo "Test: empty stdin — graceful fallback to defaults"
rm -rf "$TEST_DIR/activity"
"$SCRIPT" tool_called < /dev/null
EMPTY_EXIT=$?
assert_eq "0" "$EMPTY_EXIT" "empty stdin: exit code 0"
TODAY=$(date -u +%Y/%m/%d)
LOG_FILE="$TEST_DIR/activity/$TODAY.jsonl"
LINE=$(head -1 "$LOG_FILE" 2>/dev/null)
ES_TOOL=$(echo "$LINE" | jq -r '.target.tool // "missing"')
ES_ACTOR=$(echo "$LINE" | jq -r '.actor // "missing"')
ES_PROJECT=$(echo "$LINE" | jq -r '.project // "missing"')
ES_HAS_SESSION=$(echo "$LINE" | jq -r 'has("session_id") | tostring')
assert_eq "unknown" "$ES_TOOL" "empty stdin: target.tool defaults to unknown"
assert_eq "claude" "$ES_ACTOR" "empty stdin: actor defaults to claude"
assert_eq "unknown" "$ES_PROJECT" "empty stdin: project defaults to unknown"
assert_eq "false" "$ES_HAS_SESSION" "empty stdin: session_id field omitted"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
