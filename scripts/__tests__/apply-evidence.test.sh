#!/usr/bin/env bash
# scripts/__tests__/apply-evidence.test.sh
# Contract tests for scripts/apply-evidence.sh (GH-1694, epic GH-1692).
#
# The load-bearing claim under test: kind=run evidence is RESOLVED from the
# API and bound to the merge SHA, so a green run of the pre-merge code cannot
# be passed off as proof the merged change is live.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/apply-evidence.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

MERGE_SHA="a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"
OTHER_SHA="0000111122223333444455556666777788889999"

STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"

cat >"$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
echo "gh $*" >>"$GH_STUB_DIR/gh.log"

# Ancestry stubs (GH-1961). Absent fixture files mean "the API did not answer",
# which is the not_evaluated path — so every pre-GH-1961 case keeps working.
if [[ "${1:-} ${2:-}" == "api graphql" ]]; then
  [[ -f "$GH_STUB_DIR/twins.json" ]] || exit 1
  cat "$GH_STUB_DIR/twins.json"; exit 0
fi
if [[ "${1:-}" == "repo" && "${2:-}" == "view" ]]; then
  echo "testowner/testrepo"; exit 0
fi
if [[ "${1:-}" == "api" && "${2:-}" == *"/compare/"* ]]; then
  [[ -f "$GH_STUB_DIR/compare_status" ]] || exit 1
  cat "$GH_STUB_DIR/compare_status"; exit 0
fi

case "${1:-} ${2:-}" in
  "api user") echo "testuser" ;;
  "run list") cat "$GH_STUB_DIR/runs.json" ;;
  "issue comment")
    args=("$@")
    for ((i = 0; i < ${#args[@]}; i++)); do
      if [[ "${args[$i]}" == "--body" ]]; then printf '%s' "${args[$((i + 1))]}" >"$GH_STUB_DIR/posted.md"; fi
    done
    ;;
  *) echo "stub: unhandled gh $*" >&2; exit 64 ;;
esac
STUB
chmod +x "$STUB_BIN/gh"

# `git rev-parse <sha>^{commit}` is used to expand a short SHA; the stub echoes
# back whatever it is given so the tests can pass full SHAs directly.
cat >"$STUB_BIN/git" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "rev-parse" ]]; then
  s="${2%%^*}"
  if [[ -f "$GH_STUB_DIR/expand_to" ]]; then cat "$GH_STUB_DIR/expand_to"; else echo "$s"; fi
  exit 0
fi
exec /usr/bin/git "$@"
STUB
chmod +x "$STUB_BIN/git"

new_case() { # new_case <runs.json> → dir
  local dir="$TMP_ROOT/case-$RANDOM$RANDOM"
  mkdir -p "$dir"
  echo "$1" >"$dir/runs.json"
  : >"$dir/gh.log"
  echo "$dir"
}

run_ev() { # run_ev <dir> <args...>
  local dir="$1"; shift
  set +e
  LAST_OUT=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$dir" bash "$SCRIPT" "$@" 2>&1)
  LAST_RC=$?
  set -e
}

expect() { # expect <desc> <want-rc> <grep-pattern>
  if [[ "$LAST_RC" -eq "$2" ]] && grep -qF -- "$3" <<<"$LAST_OUT"; then
    pass "$1"
  else
    fail "$1 — rc=$LAST_RC want=$2, out: $LAST_OUT"
  fi
}

GOOD_RUNS=$(jq -nc --arg sha "$MERGE_SHA" \
  '[{databaseId: 987, conclusion: "success", headSha: $sha, workflowName: "release-ralph.yml"}]')
WRONG_SHA_RUNS=$(jq -nc --arg sha "$OTHER_SHA" \
  '[{databaseId: 987, conclusion: "success", headSha: $sha, workflowName: "release-ralph.yml"}]')
FAILED_RUNS=$(jq -nc --arg sha "$MERGE_SHA" \
  '[{databaseId: 987, conclusion: "failure", headSha: $sha, workflowName: "release-ralph.yml"}]')

