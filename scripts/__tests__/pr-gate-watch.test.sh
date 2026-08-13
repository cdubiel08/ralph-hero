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
  "pr view")
    # A second pr_view fixture, when present, is served to the SECOND call —
    # which is what a push landing mid-snapshot looks like to this script.
    if [[ -f "$GH_STUB_DIR/pr_view_second.json" && -f "$GH_STUB_DIR/pr_view_called" ]]; then
      cat "$GH_STUB_DIR/pr_view_second.json"
    else
      touch "$GH_STUB_DIR/pr_view_called"
      serve pr_view.json '{"state":"OPEN","reviewDecision":null,"headRefOid":"","comments":[]}'
    fi
    ;;
  "api repos/"*)
    # Gate-5-shaped evidence lives on two endpoints: formal review objects and
    # issue comments (comment mode's head-bound request + clean result).
    if [[ "$2" == */issues/*/comments ]]; then serve issue_comments.json '[]'
    else serve pr_reviews.json '[]'; fi
    ;;
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
# scenario <dir> <checks-json> <pr-json> <reviews-json> [issue-comments-json]
scenario() {
  local dir="$1"
  mkdir -p "$dir"
  printf '%s' "$2" >"$dir/pr_checks.json"
  printf '%s' "$3" >"$dir/pr_view.json"
  printf '%s' "$4" >"$dir/pr_reviews.json"
  printf '%s' "${5:-[]}" >"$dir/issue_comments.json"
}

HEAD_SHA="306c13de306c13de306c13de306c13de306c13de"
OLD_SHA="0000000011111111222222223333333344444444"
BOT="chatgpt-codex-connector[bot]"

# --- merge policies --------------------------------------------------------
# The script derives its evidence mode from the SAME file scripts/merge-pr.sh
# gate 5 reads, so both modes are exercised against real policy documents
# rather than a flag. The marker names match .github/ralph-merge-policy.json.
POLICY_REVIEW="$TMP_ROOT/policy-review.json"
cat >"$POLICY_REVIEW" <<EOF
{ "version": 1,
  "attestation": { "required": true },
  "external_review": { "required": true, "bot": "$BOT", "trigger": "@codex review" },
  "exempt_authors": ["dependabot[bot]", "app/dependabot"] }
EOF
POLICY_COMMENT="$TMP_ROOT/policy-comment.json"
cat >"$POLICY_COMMENT" <<EOF
{ "version": 1,
  "attestation": { "required": true },
  "external_review": { "required": true, "bot": "$BOT", "trigger": "@codex review",
    "head_marker": "ralph-review-head",
    "clean_comment_marker": "Codex Review: Didn't find any major issues." },
  "exempt_authors": ["dependabot[bot]", "app/dependabot"] }
EOF
POLICY_NOATT="$TMP_ROOT/policy-no-attestation.json"
jq '.attestation.required = false' "$POLICY_REVIEW" >"$POLICY_NOATT"
POLICY_OFF="$TMP_ROOT/policy-ext-off.json"
jq '.external_review.required = false' "$POLICY_REVIEW" >"$POLICY_OFF"
POLICY_HALF="$TMP_ROOT/policy-half.json"
jq '.external_review |= del(.clean_comment_marker)' "$POLICY_COMMENT" >"$POLICY_HALF"
POLICY_BROKEN="$TMP_ROOT/policy-broken.json"
printf '{ "version": 1, "external_review": {' >"$POLICY_BROKEN"

# attestation_comment <head-sha> [tests-exit] [verdict] -> the comment shape
# attest-pr.sh posts. It carries the COMPLETE payload gate 4 validates, not
# just head_sha: a non-empty tests[] with exit_code 0 and an APPROVED review
# verdict. An edit can preserve the sha while breaking either of the others,
# which is why the fixture has to be able to express that.
attestation_comment() {
  jq -n --arg sha "$1" --argjson exit "${2:-0}" --arg verdict "${3-APPROVED}" '
    {body: ("<!-- ralph-attestation:v1 -->\n## Merge Attestation\n\n```json\n"
      + ({version: 1, head_sha: $sha,
          tests: [{cmd: "bash scripts/__tests__/pr-gate-watch.test.sh", exit_code: $exit}],
          review: {verdict: $verdict, reviewer: "chatgpt-codex-connector[bot]"}} | tojson)
      + "\n```\n")}'
}
# The same comment with an EMPTY tests[] — an attestation with no test
# evidence is not evidence, and gate 4 says so.
attestation_comment_no_tests() {
  jq -n --arg sha "$1" '
    {body: ("<!-- ralph-attestation:v1 -->\n## Merge Attestation\n\n```json\n"
      + ({version: 1, head_sha: $sha, tests: [],
          review: {verdict: "APPROVED"}} | tojson)
      + "\n```\n")}'
}

# pr_state <state> <reviewDecision-or-null> [comments-json] [author] [mergeable]
pr_state() {
  jq -n --arg s "$1" --arg rd "$2" --arg sha "$HEAD_SHA" \
    --argjson comments "${3:-[]}" \
    --arg author "${4:-cdubiel08}" --arg mergeable "${5:-MERGEABLE}" \
    '{state: $s, reviewDecision: (if $rd == "" then null else $rd end),
      headRefOid: $sha, comments: $comments,
      author: {login: $author}, mergeable: $mergeable}'
}

OPEN_PR=$(pr_state OPEN "")
APPROVED_PR=$(pr_state OPEN APPROVED)
# A green ralph-attestation status is a claim about the past; readiness also
# needs the attestation COMMENT to still be there at this head. This is the
# realistic paired state, and the fixture for every GATE-READY expectation.
ATTESTED_PR=$(pr_state OPEN APPROVED "[$(attestation_comment "$HEAD_SHA")]")
NO_REVIEWS='[]'
# Head-bound and authored by the POLICY reviewer — the only shape gate 5
# accepts in review mode, and therefore the only shape that may be read here
# as "a verdict exists".
APPROVAL=$(jq -nc --arg bot "$BOT" --arg sha "$HEAD_SHA" \
  '[{state:"APPROVED", user:{login:$bot}, commit_id:$sha,
     html_url:"https://example.test/r/1"}]')

GREEN_CHECKS=$(jq -n --argjson a "$(check ci pass)" --argjson b "$(check lint pass)" '[$a,$b]')
ATT_PENDING=$(check ralph-attestation pending 'awaiting attestation (scripts/attest-pr.sh)')
ATT_PASS=$(check ralph-attestation pass 'ATTESTATION PASS')

# run <stub-dir> [extra args...] -> sets LAST_OUT, LAST_RC
run() {
  local dir="$1"
  shift
  local rc
  set +e
  rm -f "$dir/pr_view_called"
  LAST_OUT=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$dir" \
    RALPH_MERGE_POLICY_FILE="${POLICY:-$POLICY_REVIEW}" \
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
if [[ "$LAST_OUT" == *"attest-pr.sh 1740"* ]] && [[ "$LAST_OUT" == *"$BOT"* ]]; then
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
# The rate-limit nudge is only the right answer when the rate-limited reviewer
# is the one gate 5 waits for, so this fixture runs under a policy that names
# CodeRabbit. See "the rate-limit nudge names the right reviewer" below for
# the mismatch case, which is what this repo's own dogfood run hit.
POLICY_CODERABBIT="$TMP_ROOT/policy-coderabbit.json"
jq '.external_review.bot = "coderabbitai[bot]" | .external_review.trigger = "@coderabbitai review"' \
  "$POLICY_REVIEW" >"$POLICY_CODERABBIT"
POLICY="$POLICY_CODERABBIT"
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

echo "=== the rate-limit nudge names the right reviewer ==="
# Found by running this script against its own PR: with CodeRabbit rate-limited
# and Codex as the policy reviewer, it answered "whose turn is it" with the
# wrong name AND the wrong command — nudging a reviewer whose verdict gate 5
# does not require, while the reviewer it does require went unmentioned.
POLICY="$POLICY_REVIEW"   # bot = chatgpt-codex-connector[bot]
run "$TMP_ROOT/yours-review-ratelimit"
if [[ "$LAST_OUT" == "GATE-WAIT review"* ]] && [[ "$LAST_OUT" == *"CodeRabbit"* ]] \
   && [[ "$LAST_OUT" == *"chatgpt-codex-connector[bot]"* ]] && [ "$LAST_RC" -eq 10 ]; then
  pass "a rate-limited non-reviewer is reported, but gate 5's reviewer is the ask"
else
  fail "rate-limit reviewer mismatch (rc=$LAST_RC out=${LAST_OUT:0:170})"
fi
POLICY="$POLICY_CODERABBIT"

echo "=== precedence: review outranks attestation ==="
# Same fixture as above: attestation IS pending, but no review exists, so
# attest-pr.sh would refuse. Reporting attestation here would be a dead end.
run "$TMP_ROOT/yours-review-ratelimit"
if [[ "$LAST_OUT" != *attestation* ]]; then
  pass "does not send the caller to attest without a review verdict"
else
  fail "precedence: attestation reported before a review exists"
fi
POLICY="$POLICY_REVIEW"

D="$TMP_ROOT/commented-only"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$OPEN_PR" "$(jq -nc --arg bot "$BOT" --arg sha "$HEAD_SHA" \
    '[{state:"COMMENTED", user:{login:$bot}, commit_id:$sha}]')"
expect "comment-only reviews are not a verdict" "$D" "GATE-YOURS review" 0
# The same COMMENTED review at an OLDER head says nothing about this one —
# there are no threads at this head to adjudicate, so it is a plain wait.
D="$TMP_ROOT/commented-stale"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$OPEN_PR" "$(jq -nc --arg bot "$BOT" --arg sha "$OLD_SHA" \
    '[{state:"COMMENTED", user:{login:$bot}, commit_id:$sha}]')"
expect "comment-only review at an older head is a wait, not an adjudication" "$D" "GATE-WAIT review" 10

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
  "$ATTESTED_PR" "$APPROVAL"
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
# By NAME ONLY, matching gate 3's exact `ralph-attestation` comparison. A
# renamed status is plain CI to both this script and the gate until the repo
# DECLARES the new name via PR_GATE_ATTEST_CHECK. The description fallback
# that used to cover this was removed: it made a failed check whose
# description merely mentions attest-pr.sh leave the CI bucket here while
# gate 3 still blocked on it (codex P2, PR #1764).
D="$TMP_ROOT/renamed"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" \
  --argjson a "$(check my-custom-gate pending 'awaiting attestation (scripts/attest-pr.sh)')" '$g + [$a]')" \
  "$APPROVED_PR" "$APPROVAL"
expect "an undeclared renamed status is CI, exactly as gate 3 sees it" "$D" "GATE-WAIT ci" 10

# The failure this protects: a FAILED check merely mentioning attest-pr.sh in
# its description, under a policy that waives attestation. It used to leave the
# CI bucket via the description match and then be ignored by $att_bad because
# attestation was waived — vanishing from the ladder entirely and reaching
# GATE-READY, while gate 3 still blocks on it.
POLICY="$POLICY_NOATT"
D="$TMP_ROOT/desc-mentions-attest-fail"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" \
  --argjson a "$(check some-linter fail 'compare against scripts/attest-pr.sh output')" '$g + [$a]')" \
  "$APPROVED_PR" "$APPROVAL"
expect "a failed check that merely mentions attest-pr.sh still fails CI" "$D" "GATE-FAIL ci" 0
run "$D"
if [[ "$LAST_OUT" == *"some-linter"* ]]; then
  pass "names the failed check rather than swallowing it as an attestation"
else
  fail "description-match leak (out=${LAST_OUT:0:150})"
fi
POLICY="$POLICY_REVIEW"

D="$TMP_ROOT/env-override"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$(check other-gate pending)" '$g + [$a]')" \
  "$APPROVED_PR" "$APPROVAL"
set +e
out=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$D" PR_GATE_ATTEST_CHECK=other-gate \
    RALPH_MERGE_POLICY_FILE="$POLICY_REVIEW" \
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
# A PR with no checks at all, under an attestation-REQUIRED policy, is not
# ready: gate 4 still wants an attestation. It must not crash, and it must not
# claim readiness — see P2/8 below for why that distinction is load-bearing.
D="$TMP_ROOT/no-checks"
scenario "$D" '[]' "$APPROVED_PR" "$APPROVAL"
expect "a PR with no checks at all does not crash" "$D" "GATE-YOURS attestation" 0

D="$TMP_ROOT/garbage-checks"
mkdir -p "$D"
printf 'no checks reported on the branch' >"$D/pr_checks.json"
printf '%s' "$APPROVED_PR" >"$D/pr_view.json"
printf '%s' "$APPROVAL" >"$D/pr_reviews.json"
printf '[]' >"$D/issue_comments.json"
# An unparseable payload is NOT proof of zero checks — see P2/18 for why this
# withholds the verdict instead of continuing, and why that is the one place
# this script is deliberately stricter than gate 3.
expect "unparseable checks payload withholds the verdict" "$D" "GATE-WAIT ci" 10

echo "=== usage errors ==="
for bad in "" "abc" "12x"; do
  set +e
  PATH="$STUB_BIN:$PATH" RALPH_MERGE_POLICY_FILE="$POLICY_REVIEW" GH_STUB_DIR="$TMP_ROOT/ready" bash "$SCRIPT" $bad >/dev/null 2>&1
  rc=$?
  set -e
  if [ "$rc" -eq 2 ]; then pass "usage error for '$bad'"; else fail "usage '$bad' (rc=$rc)"; fi
done
set +e
PATH="$STUB_BIN:$PATH" RALPH_MERGE_POLICY_FILE="$POLICY_REVIEW" GH_STUB_DIR="$TMP_ROOT/ready" bash "$SCRIPT" 1740 --interval x >/dev/null 2>&1
rc=$?
set -e
if [ "$rc" -eq 2 ]; then pass "usage error for non-numeric --interval"; else fail "--interval (rc=$rc)"; fi

echo "=== --watch exits on a terminal verdict ==="
set +e
out=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$TMP_ROOT/yours-attest" \
  RALPH_MERGE_POLICY_FILE="$POLICY_REVIEW" \
  bash "$SCRIPT" 1740 --watch --interval 1 2>&1)
rc=$?
set -e
if [ "$rc" -eq 0 ] && [ "$(printf '%s\n' "$out" | grep -c 'GATE-YOURS')" -eq 1 ]; then
  pass "--watch emits the verdict once and exits"
else
  fail "--watch (rc=$rc out=${out:0:120})"
fi

########################################################################
# codex P2 regressions, PR #1764. Each block pins one way the classifier
# disagreed with the gate it is supposed to be reporting on.
########################################################################

echo "=== P2/1: a red attestation status is a FAILURE, not an absence ==="
# ralph-attestation is pulled out of the CI bucket so its PENDING state can be
# called "your turn". Before the fix its FAILURES came out with it, so a
# malformed attestation JSON (or a recorded non-zero test) made the required
# status red while the classifier saw neither a failure nor a pending check —
# and an approved PR fell through to GATE-READY recommending a merge.
ATT_FAIL=$(check ralph-attestation fail 'ATTESTATION FAIL — tests[] carries a non-zero exit_code')
D="$TMP_ROOT/fail-attestation"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_FAIL" '$g + [$a]')" \
  "$APPROVED_PR" "$APPROVAL"
expect "a failed attestation status is GATE-FAIL, never GATE-READY" "$D" "GATE-FAIL attestation" 0
run "$D"
if [[ "$LAST_OUT" == *"ralph-attestation"* ]] && [[ "$LAST_OUT" != *"GATE-READY"* ]]; then
  pass "names the red status and recommends no merge"
else
  fail "attestation-fail message (out=${LAST_OUT:0:140})"
fi
# Cancelled is the same class (a cancelled required status is not a pass).
D="$TMP_ROOT/cancel-attestation"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" \
  --argjson a "$(check ralph-attestation cancel)" '$g + [$a]')" "$APPROVED_PR" "$APPROVAL"
expect "a cancelled attestation status is GATE-FAIL too" "$D" "GATE-FAIL attestation" 0

echo "=== P2/2: approvals must be the policy reviewer's, at the CURRENT head ==="
# REST keeps review objects across a push — only reviewDecision resets. An
# unfiltered `.state == "APPROVED"` therefore counts an approval of code that
# is no longer on the branch, and the watcher reports GATE-YOURS attestation
# while merge-pr.sh gate 5 is still waiting for a review of THIS head.
STALE_APPROVAL=$(jq -nc --arg bot "$BOT" --arg sha "$OLD_SHA" \
  '[{state:"APPROVED", user:{login:$bot}, commit_id:$sha, html_url:"https://example.test/r/0"}]')
D="$TMP_ROOT/stale-approval"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$OPEN_PR" "$STALE_APPROVAL"
expect "an approval of an older head is not a verdict at this head" "$D" "GATE-WAIT review" 10
run "$D"
if [[ "$LAST_OUT" != *attestation* ]]; then
  pass "does not send the caller to attest on a stale approval"
else
  fail "stale approval leaked into the attestation branch (out=${LAST_OUT:0:140})"
fi

# ...and it must be the reviewer the POLICY names. A human teammate's approval
# is real, but it is not the independent-identity evidence gate 5 requires, so
# reporting GATE-YOURS attestation would hand back a command that fails.
OTHER_APPROVAL=$(jq -nc --arg sha "$HEAD_SHA" \
  '[{state:"APPROVED", user:{login:"some-teammate"}, commit_id:$sha, html_url:"https://example.test/r/2"}]')
D="$TMP_ROOT/other-approver"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$OPEN_PR" "$OTHER_APPROVAL"
expect "an approval by an unconfigured reviewer is not gate-5 evidence" "$D" "GATE-WAIT review" 10

# A DISMISSED review at the current head is not an approval either.
DISMISSED=$(jq -nc --arg bot "$BOT" --arg sha "$HEAD_SHA" \
  '[{state:"DISMISSED", user:{login:$bot}, commit_id:$sha}]')
D="$TMP_ROOT/dismissed"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$OPEN_PR" "$DISMISSED"
expect "a DISMISSED review at this head is not a verdict" "$D" "GATE-WAIT review" 10

echo "=== P2/3: policy-exempt authors never wait for a review ==="
# merge-pr.sh and validate-attestation.sh both waive attestation AND external
# review for exempt authors, so the attestation status goes green with no
# review object in existence. Requiring one produced a GATE-WAIT that nothing
# could ever clear, and --watch never terminated on a mergeable bot PR.
D="$TMP_ROOT/exempt-author"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$(pr_state OPEN "" '[]' "dependabot[bot]")" "$NO_REVIEWS"
expect "an exempt author with no review at all reaches GATE-READY" "$D" "GATE-READY" 0
# The app/ spelling of the same identity normalizes to the same exemption.
D="$TMP_ROOT/exempt-author-app"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$(pr_state OPEN "" '[]' "app/dependabot")" "$NO_REVIEWS"
expect "the app/ spelling of an exempt author is exempt too" "$D" "GATE-READY" 0
# Non-exempt authors are unaffected — the waiver must not leak.
D="$TMP_ROOT/non-exempt-author"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$(pr_state OPEN "" '[]' "cdubiel08")" "$NO_REVIEWS"
expect "a human author still waits for the configured reviewer" "$D" "GATE-WAIT review" 10

echo "=== P2/4: comment-mode clean-review evidence (the #1839 protocol) ==="
# CODEX_CLEAN_BODY is the VERBATIM body Codex posts on a clean review, copied
# from a live comment (2026-08-13). Do NOT tidy it. The previous generation of
# this parser matched an idealized "Reviewed commit <7-sha>" paraphrase, and
# that is exactly why the bug shipped: the real body writes
# "**Reviewed commit:** `<10-char-sha>`", whose `:** ` separator and 10-char
# SHA both defeat that regex. A fixture that does not match what the server
# actually sends proves nothing. Detection here is the marker protocol
# scripts/merge-pr.sh gate 5 uses (PR #1839), not a second private parser.
CODEX_CLEAN_BODY='Codex Review: Didn'"'"'t find any major issues. More of your lovely PRs please.

**Reviewed commit:** `306c13de30`

<details> <summary>ℹ️ About Codex in GitHub</summary>

[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you
- Open a pull request for review
- Mark a draft as ready
- Comment "@codex review".

If Codex has suggestions, it will comment; otherwise it will react with 👍.
</details>'

# clean_evidence <request-sha> -> the two comments gate 5 reads: a head-bound
# request, then the bot's clean result AFTER it.
clean_evidence() {
  jq -nc --arg sha "$1" --arg bot "$BOT" --arg clean "$CODEX_CLEAN_BODY" '[
    {user:{login:"cdubiel08"},
     body:("@codex review\n<!-- ralph-review-head: " + $sha + " -->"),
     created_at:"2026-08-13T04:00:00Z"},
    {user:{login:$bot}, body:$clean, created_at:"2026-08-13T04:00:10Z",
     html_url:"https://example.test/c/1"}
  ]'
}

POLICY="$POLICY_COMMENT"
D="$TMP_ROOT/clean-comment"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$OPEN_PR" "$NO_REVIEWS" "$(clean_evidence "$HEAD_SHA")"
expect "a real clean Codex comment is a verdict — attestation is next" "$D" "GATE-YOURS attestation" 0
run "$D"
if [[ "$LAST_OUT" == *"$BOT"* ]]; then
  pass "hands back the clean-comment author as the reviewer to attest with"
else
  fail "clean-comment reviewer hint (out=${LAST_OUT:0:160})"
fi

# The request is bound to the FULL head sha, so a clean result requested at an
# older head cannot be inherited across a push.
D="$TMP_ROOT/clean-comment-stale"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$OPEN_PR" "$NO_REVIEWS" "$(clean_evidence "$OLD_SHA")"
expect "a clean result requested at an older head is not evidence" "$D" "GATE-WAIT review" 10
run "$D"
if [[ "$LAST_OUT" == *"ralph-review-head"* ]] && [[ "$LAST_OUT" == *"@codex review"* ]]; then
  pass "names the marker protocol the caller must post to unblock it"
else
  fail "comment-mode remedy (out=${LAST_OUT:0:180})"
fi

# A clean result that PRECEDES the request is not a review of the request.
D="$TMP_ROOT/clean-comment-before"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$OPEN_PR" "$NO_REVIEWS" \
  "$(clean_evidence "$HEAD_SHA" | jq -c '.[1].created_at = "2026-08-13T03:59:00Z"')"
expect "a clean comment older than the request is not evidence" "$D" "GATE-WAIT review" 10

# Findings filed at this head at-or-after the clean result override it.
LATER_FINDINGS=$(jq -nc --arg bot "$BOT" --arg sha "$HEAD_SHA" \
  '[{state:"COMMENTED", user:{login:$bot}, commit_id:$sha,
     submitted_at:"2026-08-13T04:05:00Z"}]')
D="$TMP_ROOT/clean-then-findings"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$OPEN_PR" "$LATER_FINDINGS" "$(clean_evidence "$HEAD_SHA")"
expect "findings after the clean result outrank it" "$D" "GATE-YOURS review" 0

# Under REVIEW mode the same comments are NOT evidence — that is the whole
# point of deriving the mode instead of accepting every shape everywhere.
POLICY="$POLICY_REVIEW"
D="$TMP_ROOT/clean-comment-review-mode"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$OPEN_PR" "$NO_REVIEWS" "$(clean_evidence "$HEAD_SHA")"
expect "review-mode policy ignores comment evidence" "$D" "GATE-WAIT review" 10

echo "=== P2/4b: the policy is read, and a broken one fails closed ==="
POLICY="$POLICY_HALF"
D="$TMP_ROOT/policy-half"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$APPROVED_PR" "$APPROVAL"
expect "half-configured comment mode is named, not guessed at" "$D" "GATE-FAIL policy" 0
POLICY="$POLICY_BROKEN"
expect "unparseable policy fails closed instead of reporting READY" "$D" "GATE-FAIL policy" 0
POLICY="$TMP_ROOT/policy-absent.json"
expect "no policy file at all: no external reviewer to require" "$D" "GATE-READY" 0
POLICY="$POLICY_REVIEW"

echo "=== P2/5: GATE-READY requires a mergeable head ==="
# merge-pr.sh stops at gate 2 unless GitHub says MERGEABLE, so GATE-READY on a
# conflicting head ends --watch on a recommendation that cannot succeed.
D="$TMP_ROOT/conflicting"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$(pr_state OPEN APPROVED '[]' cdubiel08 CONFLICTING)" "$APPROVAL"
expect "a CONFLICTING head is GATE-FAIL merge, not GATE-READY" "$D" "GATE-FAIL merge" 0
run "$D"
if [[ "$LAST_OUT" == *rebase* ]]; then
  pass "names the remedy (rebase) rather than recommending a merge"
else
  fail "conflict remedy (out=${LAST_OUT:0:140})"
fi

# UNKNOWN is GitHub still computing. That is a WAIT (exit 10) — a terminal
# verdict here would end the watch on an answer that has not arrived.
D="$TMP_ROOT/mergeable-unknown"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$(pr_state OPEN APPROVED "[$(attestation_comment "$HEAD_SHA")]" cdubiel08 UNKNOWN)" "$APPROVAL"
expect "uncomputed mergeability keeps the watch alive" "$D" "GATE-WAIT merge" 10

# A conflict is worth reporting even before the review/attestation questions:
# rebasing invalidates any attestation, so attesting first is wasted work.
D="$TMP_ROOT/conflict-outranks"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$(pr_state OPEN "" '[]' cdubiel08 CONFLICTING)" "$NO_REVIEWS"
expect "a conflict outranks the review/attestation questions" "$D" "GATE-FAIL merge" 0

########################################################################
# codex P2 regressions, second review pass on PR #1764. Four ways the
# revised classifier was still disagreeing with gate 5 — three of them by
# being STRICTER than the gate, which is not caution but a hang.
########################################################################

echo "=== P2/6: review mode is APPROVED-only, exactly as gate 5 is ==="
# Gate 5 on main since PR #1839: a COMMENTED review object is findings, not
# approval, and never satisfies the gate. Accepting one here would make the
# watcher LOOSER than the gate and report GATE-READY into a merge that
# refuses — the same class of disagreement as being stricter, other direction.
COMMENTED_AT_HEAD=$(jq -nc --arg bot "$BOT" --arg sha "$HEAD_SHA" \
  '[{state:"COMMENTED", user:{login:$bot}, commit_id:$sha,
     html_url:"https://example.test/r/3"}]')
D="$TMP_ROOT/commented-attested"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$(pr_state OPEN "" "[$(attestation_comment "$HEAD_SHA")]")" "$COMMENTED_AT_HEAD"
expect "COMMENTED findings are not approval, even once attested" "$D" "GATE-YOURS review" 0

# An APPROVED review by the same bot at the same head IS the evidence.
D="$TMP_ROOT/approved-attested"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$(pr_state OPEN "" "[$(attestation_comment "$HEAD_SHA")]")" "$APPROVAL"
expect "an APPROVED review at this head + attestation is GATE-READY" "$D" "GATE-READY" 0

# The gate's SHA-regex comment path is GONE (replaced by comment mode's
# markers). A bot comment naming the short SHA must therefore NOT satisfy
# review mode — the watcher does not keep a retired evidence shape alive.
D="$TMP_ROOT/legacy-sha-comment"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$OPEN_PR" "$NO_REVIEWS" \
  "$(jq -nc --arg bot "$BOT" --arg short "${HEAD_SHA:0:7}" \
     '[{user:{login:$bot}, body:("Reviewed commit " + $short + ": no findings."),
        created_at:"2026-08-13T04:00:10Z"}]')"
expect "the retired 'Reviewed commit <short-sha>' shape is not evidence" "$D" "GATE-WAIT review" 10

echo "=== the checked-in policy really is the one being read ==="
# Guards the whole mirror argument: if .github/ralph-merge-policy.json drifts
# out of comment mode, or the marker names change, this script silently starts
# answering a different question than the gate does.
REAL_POLICY="$(cd "$(dirname "$0")/../.." && pwd)/.github/ralph-merge-policy.json"
if [[ "$(jq -r '.external_review.head_marker' "$REAL_POLICY")" == "ralph-review-head" ]] \
   && [[ "$(jq -r '.external_review.clean_comment_marker' "$REAL_POLICY")" == "Codex Review: Didn't find any major issues." ]]; then
  pass "this repo's policy names both markers (comment mode), as gate 5 reads it"
else
  fail "checked-in policy markers drifted from the gate's protocol"
fi
POLICY="$REAL_POLICY"
D="$TMP_ROOT/real-policy-clean"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$OPEN_PR" "$NO_REVIEWS" "$(clean_evidence "$HEAD_SHA")"
expect "the real policy recognizes a real clean Codex result" "$D" "GATE-YOURS attestation" 0
POLICY="$POLICY_REVIEW"

echo "=== P2/7: no external review required means none is waited for ==="
# With no policy file, or external_review.required false, gate 5 does not run.
# Waiting for a review there waits for something no gate will ever ask for.
POLICY="$TMP_ROOT/policy-absent.json"
D="$TMP_ROOT/no-policy-no-reviews"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$(pr_state OPEN "" "[$(attestation_comment "$HEAD_SHA")]")" "$NO_REVIEWS"
expect "no policy file + zero reviews is READY, not a wait" "$D" "GATE-READY" 0
POLICY="$POLICY_OFF"
expect "external_review.required=false waives the review wait" "$D" "GATE-READY" 0
POLICY="$POLICY_REVIEW"
expect "the same fixture under a required policy still waits" "$D" "GATE-WAIT review" 10

echo "=== P2/8: a missing attestation STATUS is not readiness ==="
# Before validate-attestation.yml publishes, when Actions did not fire, or
# when the checks payload was unreadable, there is no attestation check to be
# pending and none to be red. Falling through to GATE-READY ended --watch on a
# merge-pr.sh run that stops at gate 4.
D="$TMP_ROOT/att-status-missing"
scenario "$D" "$GREEN_CHECKS" "$APPROVED_PR" "$APPROVAL"
expect "no attestation status under a required policy is not READY" "$D" "GATE-YOURS attestation" 0
run "$D"
if [[ "$LAST_OUT" == *"attest-pr.sh 1740"* ]]; then
  pass "hands back the attest command rather than a merge command"
else
  fail "missing-status remedy (out=${LAST_OUT:0:160})"
fi

# If the attestation COMMENT is already at this head, the work is done and
# only the status is missing — that is a wait, not another attestation.
D="$TMP_ROOT/att-status-missing-attested"
scenario "$D" "$GREEN_CHECKS" \
  "$(pr_state OPEN APPROVED "[$(attestation_comment "$HEAD_SHA")]")" "$APPROVAL"
expect "attested at this head with no status yet is a wait" "$D" "GATE-WAIT attestation" 10

# A policy that does not require attestation must not acquire the new wait.
POLICY="$POLICY_NOATT"
D="$TMP_ROOT/att-not-required"
scenario "$D" "$GREEN_CHECKS" "$APPROVED_PR" "$APPROVAL"
expect "attestation not required: a missing status is fine" "$D" "GATE-READY" 0
POLICY="$POLICY_REVIEW"

echo "=== P2/9: the reviews snapshot is paginated ==="
# On a PR with more than one page of reviews the current-head review is
# frequently on the LAST page. An unpaginated read reports "no review yet" for
# evidence that exists, and the watcher waits for a review already filed.
# The stub asserts the flag directly: without --paginate it serves page 1 only.
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
    exit "${GH_STUB_CHECKS_EXIT:-0}"
    ;;
  "pr view")
    # Serves a SECOND, different fixture to the second call when present —
    # what a push landing mid-snapshot looks like. Every stub in this file
    # needs it: the script reads the head twice on purpose, so a stub that
    # cannot express "the head moved" silently cannot test for it.
    if [[ -f "$GH_STUB_DIR/pr_view_second.json" && -f "$GH_STUB_DIR/pr_view_called" ]]; then
      cat "$GH_STUB_DIR/pr_view_second.json"
    else
      touch "$GH_STUB_DIR/pr_view_called"
      serve pr_view.json '{"state":"OPEN","reviewDecision":null,"headRefOid":"","comments":[]}'
    fi
    ;;
  "api repos/"*)
    if [[ "$2" == */issues/*/comments ]]; then serve issue_comments.json '[]'
    # A paginated endpoint emits ONE JSON array PER PAGE; `gh --paginate`
    # concatenates them, which is why both gates slurp with `-s ... add`.
    # Page 2 is served only when --paginate was actually passed.
    elif [[ " $* " == *" --paginate "* && -f "$GH_STUB_DIR/pr_reviews_page2.json" ]]; then
      serve pr_reviews.json '[]'; cat "$GH_STUB_DIR/pr_reviews_page2.json"
    else serve pr_reviews.json '[]'; fi
    ;;
  *) echo "stub: unhandled gh $*" >&2; exit 64 ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

D="$TMP_ROOT/paginated-reviews"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$OPEN_PR" "$STALE_APPROVAL"
printf '%s' "$APPROVAL" >"$D/pr_reviews_page2.json"
expect "a current-head review on page 2 is found" "$D" "GATE-YOURS attestation" 0
# And the harness is discriminating: drop page 2 and the same fixture waits.
rm "$D/pr_reviews_page2.json"
expect "without the second page the same fixture waits" "$D" "GATE-WAIT review" 10

########################################################################
# codex P2 regressions, third pass on PR #1764 (against the merged #1839
# gate). Both are about verdicts that cannot be walked back: one invents
# evidence out of an outage, the other names an action that can never
# clear the gate.
########################################################################

echo "=== P2/10: a failed evidence fetch is not an empty review list ==="
# The dangerous asymmetry is partial: comments succeed, reviews fail. A stale
# clean marker plus a green attestation then reads as GATE-READY because the
# findings that invalidate the marker were simply invisible. merge-pr.sh
# tracks the same partial outage with external_fetch_ok and stays PENDING.
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
    exit "${GH_STUB_CHECKS_EXIT:-0}"
    ;;
  "pr view")
    # Serves a SECOND, different fixture to the second call when present —
    # what a push landing mid-snapshot looks like. Every stub in this file
    # needs it: the script reads the head twice on purpose, so a stub that
    # cannot express "the head moved" silently cannot test for it.
    if [[ -f "$GH_STUB_DIR/pr_view_second.json" && -f "$GH_STUB_DIR/pr_view_called" ]]; then
      cat "$GH_STUB_DIR/pr_view_second.json"
    else
      touch "$GH_STUB_DIR/pr_view_called"
      serve pr_view.json '{"state":"OPEN","reviewDecision":null,"headRefOid":"","comments":[]}'
    fi
    ;;
  "api repos/"*)
    if [[ "$2" == */issues/*/comments ]]; then
      serve issue_comments.json '[]'
      # `[[ ... ]] && exit 1` would make the ABSENT case the branch's exit
      # status under `set -e`, failing every healthy call. Use an if.
      if [[ -f "$GH_STUB_DIR/fail_comments" ]]; then exit 1; fi
    else
      serve pr_reviews.json '[]'
      # Emit the payload FIRST, then fail: a stub that printed nothing would
      # pass with or without the guard, so this is what makes it discriminating.
      if [[ -f "$GH_STUB_DIR/fail_reviews" ]]; then exit 1; fi
    fi
    ;;
  *) echo "stub: unhandled gh $*" >&2; exit 64 ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

POLICY="$POLICY_COMMENT"
D="$TMP_ROOT/fetch-fail-reviews"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$(pr_state OPEN "" "[$(attestation_comment "$HEAD_SHA")]")" "$NO_REVIEWS" \
  "$(clean_evidence "$HEAD_SHA")"
# Control: with both fetches healthy this fixture IS ready. That is what makes
# the failure case below a real difference and not a fixture that never passed.
expect "control: clean evidence + attestation is READY" "$D" "GATE-READY" 0
touch "$D/fail_reviews"
expect "a failed reviews fetch withholds the verdict" "$D" "GATE-WAIT review" 10
rm "$D/fail_reviews"; touch "$D/fail_comments"
expect "a failed comments fetch withholds it too" "$D" "GATE-WAIT review" 10
rm "$D/fail_comments"

# REVIEW mode must fetch the same evidence gate 5 fetches. Gate 5 requests
# comments AND reviews in both modes and holds evidence_ok=false if either
# fails — so a comments-endpoint outage under a formal-review policy is a
# PENDING merge, and skipping that request here produced GATE-READY against it.
# Review mode never reads the comments payload; it consumes the FAILURE, which
# is precisely the evidence that was being discarded (codex P2, PR #1764).
POLICY="$POLICY_REVIEW"
D3="$TMP_ROOT/fetch-fail-review-mode"
scenario "$D3" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$(pr_state OPEN APPROVED "[$(attestation_comment "$HEAD_SHA")]")" "$APPROVAL"
expect "control: review mode with both endpoints healthy is READY" "$D3" "GATE-READY" 0
touch "$D3/fail_comments"
expect "review mode withholds when the COMMENTS endpoint fails" "$D3" "GATE-WAIT review" 10
rm "$D3/fail_comments"

# An exempt author is the other waiver: merge-pr.sh skips gate 5 WITHOUT
# fetching this evidence at all, so a failed fetch is not a reason to make a
# Dependabot PR wait. The waiver has to be applied before the fetch question,
# not after it — which is the ordering bug this pins (codex P2, PR #1764).
POLICY="$POLICY_COMMENT"
D2="$TMP_ROOT/fetch-fail-exempt"
scenario "$D2" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$(pr_state OPEN "" '[]' "dependabot[bot]")" "$NO_REVIEWS"
touch "$D2/fail_reviews"
expect "an exempt author does not wait on evidence the gate never fetches" "$D2" "GATE-READY" 0
rm "$D2/fail_reviews"

# With gate 5 off there is no evidence to have failed to read, so the outage
# must not manufacture a wait on a repo that requires no review at all.
POLICY="$POLICY_OFF"
touch "$D/fail_reviews"
expect "no external review required: an outage is not a review wait" "$D" "GATE-READY" 0
rm "$D/fail_reviews"
POLICY="$POLICY_REVIEW"

echo "=== P2/11: findings in comment mode need a NEW clean result ==="
# Adjudicating threads does not delete the COMMENTED review, and neither does
# attesting — so findings_after_clean stays nonzero, gate 5 keeps rejecting the
# old clean marker, and "adjudicate, then attest" is an instruction that can be
# followed perfectly and still never clear the gate.
POLICY="$POLICY_COMMENT"
D="$TMP_ROOT/comment-mode-findings"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$OPEN_PR" "$LATER_FINDINGS" "$(clean_evidence "$HEAD_SHA")"
expect "findings at this head are still GATE-YOURS review" "$D" "GATE-YOURS review" 0
run "$D"
if [[ "$LAST_OUT" == *"ralph-review-head: $HEAD_SHA"* ]] && [[ "$LAST_OUT" == *"@codex review"* ]] \
   && [[ "$LAST_OUT" == *"BEFORE attesting"* ]]; then
  pass "names the re-request that can actually clear gate 5, not a doomed attest"
else
  fail "comment-mode findings remedy (out=${LAST_OUT:0:220})"
fi
# Review mode keeps the original wording: there, adjudicating and attesting
# with the real verdict IS the path, because gate 5 wants an APPROVED review.
POLICY="$POLICY_REVIEW"
D="$TMP_ROOT/review-mode-findings"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$OPEN_PR" "$COMMENTED_AT_HEAD"
run "$D"
# Review mode has the SAME trap, with different evidence: adjudicating does not
# convert a COMMENTED review into the APPROVED object gate 5 requires, and
# neither does attesting. Only a fresh approval can. (My first pass at P2/11
# fixed comment mode and left this wording in place — it was wrong for exactly
# the reason the comment-mode one was.)
if [[ "$LAST_OUT" == *"wait for an APPROVED review BEFORE attesting"* ]] \
   && [[ "$LAST_OUT" == *"@codex review"* ]] \
   && [[ "$LAST_OUT" != *"ralph-review-head"* ]]; then
  pass "review mode asks for a fresh approval, not a doomed attest"
else
  fail "review-mode findings wording (out=${LAST_OUT:0:180})"
fi

echo "=== P2/12: waivers apply BEFORE the evidence questions ==="
# merge-pr.sh gate 4 runs only when attestation is required and the author is
# not exempt, and gate 3 excludes the attestation status from the CI red list
# outright. Under a waiver there is simply no attestation question to answer.
POLICY="$POLICY_NOATT"
D="$TMP_ROOT/waived-att-red"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" \
  --argjson a "$(check ralph-attestation fail 'ATTESTATION FAIL')" '$g + [$a]')" \
  "$APPROVED_PR" "$APPROVAL"
expect "attestation not required: a RED attestation status is not a failure" "$D" "GATE-READY" 0
D="$TMP_ROOT/waived-att-pending"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$APPROVED_PR" "$APPROVAL"
expect "attestation not required: a PENDING attestation status is not your turn" "$D" "GATE-READY" 0

# Exempt authors have attestation waived the same way gate 4 waives it.
POLICY="$POLICY_REVIEW"
D="$TMP_ROOT/exempt-att-red"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" \
  --argjson a "$(check ralph-attestation fail 'ATTESTATION FAIL')" '$g + [$a]')" \
  "$(pr_state OPEN "" '[]' "dependabot[bot]")" "$NO_REVIEWS"
expect "an exempt author's red attestation status is waived too" "$D" "GATE-READY" 0
# ...and a non-exempt author on the identical fixture still fails, so the
# waiver cannot leak into the configuration that does gate.
D="$TMP_ROOT/nonexempt-att-red"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" \
  --argjson a "$(check ralph-attestation fail 'ATTESTATION FAIL')" '$g + [$a]')" \
  "$APPROVED_PR" "$APPROVAL"
expect "a non-exempt author's red attestation still fails" "$D" "GATE-FAIL attestation" 0

echo "=== the hook this PR registers is actually executable ==="
# The hook runner execs the configured path directly, so a 100644 mode makes
# every registration return 126 Permission denied — and a test harness that
# invokes it via `bash` would never notice (codex P2, PR #1764).
HOOKS_DIR="$(cd "$(dirname "$0")/../.." && pwd)/ralph/hooks"
mode=$(git -C "$(dirname "$HOOKS_DIR")/.." ls-files -s ralph/hooks/funnel-gate-watch.sh | awk '{print $1}')
if [[ "$mode" == "100755" ]] && [[ -x "$HOOKS_DIR/funnel-gate-watch.sh" ]]; then
  pass "funnel-gate-watch.sh is committed executable, like its siblings"
else
  fail "funnel-gate-watch.sh mode is ${mode:-unknown} (needs 100755)"
fi

echo "=== P2/13: a green attestation STATUS is not live evidence ==="
# The status is computed once and published. If the comment it was computed
# from is then deleted, edited into invalidity, or belongs to an older head,
# gate 4 re-reads the live comment and rejects — so readiness may not rest on
# the status alone. Distinct from the missing-status case: here the status
# exists and is green.
POLICY="$POLICY_REVIEW"
D="$TMP_ROOT/att-green-comment-gone"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$APPROVED_PR" "$APPROVAL"
expect "green status with the attestation comment gone is not READY" "$D" "GATE-YOURS attestation" 0
run "$D"
if [[ "$LAST_OUT" == *"--carry-review"* ]]; then
  pass "names --carry-review, so re-attesting does not retype an unearned verdict"
else
  fail "re-attest remedy (out=${LAST_OUT:0:170})"
fi

# Same, with the comment present but bound to an older head.
D="$TMP_ROOT/att-green-comment-stale"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$(pr_state OPEN APPROVED "[$(attestation_comment "$OLD_SHA")]")" "$APPROVAL"
expect "green status with a stale attestation comment is not READY" "$D" "GATE-YOURS attestation" 0

# Malformed live evidence must not read as valid either.
D="$TMP_ROOT/att-green-comment-garbage"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$(pr_state OPEN APPROVED '[{"body":"<!-- ralph-attestation:v1 -->\nno json fence"}]')" "$APPROVAL"
expect "green status with an unparseable attestation comment is not READY" "$D" "GATE-YOURS attestation" 0

# And a waived policy does not acquire the new requirement.
POLICY="$POLICY_NOATT"
expect "attestation not required: live evidence is not demanded" "$D" "GATE-READY" 0
POLICY="$POLICY_REVIEW"

echo "=== P2/14: gate 6 is RUN before recommending the merge ==="
# The one gate with no status to read: a label added after
# ralph-apply-keywords was computed leaves the status green while
# apply-keywords.sh, run live, rejects the closing keyword. So the READY path
# runs the same checker merge-pr.sh runs instead of predicting it.
FAKE_APPLY="$TMP_ROOT/apply-keywords-fail.sh"
cat >"$FAKE_APPLY" <<'AK'
#!/usr/bin/env bash
echo "APPLY KEYWORDS FAIL — PR closes apply unit #1763 (ralph:apply)"
exit 1
AK
chmod +x "$FAKE_APPLY"
D="$TMP_ROOT/ready"
set +e
LAST_OUT=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$D" RALPH_MERGE_POLICY_FILE="$POLICY_REVIEW" \
  RALPH_APPLY_KEYWORDS_SH="$FAKE_APPLY" bash "$SCRIPT" 1740 2>&1)
LAST_RC=$?
set -e
if [[ "$LAST_OUT" == "GATE-FAIL apply"* ]] && [[ "$LAST_OUT" == *"#1763"* ]] && [ "$LAST_RC" -eq 0 ]; then
  pass "a live gate-6 rejection turns READY into GATE-FAIL apply, naming the checker's reason"
else
  fail "gate 6 live run (rc=$LAST_RC out=${LAST_OUT:0:170})"
fi

# A passing checker leaves READY alone...
FAKE_APPLY_OK="$TMP_ROOT/apply-keywords-ok.sh"
printf '#!/usr/bin/env bash\necho "APPLY KEYWORDS INERT — no apply block"\nexit 0\n' >"$FAKE_APPLY_OK"
chmod +x "$FAKE_APPLY_OK"
set +e
LAST_OUT=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$D" RALPH_MERGE_POLICY_FILE="$POLICY_REVIEW" \
  RALPH_APPLY_KEYWORDS_SH="$FAKE_APPLY_OK" bash "$SCRIPT" 1740 2>&1)
LAST_RC=$?
set -e
if [[ "$LAST_OUT" == "GATE-READY"* ]] && [ "$LAST_RC" -eq 0 ]; then
  pass "a passing/inert checker leaves GATE-READY intact"
else
  fail "gate 6 pass (rc=$LAST_RC out=${LAST_OUT:0:140})"
fi

# ...and a repo that does not ship the checker at all is unaffected, which is
# what keeps this inert for host repos vendoring the gate without it.
set +e
LAST_OUT=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$D" RALPH_MERGE_POLICY_FILE="$POLICY_REVIEW" \
  RALPH_APPLY_KEYWORDS_SH="$TMP_ROOT/nonexistent.sh" bash "$SCRIPT" 1740 2>&1)
LAST_RC=$?
set -e
if [[ "$LAST_OUT" == "GATE-READY"* ]] && [ "$LAST_RC" -eq 0 ]; then
  pass "no checker present: gate 6 is inert, not fatal"
else
  fail "gate 6 absent (rc=$LAST_RC out=${LAST_OUT:0:140})"
fi

# The checker must NOT run on non-READY verdicts — it costs API calls and its
# answer is irrelevant while an earlier gate is unsatisfied.
NOISY_APPLY="$TMP_ROOT/apply-keywords-noisy.sh"
printf '#!/usr/bin/env bash\ntouch "%s/ran"\nexit 1\n' "$TMP_ROOT" >"$NOISY_APPLY"
chmod +x "$NOISY_APPLY"
set +e
PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$TMP_ROOT/wait-ci" RALPH_MERGE_POLICY_FILE="$POLICY_REVIEW" \
  RALPH_APPLY_KEYWORDS_SH="$NOISY_APPLY" bash "$SCRIPT" 1740 >/dev/null 2>&1
set -e
if [[ ! -f "$TMP_ROOT/ran" ]]; then
  pass "the checker is not run while an earlier gate is unsatisfied"
else
  fail "gate 6 ran on a non-READY verdict"
fi

echo "=== P2/15: the WHOLE live attestation payload is validated ==="
# head_sha alone is not the gate. An edit can preserve the sha while turning
# tests[] empty, flipping an exit_code non-zero, or downgrading the verdict —
# and gate 4 re-reads all three from the live comment (merge-pr.sh:323-335).
# A sha-only check calls a rejected attestation valid and ends --watch on a
# merge that fails immediately.
POLICY="$POLICY_REVIEW"
ATT_READY_CHECKS=$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')

D="$TMP_ROOT/att-nonzero-exit"
scenario "$D" "$ATT_READY_CHECKS" \
  "$(pr_state OPEN APPROVED "[$(attestation_comment "$HEAD_SHA" 1)]")" "$APPROVAL"
expect "a recorded non-zero exit_code is not a valid attestation" "$D" "GATE-YOURS attestation" 0
run "$D"
if [[ "$LAST_OUT" == *"non-zero exit_code"* ]] && [[ "$LAST_OUT" == *"gate 4 re-reads this live"* ]]; then
  pass "names which part of the payload is invalid, not just that it is"
else
  fail "invalid-attestation message (out=${LAST_OUT:0:200})"
fi

D="$TMP_ROOT/att-empty-tests"
scenario "$D" "$ATT_READY_CHECKS" \
  "$(pr_state OPEN APPROVED "[$(attestation_comment_no_tests "$HEAD_SHA")]")" "$APPROVAL"
expect "an empty tests[] is not test evidence" "$D" "GATE-YOURS attestation" 0

D="$TMP_ROOT/att-verdict-rejected"
scenario "$D" "$ATT_READY_CHECKS" \
  "$(pr_state OPEN APPROVED "[$(attestation_comment "$HEAD_SHA" 0 REJECTED)]")" "$APPROVAL"
expect "a non-APPROVED verdict is evidence AGAINST merging" "$D" "GATE-YOURS attestation" 0
run "$D"
if [[ "$LAST_OUT" == *"REJECTED"* ]] && [[ "$LAST_OUT" == *"not APPROVED"* ]]; then
  pass "quotes the actual verdict back rather than calling it merely absent"
else
  fail "verdict message (out=${LAST_OUT:0:200})"
fi

D="$TMP_ROOT/att-verdict-empty"
scenario "$D" "$ATT_READY_CHECKS" \
  "$(pr_state OPEN APPROVED "[$(attestation_comment "$HEAD_SHA" 0 "")]")" "$APPROVAL"
expect "a missing verdict is not an approval either" "$D" "GATE-YOURS attestation" 0

# The complete, valid payload still reaches READY — so the cases above are a
# real difference and not a fixture that stopped passing for another reason.
D="$TMP_ROOT/att-fully-valid"
scenario "$D" "$ATT_READY_CHECKS" \
  "$(pr_state OPEN APPROVED "[$(attestation_comment "$HEAD_SHA")]")" "$APPROVAL"
expect "a complete valid attestation is READY" "$D" "GATE-READY" 0

# And a waived policy does not acquire the payload requirement.
POLICY="$POLICY_NOATT"
D="$TMP_ROOT/att-invalid-waived"
scenario "$D" "$ATT_READY_CHECKS" \
  "$(pr_state OPEN APPROVED "[$(attestation_comment "$HEAD_SHA" 1)]")" "$APPROVAL"
expect "attestation not required: an invalid payload is not our problem" "$D" "GATE-READY" 0
POLICY="$POLICY_REVIEW"

echo "=== P2/16: the findings nudge obeys the same waivers ==="
# Reached independently of $review_ok whenever attestation is ALSO waived, so
# the earlier waiver fixes did not cover it: an exempt author with a
# current-head COMMENTED review still terminated --watch asking for an
# approval that gate 5 never requires.
COMMENTED_NOW=$(jq -nc --arg bot "$BOT" --arg sha "$HEAD_SHA" \
  '[{state:"COMMENTED", user:{login:$bot}, commit_id:$sha}]')
POLICY="$POLICY_REVIEW"
D="$TMP_ROOT/findings-exempt"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$(pr_state OPEN "" '[]' "dependabot[bot]")" "$COMMENTED_NOW"
expect "an exempt author is not nudged for an approval gate 5 waives" "$D" "GATE-READY" 0
POLICY="$POLICY_OFF"
D="$TMP_ROOT/findings-ext-off"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$(pr_state OPEN "" "[$(attestation_comment "$HEAD_SHA")]")" "$COMMENTED_NOW"
expect "external review off: findings are not a blocking nudge" "$D" "GATE-READY" 0
# The nudge survives where the review IS required.
POLICY="$POLICY_REVIEW"
D="$TMP_ROOT/findings-required"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$OPEN_PR" "$COMMENTED_NOW"
expect "a required review still gets the findings nudge" "$D" "GATE-YOURS review" 0

echo "=== P2/17: the attestation fence is parsed like gate 4 parses it ==="
# gate 4 (merge-pr.sh:319-321) is an awk with BOTH fences anchored to their own
# lines. split("```json") accepted an inline fence anywhere in the body, so a
# comment the gate calls unparseable could read as valid here.
POLICY="$POLICY_REVIEW"
inline_fence_comment() { # a VALID payload reachable only via an inline fence
  jq -n --arg sha "$1" '
    {body: ("<!-- ralph-attestation:v1 -->\nSee the payload inline: ```json "
      + ({version: 1, head_sha: $sha, tests: [{cmd: "t", exit_code: 0},],
          review: {verdict: "APPROVED"}} | tojson)
      + " ``` end")}'
}
D="$TMP_ROOT/att-inline-fence"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$(pr_state OPEN APPROVED "[$(inline_fence_comment "$HEAD_SHA")]")" "$APPROVAL"
expect "an inline fence is not a payload, exactly as gate 4 sees it" "$D" "GATE-YOURS attestation" 0
# The properly fenced comment still parses — the extractor was tightened, not broken.
D="$TMP_ROOT/att-proper-fence"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$(pr_state OPEN APPROVED "[$(attestation_comment "$HEAD_SHA")]")" "$APPROVAL"
expect "a line-anchored fence still parses" "$D" "GATE-READY" 0

echo "=== P2/18: an unreadable checks payload is not zero checks ==="
# THE ONE DELIBERATE DIVERGENCE, stated rather than hidden: gate 3 treats an
# empty/unparseable payload as "no checks reported" and continues with a WARN.
# That is fine for a one-shot merge with an operator reading the warning. It is
# not fine for --watch, where a terminal verdict is a decision to stop looking.
# So this waits — non-terminally, so the next poll recovers on its own.
D="$TMP_ROOT/checks-unreadable"
mkdir -p "$D"
printf 'gh: could not resolve host' >"$D/pr_checks.json"
printf '%s' "$(pr_state OPEN APPROVED "[$(attestation_comment "$HEAD_SHA")]")" >"$D/pr_view.json"
printf '%s' "$APPROVAL" >"$D/pr_reviews.json"
printf '[]' >"$D/issue_comments.json"
expect "an unreadable checks payload never reaches READY" "$D" "GATE-WAIT ci" 10
run "$D"
if [[ "$LAST_OUT" == *"withheld"* ]] && [ "$LAST_RC" -eq 10 ]; then
  pass "withholds non-terminally, so a transient outage cannot strand the watch"
else
  fail "checks-unreadable verdict (rc=$LAST_RC out=${LAST_OUT:0:150})"
fi
# A genuinely empty but WELL-FORMED payload is a different fact and still
# classifies — "no checks on this PR" is an answer, not a failure to answer.
# "No checks on this PR" is an ANSWER, not a failure to answer, so it
# classifies normally — here as the missing-attestation-status wait, which is
# what an empty check list under a requiring policy genuinely means.
printf '[]' >"$D/pr_checks.json"
expect "a well-formed empty checks list still classifies" "$D" "GATE-WAIT attestation" 10
run "$D"
if [[ "$LAST_OUT" != *"withheld"* ]]; then
  pass "an empty list is answered, not withheld"
else
  fail "empty checks list treated as unreadable (out=${LAST_OUT:0:140})"
fi

echo "=== P2/19: the snapshot is bound to ONE head ==="
# gh pr checks exposes no SHA, so a push landing mid-snapshot would pair the
# OLD head's green checks with the NEW head. For an exempt author, or a policy
# with review and attestation off, nothing else is head-bound — so that pairing
# would produce GATE-READY for a head nothing has validated.
POLICY="$POLICY_REVIEW"
D="$TMP_ROOT/head-moved"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$(pr_state OPEN APPROVED "[$(attestation_comment "$HEAD_SHA")]")" "$APPROVAL"
# The stub serves a DIFFERENT head on the second `gh pr view`, which is exactly
# what a push landing between the two reads looks like.
printf '%s' "$(jq -n --arg sha "$OLD_SHA" '{headRefOid: $sha}')" >"$D/pr_view_second.json"
expect "a head that moves mid-snapshot refuses to classify" "$D" "GATE-WAIT ci" 10
run "$D"
if [[ "$LAST_OUT" == *"head moved"* ]] && [[ "$LAST_OUT" == *"${HEAD_SHA:0:8}"* ]]; then
  pass "names both heads rather than silently mixing their evidence"
else
  fail "head-moved message (out=${LAST_OUT:0:170})"
fi
# A settled head classifies normally. This case also pins the re-read's SHAPE:
# an implementation whose second read disagrees about form with the first
# would report a change that never happened, and --watch would never settle.
rm "$D/pr_view_second.json"
expect "a settled head classifies normally" "$D" "GATE-READY" 0

echo "=== P2/20: --interval 0 is refused, not accepted ==="
# `sleep 0` returns immediately, so --interval 0 is an unthrottled loop over
# every GitHub endpoint until something rate-limits it.
set +e
out=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$TMP_ROOT/ready" RALPH_MERGE_POLICY_FILE="$POLICY_REVIEW" \
  bash "$SCRIPT" 1740 --watch --interval 0 2>&1)
rc=$?
set -e
if [ "$rc" -eq 2 ] && [[ "$out" == *"greater than 0"* ]]; then
  pass "--interval 0 is a usage error naming the reason"
else
  fail "--interval 0 (rc=$rc out=${out:0:120})"
fi
# 1 is still allowed — the guard rejects zero, it does not impose a floor.
set +e
PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$TMP_ROOT/ready" RALPH_MERGE_POLICY_FILE="$POLICY_REVIEW" \
  timeout 20 bash "$SCRIPT" 1740 --watch --interval 1 >/dev/null 2>&1
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  pass "--interval 1 is still accepted"
else
  fail "--interval 1 rejected (rc=$rc)"
fi

echo "=== P2/21: the head re-read fails CLOSED ==="
# The guard added for P2/19 converted its OWN failure into success: an empty
# head_after skipped the mismatch check, so a snapshot that straddled a push
# could still classify. A re-read that did not happen proves nothing.
POLICY="$POLICY_REVIEW"
D="$TMP_ROOT/head-reread-fails"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PASS" '$g + [$a]')" \
  "$(pr_state OPEN APPROVED "[$(attestation_comment "$HEAD_SHA")]")" "$APPROVAL"
# An empty second read is what a failed `gh pr view` looks like here.
printf '%s' '{}' >"$D/pr_view_second.json"
expect "an unusable head re-read withholds the verdict" "$D" "GATE-WAIT ci" 10
run "$D"
if [[ "$LAST_OUT" == *"withheld"* ]] && [ "$LAST_RC" -eq 10 ]; then
  pass "fails closed non-terminally rather than classifying on an unconfirmed head"
else
  fail "head re-read failure (rc=$LAST_RC out=${LAST_OUT:0:160})"
fi
rm "$D/pr_view_second.json"
expect "a confirmed head still classifies" "$D" "GATE-READY" 0

echo "=== P2/22: the rate-limit nudge uses the POLICY trigger ==="
# A host repo naming a different trigger was told to post a command its
# reviewer does not read — terminal advice that cannot be followed.
POLICY_RL_CUSTOM="$TMP_ROOT/policy-rl-custom.json"
jq '.external_review.bot = "coderabbitai[bot]" | .external_review.trigger = "@rabbit please-review"' \
  "$POLICY_REVIEW" >"$POLICY_RL_CUSTOM"
POLICY="$POLICY_RL_CUSTOM"
run "$TMP_ROOT/yours-review-ratelimit"
if [[ "$LAST_OUT" == "GATE-YOURS review"* ]] && [[ "$LAST_OUT" == *"@rabbit please-review"* ]] \
   && [[ "$LAST_OUT" != *"@coderabbitai review"* ]]; then
  pass "the nudge names the configured trigger, not a hardcoded one"
else
  fail "rate-limit trigger (out=${LAST_OUT:0:170})"
fi
POLICY="$POLICY_REVIEW"

echo
echo "pr-gate-watch: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
