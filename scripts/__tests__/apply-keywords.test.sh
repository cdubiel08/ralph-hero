#!/usr/bin/env bash
# scripts/__tests__/apply-keywords.test.sh
# Contract tests for scripts/apply-keywords.sh (GH-1694, epic GH-1692).
#
# Harness: a PATH-injected `gh` stub answers the three calls the script makes
# (repo view, api graphql, api .../files) from canned JSON in $GH_STUB_DIR.
# Same pattern as merge-pr-gates.test.sh — no network.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/apply-keywords.sh"
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
args=("$@")
jq_expr=""
for ((i = 0; i < ${#args[@]}; i++)); do
  if [[ "${args[$i]}" == "--jq" ]]; then jq_expr="${args[$((i + 1))]}"; fi
done
# `gh api --paginate repos/...` puts the flag in $2, so key on the first
# non-flag word after the subcommand rather than on "$1 $2".
sub="${1:-}"
verb=""
for a in "${args[@]:1}"; do
  if [[ "$a" != -* ]]; then verb="$a"; break; fi
done
case "$sub $verb" in
  "repo view")
    if [[ -f "$GH_STUB_DIR/repo_view_fails" ]]; then exit 1; fi
    echo "cdubiel08 ralph-hero"
    ;;
  "api graphql")
    cat >/dev/null   # drain the piped --input document
    if [[ -f "$GH_STUB_DIR/graphql_fails" ]]; then exit 1; fi
    # A GraphQL error response is exit 0 with a top-level `errors` array —
    # the shape that used to read as "closes no issues".
    if [[ -f "$GH_STUB_DIR/graphql_override.json" ]]; then
      cat "$GH_STUB_DIR/graphql_override.json"; exit 0
    fi
    cat "$GH_STUB_DIR/graphql.json"
    ;;
  "api repos/"*)
    if [[ -f "$GH_STUB_DIR/files_fail" ]]; then exit 1; fi
    if [[ -n "$jq_expr" ]]; then jq -r "$jq_expr" "$GH_STUB_DIR/files.json"; else cat "$GH_STUB_DIR/files.json"; fi
    ;;
  *) echo "stub: unhandled gh $*" >&2; exit 64 ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

# --- fixture builders -------------------------------------------------------

# closing_issue <number> <labels-csv> <subissue-labels-csv> <sibling-labels-csv>
# Empty strings mean "none". Siblings are modelled through parent.subIssues.
closing_issue() {
  jq -nc --argjson n "$1" --arg l "$2" --arg sub "$3" --arg sib "$4" '
    def lbls($s): {nodes: (if ($s | length) > 0 then ($s | split(",") | map({name: .})) else [] end)};
    {
      number: $n,
      labels: lbls($l),
      subIssues: {nodes: (if ($sub | length) > 0 then [{number: 5001, labels: lbls($sub)}] else [] end)},
      parent: (if ($sib | length) > 0
               then {number: 4000, subIssues: {nodes: [{number: 5002, labels: lbls($sib)}]}}
               else null end)
    }'
}

setup_case() { # setup_case <policy-json> <closing-nodes-json> <files-json>
  local dir="$TMP_ROOT/case-$RANDOM$RANDOM"
  mkdir -p "$dir"
  echo "$1" >"$dir/policy.json"
  jq -nc --argjson nodes "$2" \
    '{data: {repository: {pullRequest: {closingIssuesReferences: {nodes: $nodes}}}}}' \
    >"$dir/graphql.json"
  echo "$3" >"$dir/files.json"
  echo "$dir"
}

run_case() { # run_case <dir>  → sets LAST_OUT / LAST_RC
  set +e
  LAST_OUT=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$1" RALPH_MERGE_POLICY_FILE="$1/policy.json" \
    bash "$SCRIPT" 123 2>&1)
  LAST_RC=$?
  set -e
}

