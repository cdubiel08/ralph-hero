#!/usr/bin/env bash
# scripts/__tests__/advisory-findings.test.sh
# Tests the sub-P0 finding counter (GH-1945).
#
# Harness: a PATH-injected `gh` stub serves one canned GraphQL payload, so
# counting is tested without network. Pattern follows pr-gate-watch.test.sh.
#
# The cases that justify the script's existence:
#   - BOTH badge renderings count. Greptile writes <img alt="P1">, Codex writes
#     ![P1 Badge](...). Every finding in GH-1945's evidence table is Greptile's,
#     so a Codex-only parser would report a clean PR on all three.
#   - Policy-bot P0 is SUBTRACTED (gate 5 already blocks on it) while a non-
#     policy reviewer's P0 is COUNTED (nothing else counts it).
#   - An unreadable read reports ok=false, never count=0. "Not evaluated" and
#     "none" reading alike is the defect this whole script exists to fix.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/advisory-findings.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-} ${2:-}" in
  "api graphql")
    [[ -f "$GH_STUB_DIR/fail" ]] && exit 1
    cat "$GH_STUB_DIR/threads.json"
    ;;
  "api repos/{owner}/{repo}/pulls/1740")
    [[ -f "$GH_STUB_DIR/pr.json" ]] || exit 1
    cat "$GH_STUB_DIR/pr.json"
    ;;
  "api repos/{owner}/{repo}/pulls/1740/reviews")
    [[ -f "$GH_STUB_DIR/reviews.json" ]] || exit 1
    cat "$GH_STUB_DIR/reviews.json"
    ;;
  "api repos/{owner}/{repo}/issues/1740/comments")
    [[ -f "$GH_STUB_DIR/comments.json" ]] || exit 1
    cat "$GH_STUB_DIR/comments.json"
    ;;
  *) echo "stub: unhandled gh $*" >&2; exit 64 ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

BOT="chatgpt-codex-connector[bot]"
# Findings mode — the mode this repo runs — is the one where gate 5 reads
# threads, and therefore the only one where subtracting its P0 is honest.
POLICY="$TMP_ROOT/policy.json"
cat >"$POLICY" <<EOF
{ "version": 1, "external_review": { "required": true, "bot": "$BOT",
  "head_marker": "ralph-review-head" } }
EOF
POLICY_REVIEW_MODE="$TMP_ROOT/policy-review-mode.json"
jq 'del(.external_review.head_marker)' "$POLICY" >"$POLICY_REVIEW_MODE"

D="$TMP_ROOT/stub"
mkdir -p "$D"

# thread <author> <body> [resolved] [outdated] -> one thread node
thread() {
  jq -nc --arg a "$1" --arg b "$2" --argjson r "${3:-false}" --argjson o "${4:-false}" \
    '{isResolved:$r, isOutdated:$o,
      comments:{nodes:[{author:{login:$a}, body:$b, url:"https://example.test/d/1"}]}}'
}
# The two renderings, verbatim in shape from the live PRs they were read off
# (#1941 for Greptile, #1927 for Codex).
greptile() { printf '<a href="#"><img alt="%s" src="https://greptile-static-assets.s3.amazonaws.com/badges/%s.svg?v=9" align="top"></a> **Finding**' "$1" "$(echo "$1" | tr 'A-Z' 'a-z')"; }
codex_badge() { printf '**<sub><sub>![%s Badge](https://img.shields.io/badge/%s-orange?style=flat)</sub></sub>  Finding**' "$1" "$1"; }

# threads <node>... -> the full GraphQL payload
threads() {
  local nodes
  nodes=$(printf '%s\n' "$@" | jq -sc .)
  jq -nc --argjson n "$nodes" --argjson more "${HAS_NEXT:-false}" \
    '{data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:$more}, nodes:$n}}}}}'
}

run() { # run -> sets OUT
  OUT=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$D" RALPH_MERGE_POLICY_FILE="${POLICY_UNDER_TEST:-$POLICY}" \
    bash "$SCRIPT" 1740 2>&1)
}
# expect_json <label> <jq-predicate>
expect_json() {
  run
  if jq -e "$2" >/dev/null 2>&1 <<<"$OUT"; then pass "$1"; else fail "$1 (out=$OUT)"; fi
}

echo "=== both reviewers' badge renderings are counted ==="
threads "$(thread greptile-apps "$(greptile P1)")" \
        "$(thread greptile-apps "$(greptile P2)")" >"$D/threads.json"
expect_json "Greptile's <img alt> badges count" '.ok == true and .count == 2 and .summary == "1xP1, 1xP2"'

threads "$(thread chatgpt-codex-connector "$(codex_badge P1)")" >"$D/threads.json"
expect_json "Codex's ![Px Badge] markup counts" '.ok == true and .count == 1 and .summary == "1xP1"'

echo "=== the one subtraction: what gate 5 already blocks on ==="
threads "$(thread chatgpt-codex-connector "$(codex_badge P0)")" >"$D/threads.json"
expect_json "the policy bot's P0 is left to gate 5" '.ok == true and .count == 0'

