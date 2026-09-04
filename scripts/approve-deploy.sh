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
exec "$HERE/apply-evidence.sh" "$ISSUE" --kind run --workflow "$workflow_name" --merge-sha "$head_sha" \
  --notes "${NOTES:-deployed to $ENV_NAME via run $RUN (autonomous grant)}"
