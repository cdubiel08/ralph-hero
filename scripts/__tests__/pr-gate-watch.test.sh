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
POLICY_HALF="$TMP_ROOT/policy-half.json"
jq '.external_review |= del(.clean_comment_marker)' "$POLICY_COMMENT" >"$POLICY_HALF"
POLICY_BROKEN="$TMP_ROOT/policy-broken.json"
printf '{ "version": 1, "external_review": {' >"$POLICY_BROKEN"

# attestation_comment <head-sha> -> the comment shape attest-pr.sh posts: the
# v1 marker plus a fenced JSON block carrying head_sha.
attestation_comment() {
  jq -n --arg sha "$1" '
    {body: ("<!-- ralph-attestation:v1 -->\n## Merge Attestation\n\n```json\n"
      + ({version: 1, head_sha: $sha} | tojson)
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
  "$(pr_state OPEN APPROVED '[]' cdubiel08 UNKNOWN)" "$APPROVAL"
expect "uncomputed mergeability keeps the watch alive" "$D" "GATE-WAIT merge" 10

# A conflict is worth reporting even before the review/attestation questions:
# rebasing invalidates any attestation, so attesting first is wasted work.
D="$TMP_ROOT/conflict-outranks"
scenario "$D" "$(jq -n --argjson g "$GREEN_CHECKS" --argjson a "$ATT_PENDING" '$g + [$a]')" \
  "$(pr_state OPEN "" '[]' cdubiel08 CONFLICTING)" "$NO_REVIEWS"
expect "a conflict outranks the review/attestation questions" "$D" "GATE-FAIL merge" 0

echo
echo "pr-gate-watch: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
