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
#
# Also covers GH-1683: the redirect message must only mention
# scripts/attest-pr.sh when the host repo actually ships it — a repo with
# scripts/merge-pr.sh but no scripts/attest-pr.sh must not be pointed at a
# nonexistent prerequisite. Includes a subdirectory cwd to exercise the
# `git rev-parse --show-toplevel` resolution path.

set -euo pipefail

HOOK="$(cd "$(dirname "$0")/../.." && pwd)/ralph/hooks/funnel-merge.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# Three throwaway git repos:
#   GATED_REPO    — ships scripts/merge-pr.sh only (no attest-pr.sh)
#   ATTEST_REPO   — ships both merge-pr.sh and attest-pr.sh (ralph-hero's shape)
#   PLAIN_REPO    — ships neither; the hook must stay out of its way entirely
# Each gets a nested subdirectory so a non-root cwd can be exercised.
GATED_REPO="$TMP_ROOT/gated"
ATTEST_REPO="$TMP_ROOT/attested"
PLAIN_REPO="$TMP_ROOT/plain"
mkdir -p "$GATED_REPO/scripts" "$GATED_REPO/nested/sub" \
  "$ATTEST_REPO/scripts" "$ATTEST_REPO/nested/sub" "$PLAIN_REPO"
git init -q "$GATED_REPO"
git init -q "$ATTEST_REPO"
git init -q "$PLAIN_REPO"
printf '#!/usr/bin/env bash\necho stub\n' >"$GATED_REPO/scripts/merge-pr.sh"
chmod +x "$GATED_REPO/scripts/merge-pr.sh"
printf '#!/usr/bin/env bash\necho stub\n' >"$ATTEST_REPO/scripts/merge-pr.sh"
printf '#!/usr/bin/env bash\necho stub\n' >"$ATTEST_REPO/scripts/attest-pr.sh"
chmod +x "$ATTEST_REPO/scripts/merge-pr.sh" "$ATTEST_REPO/scripts/attest-pr.sh"

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
# GH-1683: the attestation clause is conditional on attest-pr.sh existing.
# ---------------------------------------------------------------------------

# 10. Repo shipping BOTH scripts -> message names the gate AND the attest step.
run_hook "$ATTEST_REPO" "gh pr merge 123"
expect_rc "gated+attested repo redirects" 2
if [[ "$LAST_ERR" == *"$ATTEST_REPO/scripts/merge-pr.sh"* ]] &&
  [[ "$LAST_ERR" == *"attest first via bash"* ]] &&
  [[ "$LAST_ERR" == *"$ATTEST_REPO/scripts/attest-pr.sh"* ]]; then
  pass "repo with attest-pr.sh -> message includes the attest clause"
else
  fail "repo with attest-pr.sh -> expected attest clause, got: $LAST_ERR"
fi

# 11. Repo shipping merge-pr.sh but NOT attest-pr.sh -> no attest mention at
# all. Pointing at a nonexistent prerequisite is the GH-1683 defect.
run_hook "$GATED_REPO" "gh pr merge 123"
expect_rc "gated-only repo redirects" 2
if [[ "$LAST_ERR" == *"$GATED_REPO/scripts/merge-pr.sh"* ]] &&
  [[ "$LAST_ERR" != *"attest-pr.sh"* ]] &&
  [[ "$LAST_ERR" != *"attest first"* ]]; then
  pass "repo without attest-pr.sh -> message omits the attest clause"
else
  fail "repo without attest-pr.sh -> expected no attest mention, got: $LAST_ERR"
fi

# 12. Subdirectory cwd: ROOT comes from `git rev-parse --show-toplevel`, so
# the printed paths must be repo-root-relative, not cwd-relative — and the
# attest-clause decision must key off the resolved root, not the subdir.
run_hook "$ATTEST_REPO/nested/sub" "gh pr merge 123"
expect_rc "subdirectory cwd (attested repo) redirects" 2
if [[ "$LAST_ERR" == *"$ATTEST_REPO/scripts/merge-pr.sh"* ]] &&
  [[ "$LAST_ERR" == *"$ATTEST_REPO/scripts/attest-pr.sh"* ]]; then
  pass "subdirectory cwd (attested) -> paths resolve to repo root, attest clause kept"
else
  fail "subdirectory cwd (attested) -> expected root-relative paths + attest clause, got: $LAST_ERR"
fi

run_hook "$GATED_REPO/nested/sub" "gh pr merge 123"
expect_rc "subdirectory cwd (gated-only repo) redirects" 2
if [[ "$LAST_ERR" == *"$GATED_REPO/scripts/merge-pr.sh"* ]] &&
  [[ "$LAST_ERR" != *"attest-pr.sh"* ]]; then
  pass "subdirectory cwd (gated-only) -> paths resolve to repo root, attest clause omitted"
else
  fail "subdirectory cwd (gated-only) -> expected root-relative paths + no attest mention, got: $LAST_ERR"
fi


# Quoted vs run (GH-1930): a doc edit or issue body that mentions the guarded
# command merges nothing, and refusing it makes this rail unwritable-about.
run_hook "$ATTEST_REPO" "gh issue comment 1 --body 'never use bare gh pr merge here'"
expect_rc "quoted mention of the guarded command passes" 0

# The same rule across NEWLINES (GH-2057). The stripper was line-based, so a
# multi-line `--body "..."` — the shape every real issue filing takes — had its
# quotes on different lines and was never stripped. This rail refused GH-2057's
# own filing. Backticks are incidental to the case, and deliberately included:
# what matters is that the span is quoted, not how it is marked up inside.
run_hook "$ATTEST_REPO" "$(printf 'gh issue create --title x --body "line one\nnever run bare `gh pr merge` here\nline three"')"
expect_rc "multi-line quoted mention of the guarded command passes" 0

# Backticks OUTSIDE quotes are command substitution, which really does run what
# is inside them. Stripping them would open a hole this rail exists to close.
run_hook "$ATTEST_REPO" 'echo `gh pr merge 123`'
expect_rc "command substitution invoking the guarded command still redirects" 2

# ---------------------------------------------------------------------------
echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
