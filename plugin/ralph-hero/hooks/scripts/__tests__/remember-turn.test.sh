#!/usr/bin/env bash
# Tests for remember-turn.sh
# Run: bash plugin/ralph-hero/hooks/scripts/__tests__/remember-turn.test.sh
#
# These tests cover the GH-1205 Stop hook that captures the last user +
# assistant turn into ~/projects/thoughts/dream-memories/agent/YYYY/MM/DD/.
# The script is a passive capture path: it must NEVER block the Stop event,
# so every test asserts exit code 0 plus the expected on-disk side effect.

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/remember-turn.sh"
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

assert_no_file_under() {
  local dir="$1"
  local msg="$2"
  local count
  count=$(find "$dir" -type f 2>/dev/null | wc -l | tr -d ' ')
  if [ "$count" = "0" ]; then
    PASS=$((PASS + 1))
    echo "  PASS: $msg"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $msg (found $count files under $dir)"
  fi
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local msg="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    PASS=$((PASS + 1))
    echo "  PASS: $msg"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $msg (missing: $needle)"
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local msg="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    FAIL=$((FAIL + 1))
    echo "  FAIL: $msg (unexpectedly contains: $needle)"
  else
    PASS=$((PASS + 1))
    echo "  PASS: $msg"
  fi
}

echo "Testing $SCRIPT"
echo "Test dir: $TEST_DIR"

# -----------------------------------------------------------------------------
# Test case 1: no transcript -> silent no-op, exit 0
# -----------------------------------------------------------------------------
echo
echo "Test case 1: no transcript path -> silent no-op"
export RALPH_DREAM_MEMORIES_DIR="$TEST_DIR/dream-memories-1"
unset CLAUDE_AGENT_TRANSCRIPT
mkdir -p "$RALPH_DREAM_MEMORIES_DIR"
echo '{}' | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "no transcript: exit 0"
assert_no_file_under "$RALPH_DREAM_MEMORIES_DIR" "no transcript: no file written"

# -----------------------------------------------------------------------------
# Test case 2: transcript file missing -> silent no-op
# -----------------------------------------------------------------------------
echo
echo "Test case 2: transcript path points at nonexistent file -> silent no-op"
export RALPH_DREAM_MEMORIES_DIR="$TEST_DIR/dream-memories-2"
mkdir -p "$RALPH_DREAM_MEMORIES_DIR"
export CLAUDE_AGENT_TRANSCRIPT="$TEST_DIR/does-not-exist.jsonl"
echo '{}' | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "missing transcript: exit 0"
assert_no_file_under "$RALPH_DREAM_MEMORIES_DIR" "missing transcript: no file written"
unset CLAUDE_AGENT_TRANSCRIPT

# -----------------------------------------------------------------------------
# Test case 3: short turn below threshold -> no file written
# -----------------------------------------------------------------------------
echo
echo "Test case 3: combined length below RALPH_REMEMBER_MIN_CHARS -> no write"
export RALPH_DREAM_MEMORIES_DIR="$TEST_DIR/dream-memories-3"
mkdir -p "$RALPH_DREAM_MEMORIES_DIR"
TRANSCRIPT="$TEST_DIR/transcript-3.jsonl"
cat > "$TRANSCRIPT" <<EOF
{"type":"user","message":{"content":"hi"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}
EOF
export CLAUDE_AGENT_TRANSCRIPT="$TRANSCRIPT"
export RALPH_REMEMBER_MIN_CHARS=200
echo '{}' | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "short turn: exit 0"
assert_no_file_under "$RALPH_DREAM_MEMORIES_DIR" "short turn: no file written"
unset CLAUDE_AGENT_TRANSCRIPT
unset RALPH_REMEMBER_MIN_CHARS

# -----------------------------------------------------------------------------
# Test case 4: long turn -> writes file under agent/YYYY/MM/DD/
# -----------------------------------------------------------------------------
echo
echo "Test case 4: long turn -> writes file under agent/YYYY/MM/DD/"
export RALPH_DREAM_MEMORIES_DIR="$TEST_DIR/dream-memories-4"
mkdir -p "$RALPH_DREAM_MEMORIES_DIR"
TRANSCRIPT="$TEST_DIR/transcript-4.jsonl"
LONG_USER="Please explain the architecture of the dream-loop ingest pipeline and why we chose to write raw memories under date-partitioned directories rather than a flat layout."
LONG_ASSISTANT="The pipeline writes one markdown file per raw memory under base_dir/YYYY/MM/DD/. The date partition keeps git operations cheap (rsync-friendly), lets the reindexer scan recent dates first, and lets the launchd job prune by mtime without parsing frontmatter."
cat > "$TRANSCRIPT" <<EOF
{"type":"user","message":{"content":"$LONG_USER"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"$LONG_ASSISTANT"}]}}
EOF
export CLAUDE_AGENT_TRANSCRIPT="$TRANSCRIPT"
export CLAUDE_AGENT_TYPE="impl-agent"
echo '{}' | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "long turn: exit 0"
# Today's date dir (UTC)
YEAR=$(date -u +"%Y")
MONTH=$(date -u +"%m")
DAY=$(date -u +"%d")
OUT_DIR="$RALPH_DREAM_MEMORIES_DIR/agent/$YEAR/$MONTH/$DAY"
FOUND_COUNT=$(find "$OUT_DIR" -name "agent-*.md" 2>/dev/null | wc -l | tr -d ' ')
assert_eq "1" "$FOUND_COUNT" "long turn: one file written under agent/$YEAR/$MONTH/$DAY/"
FOUND_FILE=$(find "$OUT_DIR" -name "agent-*.md" 2>/dev/null | head -1)
if [ -n "$FOUND_FILE" ]; then
  BODY=$(cat "$FOUND_FILE")
  assert_contains "$BODY" "memory_tier: raw" "frontmatter: memory_tier=raw"
  assert_contains "$BODY" "source: agent:impl-agent" "frontmatter: source=agent:impl-agent"
  assert_contains "$BODY" "## User" "body contains ## User section"
  assert_contains "$BODY" "## Assistant" "body contains ## Assistant section"
  assert_contains "$BODY" "dream-loop ingest pipeline" "body contains user message"
  assert_contains "$BODY" "date-partitioned directories" "body contains user message keyword"
  assert_contains "$BODY" "raw memory under base_dir" "body contains assistant message"
