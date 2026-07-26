#!/usr/bin/env bash
# scripts/__tests__/merge-pr-gates.test.sh
# Verification-gate tests for scripts/merge-pr.sh (GH-1589).
#
# Harness: a PATH-injected `gh` stub serves canned JSON from $GH_STUB_DIR and
# logs every invocation to $GH_STUB_LOG, so gate logic is tested without
# network. Pattern follows ralph/hooks/scripts/__tests__/review-plan-gate.test.sh.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/merge-pr.sh"
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
echo "gh $*" >>"$GH_STUB_LOG"
args=("$@")
jq_expr=""
for ((i = 0; i < ${#args[@]}; i++)); do
  if [[ "${args[$i]}" == "--jq" ]]; then jq_expr="${args[$((i + 1))]}"; fi
done
serve() {
  local f="$GH_STUB_DIR/$1"
  [[ -f "$f" ]] || { echo "{}"; return; }
  if [[ -n "$jq_expr" ]]; then jq -r "$jq_expr" "$f"; else cat "$f"; fi
}
case "${1:-} ${2:-}" in
  "pr view") serve pr_view.json ;;
  "pr checks")
    if [[ -f "$GH_STUB_DIR/pr_checks.json" ]]; then cat "$GH_STUB_DIR/pr_checks.json"; else echo "[]"; fi
    exit "${GH_STUB_CHECKS_EXIT:-0}"
    ;;
  "pr comment")
    for ((i = 0; i < ${#args[@]}; i++)); do
      if [[ "${args[$i]}" == "--body" ]]; then printf '%s\n---\n' "${args[$((i + 1))]}" >>"$GH_STUB_DIR/comments.log"; fi
    done
    ;;
  "pr merge") echo "merged" ;;
  "api user") if [[ -n "$jq_expr" ]]; then echo "testuser"; else echo '{"login":"testuser"}'; fi ;;
  *)
    echo "stub: unhandled gh $*" >&2
    exit 64
    ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

# --- fixtures --------------------------------------------------------------
SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

POLICY="$TMP_ROOT/policy.json"
cat >"$POLICY" <<'EOF'
{
  "version": 1,
  "attestation": { "required": true },
  "external_review": { "required": true, "bot": "coderabbitai" },
  "exempt_authors": ["dependabot[bot]", "app/dependabot", "github-actions[bot]"]
}
EOF

good_attestation_body() { # good_attestation_body <head_sha> [tests_exit]
  local sha="$1" texit="${2:-0}"
  local payload
  payload=$(jq -n --arg sha "$sha" --argjson texit "$texit" '{
    version: 1, pr: 123, head_sha: $sha,
    tests: [{command: "npm test", exit_code: $texit, summary: "ok"}],
    review: {verdict: "APPROVED", reviewer: "ralph:review-agent", mode: "internal"}
  }')
  # shellcheck disable=SC2016  # literal markdown code fence, no expansion wanted
  printf '<!-- ralph-attestation:v1 -->\n## Merge Attestation\n\n```json\n%s\n```\n' "$payload"
}

# write_pr_view <dir> <reviewDecision> <mergeable> <author> <att_body|""> <reviews_json>
write_pr_view() {
  local dir="$1" decision="$2" mergeable="$3" author="$4" att="$5" reviews="$6"
  local comments='[]'
  if [[ -n "$att" ]]; then
    comments=$(jq -n --arg b "$att" '[{body: $b}]')
  fi
  jq -n \
    --arg decision "$decision" --arg mergeable "$mergeable" \
    --arg author "$author" --arg sha "$SHA" \
    --argjson comments "$comments" --argjson reviews "$reviews" \
    '{state: "OPEN", mergeable: $mergeable, headRefOid: $sha,
      reviewDecision: $decision, author: {login: $author},
      headRefName: "feature/GH-9999", comments: $comments, reviews: $reviews}' \
    >"$dir/pr_view.json"
}

GREEN_CHECKS='[{"name":"test-hooks","bucket":"pass"},{"name":"lint","bucket":"skipping"}]'
CODERABBIT_REVIEWS='[{"author":{"login":"app/coderabbitai"}}]'

expect_out() { # expect_out <desc> <grep-pattern>
  if grep -qF "$2" <<<"$LAST_OUT"; then pass "$1"; else fail "$1 — missing '$2' in: $LAST_OUT"; fi
}
expect_merged() {
  if grep -q "gh pr merge" "$LAST_DIR/gh.log" 2>/dev/null; then pass "$1: merge invoked"; else fail "$1: merge NOT invoked"; fi
}
expect_not_merged() {
  if grep -q "gh pr merge" "$LAST_DIR/gh.log" 2>/dev/null; then fail "$1: merge invoked but should be blocked"; else pass "$1: merge not invoked"; fi
}

# The script requires a git repo cwd (rev-parse); run from the repo root.
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# run_case <desc> <expected_exit> <policy|""> <setup-fn> [script args...]
run_case() {
  local desc="$1" expected="$2" policy="$3" setup="$4"
  shift 4
  local dir="$TMP_ROOT/case-$RANDOM-$((PASS + FAIL))"
  mkdir -p "$dir"
  GH_STUB_DIR="$dir" "$setup" "$dir"
  local out actual
  set +e
  out=$(cd "$REPO_ROOT" && PATH="$STUB_BIN:$PATH" \
    GH_STUB_DIR="$dir" GH_STUB_LOG="$dir/gh.log" \
    RALPH_MERGE_POLICY_FILE="${policy:-/nonexistent-policy.json}" \
    bash "$SCRIPT" 123 "$@" 2>&1)
  actual=$?
  set -e
  LAST_OUT="$out"
  LAST_DIR="$dir"
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc (exit $actual)"
  else
    fail "$desc — expected exit $expected, got $actual. Output: $out"
  fi
}

