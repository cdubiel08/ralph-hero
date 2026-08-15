#!/usr/bin/env bash
# scripts/__tests__/funnel-push.test.sh
# Tests ralph/hooks/funnel-push.sh (the PreToolUse force-push courtesy rail,
# GH-1930) by feeding it simulated hook payloads on stdin.
#
# `gh` and `git` are stubbed on PATH so no network or real repo is touched —
# and so the two fail-open paths (gh unreadable, no open PR) can be proved,
# which is the half a live-network test could not pin down.
#
# Covers: force push on a PR branch redirects; a plain fast-forward push never
# does; a non-PR branch never does; an unreadable `gh` fails OPEN; the
# deliver-push.sh segment exempts itself; and a QUOTED `git push --force`
# (documentation about this rail) is not treated as a command being run.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/ralph/hooks/funnel-push.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

STUB="$TMP_ROOT/bin"
mkdir -p "$STUB"

# git stub: only `rev-parse --abbrev-ref HEAD` is consulted by the hook.
cat >"$STUB/git" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${STUB_BRANCH:-feat/1930-courtesy-funnel-for}"
EOF

# gh stub: STUB_GH_PRS is the count to report; "fail" exits non-zero.
cat >"$STUB/gh" <<'EOF'
#!/usr/bin/env bash
[ "${STUB_GH_PRS:-1}" = "fail" ] && exit 1
printf '%s\n' "${STUB_GH_PRS:-1}"
EOF
chmod +x "$STUB/git" "$STUB/gh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# run_hook <command> -> sets LAST_ERR, LAST_RC
run_hook() {
  local cmd="$1"
  local payload
  payload=$(jq -n --arg cmd "$cmd" --arg cwd "$ROOT" '{cwd: $cwd, tool_input: {command: $cmd}}')
  set +e
  printf '%s' "$payload" | PATH="$STUB:$PATH" bash "$HOOK" >/dev/null 2>"$TMP_ROOT/stderr"
  LAST_RC=$?
  set -e
  LAST_ERR=$(<"$TMP_ROOT/stderr")
}

expect_rc() {
  local desc="$1" expected="$2"
  if [[ "$LAST_RC" == "$expected" ]]; then
    pass "$desc (exit $LAST_RC)"
  else
    fail "$desc — expected exit $expected, got $LAST_RC. stderr: $LAST_ERR"
  fi
}

echo "=== funnel-push.sh ==="

# --- In scope: force push on a branch with an open PR ----------------------

run_hook "git push --force origin feat/1930-courtesy-funnel-for"
expect_rc "--force on a PR branch redirects" 2
if [[ "$LAST_ERR" == *"deliver-push.sh"* && "$LAST_ERR" == *"--expect"* ]]; then
  pass "redirect names the lease script and --expect"
else
  fail "redirect message incomplete: $LAST_ERR"
fi

run_hook "git push -f origin HEAD:feat/1930-courtesy-funnel-for"
expect_rc "-f short flag redirects" 2

run_hook "git push --force-with-lease origin feat/1930-courtesy-funnel-for"
expect_rc "--force-with-lease redirects (bare lease is the trap GH-1917 names)" 2

run_hook "git push origin +feat/1930-courtesy-funnel-for:feat/1930-courtesy-funnel-for"
expect_rc "leading + refspec is force" 2

# No refspec at all: the branch comes from the checkout.
run_hook "git push --force"
expect_rc "--force with no refspec resolves the current branch" 2

# --- Out of scope ----------------------------------------------------------

run_hook "git push origin feat/1930-courtesy-funnel-for"
expect_rc "fast-forward push is never funneled" 0

run_hook "git push --follow-tags origin feat/1930-courtesy-funnel-for"
expect_rc "--follow-tags is not -f" 0

# An assignment prefix on a FUNCTION call persists in bash after it returns,
# so the stub state is set and unset explicitly rather than inline.
export STUB_GH_PRS=0
run_hook "git push --force origin scratch/experiment"
expect_rc "force push with no open PR passes" 0

export STUB_GH_PRS=fail
run_hook "git push --force origin feat/1930-courtesy-funnel-for"
expect_rc "unreadable gh fails OPEN" 0
unset STUB_GH_PRS

run_hook "bash ralph/scripts/deliver-push.sh --branch feat/1930-courtesy-funnel-for --expect abc123"
expect_rc "the sanctioned path exempts itself" 0

# --- Quoted vs run (the defect GH-1930 filed against the funnels) ----------

run_hook "board create --title 'funnel' --body 'redirect git push --force to the lease script'"
expect_rc "a quoted git push --force inside an argument is not a command" 0

run_hook 'gh issue comment 1930 --body "we should never git push --force here"'
expect_rc "double-quoted mention is not a command" 0

# ...but a real force push in a later segment still redirects.
run_hook "echo 'about git push --force' && git push --force origin feat/1930-courtesy-funnel-for"
expect_rc "a real force push after a quoted mention still redirects" 2

echo ""
echo "funnel-push.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
