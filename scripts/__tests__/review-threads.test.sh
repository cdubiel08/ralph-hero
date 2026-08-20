#!/usr/bin/env bash
# scripts/__tests__/review-threads.test.sh
# The review-thread reader/writer (audit A4). gh is stubbed on PATH.
#
# The two properties that justify the script get explicit coverage:
#   - the thread list is read PAGINATED, and an UNREADABLE list is a distinct
#     exit 3, never rendered as "no threads" (the GH-1842 lesson);
#   - writes go through gb_gh, so a rate-limited `gh` that exits 0 having
#     written nothing is a typed refusal, not a claimed success (GH-1817).

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/review-threads.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# --- gh stub -----------------------------------------------------------------
STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
echo "gh $*" >>"$GH_STUB_LOG"
args=("$@")
query=""
cursor=""
thread=""
msg_body=""
comment_body=""
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    -f|-F)
      v="${args[$((i + 1))]:-}"
      case "$v" in
        query=*)  query="${v#query=}" ;;
        cursor=*) cursor="${v#cursor=}" ;;
        t=*)      thread="${v#t=}" ;;
        b=*)      msg_body="${v#b=}" ;;
      esac
      ;;
    --body) comment_body="${args[$((i + 1))]:-}" ;;
  esac
done
case "${1:-} ${2:-}" in
  "api graphql")
    if [[ "$query" == *addPullRequestReviewThreadReply* ]]; then
      if [[ -f "$GH_STUB_DIR/rate_limited" ]]; then
        # The GH-1817 shape: the refusal prints and gh EXITS 0.
        echo "GraphQL: API rate limit already exceeded"; exit 0
      fi
      printf 'reply %s %s\n' "$thread" "$msg_body" >>"$GH_STUB_DIR/mutations.log"
      echo '{"data":{"addPullRequestReviewThreadReply":{"comment":{"url":"https://example.test/reply/1"}}}}'
      exit 0
    fi
    if [[ "$query" == *resolveReviewThread* ]]; then
      if [[ -f "$GH_STUB_DIR/rate_limited" ]]; then
        echo "GraphQL: API rate limit already exceeded"; exit 0
      fi
      printf 'resolve %s\n' "$thread" >>"$GH_STUB_DIR/mutations.log"
      printf '{"data":{"resolveReviewThread":{"thread":{"id":"%s","isResolved":true}}}}\n' "$thread"
      exit 0
    fi
    # The paginated thread read.
    [[ -f "$GH_STUB_DIR/fail_threads" ]] && exit 1
    if [[ -n "$cursor" && -f "$GH_STUB_DIR/threads_page_$cursor.json" ]]; then
      cat "$GH_STUB_DIR/threads_page_$cursor.json"
    elif [[ -f "$GH_STUB_DIR/threads_page1.json" ]]; then
      cat "$GH_STUB_DIR/threads_page1.json"
    else
      echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}'
    fi
    exit 0
    ;;
  "pr comment")
    if [[ -f "$GH_STUB_DIR/rate_limited_comment" ]]; then
      echo "GraphQL: API rate limit already exceeded"; exit 0
    fi
    printf '%s' "$comment_body" >"$GH_STUB_DIR/nudge_body.txt"
    exit 0
    ;;
  *)
    echo "stub: unhandled gh $*" >&2
    exit 64
    ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

# Findings-mode policy: the gate-blocking tag must key on the policy bot + P0,
# read from the same file gate 5 reads.
POLICY_FINDINGS="$TMP_ROOT/policy-findings.json"
cat >"$POLICY_FINDINGS" <<'EOF'
{ "version": 1,
  "attestation": { "required": true },
  "external_review": { "required": true, "bot": "chatgpt-codex-connector[bot]",
    "trigger": "@codex review for P0 issues only",
    "head_marker": "ralph-review-head" } }
EOF

new_case() {
  CASE_DIR="$TMP_ROOT/case-$RANDOM-$((PASS + FAIL))"
  mkdir -p "$CASE_DIR"
}

run_rt() { # run_rt [args...] — sets LAST_OUT/LAST_RC (stdout+stderr merged)
  set +e
  LAST_OUT=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$CASE_DIR" GH_STUB_LOG="$CASE_DIR/gh.log" \
    RALPH_MERGE_POLICY_FILE="$POLICY_FINDINGS" \
    bash "$SCRIPT" "$@" 2>&1)
  LAST_RC=$?
  set -e
}

