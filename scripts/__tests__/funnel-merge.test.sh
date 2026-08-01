#!/usr/bin/env bash
# scripts/__tests__/funnel-merge.test.sh
# Tests ralph/hooks/funnel-merge.sh (the PreToolUse courtesy rail) by feeding
# it simulated hook payloads on stdin — the same shape Claude Code sends for
# a Bash PreToolUse event: {"tool_input": {"command": "..."}, "cwd": "..."}.
#
# Covers the redirect path (bare `gh pr merge` in a gate-shipping repo) and
# every -R/--repo bypass form, including GH-1684: gh's attached short-option
# form `-Rowner/repo` (no space between -R and its value), which the case
# pattern originally only matched with a leading space.

set -euo pipefail

HOOK="$(cd "$(dirname "$0")/../.." && pwd)/ralph/hooks/funnel-merge.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# gated_repo / plain_repo: two throwaway git repos, one that ships the merge
# gate (scripts/merge-pr.sh) and one that doesn't — the hook's redirect only
# fires for the former.
GATED_REPO="$TMP_ROOT/gated"
PLAIN_REPO="$TMP_ROOT/plain"
mkdir -p "$GATED_REPO/scripts" "$PLAIN_REPO"
git init -q "$GATED_REPO"
git init -q "$PLAIN_REPO"
printf '#!/usr/bin/env bash\necho stub\n' >"$GATED_REPO/scripts/merge-pr.sh"
chmod +x "$GATED_REPO/scripts/merge-pr.sh"

# run_hook <cwd> <command> -> sets LAST_OUT, LAST_ERR, LAST_RC
run_hook() {
  local cwd="$1" cmd="$2"
  local payload
  payload=$(jq -n --arg cmd "$cmd" --arg cwd "$cwd" \
    '{tool_input: {command: $cmd}, cwd: $cwd}')
  local out err rc
  set +e
  out=$(printf '%s' "$payload" | bash "$HOOK" 2>"$TMP_ROOT/stderr")
  rc=$?
  set -e
  err=$(<"$TMP_ROOT/stderr")
  LAST_OUT="$out"
  LAST_ERR="$err"
  LAST_RC="$rc"
}

# expect_rc <desc> <expected_rc>
expect_rc() {
  local desc="$1" expected="$2"
  if [[ "$LAST_RC" == "$expected" ]]; then
    pass "$desc (exit $LAST_RC)"
  else
    fail "$desc — expected exit $expected, got $LAST_RC. stderr: $LAST_ERR"
  fi
}

echo "=== funnel-merge.sh ==="

# 1. Bare `gh pr merge` in a repo that ships the gate -> redirected (exit 2).
run_hook "$GATED_REPO" "gh pr merge 123 --squash"
expect_rc "bare merge in gated repo redirects" 2
if [[ "$LAST_ERR" == *"merge gate"* ]]; then
  pass "redirect message names the gate"
else
  fail "redirect message missing gate mention: $LAST_ERR"
fi

# 2. Bare `gh pr merge` in a repo without the gate -> untouched (exit 0).
run_hook "$PLAIN_REPO" "gh pr merge 123 --squash"
expect_rc "bare merge in gate-less repo passes through" 0

# 3. Already going through the gate script -> never redirected.
run_hook "$GATED_REPO" "bash scripts/merge-pr.sh 123"
expect_rc "invoking the gate script itself passes through" 0

# 4. Explicit --repo (space form) targeting another repo -> bypassed.
run_hook "$GATED_REPO" "gh pr merge 123 --repo other-org/other-repo"
expect_rc "--repo <val> (space) bypasses" 0

# 5. Explicit --repo= (equals form) -> bypassed.
run_hook "$GATED_REPO" "gh pr merge 123 --repo=other-org/other-repo"
expect_rc "--repo=<val> bypasses" 0

# 6. Explicit -R (space form) -> bypassed.
run_hook "$GATED_REPO" "gh pr merge 123 -R other-org/other-repo"
expect_rc "-R <val> (space) bypasses" 0

# 7. GH-1684: attached short form -R<val>, no space -> must also bypass.
run_hook "$GATED_REPO" "gh pr merge 123 -Rother-org/other-repo"
expect_rc "-R<val> (attached, GH-1684) bypasses" 0

# 8. Attached short form with a host segment -> still bypasses.
run_hook "$GATED_REPO" "gh pr merge 123 -Rghe.example.com/other-org/other-repo"
expect_rc "-R<host/owner/repo> (attached) bypasses" 0

# 9. Over-match guard: "-R" as a substring of unrelated flag text with no
# slash immediately after it must NOT be treated as a repo target — it
# should still redirect to the local gate.
run_hook "$GATED_REPO" 'gh pr merge 123 --body "-Release notes, no repo flag here"'
expect_rc "-R-prefixed prose without a slash still redirects" 2

# ---------------------------------------------------------------------------
echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
