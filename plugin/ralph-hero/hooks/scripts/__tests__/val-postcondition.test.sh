#!/usr/bin/env bash
# Tests for val-postcondition.sh
# Run: bash plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/val-postcondition.sh"
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

# Build a minimal transcript file containing a single assistant message with the
# supplied verdict text. The transcript format is JSONL — one JSON object per
# line — matching what Claude Code produces.
make_transcript() {
  local verdict_text="$1"
  local out_path="$2"
  printf '%s\n' "$(jq -nc --arg t "$verdict_text" '{type:"assistant",message:{role:"assistant",content:[{type:"text",text:$t}]}}')" > "$out_path"
}

echo "Testing $SCRIPT"
echo "Test dir: $TEST_DIR"

echo
echo "Test case 1: stop_hook_active=true short-circuits to exit 0"
INPUT='{"transcript_path":"/dev/null","stop_hook_active":true}'
echo "$INPUT" | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "stop_hook_active=true: exit 0"

echo
echo "Test case 2: VALIDATION PASS verdict in transcript -> exit 0"
TRANSCRIPT="$TEST_DIR/transcript-pass.jsonl"
make_transcript "VALIDATION PASS — implementation matches plan" "$TRANSCRIPT"
INPUT="$(jq -nc --arg p "$TRANSCRIPT" '{transcript_path:$p,stop_hook_active:false}')"
echo "$INPUT" | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "VALIDATION PASS in transcript: exit 0"

echo
echo "Test case 3: VALIDATION FAIL verdict in transcript -> exit 0"
TRANSCRIPT="$TEST_DIR/transcript-fail.jsonl"
make_transcript "VALIDATION FAIL — tests did not pass" "$TRANSCRIPT"
INPUT="$(jq -nc --arg p "$TRANSCRIPT" '{transcript_path:$p,stop_hook_active:false}')"
echo "$INPUT" | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "VALIDATION FAIL in transcript: exit 0"

echo
echo "Test case 4: Queue empty in transcript -> exit 0"
TRANSCRIPT="$TEST_DIR/transcript-empty.jsonl"
make_transcript "No In Progress issues found. Queue empty." "$TRANSCRIPT"
INPUT="$(jq -nc --arg p "$TRANSCRIPT" '{transcript_path:$p,stop_hook_active:false}')"
echo "$INPUT" | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "Queue empty in transcript: exit 0"

echo
echo "Test case 5: no verdict in transcript -> exit 2"
TRANSCRIPT="$TEST_DIR/transcript-empty-text.jsonl"
make_transcript "still working on validation" "$TRANSCRIPT"
INPUT="$(jq -nc --arg p "$TRANSCRIPT" '{transcript_path:$p,stop_hook_active:false}')"
echo "$INPUT" | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "2" "$EXIT_CODE" "no verdict in transcript: exit 2"

echo
echo "Test case 6: smoke — transcript_path=/dev/null with stop_hook_active=false -> exit 2"
echo '{"transcript_path":"/dev/null","stop_hook_active":false}' | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "2" "$EXIT_CODE" "smoke /dev/null transcript: exit 2"

echo
echo "Test case 7: missing transcript_path field -> exit 2 (no verdict path)"
echo '{"stop_hook_active":false}' | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "2" "$EXIT_CODE" "missing transcript_path: exit 2"

echo
echo "Test case 8: nonexistent transcript file -> exit 2"
INPUT='{"transcript_path":"/tmp/nonexistent-val-postcondition-test.jsonl","stop_hook_active":false}'
echo "$INPUT" | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "2" "$EXIT_CODE" "nonexistent transcript file: exit 2"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
