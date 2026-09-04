#!/usr/bin/env bash
# scripts/__tests__/approve-deploy.test.sh
# Contract tests for scripts/approve-deploy.sh (GH-2451).
#
# The load-bearing claims under test: the grant in
# .github/ralph-merge-policy.json's `environments` block decides what this
# script may do (approve / escalate / refuse), "prod"/"production" cannot be
# granted autonomous or lead no matter what the policy says, and a GitHub
# refusal to approve is surfaced verbatim rather than caught and routed
# around.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/approve-deploy.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

SHA="a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"

STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"

# A no-op sleep keeps the bounded poll loop in approve-deploy.sh from
# actually waiting real wall-clock time in the "run still building" case.
cat >"$STUB_BIN/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$STUB_BIN/sleep"

# Handles both approve-deploy.sh's own gh calls (pending_deployments GET/POST,
# the run-status poll) and everything apply-evidence.sh needs once a
# successful autonomous approval execs into it (run list, repo view, the
# ancestry twin query, compare, issue comment) — the same shape
# apply-evidence.test.sh's stub uses, since approve-deploy.sh reuses that
# script rather than duplicating its evidence-posting logic.
cat >"$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
echo "gh $*" >>"$GH_STUB_DIR/gh.log"
joined="$*"

case "$joined" in
  *"actions/runs/"*"/pending_deployments"*"-X POST"*)
    if [[ -f "$GH_STUB_DIR/approve_fails" ]]; then
      echo "gh: HTTP 422: Not a required reviewer for this deployment (https://docs.github.com/rest)" >&2
      exit 1
    fi
    echo "$joined" >>"$GH_STUB_DIR/approve_calls.log"
    echo '[]'
    exit 0
    ;;
  *"actions/runs/"*"/pending_deployments"*)
    [[ -f "$GH_STUB_DIR/pending.json" ]] || { echo '[]'; exit 0; }
    cat "$GH_STUB_DIR/pending.json"
    exit 0
    ;;
  *"actions/runs/"*)
    [[ -f "$GH_STUB_DIR/run.json" ]] || { echo '{}'; exit 0; }
    cat "$GH_STUB_DIR/run.json"
    exit 0
    ;;
esac

if [[ "${1:-} ${2:-}" == "api graphql" ]]; then
  [[ -f "$GH_STUB_DIR/twins.json" ]] || exit 1
  cat "$GH_STUB_DIR/twins.json"; exit 0
fi
if [[ "${1:-}" == "repo" && "${2:-}" == "view" ]]; then
  echo "testowner/testrepo"; exit 0
fi
if [[ "${1:-}" == "api" && "${2:-}" == *"/compare/"* ]]; then
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

cat >"$STUB_BIN/git" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "rev-parse" ]]; then
  if [[ "${2:-}" == "--show-toplevel" ]]; then echo "$GH_STUB_DIR"; exit 0; fi
  echo "${2%%^*}"; exit 0
fi
exec /usr/bin/git "$@"
STUB
chmod +x "$STUB_BIN/git"

new_case() { # new_case → dir, with a policy file the caller fills in
  local dir="$TMP_ROOT/case-$RANDOM$RANDOM"
  mkdir -p "$dir/.github"
  : >"$dir/gh.log"
  echo "$dir"
}

