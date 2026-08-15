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
  *) echo "stub: unhandled gh $*" >&2; exit 64 ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

BOT="chatgpt-codex-connector[bot]"
POLICY="$TMP_ROOT/policy.json"
cat >"$POLICY" <<EOF
{ "version": 1, "external_review": { "required": true, "bot": "$BOT" } }
EOF

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
  OUT=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$D" RALPH_MERGE_POLICY_FILE="$POLICY" \
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

echo
echo "advisory-findings: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
