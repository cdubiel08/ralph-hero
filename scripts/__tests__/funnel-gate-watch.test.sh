#!/usr/bin/env bash
# scripts/__tests__/funnel-gate-watch.test.sh
# Tests ralph/hooks/funnel-gate-watch.sh (the PreToolUse `gh pr checks` poll-loop
# courtesy rail, GH-1845) by feeding it simulated hook payloads on stdin.
#
# The hook is invoked DIRECTLY, never as `bash "$HOOK"`: a 100644 hook returns
# exit 126 from the real runner, and a test that goes through `bash` would never
# notice. The committed mode is asserted on its own besides.
#
# Because this rail is advisory (exit 0 always), every assertion is about
# whether the ADVICE was printed, not about the exit code — and the exit code is
# separately pinned at 0 on the tripping case, since an exit 2 here would be a
# third blocking rail the doctrine does not permit.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/ralph/hooks/funnel-gate-watch.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# run_hook <command> [cwd] -> sets LAST_ERR, LAST_RC
run_hook() {
  local cmd="$1" cwd="${2:-$ROOT}" payload
  payload=$(jq -n --arg cmd "$cmd" --arg cwd "$cwd" '{cwd: $cwd, tool_input: {command: $cmd}}')
  set +e
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>"$TMP_ROOT/stderr"
  LAST_RC=$?
  set -e
  LAST_ERR=$(<"$TMP_ROOT/stderr")
}

redirects() {
  local desc="$1"
  if [[ "$LAST_ERR" == *"pr-gate-watch.sh"* ]]; then pass "$desc"; else fail "$desc (silent)"; fi
}
silent() {
  local desc="$1"
  if [[ -z "$LAST_ERR" ]]; then pass "$desc"; else fail "$desc (redirected: $LAST_ERR)"; fi
}

echo "== executable bit =="
# The real runner execs the hook; 100644 would be exit 126 in production while
# every `bash "$HOOK"` test stayed green.
if [[ -x "$HOOK" ]]; then pass "hook is executable on disk"; else fail "hook is not executable"; fi
MODE=$(git -C "$ROOT" ls-files -s -- ralph/hooks/funnel-gate-watch.sh | awk '{print $1}')
if [[ "$MODE" == "100755" ]]; then
  pass "committed mode is 100755"
else
  fail "committed mode is ${MODE:-<untracked>}, want 100755"
fi

echo "== the loop this exists for =="
run_hook 'until ! gh pr checks 1845 | grep -q pending; do sleep 30; done'
redirects "canonical until-negation poll loop"
if [[ "$LAST_RC" == "0" ]]; then
  pass "advisory only — exits 0, never 2"
else
  fail "exit $LAST_RC — this rail must never block (GH-1845)"
fi
if [[ "$LAST_ERR" == *"1845"* ]]; then
  pass "recovers the PR number into a runnable line"
else
  fail "did not recover the PR number"
fi

run_hook 'while gh pr checks 1845 | grep -q pending; do sleep 60; done'
redirects "while-loop form"
run_hook 'for i in 1 2 3; do gh pr checks 1845; sleep 30; done'
redirects "counted retry loop"
run_hook 'until [ -z "$(gh pr checks 1845 --json state)" ]; do sleep 5; done'
redirects "gh inside a command substitution"

echo "== command position, not substring =="
# A loop that never calls gh. The substring match this replaces fired here.
run_hook 'while true; do echo "gh pr checks"; sleep 30; done'
silent "quoted 'gh pr checks' inside echo is an argument, not a command"
run_hook 'while true; do grep -q "gh pr checks" notes.md; sleep 30; done'
silent "quoted mention inside a grep pattern"
run_hook "board comment 1845 -m 'do not use until ! gh pr checks in a loop with sleep'"
silent "documenting this rail on the board does not trip it"
run_hook 'while true; do ./mygh pr checks 1845; sleep 30; done'
silent "a different binary ending in gh is not gh"

echo "== a poll loop, not a single read =="
run_hook 'gh pr checks 1845'
silent "one-shot check is a legitimate read"
run_hook 'gh pr checks 1845 && bash scripts/attest-pr.sh 1845'
silent "one-shot check chained into real work"
run_hook 'for pr in 1 2 3; do gh pr checks $pr; done'
silent "sweep over several PRs with no sleep is not polling"

echo "== -R bypass is as narrow as the trip =="
run_hook 'until ! gh pr checks 42 -R other/repo | grep -q pending; do sleep 30; done'
silent "another repo's PR is outside jurisdiction"
run_hook 'until ! gh pr checks 42 -Rother/repo | grep -q pending; do sleep 30; done'
silent "gh's attached -Rowner/repo shorthand also bypasses"
run_hook 'until ! gh pr checks 42 --repo=other/repo | grep -q pending; do sleep 30; done'
silent "--repo=owner/repo bypasses"
# The defect: a bare ` -R ` anywhere silencing the rail on a loop that DOES
# target this repo.
run_hook 'until ! gh pr checks 1845 | grep -R pending .; do sleep 30; done'
redirects "a bare -R with no owner/repo does not silence the rail"
run_hook 'until ! gh pr checks 1845 | some-tool --repo-mode; do sleep 30; done'
redirects "an unrelated --repo-prefixed flag does not silence the rail"

echo "== already using the classifier =="
run_hook 'until bash scripts/pr-gate-watch.sh 1845; do gh pr checks 1845; sleep 30; done'
silent "a command already naming the classifier is left alone"

echo "== degrades quietly =="
run_hook 'until ! gh pr checks 1845 | grep -q pending; do sleep 30; done' "$TMP_ROOT"
silent "a repo that ships no pr-gate-watch.sh gets no redirect"
LAST_ERR=$(printf '%s' '{"tool_input":{}}' | "$HOOK" 2>&1 >/dev/null) || true
silent "a payload with no command"
LAST_ERR=$(printf '%s' 'not json' | "$HOOK" 2>&1 >/dev/null) || true
silent "a payload that is not JSON"

echo "== GH-2058: the stripper reads the whole command =="
# The `sed` this replaced could not match a quoted span whose opening and
# closing quotes landed on different lines, so a body describing the futile
# loop kept its `gh pr checks` visible and drew the advisory.
run_hook 'gh issue create --title T --body "The futile loop looks like:
until ! gh pr checks 1845 | grep -q pending; do sleep 30; done
and it never terminates."'
silent "a multi-line quoted body describing the loop draws no advisory"

run_hook 'gh issue create --title T --body "never write: until ! gh pr checks 1845; do sleep 30; done"'
silent "a single-line quoted body describing the loop draws no advisory"

# The carve-out that matters: a command substitution inside double quotes is
# execution, not an argument — and it still is when the command is multi-line.
run_hook 'while [ -n "$(gh pr checks 1845)" ]; do
  sleep 30
done'
redirects "a multi-line loop wrapping the call in a substitution still redirects"

# ...and a real loop after a multi-line quoted mention is not amnestied.
run_hook 'echo "prose about
polling" ; until ! gh pr checks 1845 | grep -q pending; do sleep 30; done'
redirects "a real loop after a multi-line quoted span still redirects"


echo
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]
