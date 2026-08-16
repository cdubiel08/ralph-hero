#!/usr/bin/env bash
# scripts/__tests__/ruleset-contexts.test.sh
# Tests the required-but-not-produced context reader (GH-2057).
#
# Harness: a PATH-injected `gh` stub serves one canned GraphQL payload and one
# canned branch-rules payload, so detection is tested without network. Pattern
# follows pr-linkage-drift.test.sh.
#
# The cases that justify the script's existence:
#   - The founding scenario (PR #2055): the ruleset still requires a per-matrix
#     context the diff stopped producing. Every other gate passed; only this
#     read can name the string GitHub refuses with.
#   - A healthy PR is SILENT. This rides on the verdict that says "merge now";
#     a false alarm there is the expensive way to be wrong.
#   - FAIL OPEN is the load-bearing bound: an unreadable ruleset, a repo with
#     no ruleset, and a head where CI has not reported must never manufacture a
#     missing context.
#   - "read, nothing missing" and "never read" must not render alike.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/ruleset-contexts.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-} ${2:-}" in
  "repo view")
    echo "acme widgets"
    ;;
  "api graphql")
    [[ -f "$GH_STUB_DIR/gqlfail" ]] && exit 1
    cat "$GH_STUB_DIR/pr.json"
    ;;
  "api repos/acme/widgets/rules/branches/"*)
    [[ -f "$GH_STUB_DIR/rulesfail" ]] && exit 1
    cat "$GH_STUB_DIR/rules.json"
    ;;
  *) echo "stub: unhandled gh $*" >&2; exit 64 ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

D="$TMP_ROOT/stub"
mkdir -p "$D"
export GH_STUB_DIR="$D"

# pr_payload <produced-json-array> [hasNextPage] [rollup-present]
pr_payload() {
  local produced="$1" next="${2:-false}" present="${3:-true}"
  if [[ "$present" != "true" ]]; then
    jq -n '{data:{repository:{pullRequest:{
      baseRefName:"main", headRefOid:"deadbeef",
      commits:{nodes:[{commit:{statusCheckRollup:null}}]}}}}}' >"$D/pr.json"
    return
  fi
  jq -n --argjson produced "$produced" --argjson next "$next" '
    {data:{repository:{pullRequest:{
      baseRefName:"main", headRefOid:"deadbeef",
      commits:{nodes:[{commit:{statusCheckRollup:{contexts:{
        pageInfo:{hasNextPage:$next},
        nodes: ($produced | map({__typename:"CheckRun", name:.}))
      }}}}]}
    }}}}' >"$D/pr.json"
}

# rules_payload <required-json-array>
rules_payload() {
  jq -n --argjson req "$1" '
    [{type:"pull_request"},
     {type:"required_status_checks",
      parameters:{required_status_checks: ($req | map({context:.}))}}]' >"$D/rules.json"
}

run() { PATH="$STUB_BIN:$PATH" bash "$SCRIPT" "${1:-42}"; }

echo "=== ruleset-contexts.sh (GH-2057) ==="

rm -f "$D/gqlfail" "$D/rulesfail"

# --- the founding scenario --------------------------------------------------
rules_payload '["board-tests","build-and-test-knowledge (20)","build-and-test-knowledge (22)"]'
pr_payload    '["board-tests","build-and-test-knowledge (22)"]'
out=$(run)
if [[ "$(jq -r '.ok' <<<"$out")" == "true" \
   && "$(jq -r '.count' <<<"$out")" == "1" \
   && "$(jq -r '.missing[0]' <<<"$out")" == "build-and-test-knowledge (20)" ]]; then
  pass "a required matrix leg the diff stopped producing is named"
else
  fail "founding scenario not detected: $out"
fi

# --- healthy PR: silent -----------------------------------------------------
rules_payload '["board-tests","test-hooks"]'
pr_payload    '["board-tests","test-hooks","CodeQL"]'
out=$(run)
if [[ "$(jq -r '.ok' <<<"$out")" == "true" && "$(jq -r '.count' <<<"$out")" == "0" ]]; then
  pass "every required context produced is silent (extras are not missing)"
else
  fail "false alarm on a healthy PR: $out"
fi

# --- a repo with no ruleset is an ANSWER, not a skip ------------------------
printf '[]\n' >"$D/rules.json"
pr_payload '["board-tests"]'
out=$(run)
if [[ "$(jq -r '.ok' <<<"$out")" == "true" && "$(jq -r '.count' <<<"$out")" == "0" ]]; then
  pass "no ruleset reads as ok=true count=0 — nothing can refuse the merge"
else
  fail "empty ruleset misreported: $out"
fi

# --- an unreadable ruleset is NOT a clean answer ----------------------------
rules_payload '["board-tests"]'
pr_payload    '["board-tests"]'
touch "$D/rulesfail"
out=$(run)
if [[ "$(jq -r '.ok' <<<"$out")" == "false" && "$(jq -r '.count' <<<"$out")" == "0" ]]; then
  pass "an unreadable ruleset reports ok=false, distinct from 'nothing required'"
else
  fail "unreadable ruleset read as clean: $out"
fi
rm -f "$D/rulesfail"

# --- CI has not reported: fail open, do not indict the whole ruleset --------
rules_payload '["board-tests","test-hooks"]'
pr_payload '[]' false false
out=$(run)
if [[ "$(jq -r '.ok' <<<"$out")" == "false" && "$(jq -r '.count' <<<"$out")" == "0" ]]; then
  pass "a head with no reported checks is not evaluated, not all-missing"
else
  fail "unstarted CI reported as missing contexts: $out"
fi

# --- truncated context page: not evaluated ----------------------------------
rules_payload '["board-tests","test-hooks"]'
pr_payload    '["board-tests"]' true
out=$(run)
if [[ "$(jq -r '.ok' <<<"$out")" == "false" ]]; then
  pass "more than one page of contexts is not evaluated rather than accused"
else
  fail "truncated produced set treated as complete: $out"
fi

# --- a failed graphql call is not a clean answer ----------------------------
touch "$D/gqlfail"
out=$(run)
if [[ "$(jq -r '.ok' <<<"$out")" == "false" ]]; then
  pass "a failed GraphQL call reports ok=false"
else
  fail "failed GraphQL call read as clean: $out"
fi
rm -f "$D/gqlfail"

# --- usage ------------------------------------------------------------------
if PATH="$STUB_BIN:$PATH" bash "$SCRIPT" >/dev/null 2>&1; then
  fail "missing PR number should exit 2"
else
  pass "missing PR number is refused"
fi

echo
echo "ruleset-contexts: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
