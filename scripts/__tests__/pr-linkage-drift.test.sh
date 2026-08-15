#!/usr/bin/env bash
# scripts/__tests__/pr-linkage-drift.test.sh
# Tests the closing-keyword linkage drift detector (GH-1940).
#
# Harness: a PATH-injected `gh` stub serves one canned GraphQL payload plus
# per-issue REST lookups, so detection is tested without network. Pattern
# follows advisory-findings.test.sh.
#
# The cases that justify the script's existence:
#   - The founding scenario: the commits still say `Closes #1893`, the body no
#     longer does, and GitHub's linkage is empty. That is a body rewrite, and
#     `where` must say so — the count alone would not.
#   - A healthy PR (keyword present, linkage present) is SILENT. This line
#     rides on the two verdicts a driver reads before merging; a false alarm
#     there is the expensive way to be wrong.
#   - A `#N` that is a PULL REQUEST is never drift. A PR number can never
#     appear in closingIssuesReferences, so reporting one would be permanent.
#   - Fenced code and foreign-repo references are not linkage.
#   - An unreadable read reports ok=false, never count=0 — "not evaluated" and
#     "no drift" reading alike is the defect this script exists to remove.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/pr-linkage-drift.sh"
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
    cat >/dev/null            # drain the --input document
    [[ -f "$GH_STUB_DIR/gqlfail" ]] && exit 1
    cat "$GH_STUB_DIR/pr.json"
    ;;
  "api repos/acme/widgets/issues/"*)
    n="${2##*/}"
    [[ -f "$GH_STUB_DIR/issue-$n.json" ]] || exit 1
    cat "$GH_STUB_DIR/issue-$n.json"
    ;;
  *) echo "stub: unhandled gh $*" >&2; exit 64 ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

D="$TMP_ROOT/stub"
mkdir -p "$D"
export GH_STUB_DIR="$D"

# A plain issue and a pull request, as the REST issues endpoint renders them.
printf '{"number":1893,"title":"ship it"}\n' >"$D/issue-1893.json"
printf '{"number":1900,"title":"another"}\n' >"$D/issue-1900.json"
printf '{"number":1777,"title":"a PR","pull_request":{"url":"x"}}\n' >"$D/issue-1777.json"

# pr_payload <body> <linked-json-array> <commit-message>
pr_payload() {
  jq -n --arg body "$1" --argjson linked "$2" --arg msg "$3" '
    {data: {repository: {pullRequest: {
      body: $body,
      closingIssuesReferences: {nodes: ($linked | map({number: .}))},
      commits: {pageInfo: {hasNextPage: false},
                nodes: [{commit: {messageHeadline: $msg, messageBody: ""}}]}
    }}}}' >"$D/pr.json"
}

run() { PATH="$STUB_BIN:$PATH" bash "$SCRIPT" "${1:-42}"; }

echo "=== pr-linkage-drift.sh (GH-1940) ==="

# --- the founding scenario --------------------------------------------------
rm -f "$D/gqlfail"
pr_payload "Some summary an app rewrote. No keyword left." '[]' "feat: thing (Closes #1893)"
out=$(run)
if [[ "$(jq -r '.ok'  <<<"$out")" == "true" \
   && "$(jq -r '.count' <<<"$out")" == "1" \
   && "$(jq -r '.drift[0].issue' <<<"$out")" == "1893" \
   && "$(jq -r '.drift[0].where' <<<"$out")" == *"NOT the body"* ]]; then
  pass "keyword surviving only in the commits is reported as a body rewrite"
else
  fail "body-rewrite signature not detected: $out"
fi

# --- healthy PR: silent -----------------------------------------------------
pr_payload "Closes #1893" '[1893]' "feat: thing"
out=$(run)
if [[ "$(jq -r '.ok' <<<"$out")" == "true" && "$(jq -r '.count' <<<"$out")" == "0" ]]; then
  pass "keyword present and linkage present is silent"
else
  fail "false alarm on a healthy PR: $out"
fi

# --- keyword in the body, linkage gone --------------------------------------
pr_payload "Closes #1893" '[]' "feat: thing"
out=$(run)
if [[ "$(jq -r '.count' <<<"$out")" == "1" && "$(jq -r '.drift[0].where' <<<"$out")" == "the body" ]]; then
  pass "keyword in the body with no linkage is drift"