echo "== argument validation =="

dir=$(new_case '[]')
run_ev "$dir" 1697 --kind vibes --notes "x"
expect "an unknown kind is refused" 2 "--kind must be run|observation|settings"

dir=$(new_case '[]')
run_ev "$dir" 1697 --kind settings --check "true"
expect "--notes is mandatory — evidence must say what is live" 2 "--notes is required"

dir=$(new_case '[]')
run_ev "$dir" 1697 --kind settings --notes "it is live"
expect "settings/observation evidence needs at least one --check" 2 "requires at least one --check"

dir=$(new_case '[]')
run_ev "$dir" 1697 --kind run --notes "x" --merge-sha "$MERGE_SHA"
expect "kind=run needs --workflow" 2 "requires --workflow"

dir=$(new_case '[]')
run_ev "$dir" 1697 --kind run --notes "x" --workflow release-ralph.yml
expect "kind=run needs --merge-sha" 2 "requires --merge-sha"

echo "== kind=run is bound to the merge SHA =="

dir=$(new_case "$GOOD_RUNS")
run_ev "$dir" 1697 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" \
  --notes "release-ralph fired on the merge" --dry-run
expect "a successful run AT the merge SHA produces evidence" 0 "ralph-apply-evidence:v1"
if jq -e --arg s "$MERGE_SHA" '.merge_sha == $s and .run.head_sha == $s and .run.id == 987' \
     <<<"$(sed -n '/```json/,/```/p' <<<"$LAST_OUT" | sed '1d;$d')" >/dev/null; then
  pass "run id + head_sha are RESOLVED from the API, not hand-typed"
else
  fail "run id + head_sha resolution — payload: $LAST_OUT"
fi

dir=$(new_case "$WRONG_SHA_RUNS")
run_ev "$dir" 1697 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" --notes "x" --dry-run
expect "a green run of the PRE-merge code posts NOTHING" 1 "no SUCCESSFUL run of release-ralph.yml"

dir=$(new_case "$FAILED_RUNS")
run_ev "$dir" 1697 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" --notes "x" --dry-run
expect "a FAILED run at the right SHA posts nothing either" 1 "no SUCCESSFUL run"

dir=$(new_case '[]')
run_ev "$dir" 1697 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" --notes "x" --dry-run
expect "no runs at all ⇒ nothing to attest" 1 "no SUCCESSFUL run"

dir=$(new_case "$GOOD_RUNS")
echo "$MERGE_SHA" >"$dir/expand_to"
run_ev "$dir" 1697 --kind run --workflow release-ralph.yml --merge-sha "a1b2c3d" --notes "x" --dry-run
expect "a SHORT --merge-sha is expanded before binding" 0 "ralph-apply-evidence:v1"

echo "== ancestry: the bound run must descend from the fix merge (GH-1961) =="

FIX_SHA="ffffeeee11112222333344445555666677778888"
STACKED_SHA="aaaabbbbccccddddeeeeffff0000111122223333"
twins_json() { # twins_json <closing-pr-nodes-json>
  jq -nc --argjson prs "$1" \
    '{data:{repository:{defaultBranchRef:{name:"main"},issue:{blockedBy:{nodes:[
       {number: 1952, closedByPullRequestsReferences:{nodes: $prs}}]}}}}}'
}
TWINS=$(twins_json "$(jq -nc --arg fix "$FIX_SHA" \
  '[{number:1955, merged:true, baseRefName:"main", mergeCommit:{oid:$fix}}]')")