fi
unset CLAUDE_AGENT_TRANSCRIPT
unset CLAUDE_AGENT_TYPE

# -----------------------------------------------------------------------------
# Test case 5: secret scrubbing - GitHub PAT redacted
# -----------------------------------------------------------------------------
echo
echo "Test case 5: secret scrubbing - GitHub PAT redacted"
export RALPH_DREAM_MEMORIES_DIR="$TEST_DIR/dream-memories-5"
mkdir -p "$RALPH_DREAM_MEMORIES_DIR"
TRANSCRIPT="$TEST_DIR/transcript-5.jsonl"
# Embed a synthetic fake token. Long enough to match the ghp_ pattern (36+ chars after prefix).
FAKE_TOKEN="ghp_$(printf 'A%.0s' {1..40})"
LONG_USER="Here is my GitHub PAT to authenticate the action: $FAKE_TOKEN please configure git remote with it now this is a long enough message to exceed the minimum threshold so the hook actually writes a file."
LONG_ASSISTANT="I will not store the token verbatim — secrets should live in env vars, not transcripts. This is a long enough assistant reply to clear the combined-length threshold for the remember hook."
cat > "$TRANSCRIPT" <<EOF
{"type":"user","message":{"content":"$LONG_USER"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"$LONG_ASSISTANT"}]}}
EOF
export CLAUDE_AGENT_TRANSCRIPT="$TRANSCRIPT"
export CLAUDE_AGENT_TYPE="impl-agent"
echo '{}' | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "secret scrub: exit 0"
YEAR=$(date -u +"%Y")
MONTH=$(date -u +"%m")
DAY=$(date -u +"%d")
OUT_DIR="$RALPH_DREAM_MEMORIES_DIR/agent/$YEAR/$MONTH/$DAY"
FOUND_FILE=$(find "$OUT_DIR" -name "agent-*.md" 2>/dev/null | head -1)
if [ -n "$FOUND_FILE" ]; then
  BODY=$(cat "$FOUND_FILE")
  assert_not_contains "$BODY" "$FAKE_TOKEN" "secret scrub: PAT not present in memory file"
  assert_contains "$BODY" "[REDACTED]" "secret scrub: [REDACTED] marker present"
fi
unset CLAUDE_AGENT_TRANSCRIPT
unset CLAUDE_AGENT_TYPE