# Greptile's status check is completion-only (GH-1893) — it reports `pass`
# regardless of findings — so its top severity has no gate behind it and must
# be counted here or nowhere.
threads "$(thread greptile-apps "$(greptile P0)")" >"$D/threads.json"
expect_json "a non-policy reviewer's P0 IS counted" '.ok == true and .count == 1 and .summary == "1xP0"'

# The subtraction is "gate 5 already blocks on this thread", not "the bot's
# findings are someone else's problem" — and in review mode gate 5 asks for an
# APPROVED review and never reads a thread. Subtracting there would hide the
# PR's highest-severity finding behind an approval (Greptile P1, PR #1946).
threads "$(thread chatgpt-codex-connector "$(codex_badge P0)")" >"$D/threads.json"
POLICY_UNDER_TEST="$POLICY_REVIEW_MODE" \
  expect_json "in review mode the bot's P0 is counted — nothing else blocks it" \
  '.ok == true and .count == 1 and .summary == "1xP0"'

echo "=== state: resolved, outdated, unbadged ==="
threads "$(thread greptile-apps "$(greptile P1)" true false)" >"$D/threads.json"
expect_json "a resolved thread is adjudicated, not outstanding" '.count == 0'
threads "$(thread greptile-apps "$(greptile P1)" false true)" >"$D/threads.json"
expect_json "an outdated thread is about code that is gone" '.count == 0'
threads "$(thread cdubiel08 "just a question, no badge")" >"$D/threads.json"
expect_json "an unbadged human comment is not a finding" '.count == 0'
# A P1 mentioned in PROSE is not a P1 finding: the badge markup is the signal,
# and a bare substring match would inflate the count off any thread discussing
# severities — including this repo's own review-policy threads.
threads "$(thread greptile-apps "$(greptile P2)  this is not a P1 or P0 issue")" >"$D/threads.json"
expect_json "severity comes from the badge, not the prose" '.count == 1 and .summary == "1xP2"'

echo "=== unreadable is never clean ==="
touch "$D/fail"
expect_json "a failed graphql read reports ok=false, not zero" '.ok == false and .count == 0 and (.detail | length > 0)'
rm "$D/fail"
printf 'not json' >"$D/threads.json"
expect_json "an unparseable payload reports ok=false" '.ok == false'
HAS_NEXT=true threads "$(thread greptile-apps "$(greptile P1)")" >"$D/threads.json"
expect_json "more than 100 threads is not counted rather than undercounted" '.ok == false and (.detail | test("100"))'

echo "=== zero findings is not proof anyone looked (GH-1971) ==="
HEAD="8430effbdd1111111111111111111111111111aa"
mk_pr() { jq -nc --arg s "$HEAD" '{head:{sha:$s}, user:{login:"cdubiel08"}}' >"$D/pr.json"; }
threads >"$D/threads.json"   # no findings at all — the quota-exhausted PR

mk_pr; echo '[]' >"$D/reviews.json"; echo '[]' >"$D/comments.json"
expect_json "no review and no comment at head reads as unreviewed, not clean" \
  '.ok == true and .count == 0 and .reviewed == "false"'

jq -nc --arg s "$HEAD" '[{commit_id:$s, state:"COMMENTED", user:{login:"greptile-apps[bot]"}}]' >"$D/reviews.json"
expect_json "a review object at the head is proof someone looked" '.reviewed == "true"'

jq -nc --arg s "$HEAD" '[{commit_id:$s, state:"DISMISSED", user:{login:"greptile-apps[bot]"}}]' >"$D/reviews.json"
echo '[]' >"$D/comments.json"
expect_json "a dismissed review is not a look" '.reviewed == "false"'

# The comment shape gate 5 accepts: the reviewer reports the commit it read.
echo '[]' >"$D/reviews.json"
jq -nc --arg s "${HEAD:0:10}" '[{body:"**Reviewed commit:** `\($s)`", user:{login:"chatgpt-codex-connector[bot]"}}]' >"$D/comments.json"
expect_json "a reviewer comment naming the head counts" '.reviewed == "true"'

# The trap this bound exists for: the driver's own request comment names the
# head. Counting it would make every PR prove its own review.
jq -nc --arg s "$HEAD" '[{body:"@codex review for P0 issues only\n<!-- ralph-review-head: \($s) -->", user:{login:"cdubiel08"}}]' >"$D/comments.json"
expect_json "the author's own head-marker request does not prove a review" '.reviewed == "false"'

# A review at an OLDER head is not a review of this one.
jq -nc '[{commit_id:"deadbeef00000000000000000000000000000000", state:"COMMENTED", user:{login:"greptile-apps[bot]"}}]' >"$D/reviews.json"
echo '[]' >"$D/comments.json"
expect_json "a review at an older head does not carry forward" '.reviewed == "false"'

# An unreadable history must not read as either verdict.
rm -f "$D/pr.json" "$D/reviews.json" "$D/comments.json"
expect_json "an unreadable review history is unknown, never false" \
  '.ok == true and .count == 0 and .reviewed == "unknown"'

echo
echo "advisory-findings: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
