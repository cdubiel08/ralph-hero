#!/usr/bin/env bash
# scripts/__tests__/pr-gate-watch.test.sh
# Tests the verdict ladder of scripts/pr-gate-watch.sh.
#
# Harness: a PATH-injected `gh` stub serves canned JSON from $GH_STUB_DIR, so
# classification is tested without network. Pattern follows
# merge-pr-gates.test.sh.
#
# The two verdicts that justify the script's existence get explicit coverage:
#   - GATE-YOURS attestation: every other check is green and the attestation
#     status is pending, i.e. the state in which a `! grep -q pending` loop
#     waits forever (PR #1740).
#   - GATE-YOURS review: CodeRabbit's check PASSES while carrying "Review rate
#     limited" and no review exists, i.e. the state in which an all-green
#     board is still not merge-ready.
# Plus the precedence between them: review must outrank attestation, because
# attest-pr.sh refuses outright when no review verdict exists.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/pr-gate-watch.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# --- gh stub ---------------------------------------------------------------
STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
serve() {
  local f="$GH_STUB_DIR/$1"
  if [[ -f "$f" ]]; then cat "$f"; else echo "$2"; fi
}
case "${1:-} ${2:-}" in
  "pr checks")
    serve pr_checks.json '[]'
    # Real `gh pr checks` exits non-zero whenever a check is pending or
    # failing; the script must tolerate that rather than treat it as an error.
    exit "${GH_STUB_CHECKS_EXIT:-0}"
    ;;
  "pr view") serve pr_view.json '{"state":"OPEN","reviewDecision":null,"headRefOid":"","comments":[]}' ;;
  "api repos/"*) serve pr_reviews.json '[]' ;;
  *) echo "stub: unhandled gh $*" >&2; exit 64 ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

# --- fixture helpers -------------------------------------------------------
# check <name> <bucket> [description] -> one JSON check object
check() {
  jq -n --arg n "$1" --arg b "$2" --arg d "${3:-}" \
    '{name: $n, bucket: $b, description: $d}'
}
# scenario <dir> <checks-json> <pr-json> <reviews-json>
scenario() {
  local dir="$1"
  mkdir -p "$dir"
  printf '%s' "$2" >"$dir/pr_checks.json"
  printf '%s' "$3" >"$dir/pr_view.json"
  printf '%s' "$4" >"$dir/pr_reviews.json"
}

HEAD_SHA="306c13de306c13de306c13de306c13de306c13de"
OLD_SHA="0000000011111111222222223333333344444444"

# attestation_comment <head-sha> -> the comment shape attest-pr.sh posts: the
# v1 marker plus a fenced JSON block carrying head_sha.
attestation_comment() {
  jq -n --arg sha "$1" '
    {body: ("<!-- ralph-attestation:v1 -->\n## Merge Attestation\n\n```json\n"
      + ({version: 1, head_sha: $sha} | tojson)
      + "\n```\n")}'
}

# pr_state <state> <reviewDecision-or-null> [comments-json]
pr_state() {
  jq -n --arg s "$1" --arg rd "$2" --arg sha "$HEAD_SHA" \
    --argjson comments "${3:-[]}" \
    '{state: $s, reviewDecision: (if $rd == "" then null else $rd end),
      headRefOid: $sha, comments: $comments}'
}

OPEN_PR=$(pr_state OPEN "")
APPROVED_PR=$(pr_state OPEN APPROVED)
NO_REVIEWS='[]'
APPROVAL='[{"state":"APPROVED","user":{"login":"coderabbitai[bot]"},"html_url":"https://example.test/r/1"}]'

GREEN_CHECKS=$(jq -n --argjson a "$(check ci pass)" --argjson b "$(check lint pass)" '[$a,$b]')
ATT_PENDING=$(check ralph-attestation pending 'awaiting attestation (scripts/attest-pr.sh)')
ATT_PASS=$(check ralph-attestation pass 'ATTESTATION PASS')

# run <stub-dir> [extra args...] -> sets LAST_OUT, LAST_RC
run() {
  local dir="$1"
  shift
  local rc
  set +e
  LAST_OUT=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$dir" \
    GH_STUB_CHECKS_EXIT="${CHECKS_EXIT:-0}" bash "$SCRIPT" 1740 "$@" 2>&1)
  rc=$?
  set -e
  LAST_RC=$rc
}

# expect <label> <stub-dir> <verdict-prefix> <expected-rc>
expect() {
  local label="$1" dir="$2" want="$3" want_rc="$4"
  run "$dir"
  if [[ "$LAST_OUT" == "$want"* ]] && [ "$LAST_RC" -eq "$want_rc" ]; then
    pass "$label"
  else
    fail "$label (rc=$LAST_RC want=$want_rc out=${LAST_OUT:0:110})"
  fi
}