# thread <id> <resolved> <outdated> <path> <line> <author> <body>
thread() {
  jq -n --arg id "$1" --argjson r "$2" --argjson o "$3" --arg p "$4" \
    --argjson l "$5" --arg a "$6" --arg b "$7" \
    '{id: $id, isResolved: $r, isOutdated: $o, path: $p, line: $l,
      comments: {nodes: [{author: {login: $a}, body: $b, url: ("https://example.test/t/" + $id)}]}}'
}
page() { # page <hasNext> <endCursor-or-null> <nodes-json>
  jq -n --argjson hn "$1" --arg c "$2" --argjson nodes "$3" \
    '{data: {repository: {pullRequest: {reviewThreads: {
        pageInfo: {hasNextPage: $hn, endCursor: (if $c == "" then null else $c end)},
        nodes: $nodes}}}}}'
}

# Both measured badge forms (advisory-findings.sh's header is the source of
# truth): Codex ![P0 Badge](…), Greptile <img alt="P1">.
CODEX_P0_BODY='**<sub><sub>![P0 Badge](https://img.shields.io/badge/P0-red)</sub></sub>** unread refusal'
GREPTILE_P1_BODY='<a href="#"><img alt="P1" src="https://greptile.example/p1.svg"></a> **style: naming**'

seed_two_pages() {
  TA=$(thread PRRT_a false false "scripts/x.sh" 10 "chatgpt-codex-connector" "$CODEX_P0_BODY")
  TB=$(thread PRRT_b false false "ralph/y.ts" 20 "greptile-apps" "$GREPTILE_P1_BODY")
  TC=$(thread PRRT_c true false "docs/z.md" 5 "greptile-apps" "plain prose finding, no badge")
  page true "CUR2" "[$TA]" >"$CASE_DIR/threads_page1.json"
  page false "" "[$TB, $TC]" >"$CASE_DIR/threads_page_CUR2.json"
}

echo "=== review-threads.sh: paginated read ==="

# 1. The listing merges pages — a thread on page 2 is not invisible.
new_case
seed_two_pages
run_rt 123
[[ "$LAST_RC" -eq 0 ]] && pass "listing exits 0" || fail "listing rc=$LAST_RC out=$LAST_OUT"
grep -q "PRRT_a" <<<"$LAST_OUT" && grep -q "PRRT_b" <<<"$LAST_OUT" && grep -q "PRRT_c" <<<"$LAST_OUT" \
  && pass "threads from BOTH pages are listed" || fail "pagination lost a thread: $LAST_OUT"
grep -q "3 thread(s)" <<<"$LAST_OUT" && pass "summary counts all pages" || fail "summary wrong: $LAST_OUT"
grep -c "gh api graphql" "$CASE_DIR/gh.log" | grep -q "^2$" \
  && pass "exactly two pages fetched" || fail "page fetch count wrong"

# 2. --unresolved filters the resolved thread out, keeps outdated flags visible.
new_case
seed_two_pages
run_rt 123 --unresolved
grep -q "PRRT_a" <<<"$LAST_OUT" && grep -q "PRRT_b" <<<"$LAST_OUT" \
  && ! grep -q "PRRT_c" <<<"$LAST_OUT" \
  && pass "--unresolved drops resolved threads" || fail "--unresolved filter wrong: $LAST_OUT"

# 3. Severity badges parse in BOTH reviewers' renderings; the policy bot's P0
#    carries the gate-blocking tag, the non-policy P1 does not.
new_case
seed_two_pages
run_rt 123
grep -q "P0(gate-blocking)" <<<"$LAST_OUT" \
  && pass "policy-bot P0 is tagged gate-blocking (Codex badge form)" || fail "gate-blocking tag missing: $LAST_OUT"
grep -qE "PRRT_b.*P1" <<<"$LAST_OUT" && ! grep -qE "PRRT_b.*gate-blocking" <<<"$LAST_OUT" \
  && pass "Greptile img-alt P1 parses and is advisory" || fail "greptile badge parse wrong: $LAST_OUT"

# 4. --json is a machine-readable array with the documented fields.
new_case
seed_two_pages
run_rt 123 --json
jq -e 'type == "array" and length == 3' >/dev/null 2>&1 <<<"$LAST_OUT" \
  && pass "--json emits the full array" || fail "--json unparseable: $LAST_OUT"
jq -e '.[0] | has("id") and has("resolved") and has("outdated") and has("tier")
        and has("path") and has("line") and has("author") and has("url")
        and has("excerpt") and has("gating")' >/dev/null 2>&1 <<<"$LAST_OUT" \
  && pass "--json rows carry every documented field" || fail "--json fields missing"

# 5. An UNREADABLE list is exit 3 and says so — never "no threads".
new_case
: >"$CASE_DIR/fail_threads"
run_rt 123
[[ "$LAST_RC" -eq 3 ]] && pass "unreadable list is a distinct exit 3" || fail "unreadable rc=$LAST_RC"
grep -q "UNREADABLE" <<<"$LAST_OUT" && grep -q "NOT the same as no threads" <<<"$LAST_OUT" \
  && pass "unreadable is named as unreadable" || fail "unreadable message wrong: $LAST_OUT"