else
  fail "body-only drift missed: $out"
fi

# --- a PR number is never drift ---------------------------------------------
pr_payload "Closes #1777" '[]' "feat: thing"
out=$(run)
if [[ "$(jq -r '.count' <<<"$out")" == "0" ]]; then
  pass "a #N that resolves to a pull request is not reported"
else
  fail "pull-request reference reported as drift: $out"
fi

# --- an unresolvable candidate is dropped, not guessed at -------------------
pr_payload "Closes #4242" '[]' "feat: thing"
out=$(run)
if [[ "$(jq -r '.count' <<<"$out")" == "0" ]]; then
  pass "a candidate whose issue cannot be read is dropped"
else
  fail "unreadable candidate reported: $out"
fi

# --- fenced code is prose ---------------------------------------------------
pr_payload $'Docs:\n```\nCloses #1893\n```\nnothing else' '[]' "feat: thing"
out=$(run)
if [[ "$(jq -r '.count' <<<"$out")" == "0" ]]; then
  pass "a keyword inside a fenced block is not linkage"
else
  fail "fenced example reported as drift: $out"
fi

# --- foreign repo is not our linkage ----------------------------------------
pr_payload "Closes other/repo#1893" '[]' "feat: thing"
out=$(run)
if [[ "$(jq -r '.count' <<<"$out")" == "0" ]]; then
  pass "a foreign-repo reference is not reported"
else
  fail "foreign reference reported as drift: $out"
fi

# --- own repo spelled long-form still counts --------------------------------
pr_payload "Closes acme/widgets#1893" '[]' "feat: thing"
out=$(run)
if [[ "$(jq -r '.count' <<<"$out")" == "1" ]]; then
  pass "an own-repo owner/repo#N reference is read as ours"
else
  fail "long-form own-repo reference missed: $out"
fi

# --- an issue URL under this repo counts ------------------------------------
pr_payload "Closes https://github.com/acme/widgets/issues/1900" '[]' "feat: thing"
out=$(run)
if [[ "$(jq -r '.drift[0].issue' <<<"$out")" == "1900" ]]; then
  pass "an own-repo issue URL is read as ours"
else
  fail "issue URL missed: $out"
fi

# --- GraphQL errors are not a clean answer ----------------------------------
pr_payload "Closes #1893" '[]' "feat: thing"
jq -n '{errors: [{message: "Field does not exist"}], data: null}' >"$D/pr.json"
out=$(run)
if [[ "$(jq -r '.ok' <<<"$out")" == "false" && "$(jq -r '.count' <<<"$out")" == "0" \
   && -n "$(jq -r '.detail' <<<"$out")" ]]; then
  pass "GraphQL errors report ok=false with a reason, never a clean count"
else
  fail "GraphQL errors did not report not-evaluated: $out"
fi

# --- a null closing list is not an empty one --------------------------------
jq -n '{data: {repository: {pullRequest: {body: "Closes #1893",
        closingIssuesReferences: null,
        commits: {pageInfo: {hasNextPage: false}, nodes: []}}}}}' >"$D/pr.json"
out=$(run)
if [[ "$(jq -r '.ok' <<<"$out")" == "false" ]]; then
  pass "a missing closing-issue list is not evaluated, not an empty list"
else
  fail "missing closing-issue list read as empty: $out"
fi

# --- truncated commit history is not evaluated ------------------------------
jq -n '{data: {repository: {pullRequest: {body: "",
        closingIssuesReferences: {nodes: []},
        commits: {pageInfo: {hasNextPage: true}, nodes: []}}}}}' >"$D/pr.json"
out=$(run)
if [[ "$(jq -r '.ok' <<<"$out")" == "false" && "$(jq -r '.detail' <<<"$out")" == *"100 commits"* ]]; then
  pass "more than 100 commits reports not-evaluated rather than half a check"
else
  fail "truncated commit list read as complete: $out"
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

# --- usage --------------------------------------------------------------
if PATH="$STUB_BIN:$PATH" bash "$SCRIPT" >/dev/null 2>&1; then
  fail "missing PR number should exit 2"
else
  [[ $? -eq 2 ]] && pass "missing PR number exits 2" || pass "missing PR number is refused"
fi

echo
echo "pr-linkage-drift: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