run_ad() { # run_ad <dir> <policy-json> <args...>
  local dir="$1" policy="$2"; shift 2
  echo "$policy" >"$dir/.github/ralph-merge-policy.json"
  set +e
  LAST_OUT=$(PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$dir" RALPH_MERGE_POLICY_FILE="$dir/.github/ralph-merge-policy.json" \
    RALPH_APPROVE_DEPLOY_POLL_SEC=1 RALPH_APPROVE_DEPLOY_TIMEOUT_SEC=2 \
    bash "$SCRIPT" "$@" 2>&1)
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

POLICY='{ "environments": { "staging": "autonomous", "qa": "lead", "prod": "autonomous" } }'

PENDING=$(jq -nc '[{environment: {id: 555, name: "staging"}}, {environment: {id: 556, name: "qa"}}, {environment: {id: 557, name: "prod"}}]')
RUN_DONE=$(jq -nc --arg sha "$SHA" '{status: "completed", conclusion: "success", head_sha: $sha, name: "deploy.yml"}')
RUN_BUILDING=$(jq -nc '{status: "in_progress", conclusion: null, head_sha: "", name: "deploy.yml"}')
GOOD_RUNS_FOR_EVIDENCE=$(jq -nc --arg sha "$SHA" '[{databaseId: 42, conclusion: "success", headSha: $sha, workflowName: "deploy.yml"}]')
NO_TWINS=$(jq -nc '{data:{repository:{defaultBranchRef:{name:"main"},issue:{blockedBy:{nodes:[]}}}}}')

echo "== argument validation =="

dir=$(new_case)
run_ad "$dir" "$POLICY"
expect "missing args → usage refusal" 2 "Usage:"

dir=$(new_case)
run_ad "$dir" "$POLICY" 2451 4242
expect "missing --env → refused" 2 "--env is required"

echo "== human grant: refuses outright, names the policy file =="

dir=$(new_case)
echo "$PENDING" >"$dir/pending.json"
run_ad "$dir" '{ "environments": { "review-app": "human" } }' 2451 4242 --env review-app
expect "human grant refuses" 1 "cannot approve it"
expect "human grant names the policy file" 1 "ralph-merge-policy.json"
if [[ ! -f "$dir/approve_calls.log" ]]; then pass "human grant never calls the approve API"; else fail "human grant should not approve" "approve_calls.log exists"; fi

echo "== reserved set: prod/production are ALWAYS human, regardless of config =="

dir=$(new_case)
echo "$PENDING" >"$dir/pending.json"
run_ad "$dir" "$POLICY" 2451 4242 --env prod
expect "prod configured autonomous is still refused as human" 1 "cannot approve it"

dir=$(new_case)
echo "$PENDING" >"$dir/pending.json"
run_ad "$dir" "$POLICY" 2451 4242 --env PRODUCTION
expect "PRODUCTION (case-insensitive, unconfigured) is refused as human" 1 "cannot approve it"
if [[ ! -f "$dir/approve_calls.log" ]]; then pass "reserved env never calls the approve API"; else fail "reserved env should not approve" "approve_calls.log exists"; fi

echo "== lead grant: escalates, never approves =="

dir=$(new_case)
echo "$PENDING" >"$dir/pending.json"
run_ad "$dir" "$POLICY" 2451 4242 --env qa
expect "lead grant refuses to approve" 1 "not approving run 4242"
expect "lead grant prints the board escalation command" 1 "board move 2451 human-needed --why"
if [[ ! -f "$dir/approve_calls.log" ]]; then pass "lead grant never calls the approve API"; else fail "lead grant should not approve" "approve_calls.log exists"; fi

echo "== no pending deployment for the named environment =="

dir=$(new_case)
echo "$PENDING" >"$dir/pending.json"
run_ad "$dir" "$POLICY" 2451 4242 --env prealpha
expect "unconfigured (default-human) env name is refused as human, before pending lookup" 1 "cannot approve it"

dir=$(new_case)
echo "$PENDING" >"$dir/pending.json"
run_ad "$dir" '{ "environments": { "canary": "autonomous" } }' 2451 4242 --env canary
expect "a granted environment absent from pending_deployments is refused" 1 "no pending deployment for environment 'canary'"

echo "== autonomous grant: GitHub's own refusal is verbatim, never routed around =="

dir=$(new_case)
echo "$PENDING" >"$dir/pending.json"
: >"$dir/approve_fails"
run_ad "$dir" "$POLICY" 2451 4242 --env staging
expect "a GitHub-refused approval surfaces GitHub's own message" 1 "Not a required reviewer"
expect "a GitHub-refused approval is not silently passed" 1 "nothing routed around it"

echo "== autonomous grant: approves, waits, and posts evidence via apply-evidence.sh =="

dir=$(new_case)
echo "$PENDING" >"$dir/pending.json"
echo "$RUN_DONE" >"$dir/run.json"
echo "$GOOD_RUNS_FOR_EVIDENCE" >"$dir/runs.json"
echo "$NO_TWINS" >"$dir/twins.json"
run_ad "$dir" "$POLICY" 2451 4242 --env staging
expect "a completed successful run posts apply evidence" 0 "APPLY EVIDENCE POSTED"
if grep -qF "environment_ids[]=555" "$dir/approve_calls.log" 2>/dev/null; then
  pass "the correct environment id (555, staging) was approved"
else
  fail "environment id resolution" "$(cat "$dir/approve_calls.log" 2>/dev/null || echo "no approve_calls.log")"
fi
if grep -qF "state=approved" "$dir/approve_calls.log" 2>/dev/null; then
  pass "the approval call carries state=approved"
else
  fail "state=approved missing" "$(cat "$dir/approve_calls.log" 2>/dev/null || echo "no approve_calls.log")"
fi

echo "== autonomous grant: run does not conclude within the bound → no evidence, no hang =="

dir=$(new_case)
echo "$PENDING" >"$dir/pending.json"
echo "$RUN_BUILDING" >"$dir/run.json"
run_ad "$dir" "$POLICY" 2451 4242 --env staging
expect "a run still building times out cleanly" 75 "has not completed after"
expect "the timeout tells the operator how to post evidence later" 75 "scripts/apply-evidence.sh 2451"

echo "== autonomous grant: a concluded but FAILED run posts no evidence =="

dir=$(new_case)
echo "$PENDING" >"$dir/pending.json"
echo "$RUN_DONE" | jq '.conclusion = "failure"' >"$dir/run.json"
run_ad "$dir" "$POLICY" 2451 4242 --env staging
expect "a failed run is refused, nothing posted" 1 "concluded 'failure', not 'success'"

echo "== malformed policy fails closed =="

dir=$(new_case)
echo "$PENDING" >"$dir/pending.json"
run_ad "$dir" '{ "environments": { "staging": "sometimes" } }' 2451 4242 --env staging
expect "an unrecognized grant value refuses (fail closed)" 2 "malformed"

echo
echo "approve-deploy: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