echo "=== the headline case: attestation is the only thing left ==="
D="$TMP_ROOT/yours-attest"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$APPROVED_PR" "$APPROVAL"
expect "GATE-YOURS attestation when all else is green" "$D" "GATE-YOURS attestation" 0
run "$D"
if [[ "$LAST_OUT" == *"attest-pr.sh 1740"* ]] && [[ "$LAST_OUT" == *"coderabbitai[bot]"* ]]; then
  pass "hands back a runnable attest-pr.sh command with the real reviewer login"
else
  fail "attest command hint (out=${LAST_OUT:0:160})"
fi
# The stranding condition itself: gh pr checks exits 8 while pending.
CHECKS_EXIT=8 expect "non-zero gh pr checks exit is not an error" "$D" "GATE-YOURS attestation" 0
unset CHECKS_EXIT

echo "=== attested, but the validator has not caught up ==="
# The gap that made the first dogfood run wrong: attest-pr.sh has posted, so
# the next move is to WAIT for validate-attestation.yml — telling the caller to
# attest again here would have them redo work they just did.
ATT_CHECKS=$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')
D="$TMP_ROOT/attested-recomputing"
scenario "$D" "$ATT_CHECKS" \
  "$(pr_state OPEN APPROVED "[$(attestation_comment "$HEAD_SHA")]")" "$APPROVAL"
expect "GATE-WAIT attestation while the validator recomputes" "$D" "GATE-WAIT attestation" 10

# Same comparison, other direction: a new push moves the head, so the recorded
# attestation is stale and re-attesting is correctly demanded again.
D="$TMP_ROOT/attested-stale"
scenario "$D" "$ATT_CHECKS" \
  "$(pr_state OPEN APPROVED "[$(attestation_comment "$OLD_SHA")]")" "$APPROVAL"
expect "GATE-YOURS attestation again after the head moves" "$D" "GATE-YOURS attestation" 0

# A malformed attestation comment must not be read as a valid attestation.
D="$TMP_ROOT/attested-garbage"
scenario "$D" "$ATT_CHECKS" \
  "$(pr_state OPEN APPROVED '[{"body":"<!-- ralph-attestation:v1 -->\nno json fence here"}]')" \
  "$APPROVAL"
expect "unparseable attestation comment is not treated as attested" "$D" "GATE-YOURS attestation" 0

echo "=== the other false signal: green board, no actual review ==="
D="$TMP_ROOT/yours-review-ratelimit"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" \
  --argjson c "$(check CodeRabbit pass 'Review rate limited')" '$g + [$a, $c]')" \
  "$OPEN_PR" "$NO_REVIEWS"
expect "GATE-YOURS review on a rate-limited CodeRabbit pass" "$D" "GATE-YOURS review" 0
run "$D"
if [[ "$LAST_OUT" == *"@coderabbitai review"* ]]; then
  pass "names the nudge that unblocks it"
else
  fail "nudge hint (out=${LAST_OUT:0:120})"
fi

echo "=== precedence: review outranks attestation ==="
# Same fixture as above: attestation IS pending, but no review exists, so
# attest-pr.sh would refuse. Reporting attestation here would be a dead end.
run "$TMP_ROOT/yours-review-ratelimit"
if [[ "$LAST_OUT" != *attestation* ]]; then
  pass "does not send the caller to attest without a review verdict"
else
  fail "precedence: attestation reported before a review exists"
fi

D="$TMP_ROOT/commented-only"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$OPEN_PR" '[{"state":"COMMENTED","user":{"login":"coderabbitai[bot]"}}]'
expect "comment-only reviews are not a verdict" "$D" "GATE-YOURS review" 0

echo "=== waiting states (non-terminal, exit 10) ==="
D="$TMP_ROOT/wait-ci"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson p "$(check board-tests pending)" \
  --argjson a "$ATT_PENDING" '$g + [$p, $a]')" "$APPROVED_PR" "$APPROVAL"
expect "GATE-WAIT ci while other checks run" "$D" "GATE-WAIT ci" 10
run "$D"
if [[ "$LAST_OUT" == *"board-tests"* ]] && [[ "$LAST_OUT" != *"ralph-attestation"* ]]; then
  pass "names the running check, excluding attestation"
else
  fail "running-check naming (out=${LAST_OUT:0:120})"
fi

D="$TMP_ROOT/wait-review"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$OPEN_PR" "$NO_REVIEWS"
expect "GATE-WAIT review when nobody has reviewed yet" "$D" "GATE-WAIT review" 10

