#!/usr/bin/env bash
# scripts/__tests__/gh-budget.test.sh
# Contract tests for scripts/lib/gh-budget.sh (GH-1817).
#
# The load-bearing case is the one the library exists for: `gh` printing a
# rate-limit message and EXITING 0. Every other case is here to keep the guard
# from becoming a nuisance that people route around — a healthy call must stay
# transparent, and an unreadable budget must never block work.

set -euo pipefail

LIB="$(cd "$(dirname "$0")/.." && pwd)/lib/gh-budget.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"
export STUB_DIR="$TMP_ROOT/state"
mkdir -p "$STUB_DIR"

# A `gh` whose behaviour each case dials in by dropping files in STUB_DIR.
cat >"$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
if [[ "${1:-} ${2:-}" == "api rate_limit" ]]; then
  [[ -f "$STUB_DIR/rl_unreadable" ]] && exit 1
  cat "$STUB_DIR/rate_limit.json"
  exit 0
fi
# Any other invocation is the "write" under test.
[[ -f "$STUB_DIR/write_stdout" ]] && cat "$STUB_DIR/write_stdout"
[[ -f "$STUB_DIR/write_stderr" ]] && cat "$STUB_DIR/write_stderr" >&2
exit "$(cat "$STUB_DIR/write_exit" 2>/dev/null || echo 0)"
STUB
chmod +x "$STUB_BIN/gh"
PATH="$STUB_BIN:$PATH"
export PATH