ancestry_case() { # ancestry_case <compare-status> [twins-json] → dir
  local d; d=$(new_case "$GOOD_RUNS")
  echo "$1" >"$d/compare_status"
  [[ $# -lt 2 ]] || echo "$2" >"$d/twins.json"
  echo "$d"
}

payload_of() { sed -n '/```json/,/```/p' <<<"$LAST_OUT" | sed '1d;$d'; }

dir=$(ancestry_case behind "$TWINS")
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" --notes "x" --dry-run
expect "a run that PREDATES the fix merge posts nothing" 1 "does NOT descend from the fix merge"

dir=$(ancestry_case diverged "$TWINS")
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" --notes "x" --dry-run
expect "a diverged run is refused too" 1 "does NOT descend from the fix merge"

dir=$(ancestry_case identical "$TWINS")
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" --notes "x" --dry-run
expect "a run AT the fix merge is accepted" 0 "ralph-apply-evidence:v1"
if jq -e --arg f "$FIX_SHA" '.ancestry.status == "descends" and .ancestry.checked[0].fix_merge == $f
      and (.ancestry.checked[0].source | test("derived"))' <<<"$(payload_of)" >/dev/null; then
  pass "the fix merge is DERIVED from the blockedBy twin, not typed"
else
  fail "derived fix merge — payload: $(payload_of)"
fi

dir=$(ancestry_case ahead "$TWINS")
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" --notes "x" --dry-run
expect "a run above the fix merge is accepted" 0 "ralph-apply-evidence:v1"

# An unwired twin must not fail the check — settings-only apply units legitimately
# have no ship issue. But it must SAY so, in the payload, not go quiet.
dir=$(ancestry_case behind)
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" --notes "x" --dry-run
expect "an unreadable twin does not block, but warns" 0 "ancestry NOT CHECKED"
if jq -e '.ancestry.status == "not_evaluated" and (.ancestry.reason | length) > 0' <<<"$(payload_of)" >/dev/null; then
  pass "not_evaluated is RECORDED with a reason — never silence"
else
  fail "not_evaluated recording — payload: $(payload_of)"
fi

dir=$(ancestry_case identical "$(jq -nc '{data:{repository:{issue:{blockedBy:{nodes:[]}}}}}')")
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" --notes "x" --dry-run
expect "no blocked-by twin ⇒ not evaluated, not refused" 0 "no blocked-by twin with a closing PR merged"

# --fix-merge makes an unevaluable unit evaluable — and is still a real gate.
dir=$(ancestry_case behind)
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" \
  --fix-merge "$FIX_SHA" --notes "x" --dry-run
expect "--fix-merge is checked, not merely recorded" 1 "does NOT descend from the fix merge"

dir=$(ancestry_case ahead "$TWINS")
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" \
  --fix-merge "$FIX_SHA" --notes "x" --dry-run
if jq -e '.ancestry.checked[0].source | test("operator")' <<<"$(payload_of)" >/dev/null; then
  pass "--fix-merge overrides derivation and is labelled as an operator assertion"
else
  fail "--fix-merge provenance — payload: $(payload_of)"
fi

# A question with a subject that went unanswered is NOT the not_evaluated case.
# Posting there would rebuild the defect this check removes: a failed read
# rendering as a pass, in evidence no later reader re-opens (PR #1962 review).
dir=$(new_case "$GOOD_RUNS")
echo "$TWINS" >"$dir/twins.json"   # no compare_status ⇒ the compare API does not answer
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" --notes "x" --dry-run
expect "an UNANSWERED compare refuses — it never renders as a pass" 1 "could not determine whether"

# A PR merged into some other base may never become an ancestor of the default
# branch; counting it would refuse honest evidence forever.
dir=$(ancestry_case identical "$(twins_json "$(jq -nc --arg fix "$FIX_SHA" --arg st "$STACKED_SHA" \
  '[{number:1955, merged:true, baseRefName:"main", mergeCommit:{oid:$fix}},
    {number:1956, merged:true, baseRefName:"feat/stacked-base", mergeCommit:{oid:$st}}]')")")
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" --notes "x" --dry-run
if [[ "$LAST_RC" -eq 0 ]] && jq -e --arg f "$FIX_SHA" --arg s "$STACKED_SHA" \
     '([.ancestry.checked[].fix_merge] == [$f])' <<<"$(payload_of)" >/dev/null; then
  pass "only PRs merged to the DEFAULT branch become required ancestors"
else
  fail "default-branch filter — rc=$LAST_RC payload: $(payload_of)"
fi

# Ancestry is a kind=run concern only: settings evidence has no run to place.
dir=$(new_case '[]')
run_ev "$dir" 1953 --kind settings --notes "label exists" --check "true" --dry-run
if [[ "$LAST_RC" -eq 0 ]] && ! grep -q 'ancestry' <<<"$LAST_OUT"; then
  pass "kind=settings carries no ancestry claim"
else
  fail "kind=settings ancestry — rc=$LAST_RC out: $LAST_OUT"
fi

echo "== checks record REAL exit codes =="

dir=$(new_case '[]')
run_ev "$dir" 1697 --kind settings --notes "label exists" --check "true" --check "false" --dry-run
payload=$(sed -n '/```json/,/```/p' <<<"$LAST_OUT" | sed '1d;$d')
if jq -e '(.checks | length) == 2 and .checks[0].exit_code == 0 and .checks[1].exit_code == 1' <<<"$payload" >/dev/null; then
  pass "a failing check is recorded truthfully, not dropped"
else
  fail "check exit codes — payload: $payload"
fi
if jq -e '.actor == "testuser" and (.applied_at | test("^[0-9]{4}-"))' <<<"$payload" >/dev/null; then
  pass "actor and applied_at are stamped from the environment, not typed"
else
  fail "actor/applied_at — payload: $payload"
fi

echo "== posting =="

dir=$(new_case '[]')
run_ev "$dir" 1697 --kind settings --notes "it is live" --check "true"
expect "posts the comment and says how to close" 0 "APPLY EVIDENCE POSTED"
expect "and names the close command" 0 "board move 1697 done"
if grep -qF 'ralph-apply-evidence:v1' "$dir/posted.md"; then
  pass "the posted body carries the marker"
else
  fail "posted body missing the marker"
fi

dir=$(new_case '[]')
run_ev "$dir" 1697 --kind settings --notes "it is live" --check "true" --dry-run
if [[ ! -f "$dir/posted.md" ]]; then pass "--dry-run posts nothing"; else fail "--dry-run posted anyway"; fi


echo "== review-hardened edges (CodeRabbit, PR #1700) =="

dir=$(new_case '[]')
run_ev "$dir" 1697 --kind settings --notes "x" --check
expect "a trailing flag with no value prints usage, not a bare exit 1" 2 "requires a non-empty value"

dir=$(new_case '[]')
run_ev "$dir" 1697 --kind
expect "a trailing --kind likewise" 2 "requires a non-empty value"

dir=$(new_case '[]')
run_ev "$dir" 1697 --bogus
if grep -qF -- "design rationale" <<<"$LAST_OUT"; then
  fail "usage extract leaks the design rationale"
else
  pass "usage prints the usage block only, not the rationale below it"
fi

# A long check output used to die on EPIPE: `head -20` closes the pipe, echo
# takes SIGPIPE, and pipefail+errexit aborted AFTER the checks had run.
dir=$(new_case '[]')
# Bash-only generator: an absent `seq` would exit 127 and the dry run would
# still emit evidence, so the assertion would pass without ever producing
# output longer than the 20-line preview.
run_ev "$dir" 1697 --kind settings --notes "long output" \
  --check 'for i in $(printf "%s " {1..500}); do echo "line $i"; done' --dry-run
expect "a check whose output exceeds the preview does not abort the script" 0 "ralph-apply-evidence:v1"
payload=$(sed -n '/```json/,/```/p' <<<"$LAST_OUT" | sed '1d;$d')
if jq -e '.checks[0].exit_code == 0' <<<"$payload" >/dev/null; then
  pass "and the long-output check really ran (exit 0, not a 127 from a missing tool)"
else
  fail "long-output check did not run cleanly — payload: $payload"
fi

dir=$(new_case '[]')
run_ev "$dir" 1697 --kind settings --notes "x" --check "" --dry-run
expect "an EMPTY --check is rejected, not recorded as a passing no-op" 2 "requires a non-empty value"

echo
echo "apply-evidence.test.sh: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
