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
  "api repos/"*)
    # External-review check reads findings, clean-result comments, and PR reactions.
    if [[ "$2" == */issues/*/comments ]]; then
      f="$GH_STUB_DIR/issue_comments.json"
    elif [[ "$2" == */issues/*/reactions ]]; then
      f="$GH_STUB_DIR/pr_reactions.json"
      if [[ -f "$GH_STUB_DIR/reaction_after_first" ]]; then
        count_file="$GH_STUB_DIR/reaction_calls"
        count=0
        [[ -f "$count_file" ]] && count=$(cat "$count_file")
        count=$((count + 1))
        echo "$count" >"$count_file"
        if [[ "$count" -eq 1 ]]; then f="$GH_STUB_DIR/empty_reactions.json"; fi
      fi
    else
      f="$GH_STUB_DIR/pr_reviews.json"
    fi
    [[ -f "$f" ]] || echo '[]' >"$f"
    if [[ -n "$jq_expr" ]]; then jq -r "$jq_expr" "$f"; else cat "$f"; fi
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
  "external_review": {
    "required": true,
    "bot": "chatgpt-codex-connector[bot]",
    "trigger": "@codex review",
    "head_marker": "ralph-review-head",
    "clean_comment_marker": "Codex Review: Didn't find any major issues.",
    "approval_reaction": "+1"
  },
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
  local clean_evidence=false
  if [[ "$reviews" == "__CLEAN_CODEX__" ]]; then
    reviews='[]'
    clean_evidence=true
  fi
  local files="${5:-}"
  if [[ -z "$files" ]]; then
    files='[{"path":"scripts/merge-pr.sh"},{"path":"mcp-server/src/index.ts"}]'
  fi
  local comments='[]'
  if [[ -n "$att" ]]; then comments=$(jq -n --arg b "$att" '[{body: $b}]'); fi
  # REST-shaped copy for the head-bound external-review check (needs commit_id).
  jq -n --argjson r "$reviews" --arg sha "$SHA" \
    '[$r[] | {user: {login: (.author.login // "")}, state: (.state // "APPROVED"),
              commit_id: (.commit_id // $sha), submitted_at: (.submitted_at // "2026-08-13T04:00:05Z")}]' \
    >"$dir/pr_reviews.json"
  echo '[]' >"$dir/issue_comments.json"
  echo '[]' >"$dir/pr_reactions.json"
  jq -n --arg sha "$SHA" --arg author "$author" \
    --argjson comments "$comments" --argjson reviews "$reviews" --argjson files "$files" \
    '{headRefOid: $sha, author: {login: $author}, comments: $comments, reviews: $reviews, files: $files}' \
    >"$dir/pr_view.json"
  if [[ "$clean_evidence" == "true" ]]; then
    add_clean_codex_evidence "$dir" "$SHA"
  fi
}

add_clean_codex_evidence() { # add_clean_codex_evidence <dir> <head-sha>
  local dir="$1" sha="$2"
  jq -n --arg sha "$sha" '[
    {user:{login:"cdubiel08"}, body:("@codex review\n<!-- ralph-review-head: " + $sha + " -->"), created_at:"2026-08-13T04:00:00Z"},
    {user:{login:"chatgpt-codex-connector[bot]"}, body:"Codex Review: Didn\u0027t find any major issues. What shall we delve into next?", created_at:"2026-08-13T04:00:10Z"}
  ]' >"$dir/issue_comments.json"
  echo '[{"user":{"login":"chatgpt-codex-connector[bot]"},"content":"+1","created_at":"2026-08-13T04:00:10Z"}]' \
    >"$dir/pr_reactions.json"
}

CODEX='__CLEAN_CODEX__'
CODEX_COMMENTED='[{"author":{"login":"app/chatgpt-codex-connector"},"state":"COMMENTED","submitted_at":"2026-08-13T04:00:05Z"}]'

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
    RALPH_EXTERNAL_REVIEW_RETRIES=1 \
    RALPH_EXTERNAL_REVIEW_RETRY_DELAY_SECONDS=0 \
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

s_valid() { write_pr "$1" "cdubiel08" "$(attestation_body "$SHA")" "$CODEX"; }
run_v "fully attested" success "attested @ ${SHA:0:8}" "$POLICY" s_valid

s_missing() { write_pr "$1" "cdubiel08" "" "$CODEX"; }
run_v "no attestation yet" pending "awaiting attestation" "$POLICY" s_missing

s_stale() { write_pr "$1" "cdubiel08" "$(attestation_body "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")" "$CODEX"; }
run_v "stale head_sha" pending "re-attest" "$POLICY" s_stale

s_badtests() { write_pr "$1" "cdubiel08" "$(attestation_body "$SHA" 1)" "$CODEX"; }
run_v "failing test evidence" failure "test evidence" "$POLICY" s_badtests

s_undercov() { write_pr "$1" "cdubiel08" "$(attestation_body "$SHA" 0 "scripts-shell")" "$CODEX"; }
run_v "class under-coverage (mcp-ts undeclared)" failure "not covered" "$POLICY" s_undercov

s_noext() { write_pr "$1" "cdubiel08" "$(attestation_body "$SHA")" "[]"; }
run_v "external review absent" pending "awaiting external review by chatgpt-codex-connector[bot]" "$POLICY" s_noext

s_cleanext() {
  write_pr "$1" "cdubiel08" "$(attestation_body "$SHA")" "[]"
  add_clean_codex_evidence "$1" "$SHA"
}
run_v "clean bot comment plus Codex PR thumbs-up" success "attested @ ${SHA:0:8}" "$POLICY" s_cleanext

s_reaction_arrives_after_clean_comment() {
  s_cleanext "$1"
  echo '[]' >"$1/empty_reactions.json"
  touch "$1/reaction_after_first"
}
run_v "validator retries when the Codex thumbs-up follows its clean comment" success "attested @ ${SHA:0:8}" "$POLICY" s_reaction_arrives_after_clean_comment

s_clean_without_reaction() {
  s_cleanext "$1"
  echo '[]' >"$1/pr_reactions.json"
}
run_v "clean bot comment without Codex PR thumbs-up" pending "awaiting external review" "$POLICY" s_clean_without_reaction

s_commentedext() {
  write_pr "$1" "cdubiel08" "$(attestation_body "$SHA")" "$CODEX_COMMENTED"
}
run_v "current-head COMMENTED Codex review is findings, not approval" pending "awaiting external review" "$POLICY" s_commentedext

s_prefix_collision_cleanext() {
  s_cleanext "$1"
  jq --arg stale "${SHA:0:39}e" \
    '.[0].body = ("@codex review\n<!-- ralph-review-head: " + $stale + " -->")' \
    "$1/issue_comments.json" >"$1/issue_comments.next"
  mv "$1/issue_comments.next" "$1/issue_comments.json"
}
run_v "different full SHA sharing the head prefix" pending "awaiting external review" "$POLICY" s_prefix_collision_cleanext

s_spoofed_cleanext() {
  s_cleanext "$1"
  jq '.[1].user.login = "someone-else"' "$1/issue_comments.json" >"$1/issue_comments.next"
  mv "$1/issue_comments.next" "$1/issue_comments.json"
}
run_v "clean comment from wrong identity" pending "awaiting external review" "$POLICY" s_spoofed_cleanext

s_clean_without_head_request() {
  s_cleanext "$1"
  jq 'del(.[0])' "$1/issue_comments.json" >"$1/issue_comments.next"
  mv "$1/issue_comments.next" "$1/issue_comments.json"
}
run_v "clean result without a full-head review request" pending "awaiting external review" "$POLICY" s_clean_without_head_request

s_clean_before_head_request() {
  s_cleanext "$1"
  jq '.[0].created_at = "2026-08-13T04:00:20Z"' "$1/issue_comments.json" >"$1/issue_comments.next"
  mv "$1/issue_comments.next" "$1/issue_comments.json"
}
run_v "clean result older than the full-head request" pending "awaiting external review" "$POLICY" s_clean_before_head_request

s_old_request_edited_to_current_head() {
  s_cleanext "$1"
  jq '.[0].created_at = "2026-08-13T03:59:00Z" |
      .[0].updated_at = "2026-08-13T04:00:20Z"' \
    "$1/issue_comments.json" >"$1/issue_comments.next"
  mv "$1/issue_comments.next" "$1/issue_comments.json"
}
run_v "editing an old request to the current SHA cannot reuse a prior clean result" pending "awaiting external review" "$POLICY" s_old_request_edited_to_current_head

s_request_and_clean_same_second() {
  s_cleanext "$1"
  jq '.[0].updated_at = .[1].created_at' \
    "$1/issue_comments.json" >"$1/issue_comments.next"
  mv "$1/issue_comments.next" "$1/issue_comments.json"
}
run_v "clean evidence in the request's timestamp second fails closed" pending "awaiting external review" "$POLICY" s_request_and_clean_same_second

s_findings_after_clean() {
  s_cleanext "$1"
  jq -n --arg sha "$SHA" '[{
    user:{login:"chatgpt-codex-connector[bot]"}, state:"COMMENTED", commit_id:$sha,
    submitted_at:"2026-08-13T04:00:20Z"
  }]' >"$1/pr_reviews.json"
}
run_v "later current-head Codex findings invalidate an earlier clean result" pending "awaiting external review" "$POLICY" s_findings_after_clean

s_findings_before_clean() {
  s_cleanext "$1"
  jq -n --arg sha "$SHA" '[{
    user:{login:"chatgpt-codex-connector[bot]"}, state:"COMMENTED", commit_id:$sha,
    submitted_at:"2026-08-13T04:00:05Z"
  }]' >"$1/pr_reviews.json"
}
run_v "a later clean result supersedes earlier current-head findings" success "attested @ ${SHA:0:8}" "$POLICY" s_findings_before_clean

s_wrong_reaction_identity() {
  s_cleanext "$1"
  jq '.[0].user.login = "someone-else"' "$1/pr_reactions.json" >"$1/pr_reactions.next"
  mv "$1/pr_reactions.next" "$1/pr_reactions.json"
}
run_v "thumbs-up from the wrong identity" pending "awaiting external review" "$POLICY" s_wrong_reaction_identity

# A formal review object is not Codex's clean outcome and cannot replace the
# clean-result comment plus PR thumbs-up.
s_formal_approved_ext() {
  write_pr "$1" "cdubiel08" "$(attestation_body "$SHA")" \
    '[{"author":{"login":"app/chatgpt-codex-connector"},"state":"APPROVED"}]'
}
run_v "formal APPROVED Codex review alone" pending "awaiting external review" "$POLICY" s_formal_approved_ext

s_dismissedext() {
  write_pr "$1" "cdubiel08" "$(attestation_body "$SHA")" \
    '[{"author":{"login":"app/chatgpt-codex-connector"},"state":"DISMISSED"}]'
}
run_v "DISMISSED external review" pending "awaiting external review" "$POLICY" s_dismissedext

s_exempt() { write_pr "$1" "app/dependabot" "" "[]"; }
run_v "exempt bot author" success "exempt author" "$POLICY" s_exempt

s_any() { write_pr "$1" "cdubiel08" "" "[]"; }
run_v "no policy file" success "not required" "" s_any

s_garbage() {
  write_pr "$1" "cdubiel08" '<!-- ralph-attestation:v1 -->
```json
{not json
```' "$CODEX"
}
run_v "unparseable payload" failure "unparseable" "$POLICY" s_garbage

# CodeRabbit findings (PR #1602):

# Non-APPROVED verdict must FAIL, not pass on presence
s_rejected() {
  local att
  att=$(attestation_body "$SHA")
  att="${att/APPROVED/REJECTED}"
  write_pr "$1" "cdubiel08" "$att" "$CODEX"
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
