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
    printf '%s' "$body_val" >"$GH_STUB_DIR/posted_body.txt"
    ;;
  "api --method")
    # PATCH update path: gh api --method PATCH repos/... -f body=...
    printf '%s' "$body_val" >"$GH_STUB_DIR/patched_body.txt"
    ;;
  "api --paginate")
    # Paginated REST reads: dispatch on the endpoint URL ($3).
    case "${3:-}" in
      */pulls/*/files)
        f="$GH_STUB_DIR/pr_files_rest.json"
        [[ -f "$f" ]] || jq '[.files[] | {filename: .path}]' "$GH_STUB_DIR/pr_view.json" >"$f"
        ;;
      */issues/*/comments)
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
  jq -n --arg sha "$SHA" '{headRefOid: $sha, files: [{path: "scripts/merge-pr.sh"}, {path: "mcp-server/src/index.ts"}]}' \
    >"$CASE_DIR/pr_view.json"
}

run_attest() { # run_attest [args...] — runs with stub env; sets LAST_OUT/LAST_RC
  set +e
  LAST_OUT=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$CASE_DIR" GH_STUB_LOG="$CASE_DIR/gh.log" \
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

echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
