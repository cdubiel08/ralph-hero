#!/usr/bin/env bash
# ralph/hooks/scripts/__tests__/merge-review-decision-gate.test.sh
# GH-1589 demotion: the hook is now a pure FUNNEL — bare `gh pr merge` in a
# review session is blocked toward scripts/merge-pr.sh; the script path
# passes through untouched (it self-gates). No network calls remain, so no
# gh stub is needed — these tests pin the shape contract only.

set -euo pipefail

HOOK="$(cd "$(dirname "$0")/.." && pwd)/merge-review-decision-gate.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# run_case <desc> <expected_exit> <command> [RALPH_COMMAND value]
run_case() {
  local desc="$1" expected="$2" command="$3" scope="${4-review}"
  local json actual
  json=$(jq -n --arg c "$command" '{tool_input: {command: $c}}')
  set +e
  env RALPH_HOOK_INPUT= RALPH_COMMAND="$scope" bash "$HOOK" <<<"$json" >/dev/null 2>&1
  actual=$?
  set -e
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc (exit $actual)"
  else
    fail "$desc — expected exit $expected, got $actual"
  fi
}

echo "=== merge-review-decision-gate.sh (funnel) ==="

# Out of scope: any command allowed when not a review session
run_case "non-review scope: bare gh pr merge allowed" 0 "gh pr merge 123 --merge" "impl"
run_case "non-review scope: empty RALPH_COMMAND allowed" 0 "gh pr merge 123" ""

# In scope, non-merge commands untouched
run_case "non-merge bash allowed" 0 "git status"
run_case "gh pr view allowed" 0 "gh pr view 123 --json state"
run_case "unrelated merge word allowed" 0 "git merge origin/main"

# The funnel: script path allowed, bare gh pr merge blocked
run_case "scripts/merge-pr.sh allowed" 0 "bash scripts/merge-pr.sh 123"
run_case "scripts/merge-pr.sh with worktree id allowed" 0 "bash scripts/merge-pr.sh 123 GH-123"
run_case "scripts/merge-pr.sh --force allowed (script posts override)" 0 'bash scripts/merge-pr.sh 123 --force "hotfix"'
run_case "absolute-path merge-pr.sh allowed" 0 "bash /repo/scripts/merge-pr.sh 123"
run_case "bare gh pr merge blocked" 2 "gh pr merge 123 --merge"
run_case "gh pr merge flags-first blocked" 2 "gh pr merge --squash 123"
run_case "gh pr merge URL blocked" 2 "gh pr merge https://github.com/o/r/pull/123"
run_case "chained gh pr merge blocked" 2 "gh pr checks 123 && gh pr merge 123"
# Regression (CodeRabbit, PR #1602): merge-pr.sh substring must NOT allowlist
# a command that ALSO contains a bare gh pr merge — block check runs first.
run_case "merge-pr.sh chained with bare gh pr merge blocked" 2 "bash scripts/merge-pr.sh 123 && gh pr merge 999 --squash"
run_case "merge-pr.sh then semicolon gh pr merge blocked" 2 "bash scripts/merge-pr.sh 123; gh pr merge 999"

# Block message names the verified path
json=$(jq -n '{tool_input: {command: "gh pr merge 123"}}')
set +e
msg=$(env RALPH_HOOK_INPUT= RALPH_COMMAND=review bash "$HOOK" <<<"$json" 2>&1 >/dev/null)
rc=$?
set -e
if [[ "$rc" -eq 2 ]] && grep -q "scripts/merge-pr.sh" <<<"$msg"; then
  pass "block message points at scripts/merge-pr.sh"
else
  fail "block message missing funnel target (rc=$rc): $msg"
fi

echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
