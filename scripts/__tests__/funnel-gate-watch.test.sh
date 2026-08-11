#!/usr/bin/env bash
# scripts/__tests__/funnel-gate-watch.test.sh
# Tests ralph/hooks/funnel-gate-watch.sh (the PreToolUse courtesy rail that
# redirects blind `gh pr checks` poll loops to scripts/pr-gate-watch.sh) by
# feeding it simulated hook payloads on stdin, the same shape Claude Code
# sends for a Bash PreToolUse event. Pattern follows funnel-merge.test.sh.
#
# The load-bearing distinctions under test:
#   - a POLL LOOP is redirected; a one-shot `gh pr checks` is not
#   - a repo without scripts/pr-gate-watch.sh is left entirely alone
#   - a command already using the watcher is not redirected into itself
#   - -R/--repo (incl. gh's attached `-Rowner/repo` form) targets another
#     repo's PR and is outside this rail's jurisdiction

set -euo pipefail

HOOK="$(cd "$(dirname "$0")/../.." && pwd)/ralph/hooks/funnel-gate-watch.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# Two throwaway git repos:
#   WATCH_REPO — ships scripts/pr-gate-watch.sh (ralph-hero's shape)
#   PLAIN_REPO — ships nothing; the hook must stay out of its way entirely
WATCH_REPO="$TMP_ROOT/watched"
PLAIN_REPO="$TMP_ROOT/plain"
mkdir -p "$WATCH_REPO/scripts" "$WATCH_REPO/nested/sub" "$PLAIN_REPO"
git init -q "$WATCH_REPO"
git init -q "$PLAIN_REPO"
printf '#!/usr/bin/env bash\necho stub\n' >"$WATCH_REPO/scripts/pr-gate-watch.sh"
chmod +x "$WATCH_REPO/scripts/pr-gate-watch.sh"

# run_hook <cwd> <command> -> sets LAST_ERR, LAST_RC
run_hook() {
  local cwd="$1" cmd="$2"
  local payload rc
  payload=$(jq -n --arg cmd "$cmd" --arg cwd "$cwd" \
    '{tool_input: {command: $cmd}, cwd: $cwd}')
  set +e
  printf '%s' "$payload" | bash "$HOOK" >/dev/null 2>"$TMP_ROOT/stderr"
  rc=$?
  set -e
  LAST_ERR=$(<"$TMP_ROOT/stderr")
  LAST_RC=$rc
}

expect_redirect() {
  local label="$1" cwd="$2" cmd="$3"
  run_hook "$cwd" "$cmd"
  if [ "$LAST_RC" -eq 2 ] && [[ "$LAST_ERR" == *"pr-gate-watch.sh"* ]]; then
    pass "$label"
  else
    fail "$label (rc=$LAST_RC err=${LAST_ERR:0:80})"
  fi
}

expect_silent() {
  local label="$1" cwd="$2" cmd="$3"
  run_hook "$cwd" "$cmd"
  if [ "$LAST_RC" -eq 0 ] && [ -z "$LAST_ERR" ]; then
    pass "$label"
  else
    fail "$label (rc=$LAST_RC err=${LAST_ERR:0:80})"
  fi
}

echo "=== redirect: poll loops in a watcher-shipping repo ==="
# The exact shape observed stranding a monitor on PR #1740.
expect_redirect "until-loop over gh pr checks" "$WATCH_REPO" \
  'until s=$(gh pr checks 1740 2>/dev/null) && ! grep -qE "pending" <<<"$s"; do sleep 30; done; echo "$s"'
expect_redirect "while-true loop" "$WATCH_REPO" \
  'while true; do gh pr checks 1740; sleep 20; done'
expect_redirect "sleep without an explicit loop keyword" "$WATCH_REPO" \
  'gh pr checks 1740; sleep 60; gh pr checks 1740'
expect_redirect "loop from a subdirectory cwd" "$WATCH_REPO/nested/sub" \
  'until ! gh pr checks 1740 | grep -q pending; do sleep 30; done'

echo "=== silent: reads that are not waits ==="
expect_silent "one-shot gh pr checks" "$WATCH_REPO" 'gh pr checks 1740'
expect_silent "one-shot piped to grep" "$WATCH_REPO" \
  'gh pr checks 1740 | grep -Ev "pass"'
expect_silent "one-shot with --json" "$WATCH_REPO" \
  'gh pr checks 1740 --json name,bucket'
expect_silent "unrelated gh command in a loop" "$WATCH_REPO" \
  'until gh run list --limit 1 | grep -q completed; do sleep 30; done'

echo "=== silent: already using the watcher ==="
expect_silent "watcher --watch invocation" "$WATCH_REPO" \
  'bash scripts/pr-gate-watch.sh 1740 --watch'
expect_silent "watcher inside an until loop" "$WATCH_REPO" \
  'until bash scripts/pr-gate-watch.sh 1740; do sleep 30; done'

echo "=== silent: repo does not ship the watcher ==="
expect_silent "poll loop in a plain repo" "$PLAIN_REPO" \
  'until ! gh pr checks 12 | grep -q pending; do sleep 30; done'
expect_silent "poll loop outside any git repo" "$TMP_ROOT" \
  'until ! gh pr checks 12 | grep -q pending; do sleep 30; done'

echo "=== silent: another repo's PR (-R/--repo bypass) ==="
expect_silent "-R with a space" "$WATCH_REPO" \
  'until ! gh pr checks 12 -R other/repo | grep -q pending; do sleep 30; done'
expect_silent "--repo with a space" "$WATCH_REPO" \
  'until ! gh pr checks 12 --repo other/repo | grep -q pending; do sleep 30; done'
expect_silent "--repo=" "$WATCH_REPO" \
  'until ! gh pr checks 12 --repo=other/repo | grep -q pending; do sleep 30; done'
expect_silent "attached -Rowner/repo (GH-1684 shape)" "$WATCH_REPO" \
  'until ! gh pr checks 12 -Rother/repo | grep -q pending; do sleep 30; done'
# A `-R` substring that is not a repo target must NOT trip the bypass: this is
# still a blind poll loop and must still be redirected.
expect_redirect "-R substring inside a quoted string is not a bypass" "$WATCH_REPO" \
  'until ! gh pr checks 12 | grep -q pending; do sleep 30; echo "note -Rebuilding"; done'

echo "=== malformed payloads are inert ==="
run_hook "$WATCH_REPO" ""
if [ "$LAST_RC" -eq 0 ]; then pass "empty command"; else fail "empty command (rc=$LAST_RC)"; fi
set +e
printf 'not json' | bash "$HOOK" >/dev/null 2>&1
rc=$?
set -e
if [ "$rc" -eq 0 ]; then pass "non-JSON stdin"; else fail "non-JSON stdin (rc=$rc)"; fi

echo "=== registration covers both Bash and Monitor ==="
# An armed Monitor is the form this mistake actually takes — it fails silently
# for a whole session instead of returning — so the rail must cover that tool
# too, not only Bash. Both carry the command in .tool_input.command.
HOOKS_JSON="$(cd "$(dirname "$0")/../.." && pwd)/ralph/hooks/hooks.json"
for tool in Bash Monitor; do
  if jq -e --arg t "$tool" '
      .hooks.PreToolUse[]
      | select(.matcher == $t)
      | .hooks[]
      | select(.command | endswith("funnel-gate-watch.sh"))' \
      "$HOOKS_JSON" >/dev/null 2>&1; then
    pass "registered as a PreToolUse rail for $tool"
  else
    fail "not registered for $tool in hooks.json"
  fi
done

echo
echo "funnel-gate-watch: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