expect() { # expect <desc> <want-rc> <grep-pattern>
  if [[ "$LAST_RC" -eq "$2" ]] && grep -qF "$3" <<<"$LAST_OUT"; then
    pass "$1"
  else
    fail "$1 — rc=$LAST_RC want=$2, out: $LAST_OUT"
  fi
}

POLICY_ON='{"apply":{"enabled":true,"label":"ralph:apply","infraPaths":[".github/**","terraform/**","**/Dockerfile"]}}'
POLICY_ON_NO_PATHS='{"apply":{"enabled":true,"label":"ralph:apply","infraPaths":[]}}'
POLICY_OFF='{"attestation":{"required":true}}'
CODE_FILES='[{"filename":"src/index.ts"},{"filename":"README.md"}]'
INFRA_FILES='[{"filename":"src/index.ts"},{"filename":".github/workflows/ci.yml"}]'

echo "== opt-in: the gate is inert until the repo asks for it =="

dir=$(setup_case "$POLICY_OFF" "$(jq -nc '[]')" "$CODE_FILES")
run_case "$dir"
expect "no apply block ⇒ INERT" 0 "APPLY KEYWORDS INERT"

dir=$(setup_case '{"apply":{"enabled":false}}' "$(jq -nc '[]')" "$CODE_FILES")
run_case "$dir"
expect "enabled:false ⇒ INERT" 0 "APPLY KEYWORDS INERT"

dir=$(setup_case "$POLICY_ON" "$(jq -nc '[]')" "$CODE_FILES")
rm -f "$dir/policy.json"
run_case "$dir"
expect "no policy file at all ⇒ INERT" 0 "APPLY KEYWORDS INERT"

dir=$(setup_case '{"apply":{"enabled":true' "$(jq -nc '[]')" "$CODE_FILES")
run_case "$dir"
expect "malformed policy FAILS CLOSED, never silently off" 1 "not valid JSON"

echo "== rule 1: a closing keyword may not bind an apply unit =="

dir=$(setup_case "$POLICY_ON" "$(jq -nc --argjson a "$(closing_issue 1696 'ralph:apply' '' '')" '[$a]')" "$CODE_FILES")
run_case "$dir"
expect "apply-kind closing issue is refused" 1 "binding apply-kind issue(s) #1696"
expect "and the remedy names the alternative" 1 'say "Refs #N" instead'

dir=$(setup_case "$POLICY_ON" \
  "$(jq -nc --argjson a "$(closing_issue 1693 'enhancement' '' 'ralph:apply')" '[$a]')" "$CODE_FILES")
run_case "$dir"
expect "a ship issue with an apply SIBLING is fine" 0 "APPLY KEYWORDS PASS"

dir=$(setup_case "$POLICY_ON" "$(jq -nc '[]')" "$CODE_FILES")
run_case "$dir"
expect "a PR that closes nothing passes trivially" 0 "closes no issues"

echo "== rule 2: an infra-touching PR must not close an untwinned ship issue =="

UNTWINNED=$(jq -nc --argjson a "$(closing_issue 1693 'enhancement' '' '')" '[$a]')
TWINNED_SUB=$(jq -nc --argjson a "$(closing_issue 1693 'enhancement' 'ralph:apply' '')" '[$a]')
TWINNED_SIB=$(jq -nc --argjson a "$(closing_issue 1693 'enhancement' '' 'ralph:apply')" '[$a]')

dir=$(setup_case "$POLICY_ON" "$UNTWINNED" "$CODE_FILES")
run_case "$dir"
expect "a pure-code PR never grows an apply twin (the anti-goal)" 0 "touches no configured infra path"

dir=$(setup_case "$POLICY_ON" "$UNTWINNED" "$INFRA_FILES")
run_case "$dir"
expect "infra PR + untwinned ship issue is refused" 1 "has no apply twin"
expect "and the message names the offending path" 1 ".github/workflows/ci.yml"
# GH-2077: `create` has no default landing state, so the remedy names its lane.
# A command missing --backlog would be refused by the CLI the moment it is run,
# which is the whole failure mode a "runnable remedy" assertion exists to catch.
expect "and prints the exact command to fix it" 1 "board create --backlog --label ralph:apply"

