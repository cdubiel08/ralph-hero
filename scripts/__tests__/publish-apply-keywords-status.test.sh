#!/usr/bin/env bash
# scripts/__tests__/publish-apply-keywords-status.test.sh
# Contract tests for scripts/publish-apply-keywords-status.sh (GH-1827).
#
# The FAIL path is the point of this suite: the bug it covers survived because
# only PASS and INERT were ever exercised in CI. Each case runs the script in a
# throwaway CWD with a stubbed `gh` and a stubbed scripts/apply-keywords.sh,
# then asserts on the recorded status POST — no network, no real repo.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/publish-apply-keywords-status.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
case "${1:-} ${2:-}" in
  "pr view")
    if [[ -f "$STUB_DIR/pr_view_fails" ]]; then echo "gh: rate limited" >&2; exit 1; fi
    if [[ -f "$STUB_DIR/pr_view_second" && -f "$STUB_DIR/pr_view_seen" ]]; then
      cat "$STUB_DIR/pr_view_second"; exit 0
    fi
    : >"$STUB_DIR/pr_view_seen"
    cat "$STUB_DIR/pr_view"
    ;;
  "api repos/"*)
    printf '%s\n' "$@" >"$STUB_DIR/status_post"
    if [[ -f "$STUB_DIR/publish_fails" ]]; then echo "gh: 422" >&2; exit 1; fi
    ;;
  *) echo "stub: unhandled gh $*" >&2; exit 64 ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

SHA=a7acfefb1234567890123456789012345678abcd

# Runs the script in a fresh sandbox. $1 = checker exit code, or "absent" for
# the INERT path. Sets $OUT and $RC; the recorded POST lands in $STUB_DIR.
run_case() {
  local checker="$1"
  STUB_DIR="$TMP_ROOT/case.$RANDOM"
  mkdir -p "$STUB_DIR/scripts"
  printf '%s|2026-08-13T00:00:00Z\n' "$SHA" >"$STUB_DIR/pr_view"
  if [[ "$checker" != "absent" ]]; then
    cat >"$STUB_DIR/scripts/apply-keywords.sh" <<CHECKER
#!/usr/bin/env bash
echo "APPLY KEYWORDS FAIL — PR touches infrastructure and closes #1756, which has no apply twin."
echo "second line of detail" >&2
exit $checker
CHECKER
    chmod +x "$STUB_DIR/scripts/apply-keywords.sh"
  fi
}

execute() {
  set +e
  OUT=$(cd "$STUB_DIR" && PATH="$STUB_BIN:$PATH" STUB_DIR="$STUB_DIR" \
    GITHUB_REPOSITORY=cdubiel08/ralph-hero GITHUB_RUN_ID=1 \
    bash "$SCRIPT" 1755 2>&1)
  RC=$?
  set -e
}

# The stub records one gh argv word per line; `-f key=value` pairs land as a
# bare `key=value` line.
posted() { sed -n "s/^$1=//p" "$STUB_DIR/status_post" 2>/dev/null; }

echo "=== publish-apply-keywords-status.sh ==="

# The regression: a non-zero checker must still log its verdict and publish.
run_case 1; execute
[[ $RC -eq 0 ]] && pass "FAIL path exits 0 (the status is the verdict channel)" \
  || fail "FAIL path exited $RC — output: $OUT"
grep -q "APPLY KEYWORDS FAIL" <<<"$OUT" \
  && pass "FAIL path logs the verdict text" || fail "verdict text missing from log"
grep -q "second line of detail" <<<"$OUT" \
  && pass "FAIL path logs the checker's stderr too" || fail "stderr swallowed"
[[ "$(posted state)" == "failure" ]] \
  && pass "FAIL path publishes state=failure" || fail "published state was '$(posted state)'"
[[ "$(posted context)" == "ralph-apply-keywords" ]] \
  && pass "FAIL path publishes the ralph-apply-keywords context" || fail "wrong context"
[[ "$(posted description)" == "APPLY KEYWORDS FAIL"* ]] \
  && pass "description is the verdict's first line" || fail "description was '$(posted description)'"
grep -q "commit status published: ralph-apply-keywords=failure" <<<"$OUT" \
  && pass "FAIL path confirms the publish in the log" || fail "no publish confirmation"

run_case 0; execute
[[ $RC -eq 0 && "$(posted state)" == "success" ]] \
  && pass "PASS path publishes state=success" || fail "PASS path: rc=$RC state=$(posted state)"

run_case absent; execute
[[ "$(posted state)" == "success" ]] && grep -q "INERT" <<<"$OUT" \
  && pass "absent checker publishes an INERT success" || fail "INERT path broken"

# The case the original inline comment guarded — must not regress.
run_case 1; : >"$STUB_DIR/publish_fails"; execute
[[ $RC -ne 0 ]] && grep -q "::error::failed to publish" <<<"$OUT" \
  && pass "a failed publish fails the job loudly" || fail "failed publish was silent (rc=$RC)"

# An unreadable PR must not publish against an empty SHA.
run_case 0; : >"$STUB_DIR/pr_view_fails"; execute
[[ $RC -ne 0 ]] && [[ ! -f "$STUB_DIR/status_post" ]] \
  && pass "unreadable PR publishes nothing and fails" || fail "unreadable PR: rc=$RC"

# A head that moved mid-check publishes nothing, but does not fail the job.
run_case 0
printf 'deadbeef1234567890123456789012345678abcd|2026-08-13T00:01:00Z\n' >"$STUB_DIR/pr_view_second"
execute
[[ $RC -eq 0 ]] && [[ ! -f "$STUB_DIR/status_post" ]] \
  && pass "PR changed mid-check publishes nothing, exits 0" || fail "mid-check change: rc=$RC"

# A non-SHA head is refused rather than posted.
run_case 0; printf 'unknown|2026-08-13T00:00:00Z\n' >"$STUB_DIR/pr_view"; execute
[[ $RC -ne 0 ]] && [[ ! -f "$STUB_DIR/status_post" ]] \
  && pass "unreadable head SHA publishes nothing and fails" || fail "bad SHA: rc=$RC"

echo "  $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
