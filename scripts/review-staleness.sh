#!/bin/bash
# Is the blocking CHANGES_REQUESTED bound to the CURRENT head? (GH-1816)
#
# Usage: ./scripts/review-staleness.sh PR_NUMBER
#
# Observed on GH-1774 (2026-08-12): a deliver pass read `MERGE GATE FAIL —
# review` off merge-pr.sh gate 1, read that as semantic rework, and demoted the
# issue In Review → Backlog. The CHANGES_REQUESTED it saw was filed against the
# PREVIOUS head; every finding in it had already been fixed and pushed. There
# was no rework outstanding — only a re-review that had not happened yet,
# because the reviewer was rate-limited.
#
# That is not a race, it is the NORMAL shape of a review round: the author
# pushes fixes faster than the reviewer re-reviews, and the gap widens to hours
# under rate limiting. The demotion is expensive — it drops the claim, moves a
# green and complete PR out of the review lane, and makes finished work read as
# unstarted.
#
# GitHub already holds both halves. A review carries `commit_id`; the PR
# carries `headRefOid`. A blocking review whose commit_id is not the head is a
# verdict on code that no longer exists.
#
#   live     a blocking review IS bound to the current head — the author
#            really does have work to do. Demote, unchanged from today.
#   stale    reviewDecision is CHANGES_REQUESTED and NO blocking review is
#            bound to the head — awaiting evidence, not awaiting the author.
#            Hold at In Review and surface it.
#   no-block reviewDecision is not CHANGES_REQUESTED. Nothing to distinguish.
#
# WHAT COUNTS AS BLOCKING is GitHub's own semantics, reimplemented rather than
# guessed: reviewDecision is the authority on whether a CHANGES_REQUESTED is
# still live (it accounts for dismissals and for a reviewer who later
# approved), and this script only ever runs INSIDE that answer — it never
# invents a block reviewDecision does not report. Within it, a reviewer's
# blocking verdict is their NEWEST review: a CHANGES_REQUESTED followed by that
# same reviewer's COMMENTED at the head is superseded, and scoring the older
# one would report a head-bound block that GitHub does not hold. Dismissed
# reviews are dropped for the same reason.
#
# NOT EVALUATED IS NOT STALE. An unreadable review list, a missing head, a
# blocking review with no commit_id — none of them prove the verdict predates
# the head, and reporting `stale` on a failed read would suppress a demotion
# the author actually earned. ok=false means "keep today's behaviour", which is
# the direction that cannot lose work: the caller demotes, exactly as it did
# before this file existed. The bug this fixes is over-demotion, and the fix
# may not become under-demotion when it cannot see.
#
# This script GATES NOTHING — the same split GH-1945 and GH-1849 settled.
# merge-pr.sh gate 1 is unchanged and still unforceable; a stale verdict is
# still a red gate and still blocks the merge. All this answers is WHOSE TURN
# it is, which is a question only the deliver lane's demotion decision asks.
#
# Output: one line of JSON on stdout, always. Exit 0 for every verdict; 2 on
# usage error.
#   {"ok":true,"verdict":"stale","head":"653f9edd…","blocking":[
#     {"reviewer":"coderabbitai[bot]","commit":"94055ad3…","at":"…"}],
#    "detail":"…"}

set -euo pipefail

PR_NUMBER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -*) echo "Usage: $0 PR_NUMBER" >&2; exit 2 ;;
    *) PR_NUMBER="$1"; shift ;;
  esac
done
if [[ -z "$PR_NUMBER" ]] || ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "Usage: $0 PR_NUMBER" >&2
  exit 2
fi

emit() { # emit <ok> <verdict> <head> <blocking-json> <detail>
  jq -nc --argjson ok "$1" --arg v "$2" --arg h "$3" --argjson b "$4" --arg d "$5" \
    '{ok: $ok, verdict: $v, head: $h, blocking: $b, detail: $d}'
  exit 0
}

