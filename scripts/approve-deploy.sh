#!/usr/bin/env bash
# scripts/approve-deploy.sh — the per-environment deploy gate (GH-2451).
#
# Usage:
#   scripts/approve-deploy.sh ISSUE RUN --env ENV [--notes TEXT] [--dry-run]
#
#   ISSUE   the apply unit this deploy closes (its evidence lands there)
#   RUN     the GitHub Actions run id holding the pending deployment
#   --env   the deployment environment name (as configured on GitHub)
#
# `environments.<name>: autonomous | lead | human` in
# .github/ralph-merge-policy.json (scripts/lib/merge-evidence.sh is the one
# reader) decides what this script may do for ENV. The environment is a
# property of the ACTION being approved, never of the session running this
# script — no env var selects a grant.
#
#   autonomous  approve the run's pending deployment via the GitHub API, wait
#               for the run to conclude, then post ralph-apply-evidence:v1
#               (kind=run) on ISSUE — the same shape scripts/apply-evidence.sh
#               produces, reusing that script rather than a second copy.
#   lead        refuse to approve; print the `board move` command that
#               escalates ISSUE (routes to the lead when RALPH_HERDR_LEAD is
#               set — GH-2179 — else to the human; this script never runs it).
#   human       refuse outright, naming this policy file. No escalation
#               suggestion: an environment graded "human" has no agent path
#               at all, not even a routed one.
#
# "prod"/"production" read "human" NO MATTER WHAT THE POLICY SAYS — dispatch's
# reserved-set item 4 (irreversible outside the repo) is enforced in
# me_environment_grant, not by convention here.
#
# GitHub's own refusal (the token is not a required reviewer, self-approval,
# whatever) is printed VERBATIM and this script exits non-zero. It is never
# caught and re-routed — an autonomous grant that GitHub itself declines is a
# policy/permissions mismatch to fix, not a signal to fall back to lead/human.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/gh-budget.sh
. "$HERE/lib/gh-budget.sh"
# shellcheck source=lib/merge-evidence.sh
. "$HERE/lib/merge-evidence.sh"