grep -q "no review threads" <<<"$LAST_OUT" \
  && fail "unreadable rendered as an empty list" || pass "unreadable never renders as an empty list"

# 6. A successful read of ZERO threads prints so — distinct from exit 3.
new_case
run_rt 123
[[ "$LAST_RC" -eq 0 ]] && grep -q "no review threads on PR #123" <<<"$LAST_OUT" \
  && pass "an empty list is printed, not silent" || fail "empty-list rendering wrong: rc=$LAST_RC $LAST_OUT"

echo
echo "=== review-threads.sh: writes (gb_gh-wrapped, GH-1817) ==="

# 7. --reply posts the mutation with the thread id and body.
new_case
run_rt 123 --reply PRRT_a -m "fixed in abc123, resolving"
[[ "$LAST_RC" -eq 0 ]] && grep -q "REPLIED" <<<"$LAST_OUT" \
  && pass "--reply reports the posted reply" || fail "reply rc=$LAST_RC out=$LAST_OUT"
grep -qF "reply PRRT_a fixed in abc123, resolving" "$CASE_DIR/mutations.log" \
  && pass "reply mutation carries thread id and body" || fail "reply mutation wrong: $(cat "$CASE_DIR/mutations.log" 2>/dev/null)"

# 8. --resolve resolves AND posts the status-recompute nudge (GH-1847).
new_case
run_rt 123 --resolve PRRT_a
[[ "$LAST_RC" -eq 0 ]] && grep -q "RESOLVED" <<<"$LAST_OUT" && grep -q "NUDGED" <<<"$LAST_OUT" \
  && pass "--resolve resolves and nudges" || fail "resolve rc=$LAST_RC out=$LAST_OUT"
grep -qF "resolve PRRT_a" "$CASE_DIR/mutations.log" \
  && pass "resolve mutation carries the thread id" || fail "resolve mutation missing"
[[ -f "$CASE_DIR/nudge_body.txt" ]] && grep -q "GH-1847" "$CASE_DIR/nudge_body.txt" \
  && pass "nudge comment posted, naming why it exists" || fail "nudge comment missing"

# 9. A rate-limited write (gh exits 0 having written nothing) is a typed
#    refusal, never a claimed success.
new_case
: >"$CASE_DIR/rate_limited"
run_rt 123 --resolve PRRT_a
[[ "$LAST_RC" -eq 75 ]] && pass "rate-limited resolve exits 75 (EX_TEMPFAIL)" || fail "rate-limited rc=$LAST_RC out=$LAST_OUT"
grep -q "NOT APPLIED" <<<"$LAST_OUT" && ! grep -q "^RESOLVED" <<<"$LAST_OUT" \
  && pass "rate-limited write is named, not announced as success" || fail "rate-limited messaging wrong: $LAST_OUT"
[[ ! -f "$CASE_DIR/mutations.log" ]] \
  && pass "no mutation was recorded (nothing landed)" || fail "mutation recorded despite rate limit"

# 10. Nudge-only rate limit: the resolve LANDED, and the message says exactly
#     which half failed.
new_case
: >"$CASE_DIR/rate_limited_comment"
run_rt 123 --resolve PRRT_a
[[ "$LAST_RC" -eq 75 ]] && grep -q "THREAD RESOLVED but the recompute-nudge" <<<"$LAST_OUT" \
  && pass "nudge failure is distinct from resolve failure" || fail "nudge failure messaging: rc=$LAST_RC $LAST_OUT"
grep -qF "resolve PRRT_a" "$CASE_DIR/mutations.log" \
  && pass "the resolve itself landed" || fail "resolve did not land"

echo
echo "=== review-threads.sh: usage and help ==="

# 11. --reply without -m is a usage error.
new_case
run_rt 123 --reply PRRT_a
[[ "$LAST_RC" -eq 2 ]] && grep -q -- "-m/--message" <<<"$LAST_OUT" \
  && pass "--reply without -m rejected" || fail "reply without -m rc=$LAST_RC"

# 12. --help short-circuits before any gh/policy read.
new_case
run_rt --help
[[ "$LAST_RC" -eq 0 ]] && grep -q "Usage:" <<<"$LAST_OUT" \
  && pass "--help exits 0 with usage" || fail "--help rc=$LAST_RC"
[[ ! -s "$CASE_DIR/gh.log" ]] \
  && pass "--help makes no gh calls" || fail "--help touched gh: $(cat "$CASE_DIR/gh.log")"

echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
