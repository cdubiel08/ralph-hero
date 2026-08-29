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
  # A present fixture makes repo resolution FAIL — the fourth read-failure path
  # (GH-2261), which never reaches the API at all.
  [[ -f "$GH_STUB_DIR/repo_view_fails" ]] && exit 1
  echo "testowner/testrepo"; exit 0
fi
if [[ "${1:-}" == "api" && "${2:-}" == *"/compare/"* ]]; then
  # Two different compares share this path: "did the candidate LAND on the
  # default branch" (head is a branch name) and "does the run DESCEND from the
  # fix" (head is a 40-hex sha). Keyed apart so a test can set them separately.
  head="${2##*...}"
  if [[ "$head" =~ ^[0-9a-f]{40}$ ]]; then f=compare_status; else f=landed_status; fi
  [[ -f "$GH_STUB_DIR/$f" ]] || exit 1
  cat "$GH_STUB_DIR/$f"; exit 0
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

# A twin query that SUCCEEDS and finds no ship twin — the settings-only shape.
# Cases not about ancestry use it so their subject stays the one under test: an
# absent fixture means the read FAILED, which is now a refusal in its own right
# (GH-2261) and would mask whatever else the case was asserting.
NO_TWINS=$(jq -nc '{data:{repository:{defaultBranchRef:{name:"main"},issue:{blockedBy:{nodes:[]}}}}}')

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
echo "$NO_TWINS" >"$dir/twins.json"
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
echo "$NO_TWINS" >"$dir/twins.json"
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
  echo "ahead" >"$d/landed_status"   # by default every candidate landed
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

# A read that FAILED and a subject that is genuinely ABSENT are opposite facts,
# and folding them into one `not_evaluated` rendering is what let a flapping API
# produce evidence the close gate admitted (GH-2261). BOTH directions are pinned
# here on purpose: a suite asserting only the refusal would pass against an
# implementation that refuses in both cases, which breaks every settings-only
# apply unit — the population `no_subject` exists to serve.
dir=$(ancestry_case behind)   # no twins.json ⇒ the graphql read FAILS
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" --notes "x" --dry-run
expect "an UNREADABLE twin refuses — a failed read is not an absent subject" 1 "could not read the blocked-by twin"
if grep -qF "blocked_by_twin" <<<"$LAST_OUT" && ! grep -qF 'ralph-apply-evidence:v1' <<<"$LAST_OUT"; then
  pass "the refusal names WHICH read failed, and emits no evidence"
else
  fail "unreadable-twin refusal shape — out: $LAST_OUT"
fi

# The fourth path: `gh repo view` fails, so `nwo` is empty and the twin query is
# never issued. It must not borrow the API-read message for a read that never
# reached the API.
dir=$(ancestry_case behind "$TWINS")
: >"$dir/repo_view_fails"
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" --notes "x" --dry-run
expect "an unresolvable repo refuses with its OWN reason" 1 "could not resolve this repository"
if grep -qF "repo_resolution" <<<"$LAST_OUT"; then
  pass "repo resolution failure is named apart from the API read"
else
  fail "repo-resolution reason — out: $LAST_OUT"
fi

# An unreadable default branch cannot run the reachability test, so it cannot
# say which fixes landed — the same failed read, one block further in.
dir=$(ancestry_case identical "$(jq -nc --arg fix "$FIX_SHA" \
  '{data:{repository:{issue:{blockedBy:{nodes:[{number:1952,closedByPullRequestsReferences:{nodes:[
     {number:1955, merged:true, baseRefName:"main", mergeCommit:{oid:$fix}}]}}]}}}}}')")
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" --notes "x" --dry-run
expect "an unreadable default branch refuses too" 1 "could not read the default branch"

# The other direction, and the one that must NOT become a refusal: the query
# succeeded and there is genuinely no ship twin.
dir=$(ancestry_case identical "$NO_TWINS")
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" --notes "x" --dry-run
expect "no blocked-by twin ⇒ not evaluated, not refused" 0 "no blocked-by twin with a merged closing PR"
if jq -e '.ancestry.status == "not_evaluated" and .ancestry.reason_code == "no_subject"
      and (.ancestry.reason | length) > 0' <<<"$(payload_of)" >/dev/null; then
  pass "not_evaluated is TYPED no_subject and still carries its human reason"
