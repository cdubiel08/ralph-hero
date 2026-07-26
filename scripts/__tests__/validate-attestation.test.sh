#!/usr/bin/env bash
# scripts/__tests__/validate-attestation.test.sh
# Verdict-state tests for the server-side validator (GH-1589): the
# success/failure/pending semantics the ralph-attestation commit status
# publishes. gh is stubbed on PATH; pr-file-classes.sh runs for real against
# the stub (its --pr path reads gh pr view --json files).

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/validate-attestation.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

SHA="dddddddddddddddddddddddddddddddddddddddd"

STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
jq_expr=""
for ((i = 0; i < ${#args[@]}; i++)); do
  if [[ "${args[$i]}" == "--jq" ]]; then jq_expr="${args[$((i + 1))]}"; fi
done
case "${1:-} ${2:-}" in
  "pr view")
    if [[ -n "$jq_expr" ]]; then jq -r "$jq_expr" "$GH_STUB_DIR/pr_view.json"; else cat "$GH_STUB_DIR/pr_view.json"; fi
    ;;
  "api --paginate")
    # pr-file-classes.sh paginated REST files fetch
    case "${3:-}" in
      */pulls/*/files*)
        f="$GH_STUB_DIR/pr_files_rest.json"
        [[ -f "$f" ]] || jq '[.files[] | {filename: .path}]' "$GH_STUB_DIR/pr_view.json" >"$f"
        ;;
      *) echo "stub: unhandled paginate URL $3" >&2; exit 64 ;;
    esac
    if [[ -n "$jq_expr" ]]; then jq -r "$jq_expr" "$f"; else cat "$f"; fi
    ;;
  *)
    echo "stub: unhandled gh $*" >&2
    exit 64
    ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

POLICY="$TMP_ROOT/policy.json"
cat >"$POLICY" <<'EOF'
{
  "version": 1,
  "attestation": { "required": true },
  "external_review": { "required": true, "bot": "coderabbitai" },
  "exempt_authors": ["dependabot[bot]", "app/dependabot"]
}
EOF

attestation_body() { # attestation_body <sha> [tests_exit] [classes_csv]
  local sha="$1" texit="${2:-0}" classes="${3:-scripts-shell,mcp-ts}"
  local classes_json payload
  classes_json=$(jq -n --arg csv "$classes" \
    '[($csv | split(",")[]) | {class: ., reviewed_by: ("adversarial:" + .)}]')
  payload=$(jq -n --arg sha "$sha" --argjson texit "$texit" --argjson classes "$classes_json" '{
    version: 1, pr: 123, head_sha: $sha,
    tests: [{command: "npm test", exit_code: $texit, summary: "ok"}],
    review: {verdict: "APPROVED", reviewer: "ralph:review-agent", mode: "internal"},
    file_classes: $classes, generated_by: "test-harness"
  }')
  # shellcheck disable=SC2016  # literal markdown code fence, no expansion wanted
  printf '<!-- ralph-attestation:v1 -->\n## Merge Attestation\n\n```json\n%s\n```\n' "$payload"
}

# write_pr <dir> <author> <att_body|""> <reviews_json> [files_json]
write_pr() {
  local dir="$1" author="$2" att="$3" reviews="$4"
  local files="${5:-}"
  if [[ -z "$files" ]]; then
    files='[{"path":"scripts/merge-pr.sh"},{"path":"mcp-server/src/index.ts"}]'
  fi
  local comments='[]'
  if [[ -n "$att" ]]; then comments=$(jq -n --arg b "$att" '[{body: $b}]'); fi
  jq -n --arg sha "$SHA" --arg author "$author" \
    --argjson comments "$comments" --argjson reviews "$reviews" --argjson files "$files" \
    '{headRefOid: $sha, author: {login: $author}, comments: $comments, reviews: $reviews, files: $files}' \
    >"$dir/pr_view.json"
}

CODERABBIT='[{"author":{"login":"app/coderabbitai"}}]'

# run_v <desc> <expected_state> <expected_desc_grep> <policy|""> <setup> ...
run_v() {
  local desc="$1" exp_state="$2" exp_desc="$3" policy="$4" setup="$5"
  local dir="$TMP_ROOT/case-$RANDOM-$((PASS + FAIL))"
  mkdir -p "$dir"
  "$setup" "$dir"
  local out state
  set +e
  out=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$dir" \
    RALPH_MERGE_POLICY_FILE="${policy:-/nonexistent-policy.json}" \
    bash "$SCRIPT" 123 2>&1)
  local rc=$?
  set -e
  state="${out%%|*}"
  if [[ "$rc" -eq 0 && "$state" == "$exp_state" ]] && grep -qF "$exp_desc" <<<"$out"; then
    pass "$desc → $state"
  else
    fail "$desc — expected $exp_state|*$exp_desc*, got rc=$rc: $out"
  fi
}

echo "=== validate-attestation.sh verdict states ==="

s_valid() { write_pr "$1" "cdubiel08" "$(attestation_body "$SHA")" "$CODERABBIT"; }
run_v "fully attested" success "attested @ ${SHA:0:8}" "$POLICY" s_valid

s_missing() { write_pr "$1" "cdubiel08" "" "$CODERABBIT"; }
run_v "no attestation yet" pending "awaiting attestation" "$POLICY" s_missing

s_stale() { write_pr "$1" "cdubiel08" "$(attestation_body "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")" "$CODERABBIT"; }
run_v "stale head_sha" pending "re-attest" "$POLICY" s_stale

s_badtests() { write_pr "$1" "cdubiel08" "$(attestation_body "$SHA" 1)" "$CODERABBIT"; }
run_v "failing test evidence" failure "test evidence" "$POLICY" s_badtests

s_undercov() { write_pr "$1" "cdubiel08" "$(attestation_body "$SHA" 0 "scripts-shell")" "$CODERABBIT"; }
run_v "class under-coverage (mcp-ts undeclared)" failure "not covered" "$POLICY" s_undercov

s_noext() { write_pr "$1" "cdubiel08" "$(attestation_body "$SHA")" "[]"; }
run_v "external review absent" pending "awaiting external review by coderabbitai" "$POLICY" s_noext

s_exempt() { write_pr "$1" "app/dependabot" "" "[]"; }
run_v "exempt bot author" success "exempt author" "$POLICY" s_exempt

s_any() { write_pr "$1" "cdubiel08" "" "[]"; }
run_v "no policy file" success "not required" "" s_any

s_garbage() {
  write_pr "$1" "cdubiel08" '<!-- ralph-attestation:v1 -->
```json
{not json
```' "$CODERABBIT"
}
run_v "unparseable payload" failure "unparseable" "$POLICY" s_garbage

# CodeRabbit findings (PR #1602):

# Non-APPROVED verdict must FAIL, not pass on presence
s_rejected() {
  local att
  att=$(attestation_body "$SHA")
  att="${att/APPROVED/REJECTED}"
  write_pr "$1" "cdubiel08" "$att" "$CODERABBIT"
}
run_v "REJECTED verdict fails (presence is not approval)" failure "not APPROVED" "$POLICY" s_rejected

# Malformed policy file fails CLOSED
BAD_POLICY="$TMP_ROOT/bad-policy.json"
echo '{ not json' >"$BAD_POLICY"
run_v "malformed policy fails closed" failure "not valid JSON" "$BAD_POLICY" s_valid

# Output is state|sha|description — verdict bound to the validated SHA
dir="$TMP_ROOT/sha-bind"
mkdir -p "$dir"
s_valid "$dir"
out=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$dir" RALPH_MERGE_POLICY_FILE="$POLICY" bash "$SCRIPT" 123)
if [[ "$out" == "success|$SHA|"* ]]; then
  pass "verdict line carries the validated head SHA"
else
  fail "sha binding missing from output: $out"
fi

echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
