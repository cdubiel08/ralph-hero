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
#   --dry-run   print the comment instead of posting it
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
#   * --check RUNS the command and records its real exit code. A failing check
#     is recorded truthfully and the evidence will be refused by the close gate.
#
# What this cannot do is verify that --notes is TRUE, or that an observation
# command's output meant what the operator says it meant. Shape validity is the
# floor, not proof (plan §Risks).

set -euo pipefail

MARKER='<!-- ralph-apply-evidence:v1 -->'

usage() {
  sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

ISSUE=""
KIND=""
WORKFLOW=""
MERGE_SHA=""
NOTES=""
DRY_RUN=false
CHECK_CMDS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kind)      KIND="${2:-}"; shift 2 ;;
    --workflow)  WORKFLOW="${2:-}"; shift 2 ;;
    --merge-sha) MERGE_SHA="${2:-}"; shift 2 ;;
    --notes)     NOTES="${2:-}"; shift 2 ;;
    --check)     CHECK_CMDS+=("${2:-}"); shift 2 ;;
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
  echo "$out" | head -20
  checks_json=$(jq -c --argjson c "$checks_json" --arg cmd "$cmd" --argjson rc "$rc" \
    --arg out "$(echo "$out" | tail -5)" \
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

gh issue comment "$ISSUE" --body "$body" >/dev/null
echo "APPLY EVIDENCE POSTED — #$ISSUE (kind=$KIND, actor=$ACTOR)"
echo "Close it with: board move $ISSUE done"