# -----------------------------------------------------------------------------
# Test case 6: transcript path falls back to stdin .transcript_path
# -----------------------------------------------------------------------------
echo
echo "Test case 6: transcript path from stdin Stop event JSON (no env var)"
export RALPH_DREAM_MEMORIES_DIR="$TEST_DIR/dream-memories-6"
mkdir -p "$RALPH_DREAM_MEMORIES_DIR"
TRANSCRIPT="$TEST_DIR/transcript-6.jsonl"
LONG_USER="The user asks a sufficiently long question to clear the minimum-character threshold and trigger a write through the stdin fallback path."
LONG_ASSISTANT="The assistant replies with enough content to push the combined length above 200 characters so the remember hook actually persists the turn under agent/."
cat > "$TRANSCRIPT" <<EOF
{"type":"user","message":{"content":"$LONG_USER"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"$LONG_ASSISTANT"}]}}
EOF
unset CLAUDE_AGENT_TRANSCRIPT
echo "{\"transcript_path\":\"$TRANSCRIPT\"}" | "$SCRIPT" >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "stdin fallback: exit 0"
YEAR=$(date -u +"%Y")
MONTH=$(date -u +"%m")
DAY=$(date -u +"%d")
OUT_DIR="$RALPH_DREAM_MEMORIES_DIR/agent/$YEAR/$MONTH/$DAY"
FOUND_COUNT=$(find "$OUT_DIR" -name "agent-*.md" 2>/dev/null | wc -l | tr -d ' ')
assert_eq "1" "$FOUND_COUNT" "stdin fallback: file written"

# -----------------------------------------------------------------------------
# Test case 7: idempotence - same input produces same path
# -----------------------------------------------------------------------------
echo
echo "Test case 7: idempotence - second fire on identical transcript reuses path"
export RALPH_DREAM_MEMORIES_DIR="$TEST_DIR/dream-memories-7"
mkdir -p "$RALPH_DREAM_MEMORIES_DIR"
TRANSCRIPT="$TEST_DIR/transcript-7.jsonl"
LONG_USER="A user question long enough to push combined length comfortably past the 200-character minimum threshold so the hook actually persists this turn under the agent/ directory tree."
LONG_ASSISTANT="An assistant reply with enough words to keep the combined length over threshold so the hook proceeds to the write step and the idempotence test can observe the deterministic filename."
cat > "$TRANSCRIPT" <<EOF
{"type":"user","message":{"content":"$LONG_USER"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"$LONG_ASSISTANT"}]}}
EOF
export CLAUDE_AGENT_TRANSCRIPT="$TRANSCRIPT"
export CLAUDE_AGENT_TYPE="impl-agent"
echo '{}' | "$SCRIPT" >/dev/null 2>&1
echo '{}' | "$SCRIPT" >/dev/null 2>&1
YEAR=$(date -u +"%Y")
MONTH=$(date -u +"%m")
DAY=$(date -u +"%d")
OUT_DIR="$RALPH_DREAM_MEMORIES_DIR/agent/$YEAR/$MONTH/$DAY"
FOUND_COUNT=$(find "$OUT_DIR" -name "agent-*.md" 2>/dev/null | wc -l | tr -d ' ')
assert_eq "1" "$FOUND_COUNT" "idempotence: two fires produce one file (same hash)"

# -----------------------------------------------------------------------------
# Test case 8: latency under 500ms for a small transcript
# -----------------------------------------------------------------------------
echo
echo "Test case 8: latency budget < 500ms for a small transcript"
export RALPH_DREAM_MEMORIES_DIR="$TEST_DIR/dream-memories-8"
mkdir -p "$RALPH_DREAM_MEMORIES_DIR"
TRANSCRIPT="$TEST_DIR/transcript-8.jsonl"
LONG_USER="A medium-length user message that needs to push beyond the threshold so we can time a real-world flow including the python scrub path."
LONG_ASSISTANT="A medium-length assistant response that pads enough characters to clear the combined threshold so the hook actually does its filesystem write under agent/."
cat > "$TRANSCRIPT" <<EOF
{"type":"user","message":{"content":"$LONG_USER"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"$LONG_ASSISTANT"}]}}
EOF
export CLAUDE_AGENT_TRANSCRIPT="$TRANSCRIPT"
export CLAUDE_AGENT_TYPE="impl-agent"
# Use Python rather than /usr/bin/time to read wall-clock ms portably across mac/linux.
START_MS=$(python3 -c 'import time; print(int(time.time()*1000))')
echo '{}' | "$SCRIPT" >/dev/null 2>&1
END_MS=$(python3 -c 'import time; print(int(time.time()*1000))')
ELAPSED_MS=$((END_MS - START_MS))
echo "  elapsed: ${ELAPSED_MS}ms"
if [ "$ELAPSED_MS" -lt 500 ]; then
  PASS=$((PASS + 1))
  echo "  PASS: latency under 500ms (actual: ${ELAPSED_MS}ms)"
else
  FAIL=$((FAIL + 1))
  echo "  FAIL: latency over 500ms (actual: ${ELAPSED_MS}ms)"
fi

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
