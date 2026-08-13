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
  "pr view")
    if [[ -f "$GH_STUB_DIR/merge_attempted" && -f "$GH_STUB_DIR/pr_view_after.json" ]]; then
      serve pr_view_after.json
    else
      serve pr_view.json
    fi
    ;;
  "pr checks")
    if [[ -f "$GH_STUB_DIR/pr_checks.json" ]]; then cat "$GH_STUB_DIR/pr_checks.json"; else echo "[]"; fi
    exit "${GH_STUB_CHECKS_EXIT:-0}"
    ;;
  "pr comment")
    for ((i = 0; i < ${#args[@]}; i++)); do
      if [[ "${args[$i]}" == "--body" ]]; then printf '%s\n---\n' "${args[$((i + 1))]}" >>"$GH_STUB_DIR/comments.log"; fi
    done
    ;;
  "pr merge")
    touch "$GH_STUB_DIR/merge_attempted"
    echo "merged"
    exit "${GH_STUB_MERGE_EXIT:-0}"
    ;;
  "api user") if [[ -n "$jq_expr" ]]; then echo "testuser"; else echo '{"login":"testuser"}'; fi ;;
  "api repos/"*)
    # Gate 5 reads review findings, clean-result comments, and PR reactions.
    if [[ "$2" == */issues/*/comments ]]; then
      reviews_file="$GH_STUB_DIR/issue_comments.json"
    elif [[ "$2" == */issues/*/reactions ]]; then
      reviews_file="$GH_STUB_DIR/pr_reactions.json"
    else
      reviews_file="$GH_STUB_DIR/pr_reviews.json"
    fi
    [[ -f "$reviews_file" ]] || echo '[]' >"$reviews_file"
    if [[ -n "$jq_expr" ]]; then jq -r "$jq_expr" "$reviews_file"; else cat "$reviews_file"; fi
    # Emit the payload FIRST, then fail: this reproduces a partial/failed
    # paginated fetch, and is what makes the pipefail regression discriminating
    # (a stub that printed nothing would pass with or without pipefail).
    if [[ -f "$GH_STUB_DIR/gh_api_repos_exit" ]]; then
      exit "$(cat "$GH_STUB_DIR/gh_api_repos_exit")"
    fi
    ;;
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
  "external_review": {
    "required": true,
    "bot": "chatgpt-codex-connector[bot]",
    "trigger": "@codex review",
    "head_marker": "ralph-review-head",
    "clean_comment_marker": "Codex Review: Didn't find any major issues."
  },
  "exempt_authors": ["dependabot[bot]", "app/dependabot", "github-actions[bot]"]
}
EOF

good_attestation_body() { # good_attestation_body <head_sha> [tests_exit] [verdict]
  local sha="$1" texit="${2:-0}" verdict="${3:-APPROVED}"
  local payload
  payload=$(jq -n --arg sha "$sha" --argjson texit "$texit" --arg v "$verdict" '{
    version: 1, pr: 123, head_sha: $sha,
    tests: [{command: "npm test", exit_code: $texit, summary: "ok"}],
    review: {verdict: $v, reviewer: "ralph:review-agent", mode: "internal"}
  }')
  # shellcheck disable=SC2016  # literal markdown code fence, no expansion wanted
  printf '<!-- ralph-attestation:v1 -->\n## Merge Attestation\n\n```json\n%s\n```\n' "$payload"
}

# write_pr_view <dir> <reviewDecision> <mergeable> <author> <att_body|""> <reviews_json> [extra_comment]
# reviews_json is REST-shaped ({user:{login},state,commit_id}) and is served to
# gate 5 via the `gh api .../reviews` stub branch.
write_pr_view() {
  local dir="$1" decision="$2" mergeable="$3" author="$4" att="$5" reviews="$6" extra="${7:-}"
  local clean_evidence=false
  if [[ "$reviews" == "__CLEAN_CODEX__" ]]; then
    reviews='[]'
    clean_evidence=true
  fi
  echo "$reviews" >"$dir/pr_reviews.json"
  echo '[]' >"$dir/issue_comments.json"
  echo '[]' >"$dir/pr_reactions.json"
  local comments='[]'
  if [[ -n "$att" ]]; then
    comments=$(jq -n --arg b "$att" '[{body: $b}]')
  fi
  if [[ -n "$extra" ]]; then
    comments=$(jq -n --argjson c "$comments" --arg b "$extra" '$c + [{body: $b}]')
  fi
  jq -n \
    --arg decision "$decision" --arg mergeable "$mergeable" \
    --arg author "$author" --arg sha "$SHA" \
    --argjson comments "$comments" --argjson reviews "$reviews" \
    '{state: "OPEN", mergeable: $mergeable, headRefOid: $sha,
      reviewDecision: $decision, author: {login: $author},
      headRefName: "feature/GH-9999", comments: $comments, reviews: $reviews}' \
    >"$dir/pr_view.json"
  if [[ "$clean_evidence" == "true" ]]; then
    add_clean_codex_evidence "$dir" "$SHA"
  fi
}

# CODEX_CLEAN_BODY is the VERBATIM body Codex posts on a clean review, copied
# from the live comment on PR #1830 (2026-08-13). Do not "tidy" it.
#
# The previous fixture used an idealized one-line paraphrase, and that is
# precisely why the original parser bug shipped: the real body carries a
# "**Reviewed commit:** `<10-char-sha>`" line whose `:** ` separator and
# 10-char SHA both defeated the `Reviewed commit <7-sha>([^0-9A-Fa-f]|$)`
# regex on main, so a CLEAN review could never satisfy gate 5 while a review
# WITH findings could. A fixture that does not match what the server actually
# sends proves nothing about the gate.
CODEX_CLEAN_BODY='Codex Review: Didn'"'"'t find any major issues. More of your lovely PRs please.

**Reviewed commit:** `8430effbdd`

<details> <summary>ℹ️ About Codex in GitHub</summary>

[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you
- Open a pull request for review
- Mark a draft as ready
- Comment "@codex review".

If Codex has suggestions, it will comment; otherwise it will react with 👍.
</details>'

add_clean_codex_evidence() { # add_clean_codex_evidence <dir> <head-sha>
  local dir="$1" sha="$2"
  jq -n --arg sha "$sha" --arg clean "$CODEX_CLEAN_BODY" '[
    {user:{login:"cdubiel08"}, body:("@codex review\n<!-- ralph-review-head: " + $sha + " -->"), created_at:"2026-08-13T04:00:00Z"},
    {user:{login:"chatgpt-codex-connector[bot]"}, body:$clean, created_at:"2026-08-13T04:00:10Z"}
  ]' >"$dir/issue_comments.json"
  # No reaction fixture: PR-level reactions are deliberately NOT evidence
  # (codex P1 + CodeRabbit, PR #1839). Kept empty so a regression that starts
  # reading them again fails these tests instead of passing on stale data.
  echo '[]' >"$dir/pr_reactions.json"
}

GREEN_CHECKS='[{"name":"test-hooks","bucket":"pass"},{"name":"lint","bucket":"skipping"}]'
# A clean Codex outcome is not a formal review object. The sentinel asks the
# fixture writer to install the clean comment + PR-level thumbs-up evidence.
CODEX_REVIEWS='__CLEAN_CODEX__'
COMMENTED_REVIEWS=$(jq -nc --arg sha "$SHA" \
  '[{user: {login: "chatgpt-codex-connector[bot]"}, state: "COMMENTED", commit_id: $sha,
      submitted_at: "2026-08-13T04:00:05Z"}]')
APPROVED_REVIEWS=$(jq -nc --arg sha "$SHA" \
  '[{user: {login: "chatgpt-codex-connector[bot]"}, state: "APPROVED", commit_id: $sha,
      submitted_at: "2026-08-13T04:00:05Z"}]')
DISMISSED_REVIEWS=$(jq -nc --arg sha "$SHA" \
  '[{user: {login: "chatgpt-codex-connector[bot]"}, state: "DISMISSED", commit_id: $sha,
      submitted_at: "2026-08-13T04:00:05Z"}]')
# A rate-limited reviewer publishes bucket=pass with a truthful DESCRIPTION.
RATE_LIMITED_CHECKS='[{"name":"test-hooks","bucket":"pass","description":""},
  {"name":"Codex","bucket":"pass","description":"Review rate limited"}]'

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
    RALPH_APPLY_KEYWORDS_SH="${APPLY_KEYWORDS_STUB:-/nonexistent-apply-keywords.sh}" \
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
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "$CODEX_REVIEWS"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "green path merges" 0 "$POLICY" setup_green
expect_out "green path emits PASS" "MERGE GATE PASS"
expect_merged "green path"

# 2. CHANGES_REQUESTED blocks, even with --force
setup_cr() {
  write_pr_view "$1" "CHANGES_REQUESTED" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "$CODEX_REVIEWS"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "CHANGES_REQUESTED blocks" 1 "$POLICY" setup_cr
expect_out "CR names review gate" "MERGE GATE FAIL — review"
expect_not_merged "CHANGES_REQUESTED"
run_case "CHANGES_REQUESTED blocks despite --force" 1 "$POLICY" setup_cr --force "emergency"
expect_not_merged "CHANGES_REQUESTED + force"

# 3. Pending check is PENDING (75), not FAIL — still building is not red.
setup_pending() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "$CODEX_REVIEWS"
  echo '[{"name":"build","bucket":"pending"}]' >"$1/pr_checks.json"
}
run_case "pending checks are retry-able, not failure" 75 "$POLICY" setup_pending
expect_out "pending emits PENDING token" "MERGE GATE PENDING — checks"
expect_out "pending names the check" "still running: build"
expect_not_merged "pending checks"

# 3b. --force merges through still-running checks (override stays possible)
run_case "--force merges through pending checks" 0 "$POLICY" setup_pending --force "ship it"
expect_merged "--force pending checks"

# 4. Failing check blocks and is named
setup_failing() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "$CODEX_REVIEWS"
  echo '[{"name":"test-hooks","bucket":"fail"},{"name":"lint","bucket":"pass"}]' >"$1/pr_checks.json"
}
run_case "failing check blocks" 1 "$POLICY" setup_failing
expect_out "failing check named" "test-hooks=fail"

# 5. ralph-attestation status context is excluded from gate 3
setup_att_ctx() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "$CODEX_REVIEWS"
  echo '[{"name":"test-hooks","bucket":"pass"},{"name":"ralph-attestation","bucket":"pending"}]' >"$1/pr_checks.json"
}
run_case "ralph-attestation context excluded from checks gate" 0 "$POLICY" setup_att_ctx

# 6. Missing attestation blocks
setup_no_att() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "" "$CODEX_REVIEWS"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "missing attestation blocks" 1 "$POLICY" setup_no_att
expect_out "attestation gate named" "MERGE GATE FAIL — attestation"

# 7. head_sha mismatch blocks (attest-then-push laundering)
setup_stale_att() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")" "$CODEX_REVIEWS"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "stale attestation (head_sha mismatch) blocks" 1 "$POLICY" setup_stale_att
expect_out "mismatch tells re-attest" "re-attest after the latest push"

# 8. Non-zero test exit in attestation blocks
setup_bad_tests() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA" 1)" "$CODEX_REVIEWS"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "failing test evidence blocks" 1 "$POLICY" setup_bad_tests
expect_out "test evidence named" "passing test evidence"

# 9. Missing external review is PENDING (75) — gate 1 already caught
#    CHANGES_REQUESTED, so "no review" is "not yet", never a negative verdict.
setup_no_ext() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "[]"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "missing external review is retry-able, not failure" 75 "$POLICY" setup_no_ext
expect_out "external gate emits PENDING" "MERGE GATE PENDING — external-review"
expect_out "external gate names the trigger" "@codex review"
expect_not_merged "missing external review"

# A clean Codex result is a clean bot comment plus a PR-level thumbs-up, not a
# formal GitHub APPROVED review.
setup_clean_ext() {
  setup_no_ext "$1"
  add_clean_codex_evidence "$1" "$SHA"
}
run_case "clean bot comment at the head satisfies gate 5" 0 "$POLICY" setup_clean_ext
expect_merged "clean external-review evidence"

# The reaction is NOT evidence (codex P1 + CodeRabbit, PR #1839). Requiring it
# reintroduced the permanent-pending bug class one layer up: a reaction fires
# no workflow event, so a clean comment observed before the reaction published
# a `pending` nothing would recompute. This pins the decision — with the
# reaction absent entirely, a clean comment still merges.
setup_clean_no_reaction_at_all() {
  setup_clean_ext "$1"
  echo '[]' >"$1/pr_reactions.json"
}
run_case "clean comment merges with NO reaction present at all" 0 "$POLICY" setup_clean_no_reaction_at_all
expect_merged "clean comment without any reaction"

# The other half of dropping reactions: a stale reaction cannot resurrect
# missing comment evidence. GitHub keeps PR-level reactions across pushes, so
# had they stayed evidence, one earned at an old head would satisfy a new one.
setup_stale_reaction_no_clean() {
  setup_no_ext "$1"
  echo '[{"user":{"login":"chatgpt-codex-connector[bot]"},"content":"+1","created_at":"2020-01-01T00:00:00Z"}]' \
    >"$1/pr_reactions.json"
}
run_case "a stale thumbs-up alone never satisfies gate 5" 75 "$POLICY" setup_stale_reaction_no_clean
expect_not_merged "stale reaction without clean comment"

setup_commented_ext() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "$COMMENTED_REVIEWS"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "current-head COMMENTED Codex review is findings, not approval" 75 "$POLICY" setup_commented_ext
expect_not_merged "COMMENTED Codex findings"

setup_stale_clean_ext() {
  setup_clean_ext "$1"
  jq --arg stale "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" \
    '.[0].body = ("@codex review\n<!-- ralph-review-head: " + $stale + " -->")' \
    "$1/issue_comments.json" >"$1/issue_comments.next"
  mv "$1/issue_comments.next" "$1/issue_comments.json"
}
run_case "clean result requested for a stale full SHA does not satisfy gate 5" 75 "$POLICY" setup_stale_clean_ext

setup_prefix_collision_clean_ext() {
  setup_clean_ext "$1"
  jq --arg stale "${SHA:0:39}b" \
    '.[0].body = ("@codex review\n<!-- ralph-review-head: " + $stale + " -->")' \
    "$1/issue_comments.json" >"$1/issue_comments.next"
  mv "$1/issue_comments.next" "$1/issue_comments.json"
}
run_case "different full SHA sharing the head prefix does not satisfy gate 5" 75 "$POLICY" setup_prefix_collision_clean_ext

setup_spoofed_clean_ext() {
  setup_clean_ext "$1"
  jq '.[1].user.login = "someone-else"' "$1/issue_comments.json" >"$1/issue_comments.next"
  mv "$1/issue_comments.next" "$1/issue_comments.json"
}
run_case "clean comment from wrong identity does not satisfy gate 5" 75 "$POLICY" setup_spoofed_clean_ext

setup_clean_without_head_request() {
  setup_clean_ext "$1"
  jq 'del(.[0])' "$1/issue_comments.json" >"$1/issue_comments.next"
  mv "$1/issue_comments.next" "$1/issue_comments.json"
}
run_case "clean result without a full-head review request stays pending" 75 "$POLICY" setup_clean_without_head_request

setup_clean_before_head_request() {
  setup_clean_ext "$1"
  jq '.[0].created_at = "2026-08-13T04:00:20Z"' "$1/issue_comments.json" >"$1/issue_comments.next"
  mv "$1/issue_comments.next" "$1/issue_comments.json"
}
run_case "clean result older than the full-head request stays pending" 75 "$POLICY" setup_clean_before_head_request

setup_old_request_edited_to_current_head() {
  setup_clean_ext "$1"
  jq '.[0].created_at = "2026-08-13T03:59:00Z" |
      .[0].updated_at = "2026-08-13T04:00:20Z"' \
    "$1/issue_comments.json" >"$1/issue_comments.next"
  mv "$1/issue_comments.next" "$1/issue_comments.json"
}
run_case "editing an old request to the current SHA cannot reuse a prior clean result" 75 "$POLICY" setup_old_request_edited_to_current_head

setup_request_and_clean_same_second() {
  setup_clean_ext "$1"
  jq '.[0].updated_at = .[1].created_at' \
    "$1/issue_comments.json" >"$1/issue_comments.next"
  mv "$1/issue_comments.next" "$1/issue_comments.json"
}
run_case "clean evidence in the request's timestamp second fails closed" 75 "$POLICY" setup_request_and_clean_same_second

setup_findings_after_clean() {
  setup_clean_ext "$1"
  jq -n --arg sha "$SHA" '[{
    user:{login:"chatgpt-codex-connector[bot]"}, state:"COMMENTED", commit_id:$sha,
    submitted_at:"2026-08-13T04:00:20Z"
  }]' >"$1/pr_reviews.json"
}
run_case "later current-head Codex findings invalidate an earlier clean result" 75 "$POLICY" setup_findings_after_clean

setup_findings_before_clean() {
  setup_clean_ext "$1"
  jq -n --arg sha "$SHA" '[{
    user:{login:"chatgpt-codex-connector[bot]"}, state:"COMMENTED", commit_id:$sha,
    submitted_at:"2026-08-13T04:00:05Z"
  }]' >"$1/pr_reviews.json"
}
run_case "a later clean result supersedes earlier current-head findings" 0 "$POLICY" setup_findings_before_clean

# --- v1 policies that name a formal-review bot (codex P2, PR #1839) --------
# A policy declaring NEITHER marker is in `review` mode: an APPROVED review at
# the current head satisfies gate 5, exactly as before comment mode existed.
# Without this, upgrading silently handed CodeRabbit repos Codex's protocol and
# made them unmergeable.
POLICY_V1_FORMAL="$TMP_ROOT/policy-v1-formal.json"
cat >"$POLICY_V1_FORMAL" <<'EOF'
{
  "version": 1,
  "attestation": { "required": true },
  "external_review": { "required": true, "bot": "coderabbitai", "trigger": "@coderabbitai review" },
  "exempt_authors": ["dependabot[bot]"]
}
EOF

setup_v1_formal_approved() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" \
    "$(jq -nc --arg sha "$SHA" '[{user:{login:"coderabbitai"}, state:"APPROVED", commit_id:$sha, submitted_at:"2026-08-13T04:00:00Z"}]')"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "v1 formal-review policy merges on an APPROVED review at head" 0 "$POLICY_V1_FORMAL" setup_v1_formal_approved
expect_merged "v1 formal-review APPROVED"

setup_v1_formal_stale_approved() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" \
    '[{"user":{"login":"coderabbitai"}, "state":"APPROVED", "commit_id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "submitted_at":"2026-08-13T04:00:00Z"}]'
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "v1 formal-review policy stays pending on an APPROVED review at an OLD head" 75 "$POLICY_V1_FORMAL" setup_v1_formal_stale_approved
expect_not_merged "v1 formal-review stale APPROVED"

setup_v1_formal_none() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" '[]'
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "v1 formal-review policy stays pending with no review" 75 "$POLICY_V1_FORMAL" setup_v1_formal_none
expect_out "review-mode pending names the formal-review remedy" "no current APPROVED"

# A half-configured comment protocol is unsatisfiable, not strict — say so.
POLICY_HALF_MARKER="$TMP_ROOT/policy-half-marker.json"
cat >"$POLICY_HALF_MARKER" <<'EOF'
{
  "version": 1,
  "attestation": { "required": true },
  "external_review": { "required": true, "bot": "coderabbitai", "trigger": "@x", "head_marker": "ralph-review-head" },
  "exempt_authors": []
}
EOF
run_case "policy declaring only one marker is refused" 1 "$POLICY_HALF_MARKER" setup_clean_ext
expect_out "half-marker policy names the missing half" "comment-evidence mode needs both"

# --- API outage must not read as "no evidence yet" (CodeRabbit, PR #1839) ---
# Discriminating fixture: the stub prints VALID clean evidence AND exits 1.
# Without `set -o pipefail`, `if ! x=$(gh api ... | jq ...)` records jq's exit
# 0, external_fetch_ok stays true, the good payload is trusted and the PR
# MERGES on evidence fetched from a failed call. With pipefail the pipeline
# reports gh's failure and the gate stays retry-able.
setup_ext_api_outage() {
  setup_clean_ext "$1"
  echo "1" >"$1/gh_api_repos_exit"
}
run_case "a failing external-evidence fetch is retry-able, never trusted" 75 "$POLICY" setup_ext_api_outage
expect_not_merged "external evidence fetched from a failing API call"

# 9a-bis. The SAME fixture under `external_review.required: false` — the branch
#         a repo without a review bot actually runs on (GH-1831). Every other
#         policy fixture in this file pins `required: true`, so without this the
#         disabled path ships with zero coverage and only inspection behind it.
#         `--force` and exempt-author skip gate 5 by a different predicate, so
#         neither one covers this.
POLICY_NO_EXT="$TMP_ROOT/policy-no-ext.json"
cat >"$POLICY_NO_EXT" <<'EOF'
{
  "version": 1,
  "attestation": { "required": true },
  "external_review": { "required": false, "bot": "chatgpt-codex-connector[bot]", "trigger": "@codex review" },
  "exempt_authors": ["dependabot[bot]", "app/dependabot", "github-actions[bot]"]
}
EOF
expect_absent() { # expect_absent <desc> <grep-pattern>
  if grep -qF "$2" <<<"$LAST_OUT"; then fail "$1 — unexpected '$2' in: $LAST_OUT"; else pass "$1"; fi
}
run_case "external_review.required=false: no review is not a gate" 0 "$POLICY_NO_EXT" setup_no_ext
expect_out "no-external policy still reaches PASS" "MERGE GATE PASS"
expect_absent "no-external policy emits no external-review token" "external-review"
expect_absent "no-external policy does not name the bot trigger" "@codex review"
expect_merged "external_review.required=false"

# 9b. Codex does not use formal GitHub APPROVED reviews for clean outcomes;
#     that object alone is not a substitute for clean comment + thumbs-up.
setup_formal_approved_ext() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "$APPROVED_REVIEWS"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "formal APPROVED Codex review alone does not satisfy gate 5" 75 "$POLICY" setup_formal_approved_ext
expect_not_merged "formal Codex approval without clean evidence"

# 9c. A DISMISSED review does not count (PR #1685 had exactly this shape).
setup_dismissed_ext() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "$DISMISSED_REVIEWS"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "DISMISSED external review does not satisfy gate 5" 75 "$POLICY" setup_dismissed_ext
expect_not_merged "dismissed external review"

# 9d. Rate-limited reviewer is named explicitly — the operator needs to know
#     it is a quota wait, not a silent skip. Read from the check DESCRIPTION:
#     the state says SUCCESS while no review was filed at all.
setup_rate_limited() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "[]"
  echo "$RATE_LIMITED_CHECKS" >"$1/pr_checks.json"
}
run_case "rate-limited external reviewer is PENDING" 75 "$POLICY" setup_rate_limited
expect_out "rate limit named" "rate-limited"
expect_out "rate limit cites the check" "Codex"
expect_not_merged "rate-limited reviewer"

# 9f. A passing reviewer check must NOT be read as a review — state lies.
#     (The rate-limited check is bucket=pass, so gate 3 sees nothing wrong.)
run_case "reviewer check passing is not evidence of a review" 75 "$POLICY" setup_rate_limited

# 9g. A policy-supplied bot name is DATA, not jq program text. It used to be
#     interpolated into the filter, so `x" or true or "` neutralised the
#     identity check and ANY review counted — including the author's own.
#     That defeats the whole point of an *independent* reviewer gate.
#     Verified exploitable against the pre-fix filter, which returned 1 for
#     the fixture below; the bound form returns 0 (CodeRabbit, PR #1689).
INJECT_POLICY="$TMP_ROOT/inject-policy.json"
cat >"$INJECT_POLICY" <<'EOF'
{
  "version": 1,
  "attestation": { "required": true },
  "external_review": { "required": true, "bot": "x\" or true or \"" },
  "exempt_authors": []
}
EOF
setup_inject() {
  # Only a SELF-review at the head — no bot review anywhere.
  local self_review
  self_review=$(jq -nc --arg sha "$SHA" \
    '[{user: {login: "cdubiel08"}, state: "APPROVED", commit_id: $sha}]')
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "$self_review"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "hostile policy bot name cannot make a self-review count as external" 75 "$INJECT_POLICY" setup_inject
expect_not_merged "jq injection attempt"

# 9e. --force still overrides a missing external review
run_case "--force merges without external review" 0 "$POLICY" setup_no_ext --force "reviewer down"
expect_merged "--force no external review"

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
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "$CODEX_REVIEWS"
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
  write_pr_view "$1" "" "CONFLICTING" "cdubiel08" "$(good_attestation_body "$SHA")" "$CODEX_REVIEWS"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "CONFLICTING blocks" 1 "$POLICY" setup_conflicting
run_case "CONFLICTING blocks despite --force" 1 "$POLICY" setup_conflicting --force "try anyway"
expect_not_merged "CONFLICTING + force"

# 17. Non-APPROVED attestation verdict blocks (CodeRabbit, PR #1602)
setup_rejected() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA" 0 "REJECTED")" "$CODEX_REVIEWS"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "REJECTED attestation verdict blocks" 1 "$POLICY" setup_rejected
expect_out "non-APPROVED verdict named" "not APPROVED"
expect_not_merged "REJECTED verdict"

# 18. Malformed policy file fails CLOSED (CodeRabbit, PR #1602)
BAD_POLICY="$TMP_ROOT/bad-policy.json"
echo '{ not json' >"$BAD_POLICY"
run_case "malformed policy fails closed" 1 "$BAD_POLICY" setup_green
expect_out "policy gate named" "MERGE GATE FAIL — policy"
expect_not_merged "malformed policy"

# 19. Merge is pinned to the gated head SHA (TOCTOU; CodeRabbit, PR #1602)
run_case "green path pins merge to head sha" 0 "$POLICY" setup_green
if grep -q -- "--match-head-commit $SHA" "$LAST_DIR/gh.log" 2>/dev/null; then
  pass "merge invoked with --match-head-commit \$head_sha"
else
  fail "merge missing --match-head-commit pin: $(grep 'pr merge' "$LAST_DIR/gh.log" 2>/dev/null)"
fi

# 20. GH-1677: gh pr merge exits nonzero on LOCAL branch cleanup (main held by
# a sibling worktree) AFTER the remote merge succeeded — the PR state is the
# truth, so the script must re-query and succeed.
setup_worktree_cleanup_fail() {
  setup_green "$1"
  printf '{"state":"MERGED"}' >"$1/pr_view_after.json"
}
GH_STUB_MERGE_EXIT=1 run_case "worktree cleanup failure is not a merge failure" 0 "$POLICY" setup_worktree_cleanup_fail
expect_out "worktree cleanup skip is loud" "local branch cleanup skipped"

# 21. GH-1677 inverse: a merge that ACTUALLY failed (PR still open) stays a failure.
setup_merge_actually_failed() {
  setup_green "$1"
  printf '{"state":"OPEN"}' >"$1/pr_view_after.json"
}
GH_STUB_MERGE_EXIT=1 run_case "genuine merge failure still fails" 1 "$POLICY" setup_merge_actually_failed
expect_out "genuine failure names the state" "MERGE FAILED"

# 22. Worktree cleanup is not limited to feature/GH-* branches, and resolves
#     worktree dirs under the MAIN checkout rather than $PROJECT_ROOT (which
#     inside a worktree is that worktree — so cleanup used to be a no-op in
#     the worktree-per-job flow).
setup_wt() { # setup_wt <dir> — caller sets $WT_ROOT and the branch
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "$CODEX_REVIEWS"
  jq --arg b "$WT_BRANCH" '.headRefName = $b' "$1/pr_view.json" >"$1/pr_view.tmp" \
    && mv "$1/pr_view.tmp" "$1/pr_view.json"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}

WT_ROOT="$TMP_ROOT/wtroot"
WT_BRANCH="claude/some-task"
mkdir -p "$WT_ROOT/.claude/worktrees/some-task"
export RALPH_WORKTREE_ROOT="$WT_ROOT"
run_case "non-feature branch worktree is cleaned up" 0 "$POLICY" setup_wt
if [[ -d "$WT_ROOT/.claude/worktrees/some-task" ]]; then
  fail "non-feature worktree still present after merge"
else
  pass "non-feature worktree removed"
fi

# 23. The tree we are RUNNING FROM is never removed — the rm -rf fallback
#     would delete the running script's own checkout.
WT_BRANCH="claude/self"
mkdir -p "$WT_ROOT/worktrees"
ln -sfn "$REPO_ROOT" "$WT_ROOT/worktrees/self"
run_case "current working tree is never removed" 0 "$POLICY" setup_wt
expect_out "self-removal refused loudly" "is the current working tree"
if [[ -d "$REPO_ROOT/scripts" ]]; then
  pass "current checkout intact"
else
  fail "current checkout was damaged"
fi
rm -f "$WT_ROOT/worktrees/self"

# 24. A branch whose last segment escapes the base is rejected outright.
WT_BRANCH="evil/.."
run_case "path-traversal worktree id rejected" 0 "$POLICY" setup_wt
if grep -qF "Removing worktree" <<<"$LAST_OUT"; then
  fail "traversal id reached removal"
else
  pass "traversal id rejected before removal"
fi
unset RALPH_WORKTREE_ROOT

# 25. Run from a SUBDIRECTORY: --git-common-dir returns a cwd-relative path
#     ("../.git" from <root>/scripts), so resolving it against $PROJECT_ROOT
#     put MAIN_ROOT at the repo's PARENT — and that is where `rm -rf` pointed.
#     Uses a real throwaway repo so the assertion holds anywhere, not only
#     when the suite happens to run inside a git worktree.
TREPO="$TMP_ROOT/trepo"
mkdir -p "$TREPO/sub" "$TREPO/worktrees/some-task" "$TMP_ROOT/worktrees/some-task"
git -C "$TREPO" init -q 2>/dev/null

setup_subdir() {
  write_pr_view "$1" "" "MERGEABLE" "cdubiel08" "$(good_attestation_body "$SHA")" "$CODEX_REVIEWS"
  jq '.headRefName = "claude/some-task"' "$1/pr_view.json" >"$1/pr_view.tmp" \
    && mv "$1/pr_view.tmp" "$1/pr_view.json"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
dir="$TMP_ROOT/case-subdir"
mkdir -p "$dir"
GH_STUB_DIR="$dir" setup_subdir "$dir"
set +e
(cd "$TREPO/sub" && PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$dir" GH_STUB_LOG="$dir/gh.log" \
  RALPH_MERGE_POLICY_FILE="$POLICY" bash "$SCRIPT" 123 >/dev/null 2>&1)
set -e
if [[ -d "$TMP_ROOT/worktrees/some-task" ]]; then
  pass "subdir cwd: path outside the repo is untouched"
else
  fail "subdir cwd: removed a directory OUTSIDE the repository"
fi
if [[ -d "$TREPO/worktrees/some-task" ]]; then
  fail "subdir cwd: in-repo worktree not cleaned up"
else
  pass "subdir cwd: in-repo worktree cleaned up"
fi

# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Gate 6: apply-keyword hygiene (GH-1694)
#
# The checker itself is covered by apply-keywords.test.sh; what is pinned here
# is the WIRING — that merge-pr.sh honours its verdict, that a missing checker
# is not an error (host repos vendoring merge-pr.sh without it), and that
# --force can override it loudly like every other evidence gate.
# ---------------------------------------------------------------------------
echo
echo "=== gate 6: apply-keyword hygiene ==="

APPLY_STUB_DIR="$TMP_ROOT/apply-stub"
mkdir -p "$APPLY_STUB_DIR"
cat >"$APPLY_STUB_DIR/pass.sh" <<'AK'
#!/usr/bin/env bash
echo "APPLY KEYWORDS PASS — PR #$1 closes no issues"
exit 0
AK
cat >"$APPLY_STUB_DIR/fail.sh" <<'AK'
#!/usr/bin/env bash
echo "APPLY KEYWORDS FAIL — PR #$1 carries a closing keyword binding apply-kind issue(s) #1696."
echo "  Merging is not applying."
exit 1
AK
chmod +x "$APPLY_STUB_DIR"/*.sh

APPLY_KEYWORDS_STUB="$APPLY_STUB_DIR/pass.sh"
run_case "gate 6: a passing checker does not block a green PR" 0 "$POLICY" setup_green
expect_merged "gate 6 pass"
expect_out "gate 6 pass: the verdict is echoed" "APPLY KEYWORDS PASS"

APPLY_KEYWORDS_STUB="$APPLY_STUB_DIR/fail.sh"
run_case "gate 6: a failing checker BLOCKS an otherwise-green PR" 1 "$POLICY" setup_green
expect_not_merged "gate 6 fail"
expect_out "gate 6 fail: names the gate" "MERGE GATE FAIL — apply-keywords"
expect_out "gate 6 fail: carries the checker's first line as the reason" "binding apply-kind issue(s) #1696"
expect_out "gate 6 fail: the operator remedy is printed too" "Merging is not applying."

run_case "gate 6: --force overrides it loudly, like every other evidence gate" 0 "$POLICY" setup_green \
  --force "shipping the gate that would refuse this"
expect_merged "gate 6 force"
expect_out "gate 6 force: warns rather than silently skipping" "MERGE GATE WARN — apply-keywords skipped by --force"

APPLY_KEYWORDS_STUB=""
run_case "gate 6: absent checker is not an error (host repos without it)" 0 "$POLICY" setup_green
expect_merged "gate 6 absent"

# ---------------------------------------------------------------------------
# --dry-run (GH-1712, D8): same tokens, same exit codes, provably no mutation.
# The verdict is the LAST `MERGE GATE` line plus the exit code; WARN lines are
# non-terminal advisories. One sanctioned divergence: gate 2 single-attempts
# and maps UNKNOWN to PENDING — mergeable (merge path: retry-then-soft-gate).
# ---------------------------------------------------------------------------
echo
echo "=== --dry-run (GH-1712, D8) ==="

expect_no_mutation() { # expect_no_mutation <desc> — no merge, no comment posted
  if grep -q "gh pr merge" "$LAST_DIR/gh.log" 2>/dev/null; then
    fail "$1: dry run invoked gh pr merge"
  elif grep -q "gh pr comment" "$LAST_DIR/gh.log" 2>/dev/null; then
    fail "$1: dry run posted a comment"
  else
    pass "$1: no merge, no comment"
  fi
}
expect_last_gate_line() { # expect_last_gate_line <desc> <pattern>
  local last
  last=$(grep "MERGE GATE" <<<"$LAST_OUT" | tail -1)
  if grep -qF "$2" <<<"$last"; then pass "$1"; else fail "$1 — last gate line: $last"; fi
}

# D8.1 green fixture: PASS, exit 0, no mutation, worktree untouched.
WT_ROOT_DRY="$TMP_ROOT/wtroot-dry"
mkdir -p "$WT_ROOT_DRY/.claude/worktrees/GH-9999"
export RALPH_WORKTREE_ROOT="$WT_ROOT_DRY"
run_case "dry-run: green fixture emits PASS at exit 0" 0 "$POLICY" setup_green --dry-run
expect_last_gate_line "dry-run: verdict is the last MERGE GATE line (PASS)" "MERGE GATE PASS"
expect_out "dry-run: says no merge attempted" "Dry run: no merge attempted."
expect_no_mutation "dry-run green"
if [[ -d "$WT_ROOT_DRY/.claude/worktrees/GH-9999" ]]; then
  pass "dry-run: worktree cleanup not invoked"
else
  fail "dry-run: worktree was removed"
fi
unset RALPH_WORKTREE_ROOT

# D8.2 verdict parity with the merge path across the existing gate fixtures.
run_case "dry-run: CHANGES_REQUESTED is FAIL — review (parity)" 1 "$POLICY" setup_cr --dry-run
expect_last_gate_line "dry-run CR verdict token" "MERGE GATE FAIL — review"
expect_no_mutation "dry-run CR"

run_case "dry-run: pending checks are PENDING 75 (parity)" 75 "$POLICY" setup_pending --dry-run
expect_last_gate_line "dry-run pending verdict token" "MERGE GATE PENDING — checks"
expect_no_mutation "dry-run pending"

run_case "dry-run: failing check is FAIL 1 (parity)" 1 "$POLICY" setup_failing --dry-run
expect_last_gate_line "dry-run failing-check verdict token" "MERGE GATE FAIL — checks"

run_case "dry-run: missing attestation is FAIL 1 (parity)" 1 "$POLICY" setup_no_att --dry-run
expect_last_gate_line "dry-run no-attestation verdict token" "MERGE GATE FAIL — attestation"

run_case "dry-run: missing external review is PENDING 75 (parity)" 75 "$POLICY" setup_no_ext --dry-run
expect_last_gate_line "dry-run no-external verdict token" "MERGE GATE PENDING — external-review"

run_case "dry-run: external_review.required=false is PASS 0 (parity)" 0 "$POLICY_NO_EXT" setup_no_ext --dry-run
expect_last_gate_line "dry-run no-external-required verdict token" "MERGE GATE PASS"
expect_no_mutation "dry-run required=false"

run_case "dry-run: CONFLICTING is FAIL 1 (parity)" 1 "$POLICY" setup_conflicting --dry-run
expect_last_gate_line "dry-run conflicting verdict token" "MERGE GATE FAIL — mergeable"

APPLY_KEYWORDS_STUB="$APPLY_STUB_DIR/fail.sh"
run_case "dry-run: gate 6 failure is FAIL 1 (parity)" 1 "$POLICY" setup_green --dry-run
expect_last_gate_line "dry-run gate-6 verdict token" "MERGE GATE FAIL — apply-keywords"
expect_no_mutation "dry-run gate 6"
APPLY_KEYWORDS_STUB=""

# D8.3 the sanctioned divergence: UNKNOWN mergeability → PENDING — mergeable,
# single attempt (exactly one `pr view` in the log — no retry re-query).
setup_unknown() {
  write_pr_view "$1" "" "UNKNOWN" "cdubiel08" "$(good_attestation_body "$SHA")" "$CODEX_REVIEWS"
  echo "$GREEN_CHECKS" >"$1/pr_checks.json"
}
run_case "dry-run: UNKNOWN mergeability maps to PENDING — mergeable" 75 "$POLICY" setup_unknown --dry-run
expect_last_gate_line "dry-run UNKNOWN verdict token" "MERGE GATE PENDING — mergeable"
pr_view_calls=$(grep "gh pr view" "$LAST_DIR/gh.log" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$pr_view_calls" -eq 1 ]]; then
  pass "dry-run: single attempt, no retry re-query"
else
  fail "dry-run: expected 1 pr view call, got $pr_view_calls"
fi

# D8.4 WARN is non-terminal: zero checks emit WARN then PASS; the parsed
# verdict (last MERGE GATE line) is PASS, never the WARN.
run_case "dry-run: zero checks is WARN then PASS" 0 "$POLICY" setup_no_checks --dry-run
expect_out "dry-run: WARN line present" "MERGE GATE WARN — checks"
expect_last_gate_line "dry-run: last gate line is PASS despite WARN" "MERGE GATE PASS"

# D8.5 --dry-run and --force are mutually exclusive.
run_case "dry-run: --force is refused" 1 "$POLICY" setup_green --dry-run --force "why not"
expect_not_merged "dry-run + force"

echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