dir=$(setup_case "$POLICY_ON" "$TWINNED_SUB" "$INFRA_FILES")
run_case "$dir"
expect "an apply-labelled SUB-ISSUE satisfies the split" 0 "every closing issue has an apply twin"

dir=$(setup_case "$POLICY_ON" "$TWINNED_SIB" "$INFRA_FILES")
run_case "$dir"
expect "an apply-labelled SIBLING satisfies the split" 0 "every closing issue has an apply twin"

dir=$(setup_case "$POLICY_ON_NO_PATHS" "$UNTWINNED" "$INFRA_FILES")
run_case "$dir"
expect "empty infraPaths turns rule 2 off but leaves rule 1 on" 0 "split rule off"

echo "== glob matching =="

dir=$(setup_case "$POLICY_ON" "$UNTWINNED" '[{"filename":"terraform/main.tf"}]')
run_case "$dir"
expect "terraform/** matches a nested path" 1 "has no apply twin"

dir=$(setup_case "$POLICY_ON" "$UNTWINNED" '[{"filename":"Dockerfile"}]')
run_case "$dir"
expect "**/Dockerfile also matches a TOP-LEVEL Dockerfile" 1 "has no apply twin"

dir=$(setup_case "$POLICY_ON" "$UNTWINNED" '[{"filename":"svc/api/Dockerfile"}]')
run_case "$dir"
expect "**/Dockerfile matches a nested Dockerfile" 1 "has no apply twin"

dir=$(setup_case "$POLICY_ON" "$UNTWINNED" '[{"filename":"docs/github-actions.md"}]')
run_case "$dir"
expect "a path that merely mentions github is not an infra path" 0 "touches no configured infra path"

echo "== transport failures are LOUD, never a silent pass =="

dir=$(setup_case "$POLICY_ON" "$UNTWINNED" "$INFRA_FILES")
touch "$dir/graphql_fails"
run_case "$dir"
expect "unreadable closing issues fail, not pass" 1 "cannot read closing issues"

dir=$(setup_case "$POLICY_ON" "$UNTWINNED" "$INFRA_FILES")
touch "$dir/files_fail"
run_case "$dir"
expect "an unlistable diff fails rather than reading as 'no infra'" 1 "cannot list changed files"

dir=$(setup_case "$POLICY_ON" "$UNTWINNED" "$INFRA_FILES")
touch "$dir/repo_view_fails"
run_case "$dir"
expect "an unresolvable repo fails" 1 "cannot resolve owner/repo"

echo "== a broken query must not read as a clean PR =="

dir=$(setup_case "$POLICY_ON" "$UNTWINNED" "$INFRA_FILES")
cat >"$dir/graphql_override.json" <<'GQLERR'
{"data": null, "errors": [{"message": "Field 'subIssues' doesn't exist on type 'Issue'"}]}
GQLERR
run_case "$dir"
expect "exit-0 GraphQL errors fail closed, never PASS" 1 "GraphQL errors reading PR #123"

dir=$(setup_case "$POLICY_ON" "$UNTWINNED" "$INFRA_FILES")
echo '{"data":{"repository":{"pullRequest":null}}}' >"$dir/graphql_override.json"
run_case "$dir"
expect "a null pullRequest node is a lookup failure, not 'closes no issues'" 1 "missing from the API response"

dir=$(setup_case "$POLICY_ON" "$UNTWINNED" "$INFRA_FILES")
echo '{"data":{"repository":null}}' >"$dir/graphql_override.json"
run_case "$dir"
expect "a null repository node likewise fails closed" 1 "missing from the API response"

echo
echo "apply-keywords.test.sh: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