# pipefail (set above) is load-bearing here: without it a failed `gh` would be
# masked by jq's success and read as an empty review list — i.e. as a PR with
# no blocking review, which this script would then call `stale`. That is the
# exact inversion the file forbids.
if ! pr=$(gh pr view "$PR_NUMBER" --json headRefOid,reviewDecision 2>/dev/null); then
  emit false not-evaluated "" '[]' "cannot read PR #$PR_NUMBER (gh pr view failed) — retry"
fi

head_sha=$(jq -r '.headRefOid // ""' <<<"$pr")
decision=$(jq -r '.reviewDecision // ""' <<<"$pr")

if [[ -z "$head_sha" ]]; then
  emit false not-evaluated "" '[]' "PR #$PR_NUMBER reports no head commit — staleness is not computable"
fi

if [[ "$decision" != "CHANGES_REQUESTED" ]]; then
  emit true no-block "$head_sha" '[]' "reviewDecision is ${decision:-none} on PR #$PR_NUMBER — no blocking review to date"
fi

# REST, not `gh pr view --json reviews`: the GraphQL shape strips the `[bot]`
# suffix from bot logins, and the login is the key the newest-per-reviewer
# reduction groups on. Same reason gate 5 of merge-pr.sh reads REST.
if ! reviews=$(gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER/reviews" --paginate 2>/dev/null | jq -s 'add // []'); then
  emit false not-evaluated "$head_sha" '[]' "cannot read reviews for PR #$PR_NUMBER (gh api failed) — retry"
fi

# The blocking set: per reviewer, their NEWEST non-dismissed review, kept only
# when it is still CHANGES_REQUESTED. PENDING is excluded — an unsubmitted
# draft is not a verdict anyone has filed.
blocking=$(jq -c --arg head "$head_sha" '
  [ .[]
    | select((.state // "") != "DISMISSED")
    | select((.state // "") != "PENDING")
    | select((.submitted_at // null) != null)
    | {reviewer: (.user.login // ""), state: (.state // ""),
       commit: (.commit_id // ""), at: .submitted_at}
  ]
  | sort_by(.at)
  | group_by(.reviewer)
  | map(last)
  | map(select(.state == "CHANGES_REQUESTED"))
  | map({reviewer, commit, at, at_head: (.commit == $head)})
' <<<"$reviews")

count=$(jq 'length' <<<"$blocking")

if [[ "$count" -eq 0 ]]; then
  # reviewDecision says a block is live and the review list does not show one.
  # The two disagree, so the honest answer is neither verdict: something is
  # unread (a page lost, a review type not modelled), and guessing `stale` here
  # would let the disagreement itself clear a demotion.
  emit false not-evaluated "$head_sha" '[]' \
    "reviewDecision is CHANGES_REQUESTED on PR #$PR_NUMBER but no blocking review is visible — not computable"
fi

# A blocking review with no commit_id cannot be proved to predate the head, so
# it counts as head-bound. Deliberately asymmetric: the burden of proof is on
# `stale`, which is the verdict that suppresses action.
unknown=$(jq '[.[] | select(.commit == "")] | length' <<<"$blocking")
at_head=$(jq '[.[] | select(.at_head)] | length' <<<"$blocking")

if [[ "$unknown" -gt 0 ]]; then
  emit false not-evaluated "$head_sha" "$blocking" \
    "a blocking review on PR #$PR_NUMBER carries no commit_id — cannot prove it predates the head"
fi

if [[ "$at_head" -gt 0 ]]; then
  emit true live "$head_sha" "$blocking" \
    "$at_head blocking review(s) bound to head ${head_sha:0:8} — the findings are against the current code"
fi

emit true stale "$head_sha" "$blocking" \
  "every blocking review predates head ${head_sha:0:8} ($(jq -r '[.[] | "\(.reviewer)@\(.commit[0:8])"] | join(", ")' <<<"$blocking")) — awaiting re-review, not rework"
