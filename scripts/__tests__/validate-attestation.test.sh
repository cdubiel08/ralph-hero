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
  "api graphql")
    # Findings-mode review threads (resolution state is GraphQL-only). Absent
    # fixture = a PR with no threads.
    if [[ -f "$GH_STUB_DIR/review_threads.json" ]]; then
      cat "$GH_STUB_DIR/review_threads.json"
    else
      echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false},"nodes":[]}}}}}'
    fi
    ;;
  "api repos/"*)
    # The head-bound request comment, and the review objects.
    if [[ "$2" == */issues/*/comments* ]]; then
      f="$GH_STUB_DIR/issue_comments.json"
    else
      f="$GH_STUB_DIR/pr_reviews.json"
    fi
    [[ -f "$f" ]] || echo '[]' >"$f"
    if [[ -n "$jq_expr" ]]; then jq -r "$jq_expr" "$f"; else cat "$f"; fi
    # Payload first, then fail: reproduces a partial/failed paginated fetch and
    # makes the pipefail regression discriminating.
    if [[ -f "$GH_STUB_DIR/gh_api_repos_exit" ]]; then
      exit "$(cat "$GH_STUB_DIR/gh_api_repos_exit")"
    fi
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
    "trigger": "@codex review for P0 issues only",
    "head_marker": "ralph-review-head"
  },
  "exempt_authors": ["dependabot[bot]", "app/dependabot"]
}
EOF

attestation_body() { # attestation_body <sha> [tests_exit] [classes_csv] [base_ref]
  local sha="$1" texit="${2:-0}" classes="${3:-scripts-shell,mcp-ts}" base="${4-main}"
  local classes_json payload
  classes_json=$(jq -n --arg csv "$classes" \
    '[($csv | split(",")[]) | {class: ., reviewed_by: ("adversarial:" + .)}]')
  payload=$(jq -n --arg sha "$sha" --argjson texit "$texit" --argjson classes "$classes_json" \
    --arg base "$base" '{
    version: 1, pr: 123, head_sha: $sha, base_ref: $base,
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
  local codex_evidence=false
  if [[ "$reviews" == "__CODEX_P0_CLEAN__" ]]; then
    reviews='[]'
    codex_evidence=true
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
  # The attestation is read from the PAGINATED issue-comments endpoint
  # (GH-1842), so the fixture must carry it there.
  echo "$comments" >"$dir/issue_comments.json"
  jq -n --arg sha "$SHA" --arg author "$author" \
    --argjson comments "$comments" --argjson reviews "$reviews" --argjson files "$files" \
    '{headRefOid: $sha, baseRefName: ($ENV.PR_BASE_REF // "main"),
      author: {login: $author}, comments: $comments, reviews: $reviews, files: $files}' \
    >"$dir/pr_view.json"
  if [[ "$codex_evidence" == "true" ]]; then
    add_codex_evidence "$dir" "$SHA"
  fi
}

# Findings-mode evidence (GH-1847): a head-bound request, then ONE review by
# the bot at that head. The evidence RULE lives in
# scripts/codex-review-evidence.sh and is exercised case by case in
# merge-pr-gates.test.sh; this suite owns the VERDICT MAPPING — that the
# validator consults it, publishes its detail, and fails closed without it.
add_codex_evidence() { # add_codex_evidence <dir> <head-sha>
  local dir="$1" sha="$2"
  local prior='[]'
  [[ -f "$dir/issue_comments.json" ]] && prior=$(cat "$dir/issue_comments.json")
  # Appended, never overwritten: the attestation comment lives in this same
  # list (GH-1842) and replacing it would hide the evidence under test.
  jq -n --arg sha "$sha" --argjson prior "$prior" '$prior + [
    {user:{login:"cdubiel08"},
     body:("@codex review for P0 issues only\n<!-- ralph-review-head: " + $sha + " -->"),
     created_at:"2026-08-13T04:00:00Z"}
  ]' >"$dir/issue_comments.json"
  jq -n --arg sha "$sha" '[
    {user:{login:"chatgpt-codex-connector[bot]"}, state:"COMMENTED", commit_id:$sha,
     submitted_at:"2026-08-13T04:00:10Z"}
  ]' >"$dir/pr_reviews.json"
}

CODEX='__CODEX_P0_CLEAN__'

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
    RALPH_CODEX_EVIDENCE_SH="${CODEX_EVIDENCE_STUB:-$(dirname "$SCRIPT")/codex-review-evidence.sh}" \
    RALPH_COPILOT_EVIDENCE_SH="${COPILOT_EVIDENCE_STUB:-$(dirname "$SCRIPT")/copilot-review-evidence.sh}" \
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

# GH-1841: retargeting the PR changes what it merges without moving the head.
s_retargeted() {
  PR_BASE_REF="release/2026-08" write_pr "$1" "cdubiel08" "$(attestation_body "$SHA")" "$CODEX"
}
run_v "base retargeted after attesting" pending "re-attest against the current base" "$POLICY" s_retargeted

# An attestation written before the base binding existed cannot answer the
# question, so it gets the same pending + the same remedy — never a pass.
s_no_base() { write_pr "$1" "cdubiel08" "$(attestation_body "$SHA" 0 "scripts-shell,mcp-ts" "")" "$CODEX"; }
run_v "attestation with no base_ref" pending "none recorded" "$POLICY" s_no_base

s_badtests() { write_pr "$1" "cdubiel08" "$(attestation_body "$SHA" 1)" "$CODEX"; }
run_v "failing test evidence" failure "test evidence" "$POLICY" s_badtests

s_undercov() { write_pr "$1" "cdubiel08" "$(attestation_body "$SHA" 0 "scripts-shell")" "$CODEX"; }
run_v "class under-coverage (mcp-ts undeclared)" failure "not covered" "$POLICY" s_undercov

s_noext() { write_pr "$1" "cdubiel08" "$(attestation_body "$SHA")" "[]"; }
run_v "external review absent" pending "no review request at head" "$POLICY" s_noext

s_codexext() {
  write_pr "$1" "cdubiel08" "$(attestation_body "$SHA")" "[]"
  add_codex_evidence "$1" "$SHA"
}
run_v "P0-clean review at the head validates" success "attested @ ${SHA:0:8}" "$POLICY" s_codexext

# The pending DESCRIPTION is the evidence script's own detail, not a generic
# "awaiting review": the status is what an operator reads to know what to do.
s_open_p0() {
  s_codexext "$1"
  jq -n '{data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:false},nodes:[
    {isResolved:false, isOutdated:false, comments:{nodes:[{author:{login:"chatgpt-codex-connector"},
      body:"**![P0 Badge](https://img.shields.io/badge/P0-red)**  Finding", url:"https://x/1"}]}}
  ]}}}}}' >"$1/review_threads.json"
}
run_v "an unresolved P0 finding pends, and says so" pending "unresolved P0 finding" "$POLICY" s_open_p0

# Findings mode with the predicate script absent must FAIL CLOSED — an absent
# checker is not "no external review required".
CODEX_EVIDENCE_STUB=/nonexistent-codex-evidence.sh \
  run_v "findings mode with no evidence script" failure "is missing" "$POLICY" s_codexext

# A predicate that CRASHES is pending, never success: under `set -e` an
# uncaptured failure would exit with no verdict line at all.
CRASHING_EVIDENCE="$TMP_ROOT/crashing-evidence.sh"
printf '#!/usr/bin/env bash\necho "boom"\nexit 3\n' >"$CRASHING_EVIDENCE"
chmod +x "$CRASHING_EVIDENCE"
CODEX_EVIDENCE_STUB="$CRASHING_EVIDENCE" \
  run_v "a crashing evidence script" pending "could not be evaluated" "$POLICY" s_codexext

# --- v1 formal-review policies keep working (codex P2, PR #1839) -----------
POLICY_V1_FORMAL="$TMP_ROOT/policy-v1-formal.json"
cat >"$POLICY_V1_FORMAL" <<'EOF'
{
  "version": 1,
  "attestation": { "required": true },
  "external_review": { "required": true, "bot": "coderabbitai", "trigger": "@coderabbitai review" },
  "exempt_authors": ["dependabot[bot]"]
}
EOF

s_v1_formal_approved() {
  write_pr "$1" "cdubiel08" "$(attestation_body "$SHA")" '[]'
  jq -n --arg sha "$SHA" '[{user:{login:"coderabbitai"}, state:"APPROVED", commit_id:$sha, submitted_at:"2026-08-13T04:00:00Z"}]' \
    >"$1/pr_reviews.json"
}
run_v "v1 formal-review policy validates on an APPROVED review at head" success "attested @ ${SHA:0:8}" "$POLICY_V1_FORMAL" s_v1_formal_approved

s_v1_formal_stale() {
  write_pr "$1" "cdubiel08" "$(attestation_body "$SHA")" '[]'
  echo '[{"user":{"login":"coderabbitai"}, "state":"APPROVED", "commit_id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "submitted_at":"2026-08-13T04:00:00Z"}]' \
    >"$1/pr_reviews.json"
}
run_v "v1 formal-review policy pends on an APPROVED review at an OLD head" pending "awaiting external review" "$POLICY_V1_FORMAL" s_v1_formal_stale

# --- API outage must stay retry-able, not read as missing evidence ---------
# The stub prints valid evidence AND exits non-zero; without pipefail the
# validator would trust it and publish success.
s_ext_api_outage() {
  s_codexext "$1"
  echo "1" >"$1/gh_api_repos_exit"
}
run_v "a failing external-evidence fetch" pending "retry" "$POLICY" s_ext_api_outage

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

# --- GH-1842: the attestation is read from the PAGINATED comment list -------
# The old read was `gh pr view --json comments`, a bounded window: on a PR with
# more comments than it returns, a VALID attestation fell outside it and this
# validator published a red status for evidence that exists. The fixture below
# is that PR — the attestation lives ONLY on the paginated endpoint.
s_paginated_only() {
  write_pr "$1" "cdubiel08" "$(attestation_body "$SHA")" "$CODEX"
  jq '.comments = []' "$1/pr_view.json" >"$1/pr_view.next"
  mv "$1/pr_view.next" "$1/pr_view.json"
}
run_v "an attestation outside the PR-view window still validates" \
  success "attested @ ${SHA:0:8}" "$POLICY" s_paginated_only

# An unreadable comment list is PENDING, never "awaiting attestation": a failed
# read and an absent attestation have different correct responses, and calling
# the first the second publishes a status that demands work already done.
s_comments_unreadable() {
  write_pr "$1" "cdubiel08" "$(attestation_body "$SHA")" "$CODEX"
  echo "1" >"$1/gh_api_repos_exit"
}
run_v "an unreadable comment list is not an absent attestation" \
  pending "cannot read the comments" "$POLICY" s_comments_unreadable

# --- request-mode dispatch (GH-2087) ----------------------------------------
# Same dispatch merge-pr.sh gate 5 makes: a review-request policy runs the
# Copilot predicate. Discriminating stubs — the other protocol's crashes.
COPILOT_POLICY="$TMP_ROOT/copilot-policy.json"
cat >"$COPILOT_POLICY" <<'EOF'
{ "attestation": { "required": true },
  "external_review": { "required": true, "request_mode": "review-request" } }
EOF
PASSING_EVIDENCE="$TMP_ROOT/passing-evidence.sh"
printf '#!/usr/bin/env bash\necho %s\n' \
  "'{\"ok\":true,\"turn\":\"\",\"detail\":\"stub ok\",\"reviewer\":\"copilot-pull-request-reviewer[bot]\",\"review_url\":\"\"}'" \
  >"$PASSING_EVIDENCE"
chmod +x "$PASSING_EVIDENCE"
CRASH_IF_INVOKED="$TMP_ROOT/crash-if-invoked.sh"
printf '#!/usr/bin/env bash\nexit 9\n' >"$CRASH_IF_INVOKED"
chmod +x "$CRASH_IF_INVOKED"

s_copilot() { write_pr "$1" "cdubiel08" "$(attestation_body "$SHA")" "[]"; }
COPILOT_EVIDENCE_STUB="$PASSING_EVIDENCE" CODEX_EVIDENCE_STUB="$CRASH_IF_INVOKED" \
  run_v "review-request policy runs the Copilot predicate" \
  success "attested @ ${SHA:0:8}" "$COPILOT_POLICY" s_copilot
COPILOT_EVIDENCE_STUB="$CRASH_IF_INVOKED" \
  run_v "…and a failing Copilot predicate is pending, not the Codex path" \
  pending "could not be evaluated" "$COPILOT_POLICY" s_copilot
COPILOT_EVIDENCE_STUB=/nonexistent-copilot-evidence.sh \
  run_v "review-request mode with no evidence script is a failure" \
  failure "is missing" "$COPILOT_POLICY" s_copilot

echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
