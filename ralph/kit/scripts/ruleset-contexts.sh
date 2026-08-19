#!/bin/bash
# Required-but-not-produced status contexts (GH-2057).
#
# Usage: ./scripts/ruleset-contexts.sh PR_NUMBER
#
# Every ralph gate can pass while GitHub still refuses the merge. Observed on
# PR #2055: attestation green, Codex review clean at head, apply-keywords PASS,
# every CI leg green, and merge-pr.sh printed MERGE GATE PASS immediately
# before `gh pr merge` came back with "the base branch policy prohibits the
# merge". The ruleset enumerates its required status checks by LITERAL name,
# including per-matrix entries like `build-and-test-knowledge (20)`, so a diff
# that drops a matrix leg stops producing a context the ruleset still requires.
# The check is required, nothing will ever report it, and the merge can never
# happen — but no gate here reads the ruleset, so our answer was yes and
# GitHub's was an opaque string.
#
# This script compares the two and names the difference. It is NOT A GATE: the
# refusal is GitHub's to make, and all we owe the driver is a diagnosis instead
# of that string. Same measure-do-not-gate split as GH-1945 and GH-1849.
#
# It FAILS OPEN, and that is the load-bearing bound. A repo with no ruleset is
# the common case — ralph recommends rather than imposes — and an unreadable
# ruleset is a rate limit, not a policy. Neither may darken a merge path. Note
# the two are different answers, not one: a ruleset that is READ and requires
# nothing is `ok:true, count:0`, while a ruleset we could not read is
# `ok:false`, because "checked, nothing missing" and "never checked" must not
# render alike — the defect GH-1971 fixed one line over.
#
# Honest limit, stated in the output rather than guessed at: a required context
# that is absent because CI has not started yet is indistinguishable here from
# one the diff deleted. Telling them apart needs the workflow file and its
# matrix expansion. So the wording is "required but not produced at this head"
# and the judgment stays with the driver.
#
# Output: one line of JSON on stdout, always. Exit 0 for every verdict; 2 on
# usage error.
#   {"ok":true,"count":0,"missing":[],"summary":"","detail":""}
#   {"ok":true,"count":1,"missing":["build-and-test-knowledge (20)"],
#    "summary":"build-and-test-knowledge (20)","detail":""}
#   {"ok":false,"count":0,"missing":[],"summary":"","detail":"why not"}

set -euo pipefail

PR_NUMBER="${1:-}"
if [[ -z "$PR_NUMBER" || "$PR_NUMBER" =~ [^0-9] ]]; then
  echo "Usage: $0 PR_NUMBER" >&2
  exit 2
fi

emit() { # emit <ok> <missing-json-array> <detail>
  jq -nc --argjson ok "$1" --argjson m "$2" --arg detail "$3" '
    {ok: $ok, count: ($m | length), missing: $m,
     summary: ($m | join(", ")), detail: $detail}'
  exit 0
}

if ! read -r OWNER REPO < <(gh repo view --json owner,name --jq '"\(.owner.login) \(.name)"' 2>/dev/null); then
  emit false '[]' "cannot resolve owner/repo (gh repo view failed)"
fi

# shellcheck disable=SC2016  # a GraphQL document, not a shell string to expand
QUERY='query($owner:String!,$repo:String!,$pr:Int!){
  repository(owner:$owner,name:$repo){ pullRequest(number:$pr){
    baseRefName
    headRefOid
    commits(last:1){ nodes{ commit{ statusCheckRollup{
      contexts(first:100){
        pageInfo{ hasNextPage }
        nodes{ __typename ... on CheckRun{ name } ... on StatusContext{ context } }
      } } } } }
  } } }'

if ! pr_json=$(gh api graphql -f query="$QUERY" -F owner="$OWNER" -F repo="$REPO" -F pr="$PR_NUMBER" 2>/dev/null); then
  emit false '[]' "cannot read PR #$PR_NUMBER (GraphQL read failed)"
fi

BASE=$(jq -r '.data.repository.pullRequest.baseRefName // ""' <<<"$pr_json")
[[ -n "$BASE" ]] || emit false '[]' "PR #$PR_NUMBER has no readable base branch"

# The base branch is what the ruleset applies to, and its rules are what the
# merge button consults. `rules/branches/<branch>` is the EFFECTIVE rule set
# for that ref — the merge of every ruleset that targets it — which is the
# question being asked; enumerating rulesets and re-deriving which ones apply
# would be a second copy of GitHub's own matching logic.
if ! rules_json=$(gh api "repos/$OWNER/$REPO/rules/branches/$BASE" 2>/dev/null); then
  emit false '[]' "cannot read branch rules for '$BASE' (no permission, or the read failed)"
fi

REQUIRED=$(jq -c '[.[] | select(.type == "required_status_checks")
                       | .parameters.required_status_checks[]?.context] | unique' <<<"$rules_json" 2>/dev/null) \
  || emit false '[]' "branch rules for '$BASE' were not in the expected shape"

# A ruleset requiring nothing, and no ruleset at all, are the same answer to
# this question: GitHub will refuse no merge over a missing context. Answered,
# not skipped.
[[ "$(jq 'length' <<<"$REQUIRED")" != "0" ]] || emit true '[]' ""

ROLLUP=$(jq -c '.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup' <<<"$pr_json")
if [[ "$ROLLUP" == "null" ]]; then
  # No rollup at all means no check has reported yet. Every required context is
  # trivially absent, which is the "CI has not started" reading rather than the
  # deleted-leg one — reporting the whole ruleset as missing would be a burst of
  # noise on every freshly-pushed PR.
  emit false '[]' "no status checks have reported at this head yet"
fi

# More than 100 contexts: the produced set is incomplete, so a context we simply
# did not page to would read as missing. Not evaluated beats a false accusation
# on a line whose whole job is to be believed.
if [[ "$(jq -r '.contexts.pageInfo.hasNextPage' <<<"$ROLLUP")" == "true" ]]; then
  emit false '[]' "more than 100 check contexts at this head — the produced set is incomplete"
fi

PRODUCED=$(jq -c '[.contexts.nodes[] | (.name // .context) | select(. != null)] | unique' <<<"$ROLLUP")

MISSING=$(jq -c --argjson produced "$PRODUCED" '[.[] | select(. as $r | $produced | index($r) | not)]' <<<"$REQUIRED")

emit true "$MISSING" ""
