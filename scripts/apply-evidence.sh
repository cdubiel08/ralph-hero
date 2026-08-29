#!/bin/bash
# Post a `ralph-apply-evidence:v1` comment on an apply-kind issue (GH-1694).
#
# Usage:
#   ./scripts/apply-evidence.sh ISSUE --kind run --workflow release-ralph.yml \
#       --merge-sha SHA --notes "what is now live"
#   ./scripts/apply-evidence.sh ISSUE --kind settings --notes "..." \
#       --check "gh label list | grep ralph:apply" [--check "..."]
#   ./scripts/apply-evidence.sh ISSUE --kind observation --notes "..." --check "..."
#
#   --fix-merge SHA   assert the run descends from this commit (else derived)
#   --dry-run         print the comment instead of posting it
#
# This is the ONLY sanctioned way to close an apply unit: `board move N done`
# refuses without a shape-valid comment (ralph/scripts/board.ts). The shape is
# validated there, not here — this script's job is to make honest evidence easy
# and dishonest evidence inconvenient:
#
#   * kind=run RESOLVES the run from the GitHub API by workflow name + the
#     merge SHA you name, rather than trusting hand-typed run ids. If no
#     successful run of that workflow exists at that SHA, this exits nonzero
#     and posts nothing. That is the whole point: a green run of the PRE-merge
#     code is not proof the merged change is live.
#   * kind=run also checks ANCESTRY (GH-1961): the bound run must descend from
#     the fix merge. Binding head_sha to merge_sha proves the run checked out
#     that tree; it does not prove the operator named the right tree. A run
#     triggered before the fix landed is recent, green, and produces a healthy
#     artifact — and ran the OLD workflow file, because actions/checkout pins to
#     the run's own event SHA. Observed as a near-miss on GH-1953. The fix merge
#     is DERIVED, not typed: the apply unit's `blockedBy` twin is the ship
#     issue, and its merged closing PR carries the merge commit.
#   * --check RUNS the command and records its real exit code. A failing check
#     is recorded truthfully and the evidence will be refused by the close gate.
#
# What this cannot do is verify that --notes is TRUE, or that an observation
# command's output meant what the operator says it meant. Shape validity is the
# floor, not proof (plan §Risks).

set -euo pipefail

# GH-1817: this comment IS the close gate's evidence. A rate-limited `gh`
# exiting 0 would print APPLY EVIDENCE POSTED over a comment that never landed,
# and `board move N done` would then refuse for a reason the operator has just
# been told is satisfied.
# shellcheck source=lib/gh-budget.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/gh-budget.sh"

MARKER='<!-- ralph-apply-evidence:v1 -->'

# Prints the usage block only — lines 4..12, i.e. up to and including the
# --dry-run line. The design rationale below it is for readers of the file,
# not for someone who just mistyped a flag.
usage() {
  sed -n '4,12p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

ISSUE=""
KIND=""
WORKFLOW=""
MERGE_SHA=""
FIX_MERGE=""
NOTES=""
DRY_RUN=false
CHECK_CMDS=()

# A value-taking flag in final position leaves $# == 1, and a bare `shift 2`
# would then return nonzero and kill the script under `set -e` with no output.
# needs_value makes that path print usage instead.
needs_value() { [[ $# -ge 2 && -n "$2" ]] || { echo "ERROR: $1 requires a non-empty value" >&2; usage; }; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kind)      needs_value "$@"; KIND="$2"; shift 2 ;;
    --workflow)  needs_value "$@"; WORKFLOW="$2"; shift 2 ;;
    --merge-sha) needs_value "$@"; MERGE_SHA="$2"; shift 2 ;;
    --fix-merge) needs_value "$@"; FIX_MERGE="$2"; shift 2 ;;
    --notes)     needs_value "$@"; NOTES="$2"; shift 2 ;;
    --check)     needs_value "$@"; CHECK_CMDS+=("$2"); shift 2 ;;
    --dry-run)   DRY_RUN=true; shift ;;
    -*)          usage ;;
    *)
      if [[ -z "$ISSUE" ]]; then ISSUE="$1"; else usage; fi
      shift ;;
  esac
done

[[ -n "$ISSUE" && "$ISSUE" =~ ^[0-9]+$ ]] || usage
case "$KIND" in
  run|observation|settings) ;;
  *) echo "ERROR: --kind must be run|observation|settings" >&2; exit 2 ;;
esac
[[ -n "$NOTES" ]] || { echo "ERROR: --notes is required — say, in words, what is now live" >&2; exit 2; }