# ---------------------------------------------------------------------------
echo "=== merge-pr.sh verification gates ==="

# 1. Fully green: attested, external review present, checks pass
setup_green() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "$CODERABBIT_REVIEWS"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "green path merges" 0 "$POLICY" setup_green
expect_out "green path emits PASS" "MERGE GATE PASS"
expect_merged "green path"

# 2. CHANGES_REQUESTED blocks, even with --force
setup_cr() {
  write_pr_view "$1" "CHANGES_REQUESTED" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "$CODERABBIT_REVIEWS"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "CHANGES_REQUESTED blocks" 1 "$POLICY" setup_cr
expect_out "CR names review gate" "MERGE GATE FAIL — review"
expect_not_merged "CHANGES_REQUESTED"
run_case "CHANGES_REQUESTED blocks despite --force" 1 "$POLICY" setup_cr --force "emergency"
expect_not_merged "CHANGES_REQUESTED + force"

# 3. Pending check blocks
setup_pending() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "$CODERABBIT_REVIEWS"
  echo '[{"name":"build","bucket":"pending"}]' >"$1/pr_checks.json"
}
run_case "pending checks block" 1 "$POLICY" setup_pending
expect_out "pending named" "build=pending"
expect_not_merged "pending checks"

# 4. Failing check blocks and is named
setup_failing() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "$CODERABBIT_REVIEWS"
  echo '[{"name":"test-hooks","bucket":"fail"},{"name":"lint","bucket":"pass"}]' >"$1/pr_checks.json"
}
run_case "failing check blocks" 1 "$POLICY" setup_failing
expect_out "failing check named" "test-hooks=fail"

# 5. ralph-attestation status context is excluded from gate 3
setup_att_ctx() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "$CODERABBIT_REVIEWS"
  echo '[{"name":"test-hooks","bucket":"pass"},{"name":"ralph-attestation","bucket":"pending"}]' >"$1/pr_checks.json"
}
run_case "ralph-attestation context excluded from checks gate" 0 "$POLICY" setup_att_ctx

# 6. Missing attestation blocks
setup_no_att() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "" "$CODERABBIT_REVIEWS"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "missing attestation blocks" 1 "$POLICY" setup_no_att
expect_out "attestation gate named" "MERGE GATE FAIL — attestation"

# 7. head_sha mismatch blocks (attest-then-push laundering)
setup_stale_att() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")" "$CODERABBIT_REVIEWS"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "stale attestation (head_sha mismatch) blocks" 1 "$POLICY" setup_stale_att
expect_out "mismatch tells re-attest" "re-attest after the latest push"

# 8. Non-zero test exit in attestation blocks
setup_bad_tests() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA" 1)" "$CODERABBIT_REVIEWS"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "failing test evidence blocks" 1 "$POLICY" setup_bad_tests
expect_out "test evidence named" "passing test evidence"

# 9. Missing external review blocks
setup_no_ext() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "[]"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "missing external review blocks" 1 "$POLICY" setup_no_ext
expect_out "external gate named" "MERGE GATE FAIL — external-review"

# 10. Exempt author (dependabot) skips attestation + external gates
setup_dependabot() {
  write_pr_view "$1" "" "MERGEABLE" "app/dependabot" "" "[]"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "dependabot exempt from attestation/external" 0 "$POLICY" setup_dependabot
expect_out "exempt flagged" "exempt=true"
expect_merged "dependabot exempt"

# 11. Exempt author still needs CI green
setup_dependabot_red() {
  write_pr_view "$1" "" "MERGEABLE" "app/dependabot" "" "[]"
  echo '[{"name":"build","bucket":"fail"}]' >"$1/pr_checks.json"
}
run_case "exempt author still blocked on red CI" 1 "$POLICY" setup_dependabot_red

# 12. --force skips soft gates, posts override comment, then merges
run_case "--force bypasses attestation with override comment" 0 "$POLICY" setup_no_att --force "hotfix: validator outage"
expect_out "force warns" "skipped by --force"
expect_merged "--force"
if grep -q "Merge Gate Override" "$LAST_DIR/comments.log" 2>/dev/null \
  && grep -q "hotfix: validator outage" "$LAST_DIR/comments.log" 2>/dev/null; then
  pass "--force posts override comment with reason"
else
  fail "--force override comment missing"
fi

# 13. --force without a reason is rejected
run_case "--force without reason rejected" 1 "$POLICY" setup_green --force
expect_not_merged "--force without reason"

# 14. Zero checks → warn + continue
setup_no_checks() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "$CODERABBIT_REVIEWS"
  echo '[]' >"$1/pr_checks.json"
}
run_case "zero checks warns but continues" 0 "$POLICY" setup_no_checks
expect_out "zero-checks warn" "no CI checks reported"

# 15. No policy file → gates 4-5 off, gates 0-3 still bind
setup_no_policy_green() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "" "[]"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "no policy file: merges without attestation" 0 "" setup_no_policy_green
setup_no_policy_red() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "" "[]"
  echo '[{"name":"build","bucket":"fail"}]' >"$1/pr_checks.json"
}
run_case "no policy file: red CI still blocks" 1 "" setup_no_policy_red

# 16. CONFLICTING blocks even with --force
setup_conflicting() {
  write_pr_view "$1" "" "CONFLICTING" "cdubiel08" "$(good_attestation_body "$SHA")" "$CODERABBIT_REVIEWS"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "CONFLICTING blocks" 1 "$POLICY" setup_conflicting
run_case "CONFLICTING blocks despite --force" 1 "$POLICY" setup_conflicting --force "try anyway"
expect_not_merged "CONFLICTING + force"

# ---------------------------------------------------------------------------
echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