reset_stubs() { rm -f "$STUB_DIR"/*; }

# shellcheck source=../lib/gh-budget.sh
. "$LIB"

mk_rl() { # remaining reset_epoch
  printf '{"resources":{"graphql":{"limit":5000,"remaining":%s,"used":0,"reset":%s}}}\n' \
    "$1" "$2" >"$STUB_DIR/rate_limit.json"
}

echo "=== gb_looks_rate_limited: the signature ==="

# The exact string observed on 2026-08-12, which is this whole issue's origin.
if gb_looks_rate_limited "GraphQL: API rate limit already exceeded"; then
  pass "matches the observed 'already exceeded' wording"
else
  fail "matches the observed 'already exceeded' wording"
fi

if gb_looks_rate_limited "API rate limit exceeded for user ID 1234"; then
  pass "matches the plain REST wording"
else
  fail "matches the plain REST wording"
fi

if gb_looks_rate_limited "You have exceeded a secondary rate limit"; then
  pass "matches the secondary rate limit"
else
  fail "matches the secondary rate limit"
fi

# The narrowness that keeps this from firing on unrelated repo text: several
# scripts here already match a REVIEW bot's own "Review rate limited" check
# description, which is a different concern with a different remedy.
if gb_looks_rate_limited "Review rate limited"; then
  fail "does not match the review bot's own throttling"
else
  pass "does not match the review bot's own throttling"
fi

if gb_looks_rate_limited "all gates green"; then
  fail "does not match ordinary output"
else
  pass "does not match ordinary output"
fi

echo "=== gb_gh: exit 0 is not success ==="

reset_stubs
# THE case. gh exits 0, the write never happened.
printf 'GraphQL: API rate limit already exceeded\n' >"$STUB_DIR/write_stdout"
echo 0 >"$STUB_DIR/write_exit"
rc=0
gb_gh pr comment 5 --body x >/dev/null 2>&1 || rc=$?
if [[ $rc -eq 4 ]]; then
  pass "a rate-limited write that gh exited 0 on is refused as 4"
else
  fail "a rate-limited write that gh exited 0 on is refused as 4 (got $rc)"
fi

reset_stubs
# The same message on stderr instead: gh has been seen using either stream, and
# a guard watching only one reproduces the defect on the other.
printf 'GraphQL: API rate limit already exceeded\n' >"$STUB_DIR/write_stderr"
echo 0 >"$STUB_DIR/write_exit"
rc=0
gb_gh pr comment 5 --body x >/dev/null 2>&1 || rc=$?
if [[ $rc -eq 4 ]]; then
  pass "the signature is caught on stderr too"
else
  fail "the signature is caught on stderr too (got $rc)"
fi

reset_stubs
# A rate limit gh DID report as a failure still reports as 4: "wait for the
# reset" and "this request is malformed" are different remedies.
printf 'API rate limit exceeded\n' >"$STUB_DIR/write_stderr"
echo 1 >"$STUB_DIR/write_exit"
rc=0
gb_gh pr comment 5 --body x >/dev/null 2>&1 || rc=$?
if [[ $rc -eq 4 ]]; then
  pass "a rate limit gh already failed on is still typed as 4"
else
  fail "a rate limit gh already failed on is still typed as 4 (got $rc)"
fi

reset_stubs
# An unrelated failure passes through untouched — the guard must not swallow
# every other error into one code.
printf 'HTTP 422: Validation Failed\n' >"$STUB_DIR/write_stderr"
echo 1 >"$STUB_DIR/write_exit"
rc=0
gb_gh pr comment 5 --body x >/dev/null 2>&1 || rc=$?
if [[ $rc -eq 1 ]]; then
  pass "an unrelated gh failure keeps its own exit code"
else
  fail "an unrelated gh failure keeps its own exit code (got $rc)"
fi

reset_stubs
# A healthy call is fully transparent: exit 0 AND stdout intact on stdout.
printf 'https://github.com/o/r/pull/5#issuecomment-1\n' >"$STUB_DIR/write_stdout"
echo 0 >"$STUB_DIR/write_exit"
rc=0
out=$(gb_gh pr comment 5 --body x 2>/dev/null) || rc=$?
if [[ $rc -eq 0 && "$out" == *"issuecomment-1"* ]]; then
  pass "a healthy call passes through with stdout on stdout"
else
  fail "a healthy call passes through with stdout on stdout (rc=$rc out=$out)"
fi

echo "=== gb_backoff_seconds: fails OPEN ==="

reset_stubs
mk_rl 4000 "$(( $(date +%s) + 600 ))"
if [[ "$(gb_backoff_seconds)" == "0" ]]; then
  pass "a healthy budget asks for no backoff"
else
  fail "a healthy budget asks for no backoff"
fi

reset_stubs
mk_rl 10 "$(( $(date +%s) + 600 ))"
b=$(gb_backoff_seconds)
if [[ "$b" -gt 500 && "$b" -le 600 ]]; then
  pass "a starved budget asks for the seconds until reset"
else
  fail "a starved budget asks for the seconds until reset (got $b)"
fi

reset_stubs
: >"$STUB_DIR/rl_unreadable"
# The fail-open rule: a budget check that cannot read its own budget must never
# stop work. Reading this as "starved" would convert a transient outage into a
# full stop, which is strictly worse than the starvation it guards against.
if [[ "$(gb_backoff_seconds)" == "0" ]]; then
  pass "an unreadable budget asks for no backoff (fails open)"
else
  fail "an unreadable budget asks for no backoff (fails open)"
fi

reset_stubs
# A reset already in the past is not a negative sleep.
mk_rl 10 "$(( $(date +%s) - 60 ))"
if [[ "$(gb_backoff_seconds)" == "0" ]]; then
  pass "an elapsed reset asks for no backoff"
else
  fail "an elapsed reset asks for no backoff"
fi

echo "=== gb_report_low: a backoff is never silent ==="

reset_stubs
mk_rl 10 "$(( $(date +%s) + 600 ))"
if gb_report_low 2>&1 >/dev/null | grep -q "budget low"; then
  pass "a starved budget is narrated"
else
  fail "a starved budget is narrated"
fi

reset_stubs
mk_rl 4000 "$(( $(date +%s) + 600 ))"
if [[ -z "$(gb_report_low 2>&1 >/dev/null)" ]]; then
  pass "a healthy budget stays quiet"
else
  fail "a healthy budget stays quiet"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]]