usage() {
  sed -n '4,9p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

ISSUE=""
RUN=""
ENV_NAME=""
NOTES=""
DRY_RUN=false

needs_value() { [[ $# -ge 2 && -n "$2" ]] || { echo "ERROR: $1 requires a non-empty value" >&2; usage; }; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)      needs_value "$@"; ENV_NAME="$2"; shift 2 ;;
    --notes)    needs_value "$@"; NOTES="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=true; shift ;;
    -*)         usage ;;
    *)
      if [[ -z "$ISSUE" ]]; then ISSUE="$1";
      elif [[ -z "$RUN" ]]; then RUN="$1";
      else usage; fi
      shift ;;
  esac
done

[[ -n "$ISSUE" && "$ISSUE" =~ ^[0-9]+$ ]] || usage
[[ -n "$RUN" && "$RUN" =~ ^[0-9]+$ ]] || usage
[[ -n "$ENV_NAME" ]] || { echo "ERROR: --env is required — the deployment environment name" >&2; exit 2; }

# Validated up front, before anything talks to GitHub: a config error caught
# only once the poll loop starts would fire AFTER the deployment approval
# below already went through, leaving an approved-but-unevidenced deployment
# behind. A bad knob must refuse before the first irreversible action, not
# after it (poll_sec 0 never advances elapsed; a negative/non-numeric value
# kills `sleep` mid-loop under `set -e` — same posture as
# RALPH_CLAIM_MAX_ESTIMATE elsewhere in this repo: a loud refusal, never a
# silent misbehavior).
timeout_sec="${RALPH_APPROVE_DEPLOY_TIMEOUT_SEC:-900}"
poll_sec="${RALPH_APPROVE_DEPLOY_POLL_SEC:-15}"
# Bounded to 9 digits (< 1e9, ~31 years — comfortably past any sane value) so
# the regex itself rejects an oversized string. Without the length cap, a
# digits-only value past bash's 64-bit integer range wraps during the `-gt`
# arithmetic comparison (undefined which way), so an absurd input could read
# as a small positive number and pass validation after all (GH-2451 review).
[[ "$timeout_sec" =~ ^[0-9]{1,9}$ && "$timeout_sec" -gt 0 ]] || {
  echo "ERROR: RALPH_APPROVE_DEPLOY_TIMEOUT_SEC must be a positive integer, at most 9 digits (got '$timeout_sec')" >&2
  exit 2
}
[[ "$poll_sec" =~ ^[0-9]{1,9}$ && "$poll_sec" -gt 0 ]] || {
  echo "ERROR: RALPH_APPROVE_DEPLOY_POLL_SEC must be a positive integer, at most 9 digits (got '$poll_sec')" >&2
  exit 2
}

POLICY_FILE=$(me_policy_file)
policy=""
if ! policy=$(me_policy_load "$POLICY_FILE"); then
  echo "ERROR: $POLICY_FILE is malformed — cannot read environment grants. Fix the file (fails closed)." >&2
  exit 2
fi

GRANT=$(me_environment_grant "$policy" "$ENV_NAME")
echo "--- environment '$ENV_NAME' grant: $GRANT (per $POLICY_FILE)"

# --- human: no agent path exists, at all ------------------------------------
if [[ "$GRANT" == "human" ]]; then
  echo "ERROR: environment '$ENV_NAME' is graded 'human' in $POLICY_FILE — this script" >&2
  echo "       cannot approve it, and there is no escalation route around that: a human" >&2
  echo "       must approve run $RUN in the GitHub Actions UI (or via a scoped human" >&2
  echo "       token) themselves. 'prod'/'production' are graded 'human' by construction" >&2
  echo "       regardless of what the file says (GH-2451)." >&2
  exit 1
fi

# --- resolve the pending deployment for ENV on RUN --------------------------
# Streams captured separately: a benign stderr line (a gh deprecation notice,
# say) must not corrupt the JSON stdout jq parses below into a false "no
# pending deployment" reading.
pending_err=$(mktemp)
pending_json=$(gh api "repos/{owner}/{repo}/actions/runs/$RUN/pending_deployments" 2>"$pending_err") || {
  echo "ERROR: could not read pending deployments for run $RUN:" >&2
  cat "$pending_err" >&2
  rm -f "$pending_err"
  exit 1
}
rm -f "$pending_err"
env_id=$(jq -r --arg e "$ENV_NAME" '[.[] | select(.environment.name == $e)] | first | .environment.id // empty' <<<"$pending_json")
if [[ -z "$env_id" ]]; then
  echo "ERROR: no pending deployment for environment '$ENV_NAME' on run $RUN. Seen: $(jq -c '[.[].environment.name]' <<<"$pending_json" 2>/dev/null || echo "$pending_json")" >&2
  exit 1
fi

# --- lead: escalate, never approve -------------------------------------------
if [[ "$GRANT" == "lead" ]]; then
  why="deploy approval needed: environment '$ENV_NAME' (grant=lead per $POLICY_FILE), run $RUN pending"
  echo "environment '$ENV_NAME' requires lead approval — not approving run $RUN."
  echo "escalate with: board move $ISSUE human-needed --why \"$why\""
  echo "(routes to the lead when RALPH_HERDR_LEAD is set, else to the human — GH-2179; this script never runs it itself)"
  exit 1
fi

# --- autonomous: approve, wait for conclusion, post evidence ----------------
[[ "$GRANT" == "autonomous" ]] || { echo "ERROR: unreachable grant value '$GRANT'" >&2; exit 1; }

approve_comment="${NOTES:-approved by ralph (autonomous grant, env=$ENV_NAME, GH-2451)}"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "DRY RUN: would POST repos/{owner}/{repo}/actions/runs/$RUN/pending_deployments" \
       "environment_ids=[$env_id] state=approved comment=\"$approve_comment\""
  exit 0
fi

# gb_gh, not a bare gh call: an exhausted-budget write that GitHub silently
# no-ops must not be reported here as an approval that landed (GH-1817).
# Anything gh itself refuses (not a required reviewer, self-approval, ...) is
# printed VERBATIM by gb_gh — never caught, reworded, or routed around.
rc=0
gb_gh api "repos/{owner}/{repo}/actions/runs/$RUN/pending_deployments" \
  -X POST -f "environment_ids[]=$env_id" -f state=approved -f comment="$approve_comment" \
  >/dev/null || rc=$?
if [[ $rc -eq 4 ]]; then
  echo "APPROVAL NOT SENT — rate limited; re-run this command after the reset" >&2
  exit 75
fi
[[ $rc -eq 0 ]] || { echo "ERROR: GitHub refused the approval (see its message above) — nothing routed around it." >&2; exit "$rc"; }
echo "--- approved: environment '$ENV_NAME' on run $RUN"

# --- wait for the run to conclude, bounded ----------------------------------
elapsed=0
status="" conclusion="" head_sha="" workflow_name=""
while (( elapsed < timeout_sec )); do
  run_json=$(gh api "repos/{owner}/{repo}/actions/runs/$RUN" 2>/dev/null) || run_json=""
  # A read that failed (empty/unparseable run_json) must not CLOBBER the last
  # known-good head_sha/workflow_name — those are what the timeout branch
  # below hands the operator as the recovery command, and an emptied one is a
  # recovery command apply-evidence.sh itself will refuse (--merge-sha/
  # --workflow are required). Only status/conclusion reset on a failed read,
  # since "unreadable" is itself the honest status to report.
  if jq -e . >/dev/null 2>&1 <<<"$run_json"; then
    status=$(jq -r '.status // ""' <<<"$run_json")
    conclusion=$(jq -r '.conclusion // ""' <<<"$run_json")
    new_head_sha=$(jq -r '.head_sha // ""' <<<"$run_json")
    new_workflow_name=$(jq -r '.name // ""' <<<"$run_json")
    [[ -n "$new_head_sha" ]] && head_sha="$new_head_sha"
    [[ -n "$new_workflow_name" ]] && workflow_name="$new_workflow_name"
  else
    status=""
    conclusion=""
  fi
  [[ "$status" == "completed" ]] && break
  sleep "$poll_sec"
  elapsed=$((elapsed + poll_sec))
done

if [[ "$status" != "completed" ]]; then
  echo "WARNING: run $RUN has not completed after ${timeout_sec}s (last status: '${status:-unreadable}')." >&2
  echo "         Approved, but no evidence posted." >&2
  if [[ -n "$head_sha" && -n "$workflow_name" ]]; then
    echo "         Once it finishes, run:" >&2
    echo "         scripts/apply-evidence.sh $ISSUE --kind run --workflow \"$workflow_name\" --merge-sha $head_sha --notes \"...\"" >&2
  else
    # Every poll failed to read the run at all (GH-2451 review): printing a
    # recovery command with empty --workflow/--merge-sha would be a command
    # apply-evidence.sh itself refuses — a fabricated-looking fix that is not
    # one. Point at the run instead of a command that cannot work.
    nwo=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "")
    run_url="${nwo:+https://github.com/$nwo/actions/runs/$RUN}"
    echo "         The run's workflow/commit could not be read even once — check" >&2
    echo "         ${run_url:-run $RUN} directly, then run:" >&2
    echo "         scripts/apply-evidence.sh $ISSUE --kind run --workflow WORKFLOW --merge-sha SHA --notes \"...\"" >&2
  fi
  exit 75
