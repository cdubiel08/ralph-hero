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
# does; a non-PR branch never does; an unreadable `gh` fails OPEN *and says so*
# while a measured "no open PR" stays silent (GH-2263 — the two must not render
# alike); the deliver-push.sh segment exempts itself; and a QUOTED
# `git push --force` (documentation about this rail) is not a command being run.

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

# gh stub: STUB_GH_PRS is the count to report; "fail" exits non-zero, and any
# non-numeric value is the unparseable-answer path.
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

expect_stderr_empty() {
  local desc="$1"
  if [[ -z "$LAST_ERR" ]]; then
    pass "$desc"
  else
    fail "$desc — expected silence, got: $LAST_ERR"
  fi
}

expect_stderr_says() {
  local desc="$1" needle="$2"
  if [[ "$LAST_ERR" == *"$needle"* ]]; then
    pass "$desc"
  else
    fail "$desc — stderr lacks '$needle': ${LAST_ERR:-<empty>}"
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

# --- GH-2263: fail open, but blind and measured must not render alike -------
#
# By this point the hazard is established, so the only remaining unknown is
# what the rail could not read. All three exit 0 — the rail is never
# enforcement — but only the two blind ones speak.
#
# An assignment prefix on a FUNCTION call persists in bash after it returns,
# so the stub state is set and unset explicitly rather than inline.

export STUB_GH_PRS=0
run_hook "git push --force origin scratch/experiment"
expect_rc "force push with no open PR passes" 0
expect_stderr_empty "a MEASURED no-open-PR stays silent (a line here is how the two below stop being read)"

export STUB_GH_PRS=fail
run_hook "git push --force origin feat/1930-courtesy-funnel-for"
expect_rc "unreadable gh fails OPEN" 0
expect_stderr_says "a BLIND gh names the branch it could not read" "feat/1930-courtesy-funnel-for"
expect_stderr_says "a BLIND gh says the lease rail did not evaluate" "did NOT evaluate"

export STUB_GH_PRS="not-a-number"
run_hook "git push --force origin feat/1930-courtesy-funnel-for"
expect_rc "unparseable PR count fails OPEN" 0
expect_stderr_says "an UNPARSEABLE count says the lease rail did not evaluate" "did NOT evaluate"
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

# --- GH-2058: the stripper and the segmenter both read the WHOLE command ----
#
# Same defect as funnel-board, and the expensive one to get wrong: the cost of
# a wrong redirect here is a session that cannot push its own work.

run_hook 'gh issue create --title T --body "The rail catches this form:
  git push --force origin feat/1930-courtesy-funnel-for
and redirects it to the lease script."'
expect_rc "multi-line quoted body quoting a force push passes" 0

# The single-line form passed before the fix; pinned so the two cases stay
# distinguishable.
run_hook 'gh issue create --title T --body "never git push --force origin feat/1930-courtesy-funnel-for"'
expect_rc "single-line quoted body quoting a force push passes" 0

# A real force push on a later line of a multi-line command still redirects.
run_hook 'echo "prose about
force pushing" && git push --force origin feat/1930-courtesy-funnel-for'
expect_rc "a real force push after a multi-line quoted span still redirects" 2

# A separator inside the quoted body is not a separator.
run_hook 'gh issue create --title T --body "a; b && c | d
git push --force origin feat/1930-courtesy-funnel-for"'
expect_rc "separators inside a multi-line quoted body do not split it" 0


echo ""
echo "funnel-push.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
