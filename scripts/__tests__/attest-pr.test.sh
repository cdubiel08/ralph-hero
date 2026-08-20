#!/usr/bin/env bash
# scripts/__tests__/attest-pr.test.sh
# Attestation composer tests (GH-1589): payload shape, head_sha capture,
# post-vs-update behavior, packed-arg parsing. gh is stubbed on PATH.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/attest-pr.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

SHA="cccccccccccccccccccccccccccccccccccccccc"

STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
echo "gh $*" >>"$GH_STUB_LOG"
args=("$@")
jq_expr=""
body_val=""
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    --jq) jq_expr="${args[$((i + 1))]}" ;;
    -f)
      v="${args[$((i + 1))]}"
      if [[ "$v" == body=* ]]; then body_val="${v#body=}"; fi
      ;;
    --body) body_val="${args[$((i + 1))]}" ;;
  esac
done
case "${1:-} ${2:-}" in
  "pr view")
    if [[ -n "$jq_expr" ]]; then jq -r "$jq_expr" "$GH_STUB_DIR/pr_view.json"; else cat "$GH_STUB_DIR/pr_view.json"; fi
    ;;
  "pr comment")
    # GH-1817: the observed failure — gh prints the rate-limit refusal and
    # EXITS 0, so the body is deliberately NOT recorded here. A guard that
    # only checked the exit code would let the caller announce a post that
    # never happened.
    if [[ -f "$GH_STUB_DIR/rate_limited" ]]; then
      echo "GraphQL: API rate limit already exceeded"; exit 0
    fi
    printf '%s' "$body_val" >"$GH_STUB_DIR/posted_body.txt"
    ;;
  "api --method")
    # PATCH update path: gh api --method PATCH repos/... -f body=...
    printf '%s' "$body_val" >"$GH_STUB_DIR/patched_body.txt"
    ;;
  "api --paginate")
    # Paginated REST reads: dispatch on the endpoint URL ($3).
    case "${3:-}" in
      */pulls/*/files*)
        f="$GH_STUB_DIR/pr_files_rest.json"
        [[ -f "$f" ]] || jq '[.files[] | {filename: .path}]' "$GH_STUB_DIR/pr_view.json" >"$f"
        ;;
      */issues/*/comments*)
        f="$GH_STUB_DIR/comments_list.json"
        [[ -f "$f" ]] || echo "[]" >"$f"
        ;;
      *) echo "stub: unhandled paginate URL $3" >&2; exit 64 ;;
    esac
    if [[ -n "$jq_expr" ]]; then jq -r "$jq_expr" "$f"; else cat "$f"; fi
    ;;
  "api repos/{owner}/{repo}/issues/123/comments"*|"api repos"*)
    f="$GH_STUB_DIR/comments_list.json"
    [[ -f "$f" ]] || echo "[]" >"$f"
    if [[ -n "$jq_expr" ]]; then jq -r "$jq_expr" "$f"; else cat "$f"; fi
    ;;
  *)
    echo "stub: unhandled gh $*" >&2
    exit 64
    ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

new_case() { # new_case → sets CASE_DIR, seeds pr_view.json
  CASE_DIR="$TMP_ROOT/case-$RANDOM-$((PASS + FAIL))"
  mkdir -p "$CASE_DIR"
  jq -n --arg sha "$SHA" '{headRefOid: $sha, baseRefName: "main", files: [{path: "scripts/merge-pr.sh"}, {path: "mcp-server/src/index.ts"}]}' \
    >"$CASE_DIR/pr_view.json"
}

run_attest() { # run_attest [args...] — runs with stub env; sets LAST_OUT/LAST_RC
  # RALPH_ATTEST_RETRY_WAIT_SEC=0: the rate-limit retry's fallback nap is 30 s,
  # which is suite time, not coverage. RALPH_ATTEST_CACHE_DIR keeps the run
  # cache inside the case dir instead of the real ~/.ralph.
  # RALPH_MERGE_POLICY_FILE points at a nonexistent path by default so the
  # REPO'S OWN verify block cannot leak a derived run set into cases that test
  # the no-evidence refusal; verify-block cases override it.
  set +e
  LAST_OUT=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$CASE_DIR" GH_STUB_LOG="$CASE_DIR/gh.log" \
    RALPH_ATTEST_RETRY_WAIT_SEC=0 RALPH_ATTEST_CACHE_DIR="$CASE_DIR/attest-cache" \
    RALPH_MERGE_POLICY_FILE="${POLICY_FILE_OVERRIDE:-$CASE_DIR/no-such-policy.json}" \
    bash "$SCRIPT" "$@" 2>&1)
  LAST_RC=$?
  set -e
}

extract_payload() { # from posted/patched body file
  local f="$1"
  awk '/^```json[[:space:]]*$/{flag=1; next} flag && /^```[[:space:]]*$/{exit} flag' "$f"
}

echo "=== attest-pr.sh ==="

# 1. Fresh post: marker + valid payload + head_sha + tests + classes
new_case
run_attest 123 --test "npm test::0::212 passed" \
  --review-verdict APPROVED --reviewer "ralph:review-agent" --generated-by "test-harness"
if [[ "$LAST_RC" -eq 0 ]] && grep -q "ATTESTATION POSTED" <<<"$LAST_OUT"; then
  pass "fresh attestation posts (rc 0)"
else
  fail "fresh attestation — rc=$LAST_RC out=$LAST_OUT"
fi
if grep -qF '<!-- ralph-attestation:v1 -->' "$CASE_DIR/posted_body.txt"; then
  pass "posted body carries marker"
else
  fail "marker missing from posted body"
fi
payload=$(extract_payload "$CASE_DIR/posted_body.txt")
if jq -e . >/dev/null 2>&1 <<<"$payload"; then pass "payload is valid JSON"; else fail "payload unparseable: $payload"; fi
[[ "$(jq -r .head_sha <<<"$payload")" == "$SHA" ]] && pass "head_sha captured from PR" || fail "head_sha wrong"
[[ "$(jq -r '.tests[0].exit_code' <<<"$payload")" == "0" ]] && pass "test exit_code parsed" || fail "test exit_code wrong"
[[ "$(jq -r '.tests[0].summary' <<<"$payload")" == "212 passed" ]] && pass "test summary parsed" || fail "test summary wrong"
[[ "$(jq -r .review.verdict <<<"$payload")" == "APPROVED" ]] && pass "review verdict recorded" || fail "verdict wrong"
# auto-classes from stubbed PR files: scripts/merge-pr.sh + mcp-server/... → mcp-ts, scripts-shell
auto_classes=$(jq -r '[.file_classes[].class] | sort | join(",")' <<<"$payload")
[[ "$auto_classes" == "mcp-ts,scripts-shell" ]] && pass "auto-classes computed from PR diff" || fail "auto-classes: $auto_classes"

# 2. Update-in-place when marker comment exists
new_case
jq -n '[{id: 42, body: "<!-- ralph-attestation:v1 -->\nold"}]' >"$CASE_DIR/comments_list.json"
run_attest 123 --test "npm test::0" --review-verdict APPROVED --reviewer "r" --generated-by "t"
if [[ "$LAST_RC" -eq 0 ]] && grep -q "ATTESTATION UPDATED" <<<"$LAST_OUT"; then
  pass "existing attestation updated, not duplicated"
else
  fail "update path — rc=$LAST_RC out=$LAST_OUT"
fi
if [[ -f "$CASE_DIR/patched_body.txt" && ! -f "$CASE_DIR/posted_body.txt" ]]; then
  pass "PATCH used instead of new comment"
else
  fail "expected PATCH, found new-comment post"
fi

# 3. Explicit --class appends/overrides; --no-auto-classes disables auto
new_case
run_attest 123 --test "npm test::0" --review-verdict APPROVED --reviewer "r" \
  --no-auto-classes --class "hooks-shell::security-floor" --generated-by "t"
payload=$(extract_payload "$CASE_DIR/posted_body.txt")
[[ "$(jq -r '.file_classes | length' <<<"$payload")" == "1" ]] \
  && [[ "$(jq -r '.file_classes[0].reviewed_by' <<<"$payload")" == "security-floor" ]] \
  && pass "--no-auto-classes + explicit --class respected" \
  || fail "explicit class handling wrong: $(jq -c .file_classes <<<"$payload")"

# 4. Non-integer exit code rejected
new_case
run_attest 123 --test "npm test::green" --review-verdict APPROVED --reviewer "r"
[[ "$LAST_RC" -ne 0 ]] && grep -q "exit_code must be an integer" <<<"$LAST_OUT" \
  && pass "non-integer exit code rejected" || fail "bad exit code accepted"

# 5. Missing required args rejected
new_case
run_attest 123 --review-verdict APPROVED --reviewer "r"
[[ "$LAST_RC" -ne 0 ]] && pass "missing --test rejected" || fail "missing --test accepted"
new_case
run_attest 123 --test "npm test::0"
[[ "$LAST_RC" -ne 0 ]] && pass "missing verdict/reviewer rejected" || fail "missing verdict accepted"

# ---------------------------------------------------------------------------
# --run / --carry-review (GH-1712, D9): observed runs bound to the attested
# head; carried review copied verbatim; refusals keyed on tokens, exit 75 —
# distinct from a failing test run, which posts honestly and exits 0.
# ---------------------------------------------------------------------------
echo
echo "=== --run / --carry-review (GH-1712, D9) ==="

# A throwaway git repo controls what `git rev-parse HEAD` returns; the stub PR
# head is seeded to match (binding pass) or differ (binding refusal).
RUN_REPO="$TMP_ROOT/runrepo"
git init -q "$RUN_REPO"
git -C "$RUN_REPO" -c user.email=t@t -c user.name=t commit --allow-empty -qm "seed"
LOCAL_HEAD=$(git -C "$RUN_REPO" rev-parse HEAD)

new_run_case() { # new_run_case <headRefOid> — pr_view head under our control
  CASE_DIR="$TMP_ROOT/case-$RANDOM-$((PASS + FAIL))"
  mkdir -p "$CASE_DIR"
  jq -n --arg sha "$1" '{headRefOid: $sha, baseRefName: "main", files: [{path: "scripts/merge-pr.sh"}]}' \
    >"$CASE_DIR/pr_view.json"
}

run_attest_in() { # run_attest_in <dir> [args...] — like run_attest, from <dir>
  local dir="$1"
  shift
  set +e
  LAST_OUT=$(cd "$dir" && PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$CASE_DIR" GH_STUB_LOG="$CASE_DIR/gh.log" \
    RALPH_ATTEST_RETRY_WAIT_SEC=0 RALPH_ATTEST_CACHE_DIR="$CASE_DIR/attest-cache" \
    RALPH_MERGE_POLICY_FILE="${POLICY_FILE_OVERRIDE:-$CASE_DIR/no-such-policy.json}" \
    bash "$SCRIPT" "$@" 2>&1)
  LAST_RC=$?
  set -e
}

# 6. --run with a passing command: real exit code 0, digest, ran_at_sha bound.
new_run_case "$LOCAL_HEAD"
run_attest_in "$RUN_REPO" 123 --run "echo '212 passed'" \
  --review-verdict APPROVED --reviewer "r" --no-auto-classes --generated-by "t"
[[ "$LAST_RC" -eq 0 ]] && grep -q "ATTESTATION POSTED" <<<"$LAST_OUT" \
  && pass "--run passing command posts (rc 0)" || fail "--run pass — rc=$LAST_RC out=$LAST_OUT"
payload=$(extract_payload "$CASE_DIR/posted_body.txt")
[[ "$(jq -r '.tests[0].exit_code' <<<"$payload")" == "0" ]] && pass "--run records real exit 0" || fail "--run exit code wrong"
[[ "$(jq -r '.tests[0].command' <<<"$payload")" == "echo '212 passed'" ]] && pass "--run records the command" || fail "--run command wrong"
grep -q "212 passed" <<<"$(jq -r '.tests[0].summary' <<<"$payload")" && pass "--run digest carries output" || fail "--run digest wrong"
[[ "$(jq -r '.tests[0].ran_at_sha' <<<"$payload")" == "$LOCAL_HEAD" ]] && pass "--run captures ran_at_sha" || fail "ran_at_sha wrong"

# 6b. --run with a SILENT passing command (shellcheck-clean shape): the empty
#     digest must not kill the attestation under pipefail.
new_run_case "$LOCAL_HEAD"
run_attest_in "$RUN_REPO" 123 --run "true" \
  --review-verdict APPROVED --reviewer "r" --no-auto-classes --generated-by "t"
[[ "$LAST_RC" -eq 0 ]] && pass "silent passing command posts (rc 0)" || fail "silent command rc=$LAST_RC out=$LAST_OUT"
payload=$(extract_payload "$CASE_DIR/posted_body.txt")
[[ "$(jq -r '.tests[0].summary' <<<"$payload")" == "(no output)" ]] && pass "empty output digested as (no output)" || fail "empty digest wrong: $(jq -c .tests <<<"$payload")"

# 7. --run with a FAILING command: an honest failing attestation, exit 0 —
#    the merge gate is what refuses it, not the composer.
new_run_case "$LOCAL_HEAD"
run_attest_in "$RUN_REPO" 123 --run "echo boom; exit 3" \
  --review-verdict APPROVED --reviewer "r" --no-auto-classes --generated-by "t"
[[ "$LAST_RC" -eq 0 ]] && pass "failing command still posts honestly (rc 0)" || fail "failing command rc=$LAST_RC"
payload=$(extract_payload "$CASE_DIR/posted_body.txt")
[[ "$(jq -r '.tests[0].exit_code' <<<"$payload")" == "3" ]] && pass "real non-zero exit recorded, not doctored" || fail "non-zero exit not recorded: $(jq -c .tests <<<"$payload")"

# 8. Head moved between run and post: REFUSED with its own token, exit 75,
#    nothing posted — distinct from the failing-test case above (rc 0).
new_run_case "$SHA"
run_attest_in "$RUN_REPO" 123 --run "echo ok" \
  --review-verdict APPROVED --reviewer "r" --no-auto-classes --generated-by "t"
[[ "$LAST_RC" -eq 75 ]] && pass "head-moved refusal exits 75" || fail "head-moved rc=$LAST_RC out=$LAST_OUT"
grep -qF "ATTESTATION REFUSED — head moved" <<<"$LAST_OUT" && pass "head-moved token emitted" || fail "head-moved token missing: $LAST_OUT"
[[ ! -f "$CASE_DIR/posted_body.txt" && ! -f "$CASE_DIR/patched_body.txt" ]] \
  && pass "head-moved refusal posts nothing" || fail "head-moved refusal posted anyway"

# 9. --run and --test never mix.
new_run_case "$LOCAL_HEAD"
run_attest_in "$RUN_REPO" 123 --run "echo ok" --test "npm test::0" \
  --review-verdict APPROVED --reviewer "r"
[[ "$LAST_RC" -eq 1 ]] && grep -q "mutually exclusive" <<<"$LAST_OUT" \
  && pass "--run + --test rejected" || fail "--run + --test accepted (rc=$LAST_RC)"

# 10. --carry-review copies the prior review block VERBATIM (extra keys and
#     all) and updates the existing marker comment in place.
new_run_case "$LOCAL_HEAD"
prior_review=$(jq -nc '{verdict: "APPROVED", reviewer: "ralph:review-agent", mode: "internal", url: "", note: "extra-key-preserved"}')
prior_payload=$(jq -n --arg sha "$LOCAL_HEAD" --argjson r "$prior_review" \
  '{version: 1, pr: 123, head_sha: $sha, tests: [{command: "npm test", exit_code: 0, summary: "ok"}], review: $r}')
prior_body=$(printf '<!-- ralph-attestation:v1 -->\n## Merge Attestation\n\n```json\n%s\n```\n' "$prior_payload")
jq -n --arg b "$prior_body" '[{id: 42, body: $b}]' >"$CASE_DIR/comments_list.json"
run_attest_in "$RUN_REPO" 123 --run "echo ok" --carry-review --no-auto-classes --generated-by "t"
[[ "$LAST_RC" -eq 0 ]] && grep -q "ATTESTATION UPDATED" <<<"$LAST_OUT" \
  && pass "--carry-review re-attests in place (rc 0)" || fail "--carry-review rc=$LAST_RC out=$LAST_OUT"
payload=$(extract_payload "$CASE_DIR/patched_body.txt")
if [[ "$(jq -cS '.review' <<<"$payload")" == "$(jq -cS . <<<"$prior_review")" ]]; then
  pass "--carry-review copies the review block verbatim (extra keys survive)"
else
  fail "--carry-review altered the review block: $(jq -c .review <<<"$payload")"
fi
[[ "$(jq -r '.head_sha' <<<"$payload")" == "$LOCAL_HEAD" ]] && pass "--carry-review refreshes head_sha" || fail "head_sha not refreshed"
[[ "$(jq -r '.tests[0].command' <<<"$payload")" == "echo ok" ]] && pass "--carry-review refreshes tests[] from observed runs" || fail "tests not refreshed"

# 11. --carry-review with no prior attestation: REFUSED with its own token,
#     exit 75, nothing posted — distinct from the head-moved token.
new_run_case "$LOCAL_HEAD"
run_attest_in "$RUN_REPO" 123 --run "echo ok" --carry-review --no-auto-classes --generated-by "t"
[[ "$LAST_RC" -eq 75 ]] && pass "no-prior-review refusal exits 75" || fail "no-prior rc=$LAST_RC out=$LAST_OUT"
grep -qF "ATTESTATION REFUSED — no prior review" <<<"$LAST_OUT" && pass "no-prior-review token emitted" || fail "no-prior token missing: $LAST_OUT"
grep -qF "head moved" <<<"$LAST_OUT" && fail "refusal tokens not distinct" || pass "refusal tokens distinct"
[[ ! -f "$CASE_DIR/posted_body.txt" && ! -f "$CASE_DIR/patched_body.txt" ]] \
  && pass "no-prior-review refusal posts nothing" || fail "no-prior refusal posted anyway"

# 12. --carry-review and a typed verdict never mix.
new_run_case "$LOCAL_HEAD"
run_attest_in "$RUN_REPO" 123 --run "echo ok" --carry-review --review-verdict APPROVED --reviewer "r"
[[ "$LAST_RC" -eq 1 ]] && grep -q "mutually exclusive" <<<"$LAST_OUT" \
  && pass "--carry-review + --review-verdict rejected" || fail "carry + typed verdict accepted (rc=$LAST_RC)"

# ---------------------------------------------------------------------------
# 13. Coloured run output (GH-1742): every modern test runner colours by
#     default, and the raw escape bytes made the posted payload unparseable —
#     the merge gate then refused honest, passing evidence.
# ---------------------------------------------------------------------------
echo
echo "=== --run digests survive colour (GH-1742) ==="

new_run_case "$LOCAL_HEAD"
run_attest_in "$RUN_REPO" 123 \
  --run "printf '\033[32m✓ 212 passed\033[0m \033[2m(1.20s)\033[22m\n'" \
  --review-verdict APPROVED --reviewer "r" --no-auto-classes --generated-by "t"
payload=$(extract_payload "$CASE_DIR/posted_body.txt")
jq -e . >/dev/null 2>&1 <<<"$payload" \
  && pass "coloured output still yields a parseable payload" || fail "coloured payload unparseable: $payload"
digest=$(jq -r '.tests[0].summary' <<<"$payload")
[[ "$digest" == "✓ 212 passed (1.20s)" ]] \
  && pass "digest is the stripped line, escapes and all removed" || fail "digest wrong: $(printf '%q' "$digest")"

# A pipe belongs to the markdown row, never to the stored value: the payload
# carries it bare, the table row carries it escaped.
new_run_case "$LOCAL_HEAD"
run_attest_in "$RUN_REPO" 123 --run "echo 'a|b passed'" \
  --review-verdict APPROVED --reviewer "r" --no-auto-classes --generated-by "t"
payload=$(extract_payload "$CASE_DIR/posted_body.txt")
[[ "$(jq -r '.tests[0].summary' <<<"$payload")" == "a|b passed" ]] \
  && pass "payload stores the pipe unescaped" || fail "payload pipe escaped: $(jq -c .tests <<<"$payload")"
grep -qF 'a\|b passed |' "$CASE_DIR/posted_body.txt" \
  && pass "table row escapes the pipe" || fail "table row did not escape the pipe"

# Truncation happens after stripping, so it can never bisect an escape.
new_run_case "$LOCAL_HEAD"
run_attest_in "$RUN_REPO" 123 \
  --run "printf '\033[32m%s\033[0m\n' \"\$(printf 'x%.0s' \$(seq 1 200))\"" \
  --review-verdict APPROVED --reviewer "r" --no-auto-classes --generated-by "t"
payload=$(extract_payload "$CASE_DIR/posted_body.txt")
digest=$(jq -r '.tests[0].summary' <<<"$payload")
[[ "${#digest}" -eq 120 && "$digest" != *$'\033'* ]] \
  && pass "long coloured line truncates to 120 clean chars" || fail "truncation wrong: len=${#digest}"

# ---------------------------------------------------------------------------
# 14. GH-1817: a rate-limited post exits 0 out of gh. The script must NOT
#     announce ATTESTATION POSTED over a comment that does not exist — the
#     driver would then wait on a gate that can never go green.
# ---------------------------------------------------------------------------
echo
echo "=== rate-limited posts are not silent successes (GH-1817) ==="

new_case
: >"$CASE_DIR/rate_limited"
run_attest 123 --test "npm test::0::ok" \
  --review-verdict APPROVED --reviewer "r" --generated-by "t"
[[ "$LAST_RC" -eq 75 ]] && pass "rate-limited post exits 75 (EX_TEMPFAIL)" || fail "rate-limited post rc=$LAST_RC out=$LAST_OUT"
grep -qF "ATTESTATION NOT POSTED" <<<"$LAST_OUT" && pass "rate-limited post is named, not announced as success" || fail "no refusal token: $LAST_OUT"
grep -qF "ATTESTATION POSTED —" <<<"$LAST_OUT" && fail "announced a post that never landed" || pass "does not claim a post that never landed"

# ---------------------------------------------------------------------------
# 15. Unrunnable run sets are REFUSED (audit B3): every run failed AND every
#     failure is an environment error — the attestation would assert nothing.
# ---------------------------------------------------------------------------
echo
echo "=== unrunnable run sets are refused (audit B3) ==="

new_run_case "$LOCAL_HEAD"
run_attest_in "$RUN_REPO" 123 \
  --run "echo 'bash: vitest: command not found'; exit 127" \
  --run "echo 'Error: Cannot find module vitest.config.ts'; exit 1" \
  --review-verdict APPROVED --reviewer "r" --no-auto-classes --generated-by "t"
[[ "$LAST_RC" -eq 75 ]] && pass "all-unrunnable run set exits 75" || fail "unrunnable rc=$LAST_RC out=$LAST_OUT"
grep -qF "ATTESTATION REFUSED — unrunnable run set" <<<"$LAST_OUT" \
  && pass "unrunnable refusal token emitted" || fail "unrunnable token missing: $LAST_OUT"
grep -qF "NEXT: npm ci" <<<"$LAST_OUT" \
  && pass "unrunnable NEXT names npm ci" || fail "no npm ci NEXT: $LAST_OUT"
[[ ! -f "$CASE_DIR/posted_body.txt" && ! -f "$CASE_DIR/patched_body.txt" ]] \
  && pass "unrunnable refusal posts nothing" || fail "unrunnable refusal posted anyway"

# The tsc-squatter banner and the vitest config-load failure are also the shape.
new_run_case "$LOCAL_HEAD"
run_attest_in "$RUN_REPO" 123 \
  --run "echo 'This is not the tsc command you are looking for'; exit 1" \
  --review-verdict APPROVED --reviewer "r" --no-auto-classes --generated-by "t"
[[ "$LAST_RC" -eq 75 ]] && grep -qF "unrunnable run set" <<<"$LAST_OUT" \
  && pass "tsc-squatter banner is unrunnable" || fail "tsc squatter rc=$LAST_RC out=$LAST_OUT"

# A run set with a GENUINE red still posts honestly (rc 0), even when a
# sibling failure is unrunnable — real evidence must not be suppressed.
new_run_case "$LOCAL_HEAD"
run_attest_in "$RUN_REPO" 123 \
  --run "echo 'bash: vitest: command not found'; exit 127" \
  --run "echo '3 tests failed'; exit 1" \
  --review-verdict APPROVED --reviewer "r" --no-auto-classes --generated-by "t"
[[ "$LAST_RC" -eq 0 ]] && grep -q "ATTESTATION POSTED" <<<"$LAST_OUT" \
  && pass "a genuine red among the failures still posts honestly" || fail "mixed failures rc=$LAST_RC out=$LAST_OUT"
payload=$(extract_payload "$CASE_DIR/posted_body.txt")
[[ "$(jq -r '.tests[1].exit_code' <<<"$payload")" == "1" ]] \
  && pass "the honest red is recorded, not doctored" || fail "mixed failure payload wrong"

# ---------------------------------------------------------------------------
# 16. Policy-default run set (audit A8): with no --test/--run the verify block
#     of the merge policy supplies the runs; pathRuns expand per changed file;
#     explicit flags always win; an absent block keeps the refusal.
# ---------------------------------------------------------------------------
echo
echo "=== policy-default run set (audit A8) ==="

VERIFY_POLICY="$TMP_ROOT/policy-verify.json"
cat >"$VERIFY_POLICY" <<'EOF'
{ "version": 1,
  "attestation": { "required": true },
  "verify": {
    "runs": ["echo base-verify-ran"],
    "pathRuns": {
      "mcp-server/**": ["echo cockpit-style-run-ran"],
      "no-such-dir/**": ["echo must-never-run"]
    }
  } }
EOF

# The stubbed PR diff (new_run_case) includes scripts/merge-pr.sh only; seed a
# case whose diff also touches mcp-server/** so exactly ONE pathRun matches.
new_run_case "$LOCAL_HEAD"
jq -n --arg sha "$LOCAL_HEAD" '{headRefOid: $sha, baseRefName: "main",
  files: [{path: "scripts/merge-pr.sh"}, {path: "mcp-server/src/index.ts"}]}' \
  >"$CASE_DIR/pr_view.json"
POLICY_FILE_OVERRIDE="$VERIFY_POLICY" run_attest_in "$RUN_REPO" 123 \
  --review-verdict APPROVED --reviewer "r" --no-auto-classes --generated-by "t"
[[ "$LAST_RC" -eq 0 ]] && grep -q "ATTESTATION POSTED" <<<"$LAST_OUT" \
  && pass "no-flags attest derives and posts from the verify block" || fail "verify derivation rc=$LAST_RC out=$LAST_OUT"
grep -qF "RUN SET DERIVED FROM POLICY" <<<"$LAST_OUT" \
  && pass "derivation is narrated, not silent" || fail "no derivation narration: $LAST_OUT"
payload=$(extract_payload "$CASE_DIR/posted_body.txt")
cmds=$(jq -r '[.tests[].command] | join("|")' <<<"$payload")
[[ "$cmds" == "echo base-verify-ran|echo cockpit-style-run-ran" ]] \
  && pass "base runs + the matched pathRun execute, in order" || fail "derived run set wrong: $cmds"
grep -qF "must-never-run" <<<"$cmds" \
  && fail "an unmatched pathRuns glob executed" || pass "unmatched pathRuns glob does not execute"

# Explicit --run wins outright: nothing from the policy runs.
new_run_case "$LOCAL_HEAD"
POLICY_FILE_OVERRIDE="$VERIFY_POLICY" run_attest_in "$RUN_REPO" 123 \
  --run "echo explicit-wins" \
  --review-verdict APPROVED --reviewer "r" --no-auto-classes --generated-by "t"
payload=$(extract_payload "$CASE_DIR/posted_body.txt")
[[ "$(jq -r '.tests | length' <<<"$payload")" == "1" ]] \
  && [[ "$(jq -r '.tests[0].command' <<<"$payload")" == "echo explicit-wins" ]] \
  && pass "explicit --run overrides the policy verify block" || fail "explicit did not win: $(jq -c .tests <<<"$payload")"

# No verify block (default POLICY_FILE_OVERRIDE points at a nonexistent file):
# today's refusal, extended to NAME the verify block as the way to set a default.
new_run_case "$LOCAL_HEAD"
run_attest_in "$RUN_REPO" 123 --review-verdict APPROVED --reviewer "r"
[[ "$LAST_RC" -eq 1 ]] && grep -q "at least one --test" <<<"$LAST_OUT" \
  && pass "absent verify block keeps the refusal" || fail "absent-block behavior changed: rc=$LAST_RC $LAST_OUT"
grep -q "verify" <<<"$LAST_OUT" && grep -q "NEXT:" <<<"$LAST_OUT" \
  && pass "refusal names the verify block and a runnable NEXT" || fail "refusal not extended: $LAST_OUT"

# ---------------------------------------------------------------------------
# 17. --resume (audit B3): re-posts CACHED runs only while the PR head is
#     unchanged. Stale cache refuses with the reason; no cache refuses.
# ---------------------------------------------------------------------------
echo
echo "=== --resume re-posts from cache, head-pinned (audit B3) ==="

new_run_case "$LOCAL_HEAD"
run_attest_in "$RUN_REPO" 123 --run "echo 'cached 7 passed'" \
  --review-verdict APPROVED --reviewer "r" --no-auto-classes --generated-by "t"
[[ "$LAST_RC" -eq 0 ]] || fail "resume setup post failed: $LAST_OUT"
[[ -f "$CASE_DIR/attest-cache/123-$LOCAL_HEAD.json" ]] \
  && pass "run results cached keyed on (pr, head_sha)" || fail "no cache written"
rm -f "$CASE_DIR/posted_body.txt"
run_attest_in "$RUN_REPO" 123 --resume \
  --review-verdict APPROVED --reviewer "r" --no-auto-classes --generated-by "t"
[[ "$LAST_RC" -eq 0 ]] && grep -q "ATTESTATION POSTED" <<<"$LAST_OUT" \
  && pass "--resume re-posts at the unchanged head" || fail "resume rc=$LAST_RC out=$LAST_OUT"
grep -q "RUNNING:" <<<"$LAST_OUT" \
  && fail "--resume re-ran the suite" || pass "--resume did not re-run anything"
payload=$(extract_payload "$CASE_DIR/posted_body.txt")
[[ "$(jq -r '.tests[0].command' <<<"$payload")" == "echo 'cached 7 passed'" ]] \
  && pass "--resume publishes the cached run results" || fail "resume payload wrong: $(jq -c .tests <<<"$payload")"

# Head moved since the cache was written: REFUSED with the reason.
jq -n --arg sha "$SHA" '{headRefOid: $sha, baseRefName: "main",
  files: [{path: "scripts/merge-pr.sh"}]}' >"$CASE_DIR/pr_view.json"
rm -f "$CASE_DIR/posted_body.txt"
run_attest_in "$RUN_REPO" 123 --resume \
  --review-verdict APPROVED --reviewer "r" --no-auto-classes --generated-by "t"
[[ "$LAST_RC" -eq 75 ]] && grep -qF "stale cache" <<<"$LAST_OUT" \
  && pass "--resume refuses a moved head as stale cache" || fail "stale-cache rc=$LAST_RC out=$LAST_OUT"
grep -q "NEXT:" <<<"$LAST_OUT" && pass "stale-cache refusal has a NEXT" || fail "stale-cache NEXT missing"
[[ ! -f "$CASE_DIR/posted_body.txt" ]] \
  && pass "stale cache posts nothing" || fail "stale cache posted anyway"

# No cache at all: its own refusal, not the stale one.
new_run_case "$LOCAL_HEAD"
run_attest_in "$RUN_REPO" 123 --resume \
  --review-verdict APPROVED --reviewer "r" --no-auto-classes --generated-by "t"
[[ "$LAST_RC" -eq 75 ]] && grep -qF "no cached runs" <<<"$LAST_OUT" \
  && pass "--resume with no cache refuses by name" || fail "no-cache rc=$LAST_RC out=$LAST_OUT"

# --resume never mixes with fresh evidence.
new_run_case "$LOCAL_HEAD"
run_attest_in "$RUN_REPO" 123 --resume --run "echo fresh" \
  --review-verdict APPROVED --reviewer "r"
[[ "$LAST_RC" -eq 1 ]] && grep -q "never mixes" <<<"$LAST_OUT" \
  && pass "--resume + --run rejected" || fail "resume+run accepted (rc=$LAST_RC)"

# A rate-limited post in run mode points the NEXT at --resume (cache exists).
new_run_case "$LOCAL_HEAD"
: >"$CASE_DIR/rate_limited"
run_attest_in "$RUN_REPO" 123 --run "echo ok" \
  --review-verdict APPROVED --reviewer "r" --no-auto-classes --generated-by "t"
[[ "$LAST_RC" -eq 75 ]] && grep -qF -- "--resume" <<<"$LAST_OUT" \
  && pass "rate-limited run-mode post names --resume as the NEXT" || fail "rate-limit NEXT: rc=$LAST_RC $LAST_OUT"

# --help short-circuits before everything (no gh, no policy, no git).
set +e
HELP_OUT=$(bash "$SCRIPT" --help 2>&1)
HELP_RC=$?
set -e
[[ "$HELP_RC" -eq 0 ]] && grep -q "Usage:" <<<"$HELP_OUT" \
  && pass "--help exits 0 with usage, before any config read" || fail "--help rc=$HELP_RC"

echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