fi

if [[ "$conclusion" != "success" ]]; then
  echo "ERROR: run $RUN concluded '$conclusion', not 'success' — nothing to attest. Posting no evidence." >&2
  exit 1
fi

echo "--- run $RUN concluded success ($workflow_name @ ${head_sha:0:8}) — posting apply evidence"

# --- verify RUN's deployment actually belongs to ISSUE (GH-2469) ------------
#
# ISSUE is operator-supplied argv; a copy-paste error (right RUN, wrong
# ISSUE) would otherwise post evidence — and eventually close — an unrelated
# apply unit. RUN's own head_sha resolves to the PR GitHub associates with
# that commit; ISSUE's cross-reference timeline names every PR that mentions
# it, closing keyword or bare "Refs #N" alike — apply units are deliberately
# never CLOSED by a keyword (CLAUDE.md's "no closing keyword may bind an
# apply unit"), so closingIssuesReferences alone would read empty for every
# correctly-configured apply unit; CROSS_REFERENCED_EVENT catches the
# reference either way, same as a closing one. Overlap between the two sets
# is the confirmation. Either read failing, RUN having no associated PR, or
# ISSUE having no recorded reference yet all degrade to today's
# operator-trusted behaviour — a fixture that can't be read is not evidence
# of a mismatch, and blocking on it would refuse a legitimate deploy that
# just has nothing to cross-check against (e.g. a manual/dispatch run).
nwo=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "")
run_pr_list=""
if [[ -n "$nwo" ]]; then
  run_prs_json=$(gh api "repos/$nwo/commits/$head_sha/pulls" 2>/dev/null || echo "")
  if jq -e 'type == "array"' >/dev/null 2>&1 <<<"$run_prs_json"; then
    run_pr_list=$(jq -r '.[].number' <<<"$run_prs_json")
  fi