echo "=== terminal failure states ==="
D="$TMP_ROOT/fail-ci"
scenario "$D" "$(jq -n --argjson f "$(check board-tests fail)" --argjson a "$ATT_PENDING" '[$f,$a]')" \
  "$APPROVED_PR" "$APPROVAL"
expect "GATE-FAIL on a failed check" "$D" "GATE-FAIL ci" 0

D="$TMP_ROOT/fail-cancel"
scenario "$D" "$(jq -n --argjson f "$(check board-tests cancel)" '[$f]')" "$APPROVED_PR" "$APPROVAL"
expect "GATE-FAIL on a cancelled check" "$D" "GATE-FAIL ci" 0

D="$TMP_ROOT/fail-review"
scenario "$D" "$GREEN_CHECKS" "$(pr_state OPEN CHANGES_REQUESTED)" \
  '[{"state":"CHANGES_REQUESTED","user":{"login":"coderabbitai[bot]"}}]'
expect "GATE-FAIL on live CHANGES_REQUESTED" "$D" "GATE-FAIL review" 0

echo "=== ready and done ==="
D="$TMP_ROOT/ready"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$APPROVED_PR" "$APPROVAL"
expect "GATE-READY when green, reviewed and attested" "$D" "GATE-READY" 0
run "$D"
if [[ "$LAST_OUT" == *"merge-pr.sh 1740"* ]]; then
  pass "points at the merge gate, not bare gh pr merge"
else
  fail "merge hint (out=${LAST_OUT:0:120})"
fi

for state in MERGED CLOSED; do
  D="$TMP_ROOT/done-$state"
  scenario "$D" "$GREEN_CHECKS" "$(pr_state "$state" "")" "$APPROVAL"
  expect "GATE-DONE when PR is $state" "$D" "GATE-DONE" 0
done

echo "=== attestation-check identification ==="
# A repo that renamed the status: identified by its description instead.
D="$TMP_ROOT/renamed"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" \
  --argjson a "$(check my-custom-gate pending 'awaiting attestation (scripts/attest-pr.sh)')" '$g + [$a]')" \
  "$APPROVED_PR" "$APPROVAL"
expect "recognised via its attest-pr.sh description" "$D" "GATE-YOURS attestation" 0

D="$TMP_ROOT/env-override"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$(check other-gate pending)" '$g + [$a]')" \
  "$APPROVED_PR" "$APPROVAL"
set +e
out=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$D" PR_GATE_ATTEST_CHECK=other-gate \
  bash "$SCRIPT" 1740 2>&1)
rc=$?
set -e
if [[ "$out" == "GATE-YOURS attestation"* ]] && [ "$rc" -eq 0 ]; then
  pass "PR_GATE_ATTEST_CHECK renames the watched status"
else
  fail "PR_GATE_ATTEST_CHECK (rc=$rc out=${out:0:110})"
fi
# Without the override the same check is just another pending CI job.
expect "same check is plain CI without the override" "$D" "GATE-WAIT ci" 10

echo "=== degenerate inputs ==="
D="$TMP_ROOT/no-checks"
scenario "$D" '[]' "$APPROVED_PR" "$APPROVAL"
expect "a PR with no checks at all is ready, not crashed" "$D" "GATE-READY" 0

D="$TMP_ROOT/garbage-checks"
mkdir -p "$D"
printf 'no checks reported on the branch' >"$D/pr_checks.json"
printf '%s' "$APPROVED_PR" >"$D/pr_view.json"
printf '%s' "$APPROVAL" >"$D/pr_reviews.json"
expect "unparseable checks payload degrades to no checks" "$D" "GATE-READY" 0

echo "=== usage errors ==="
for bad in "" "abc" "12x"; do
  set +e
  PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$TMP_ROOT/ready" bash "$SCRIPT" $bad >/dev/null 2>&1
  rc=$?
  set -e
  if [ "$rc" -eq 2 ]; then pass "usage error for '$bad'"; else fail "usage '$bad' (rc=$rc)"; fi
done
set +e
PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$TMP_ROOT/ready" bash "$SCRIPT" 1740 --interval x >/dev/null 2>&1
rc=$?
set -e
if [ "$rc" -eq 2 ]; then pass "usage error for non-numeric --interval"; else fail "--interval (rc=$rc)"; fi

echo "=== --watch exits on a terminal verdict ==="
set +e
out=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$TMP_ROOT/yours-attest" \
  bash "$SCRIPT" 1740 --watch --interval 1 2>&1)
rc=$?
set -e
if [ "$rc" -eq 0 ] && [ "$(printf '%s\n' "$out" | grep -c 'GATE-YOURS')" -eq 1 ]; then
  pass "--watch emits the verdict once and exits"
else
  fail "--watch (rc=$rc out=${out:0:120})"
fi

echo
echo "pr-gate-watch: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