else
  fail "no_subject typing — payload: $(payload_of)"
fi

# --fix-merge makes a subject-less unit evaluable — and is still a real gate.
dir=$(ancestry_case behind "$NO_TWINS")
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" \
  --fix-merge "$FIX_SHA" --notes "x" --dry-run
expect "--fix-merge is checked, not merely recorded" 1 "does NOT descend from the fix merge"

dir=$(ancestry_case ahead "$NO_TWINS")
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" \
  --fix-merge "$FIX_SHA" --notes "x" --dry-run
if jq -e '.ancestry.checked[0].source | test("operator")' <<<"$(payload_of)" >/dev/null; then
  pass "--fix-merge is labelled as an operator assertion, not as derived truth"
else
  fail "--fix-merge provenance — payload: $(payload_of)"
fi

# --fix-merge ADDS to the derived set and can never replace it, so it cannot
# rescue a read failure either: proceeding on an operator sha while the
# derivation is unknown is exactly "name a weak ancestor and skip the real fix".
dir=$(ancestry_case ahead)   # no twins.json ⇒ the read FAILS
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" \
  --fix-merge "$FIX_SHA" --notes "x" --dry-run
expect "--fix-merge does not rescue a failed read" 1 "could not read the blocked-by twin"

# An override that SUPPRESSED derivation would let an operator name a weak
# ancestor and skip the real fix — this issue's own defect handed a flag.
dir=$(ancestry_case identical "$TWINS")
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" \
  --fix-merge "$STACKED_SHA" --notes "x" --dry-run
if [[ "$LAST_RC" -eq 0 ]] && jq -e --arg f "$FIX_SHA" --arg s "$STACKED_SHA" \
     '([.ancestry.checked[].fix_merge] | sort) == ([$f, $s] | sort)' <<<"$(payload_of)" >/dev/null; then
  pass "--fix-merge ADDS to the derived set — it can never suppress it"
else
  fail "--fix-merge augmentation — rc=$LAST_RC payload: $(payload_of)"
fi

# A question with a subject that went unanswered is NOT the not_evaluated case.
# Posting there would rebuild the defect this check removes: a failed read
# rendering as a pass, in evidence no later reader re-opens (PR #1962 review).
dir=$(new_case "$GOOD_RUNS")
echo "$TWINS" >"$dir/twins.json"
echo "ahead" >"$dir/landed_status"   # no compare_status ⇒ the ancestry compare does not answer
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" --notes "x" --dry-run
expect "an UNANSWERED compare refuses — it never renders as a pass" 1 "could not determine whether"

# A merge that never landed on the default branch (a stacked base) can never
# become an ancestor; requiring it would refuse honest evidence forever.
dir=$(ancestry_case identical "$TWINS")
echo "behind" >"$dir/landed_status"
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" --notes "x" --dry-run
expect "a merge that never landed is not a required ancestor" 0 "not reachable from main"

# Candidates are filtered by REACHABILITY, not by the PR's recorded base name —
# a branch rename must not discard a real fix merge.
dir=$(ancestry_case identical "$(twins_json "$(jq -nc --arg fix "$FIX_SHA" \
  '[{number:1955, merged:true, baseRefName:"master", mergeCommit:{oid:$fix}}]')")")
run_ev "$dir" 1953 --kind run --workflow release-ralph.yml --merge-sha "$MERGE_SHA" --notes "x" --dry-run
if [[ "$LAST_RC" -eq 0 ]] && jq -e --arg f "$FIX_SHA" '[.ancestry.checked[].fix_merge] == [$f]' \
     <<<"$(payload_of)" >/dev/null; then
  pass "a renamed default branch does not discard the fix merge"
else
  fail "rename resilience — rc=$LAST_RC payload: $(payload_of)"
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