fi

if [[ -z "$nwo" || -z "$run_pr_list" ]]; then
  echo "--- linkage: could not resolve a PR for run $RUN's commit ${head_sha:0:8} — proceeding operator-trusted (GH-2469)"
else
  # Own-repo references only: a PR in another repository (a fork, a cross-repo
  # mention) can share the run's PR NUMBER, and a number-only overlap would let
  # it vouch for a deploy it has nothing to do with (PR #2478 review). The
  # source's repository is read and filtered against the run's own.
  issue_refs_json=$(gh api graphql -f owner="${nwo%%/*}" -f repo="${nwo##*/}" -F n="$ISSUE" -f query='
    query($owner:String!,$repo:String!,$n:Int!){
      repository(owner:$owner,name:$repo){ issue(number:$n){
        timelineItems(first:100, itemTypes:[CROSS_REFERENCED_EVENT]){
          pageInfo{ hasNextPage }
          nodes{ ... on CrossReferencedEvent{ source{ ... on PullRequest{ number repository{ nameWithOwner } } } } }
        }
      } } }' 2>/dev/null || echo "")
  if ! jq -e '.data.repository.issue.timelineItems.nodes | type == "array"' >/dev/null 2>&1 <<<"$issue_refs_json"; then
    echo "--- linkage: could not read #$ISSUE's cross-reference timeline — proceeding operator-trusted (GH-2469)"
  elif [[ "$(jq -r '.data.repository.issue.timelineItems.pageInfo.hasNextPage // false' <<<"$issue_refs_json")" == "true" ]]; then
    # A truncated page is not the relationship set: the run's PR may sit past
    # it (a false refusal) or the visible page may be empty of PRs (a false
    # pass). Neither reading is evidence — say so and fall back, rather than
    # judge on half a list (PR #2478 review).
    echo "--- linkage: #$ISSUE has more than 100 cross-references — page truncated, cannot establish linkage; proceeding operator-trusted (GH-2469)"
  else
    ref_pr_list=$(jq -r --arg nwo "$nwo" '
      [ .data.repository.issue.timelineItems.nodes[].source
        | select(.repository.nameWithOwner == $nwo) | .number // empty ] | unique | .[]' <<<"$issue_refs_json")
    if [[ -z "$ref_pr_list" ]]; then
      echo "--- linkage: #$ISSUE is not referenced by any PR yet — proceeding operator-trusted (GH-2469)"
    else
      match=""
      while read -r rp; do
        [[ -n "$rp" ]] || continue
        if grep -qxF "$rp" <<<"$run_pr_list"; then match="$rp"; break; fi
      done <<<"$ref_pr_list"
      if [[ -z "$match" ]]; then
        echo "ERROR: run $RUN's commit (PR $(tr '\n' ',' <<<"$run_pr_list" | sed 's/,$//')) does not reference #$ISSUE." >&2
        echo "       #$ISSUE is instead referenced by PR(s) $(tr '\n' ',' <<<"$ref_pr_list" | sed 's/,$//')." >&2
        echo "       This looks like a copy-paste error (right RUN, wrong ISSUE, or vice versa) — refusing" >&2
        echo "       to post evidence for a deploy that may not belong to this apply unit. Re-run with the" >&2
        echo "       correct ISSUE/RUN pairing, or post evidence by hand if this is actually correct." >&2
        exit 1
      fi
      echo "--- linkage: run $RUN's PR #$match references #$ISSUE — confirmed (GH-2469)"
    fi
  fi
fi

exec "$HERE/apply-evidence.sh" "$ISSUE" --kind run --workflow "$workflow_name" --merge-sha "$head_sha" \
  --notes "${NOTES:-deployed to $ENV_NAME via run $RUN (autonomous grant)}"