ACTOR=$(gh api user --jq '.login' 2>/dev/null || echo "${USER:-unknown}")
APPLIED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# --- checks: run them, record the real exit code ----------------------------
checks_json='[]'
# bash 3.2 (macOS) treats an EMPTY array as unbound under `set -u`, and
# ${#a[@]+...} is a bad substitution on bash 5 — so count explicitly.
CHECK_COUNT=0
for cmd in ${CHECK_CMDS[@]+"${CHECK_CMDS[@]}"}; do
  CHECK_COUNT=$((CHECK_COUNT + 1))
  set +e
  out=$(bash -c "$cmd" 2>&1)
  rc=$?
  set -e
  echo "--- check: $cmd (exit $rc)"
  # Here-strings, not `echo | head`: head closes the pipe after 20 lines, echo
  # takes EPIPE, and `set -o pipefail` + `set -e` would abort the script AFTER
  # the checks already ran — losing evidence that was honestly gathered.
  head -20 <<<"$out"
  checks_json=$(jq -c --argjson c "$checks_json" --arg cmd "$cmd" --argjson rc "$rc" \
    --arg out "$(tail -5 <<<"$out")" \
    '$c + [{cmd: $cmd, exit_code: $rc, output_tail: $out}]' <<<'null')
done

payload=$(jq -n \
  --arg kind "$KIND" --arg at "$APPLIED_AT" --arg actor "$ACTOR" --arg notes "$NOTES" \
  --argjson checks "$checks_json" \
  '{kind: $kind, applied_at: $at, actor: $actor, notes: $notes}
   | if ($checks | length) > 0 then . + {checks: $checks} else . end')

# --- kind=run: resolve the run from the API, bound to the merge SHA ---------
if [[ "$KIND" == "run" ]]; then
  [[ -n "$WORKFLOW" ]] || { echo "ERROR: --kind run requires --workflow" >&2; exit 2; }
  [[ -n "$MERGE_SHA" ]] || { echo "ERROR: --kind run requires --merge-sha — the commit that had to be deployed" >&2; exit 2; }

  # Resolve to the FULL sha: a short --merge-sha would never equal the API's
  # headSha and the close gate would reject otherwise-honest evidence.
  full_sha=$(git rev-parse "$MERGE_SHA^{commit}" 2>/dev/null || echo "$MERGE_SHA")

  run_json=$(gh run list --workflow "$WORKFLOW" --commit "$full_sha" --limit 20 \
    --json databaseId,conclusion,headSha,workflowName 2>/dev/null || echo '[]')
  best=$(jq -c --arg sha "$full_sha" '
    [ .[] | select(.headSha == $sha) | select(.conclusion == "success") ] | first // empty
  ' <<<"$run_json")

  if [[ -z "$best" ]]; then
    echo "ERROR: no SUCCESSFUL run of $WORKFLOW at ${full_sha:0:8} — nothing to attest." >&2
    echo "       The workflow has not proven it executed the merged code. Posting nothing." >&2
    echo "       Seen: $(jq -c '[.[] | {id: .databaseId, conclusion, headSha: .headSha[0:8]}]' <<<"$run_json")" >&2
    exit 1
  fi

  payload=$(jq -c --argjson p "$payload" --argjson r "$best" --arg sha "$full_sha" \
    '$p + {merge_sha: $sha,
           run: {workflow: $r.workflowName, id: $r.databaseId,
                 conclusion: $r.conclusion, head_sha: $r.headSha}}' <<<'null')

  # --- ancestry: the bound run must descend from the fix merge (GH-1961) ----
  #
  # Derivation, not prose: `board dep` records the ship↔apply twin as GitHub's
  # native blockedBy relation, and the ship issue names its own closing PR.
  # --fix-merge ADDS to that derivation for a unit whose twin was never wired;
  # it may never replace it. An override that suppressed the derived commit
  # would let an operator name a weak ancestor and skip the real fix, which is
  # this issue's own defect handed a flag (PR #1962 review).
  #
  # The ancestry test is the compare API rather than the more idiomatic
  # `git merge-base --is-ancestor`, which needs BOTH commits in the local
  # object store — in a fresh worktree or in CI that fails for a reason
  # unrelated to ancestry, which is precisely the fail-open being closed here.
  #
  # `ancestry_reason` is paired with a TYPED `ancestry_reason_code` because the
  # free-text string covered two opposite facts under one `not_evaluated`
  # rendering (GH-2261): a question with no SUBJECT (a settings-only unit with
  # no ship twin — legitimately proceeds) and a question whose READ failed (we
  # do not know whether a subject exists — must refuse). A failed read
  # rendering as a calm pass is the defect this whole check exists to remove,
  # and the compare-API `unknown` path below already applies that rule; these
  # two paths were the ones it missed. The code is what `validateApplyEvidence`
  # keys on, so the close gate becomes a second enforcement point instead of
  # trusting this script alone — and `no_subject` passes there BY
  # CONSTRUCTION, needing no operator assertion (an escape hatch every
  # legitimate unit must carry is the routine path, not an escape hatch).
  ancestry_reason=""
  ancestry_reason_code=""
  ancestry_failed_read=""
  derived_shas=""
  operator_shas=""
  if [[ -n "$FIX_MERGE" ]]; then
    operator_shas=$(git rev-parse "$FIX_MERGE^{commit}" 2>/dev/null || echo "$FIX_MERGE")
  fi
  {
    nwo=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo '')
    twins=""
    if [[ -n "$nwo" ]]; then twins=$(gh api graphql -f owner="${nwo%%/*}" -f repo="${nwo##*/}" -F n="$ISSUE" -f query='
      query($owner:String!,$repo:String!,$n:Int!){
        repository(owner:$owner,name:$repo){ defaultBranchRef{ name } issue(number:$n){
          blockedBy(first:20){ nodes{ number
            closedByPullRequestsReferences(first:10,includeClosedPrs:true){
              nodes{ number merged baseRefName mergeCommit{ oid } } } } } } }
      }' 2>/dev/null || echo ''); fi
    if [[ -z "$nwo" ]]; then
      # Its own string: this never reached the API, and telling the operator
      # the API could not be read would name the wrong thing to retry.
      ancestry_reason="could not resolve this repository (gh repo view) to look the twin up"
      ancestry_reason_code="read_failed"
      ancestry_failed_read="repo_resolution"
    elif [[ -z "$twins" ]]; then
      ancestry_reason="could not read the blocked-by twin from the API"
      ancestry_reason_code="read_failed"
      ancestry_failed_read="blocked_by_twin"
    else
      # Requiring EVERY collected merge is sound once they are all on the
      # default branch: each is reachable from it, so any commit at or above
      # all of them descends from all of them — "all" is exactly "the latest",
      # without needing an ordering the API does not promise.
      #
      # The candidates are filtered by REACHABILITY from the default branch,
      # not by the PR's recorded `baseRefName`. Base name was a proxy for the
      # property actually wanted — did this land? — and it breaks under a
      # branch rename, discarding a real fix merge and silently downgrading to
      # not_evaluated (PR #1962 review). Reachability survives the rename,
      # because history does; and a merge into a stacked base that never
      # landed is still excluded, which is what the proxy was there for.
      def_branch=$(jq -r '.data.repository.defaultBranchRef.name // empty' <<<"$twins")
      candidates=$(jq -r '
        [ .data.repository.issue.blockedBy.nodes[]?
          | .closedByPullRequestsReferences.nodes[]?
          | select(.merged == true) | .mergeCommit.oid // empty ] | unique | .[]' <<<"$twins")
      if [[ -z "$candidates" ]]; then
        ancestry_reason="no blocked-by twin with a merged closing PR"
        ancestry_reason_code="no_subject"
      elif [[ -z "$def_branch" ]]; then
        ancestry_reason="could not read the default branch to test which fixes landed"
        ancestry_reason_code="read_failed"
        ancestry_failed_read="default_branch"
      else
        while read -r cand; do
          [[ -n "$cand" ]] || continue
          landed=$(gh api "repos/{owner}/{repo}/compare/$cand...$def_branch" --jq '.status' 2>/dev/null || echo "unknown")
          case "$landed" in
            identical|ahead) derived_shas+="$cand"$'\n' ;;
            unknown)
              echo "ERROR: could not determine whether ${cand:0:8} landed on $def_branch — the compare" >&2
              echo "       API did not answer. Posting nothing; re-run once it responds (GH-1961)." >&2
              exit 1 ;;
            *) echo "--- ancestry: ${cand:0:8} is not reachable from $def_branch ($landed) — not a required ancestor" ;;
          esac
        done <<<"$candidates"
        if [[ -z "$derived_shas" ]]; then
          ancestry_reason="no blocked-by twin whose closing PR landed on $def_branch"
          ancestry_reason_code="no_subject"
        fi
      fi
    fi
  }

  # A read that FAILED is refused here, before anything is composed — the same
  # treatment the compare-API `unknown` path below already gets, for the same
  # reason. --fix-merge deliberately does NOT rescue it: the flag ADDS to the
  # derived set and can never replace it, so proceeding on an operator sha
  # while the derivation is unknown is precisely "name a weak ancestor and skip
  # the real fix" — this check's own defect handed a flag (GH-1961/GH-2261).
  if [[ "$ancestry_reason_code" == "read_failed" ]]; then
    echo "ERROR: ancestry could not be evaluated — $ancestry_reason (failed read:" >&2
    echo "       $ancestry_failed_read). Posting nothing; re-run once it responds." >&2
    echo "       An unreadable read is not an absent subject, and unverified ancestry" >&2
    echo "       may not reach Done (GH-1961, GH-2261)." >&2
    exit 1
  fi

  # Operator assertions are added to the derived set, never substituted for it.
  fix_shas=$(printf '%s\n%s\n' "$derived_shas" "$operator_shas" | sed '/^$/d' | sort -u)

  if [[ -z "$fix_shas" ]]; then
    echo "WARNING: ancestry NOT CHECKED — $ancestry_reason." >&2
    echo "         Recency and a green conclusion are not ancestry (GH-1961). Pass" >&2
    echo "         --fix-merge <sha> to make this checkable." >&2
    payload=$(jq -c --argjson p "$payload" --arg why "$ancestry_reason" --arg code "$ancestry_reason_code" \
      '$p + {ancestry: {status: "not_evaluated", reason_code: $code, reason: $why}}' <<<'null')
  else
    checked='[]'
    while read -r fix; do
      [[ -n "$fix" ]] || continue
      fix_source="derived from blockedBy twin"
      if ! grep -qxF "$fix" <<<"$derived_shas"; then fix_source="operator (--fix-merge)"; fi
      status=$(gh api "repos/{owner}/{repo}/compare/$fix...$full_sha" --jq '.status' 2>/dev/null || echo "unknown")
      echo "--- ancestry: $fix -> ${full_sha:0:8} = $status ($fix_source)"
      case "$status" in
        identical|ahead) ;;
        unknown)
          # A question that HAS a subject and went unanswered is not the same as
          # one with no subject. Posting here would be the defect this whole
          # check exists to remove — a failed read rendering as a pass, in
          # evidence no later reader re-opens (PR #1962 review). Retry instead.
          echo "ERROR: could not determine whether ${full_sha:0:8} descends from ${fix:0:8} — the" >&2
          echo "       compare API did not answer (unreachable or rate-limited). Posting nothing;" >&2
          echo "       re-run once it responds. Unverified ancestry may not reach Done (GH-1961)." >&2
          exit 1 ;;
        *)
          echo "ERROR: the run at ${full_sha:0:8} does NOT descend from the fix merge ${fix:0:8} (compare: $status)." >&2
          echo "       It checked out the PRE-fix tree, so its green conclusion is a sample of the bug" >&2
          echo "       not firing, not proof the fix works (GH-1961). Posting nothing." >&2
          exit 1 ;;
      esac
      checked=$(jq -c --argjson c "$checked" --arg fix "$fix" --arg st "$status" --arg src "$fix_source" \
        '$c + [{fix_merge: $fix, status: $st, source: $src}]' <<<'null')
    done <<<"$fix_shas"
    # A derivation that failed while an operator sha carried the check is still
    # recorded: the reader must be able to see that only half the question was
    # answerable from board data.
    payload=$(jq -c --argjson p "$payload" --argjson c "$checked" --arg why "$ancestry_reason" \
      '$p + {ancestry: ({status: "descends", checked: $c}
                        | if $why == "" then . else . + {derivation_note: $why} end)}' <<<'null')
  fi
elif [[ "$CHECK_COUNT" -eq 0 ]]; then
  echo "ERROR: --kind $KIND requires at least one --check (a command whose exit code is the evidence)" >&2
  exit 2
fi

# shellcheck disable=SC2016  # literal markdown fence, no expansion wanted
body=$(printf '%s\n## Apply evidence\n\n%s\n\n```json\n%s\n```\n' \
  "$MARKER" "$NOTES" "$(jq . <<<"$payload")")

if [[ "$DRY_RUN" == "true" ]]; then
  echo "$body"
  exit 0
fi

rc=0
gb_gh issue comment "$ISSUE" --body "$body" >/dev/null || rc=$?
if [[ $rc -eq 4 ]]; then
  echo "APPLY EVIDENCE NOT POSTED — rate limited; re-run this command after the reset" >&2
  exit 75
fi
[[ $rc -ne 0 ]] && exit "$rc"
echo "APPLY EVIDENCE POSTED — #$ISSUE (kind=$KIND, actor=$ACTOR)"
echo "Close it with: board move $ISSUE done"
