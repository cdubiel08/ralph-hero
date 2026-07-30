#!/usr/bin/env bash
# Tests for the slim `ralph:hero --mode auto` never-terminating watcher hooks:
#   autopilot-director-postcheck.sh  (arms autoloop + marks pending wakeup)
#   autopilot-wakeup-clear.sh        (clears pending mark; rejects 300s)
#   autopilot-stop-gate.sh           (blocks stop when a tick owes a wakeup)
# Run: bash ralph/hooks/scripts/__tests__/autopilot-auto-watcher.test.sh

set -uo pipefail

HOOK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
POSTCHECK="$HOOK_DIR/autopilot-director-postcheck.sh"
WAKEUP="$HOOK_DIR/autopilot-wakeup-clear.sh"
STOPGATE="$HOOK_DIR/autopilot-stop-gate.sh"

TEST_DIR="$(mktemp -d)"
trap "rm -rf $TEST_DIR" EXIT

SID="testsession"
AUTOLOOP="$TEST_DIR/ralph-hero-autoloop-$SID"
PENDING="$TEST_DIR/ralph-hero-pending-wakeup-$SID"

PASS=0
FAIL=0
assert_eq() {
  if [ "$1" = "$2" ]; then PASS=$((PASS+1)); echo "  PASS: $3";
  else FAIL=$((FAIL+1)); echo "  FAIL: $3"; echo "    expected: $1"; echo "    actual:   $2"; fi
}
assert_file() {
  if [ -f "$1" ]; then PASS=$((PASS+1)); echo "  PASS: $2 (exists)";
  else FAIL=$((FAIL+1)); echo "  FAIL: $2 (missing)"; fi
}
assert_nofile() {
  if [ ! -f "$1" ]; then PASS=$((PASS+1)); echo "  PASS: $2 (absent)";
  else FAIL=$((FAIL+1)); echo "  FAIL: $2 (present)"; fi
}
reset() { rm -f "$AUTOLOOP" "$PENDING"; }
run() { # run <script> <input-json>  (RALPH_COMMAND=hero + clean TMPDIR)
  echo "$2" | env RALPH_COMMAND=hero RALPH_HOOK_INPUT= TMPDIR="$TEST_DIR" bash "$1" >/dev/null 2>&1
  echo $?
}

echo "Testing $POSTCHECK / $WAKEUP / $STOPGATE"

echo
echo "== discriminator: non-hero session is a no-op (legacy autopilot uses its own copies) =="
reset
ec=$(echo '{"session_id":"'"$SID"'","tool_input":{"skill":"loop","args":"Run /ralph:hero --tick on the queue"}}' \
  | env RALPH_COMMAND=autopilot RALPH_HOOK_INPUT= TMPDIR="$TEST_DIR" bash "$POSTCHECK" >/dev/null 2>&1; echo $?)
assert_eq "0" "$ec" "postcheck exits 0 for RALPH_COMMAND=autopilot"
assert_nofile "$AUTOLOOP" "no autoloop armed for non-hero session"

echo
echo "== postcheck: Skill(loop, .../ralph:hero --tick) arms watcher + marks pending =="
reset
ec=$(run "$POSTCHECK" '{"session_id":"'"$SID"'","tool_input":{"skill":"loop","args":"Run /ralph:hero --tick on the queue"}}')
assert_eq "0" "$ec" "postcheck exits 0"
assert_file "$AUTOLOOP" "autoloop armed by Skill(loop,/ralph:hero --tick)"
assert_file "$PENDING" "pending wakeup marked for the launch tick"

echo
echo "== postcheck: outside the watcher (no autoloop), other Skill is ignored =="
reset
ec=$(run "$POSTCHECK" '{"session_id":"'"$SID"'","tool_input":{"skill":"plan","args":"123"},"tool_response":"result: Plan complete for #123"}')
assert_eq "0" "$ec" "postcheck exits 0"
assert_nofile "$PENDING" "no pending wakeup when watcher not armed (one-shot/default)"

echo
echo "== postcheck: armed + 'Dispatched' tick result marks pending =="
reset; touch "$AUTOLOOP"
ec=$(run "$POSTCHECK" '{"session_id":"'"$SID"'","tool_input":{"skill":"ralph:hero","args":"--tick"},"tool_response":"some text\nresult: Dispatched #42 to builders via impl"}')
assert_eq "0" "$ec" "postcheck exits 0"
assert_file "$PENDING" "Dispatched result marks pending wakeup"

echo
echo "== postcheck: armed + 'Queue empty' marks pending (never-terminate) =="
reset; touch "$AUTOLOOP"
ec=$(run "$POSTCHECK" '{"session_id":"'"$SID"'","tool_input":{"skill":"ralph:hero","args":"--tick"},"tool_response":"result: Queue empty. No events to dispatch."}')
assert_eq "0" "$ec" "postcheck exits 0"
assert_file "$PENDING" "Queue empty is idle (not terminal) -> still owes a wakeup"

echo
echo "== wakeup-clear: delaySeconds=300 is rejected =="
reset; touch "$AUTOLOOP" "$PENDING"
ec=$(run "$WAKEUP" '{"session_id":"'"$SID"'","tool_input":{"delaySeconds":300}}')
assert_eq "2" "$ec" "300s blocked (cache-window anti-pattern)"
assert_file "$PENDING" "pending NOT cleared on a rejected wakeup"

echo
echo "== wakeup-clear: valid delay clears the pending mark, autoloop persists =="
reset; touch "$AUTOLOOP" "$PENDING"
ec=$(run "$WAKEUP" '{"session_id":"'"$SID"'","tool_input":{"delaySeconds":3600}}')
assert_eq "0" "$ec" "valid 3600s allowed"
assert_nofile "$PENDING" "pending cleared by ScheduleWakeup"
assert_file "$AUTOLOOP" "autoloop persists across ticks"

echo
echo "== stop-gate: not in watcher -> allow stop =="
reset
ec=$(run "$STOPGATE" '{"session_id":"'"$SID"'","stop_hook_active":false}')
assert_eq "0" "$ec" "no autoloop -> exit 0"

echo
echo "== stop-gate: armed + pending wakeup -> BLOCK =="
reset; touch "$AUTOLOOP" "$PENDING"
ec=$(run "$STOPGATE" '{"session_id":"'"$SID"'","stop_hook_active":false}')
assert_eq "2" "$ec" "autoloop + pending -> exit 2 (block silent drop)"

echo
echo "== stop-gate: armed + wakeup already scheduled -> allow =="
reset; touch "$AUTOLOOP"
ec=$(run "$STOPGATE" '{"session_id":"'"$SID"'","stop_hook_active":false}')
assert_eq "0" "$ec" "autoloop, no pending -> exit 0 (wakeup scheduled, turn ends)"

echo
echo "== stop-gate: re-entry (stop_hook_active=true) releases + cleans up =="
reset; touch "$AUTOLOOP" "$PENDING"
ec=$(run "$STOPGATE" '{"session_id":"'"$SID"'","stop_hook_active":true}')
assert_eq "0" "$ec" "re-entry -> exit 0"
assert_nofile "$PENDING" "re-entry cleans pending"
assert_nofile "$AUTOLOOP" "re-entry cleans autoloop"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
