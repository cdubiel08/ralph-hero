#!/bin/bash
# Sub-P0 review findings, counted so they stop being invisible (GH-1945).
#
# Usage: ./scripts/advisory-findings.sh PR_NUMBER [HEAD_SHA]
#
# The merge gate blocks on ONE thing: unresolved P0 threads from the policy
# reviewer (scripts/codex-review-evidence.sh, findings mode). Everything else a
# reviewer files — every P1, every P2, and every finding from a reviewer the
# policy does not gate on — is advisory by design. Advisory turned out to mean
# UNREAD: three consecutive PRs merged over valid open findings (#1939, #1941,
# #1942), because a PR with five open P1 threads and a PR with none produced
# byte-identical output from every surface a driver looks at.
#
# This script does not gate anything. It makes the two states distinguishable,
# and leaves the judgment exactly where it is — with the person merging.
#
# Reviewer-agnostic ON PURPOSE. Severity is read from the badge each reviewer
# renders, and the two reviewers on this repo render it differently (measured
# 2026-08-15):
#   Greptile: <a href="#"><img alt="P1" src="...greptile.../p1.svg"></a> **...**
#   Codex:    **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange...
# A parser written against either one alone would have missed every finding in
# GH-1945's evidence table, which is entirely Greptile's.
#
# What is counted: unresolved, non-outdated threads whose first comment carries
# a severity badge, MINUS the ones the merge gate already blocks on (policy bot
# + P0). Outdated is excluded for the same reason gate 5 excludes it — GitHub
# marks a thread outdated when the code it anchors to is gone, and no reviewer
# here resolves its own threads, so counting outdated ones would report findings
# about code that no longer exists, forever.
#
# Note the corollary: a P0 from a NON-policy reviewer is counted here, because
# nothing else counts it. Greptile's status check is completion-only — it
# reports `pass` regardless of findings (GH-1893) — so its top severity has no
# gate behind it either.
#
# A COUNT OF ZERO IS NOT A CLEAN PR (GH-1971). The count answers "what is
# outstanding", never "did anyone look" — so a reviewer that is rate-limited,
# quota-exhausted, uninstalled or simply silent produced `count: 0`, rendered
# byte-identically to a PR that was reviewed and found clean. That is this
# script's own defect, one layer in: GH-1945 shipped it because "findings
# outstanding" and "no findings" looked alike, and "nobody looked" then
# collapsed into the same reading. Live, not hypothetical — the Greptile trial
# (GH-1893) is a capped free tier, and Greptile supplies the advisory layer.
#
# So `reviewed` is reported beside the count, in three states, and the caller
# must render "unreviewed" as its own thing:
#   "true"    a non-author review object AT THIS HEAD, or a non-author comment
#             naming this head commit
#   "false"   the head was read and neither exists
#   "unknown" the head or the evidence could not be read
# The test is the shape gate 5 already uses (codex-review-evidence.sh): a
# review object at the head, or a comment naming the head. Not that script
# itself — it binds to the ONE policy bot and to a scoped request comment,
# while this line is reviewer-agnostic by construction.
#
# Two deliberate bounds. The PR AUTHOR is excluded: the driver's own
# `<!-- ralph-review-head: <sha> -->` request comment names the head, and
# counting it would make every PR self-satisfying — the request would prove the
# review. And `reviewed` is never inferred from the findings themselves: an
# unresolved thread can be inherited from an older head, so treating one as
# proof of a look would reintroduce the same false positive by the back door.
#
# The honest limit, stated once: an advisory reviewer with nothing to say may
# file nothing at all, so `reviewed:false` is not proof of a quota problem. The
# line does not diagnose WHY nobody looked — only stops reporting it as clean.
#
# Output: one line of JSON on stdout, always. Exit 0 for every verdict; 2 on
# usage error.
#   {"ok":true,"count":3,"summary":"2xP1, 1xP2","first_url":"...","reviewed":"true"}
#   {"ok":false,"count":0,"summary":"","first_url":"","reviewed":"unknown","detail":"why not"}
# ok=false is "not evaluated", never "none": the caller must print that
# distinction rather than let an API failure read as a clean PR. That is the
# same defect this whole script exists to fix, one layer up.

set -euo pipefail

PR_NUMBER="${1:-}"
HEAD_SHA="${2:-}"
if [[ -z "$PR_NUMBER" ]]; then
  echo "Usage: $0 PR_NUMBER [HEAD_SHA]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
POLICY_FILE="${RALPH_MERGE_POLICY_FILE:-$REPO_ROOT/.github/ralph-merge-policy.json}"

# The gating reviewer, read from the same policy file gate 5 reads, so "what
# the gate already blocks on" cannot drift from what this script subtracts.
#
# And only in FINDINGS mode. The subtraction is not "the bot's P0 is someone
# else's problem" — it is "gate 5 already blocks on exactly this thread". That
# is true only where gate 5 reads threads at all. In review mode gate 5 asks
# for an APPROVED review object and never looks at a thread, so a bot P0 left
# open under an approval is blocked by nothing; subtracting it there would hide
# the highest-severity finding on the PR from the one line reporting findings
# (Greptile P1, PR #1946). Mode is derived exactly as pr-gate-watch.sh and
# validate-attestation.sh derive it: a head_marker means findings mode.
BOT="chatgpt-codex-connector[bot]"
MODE="review"
if [[ -f "$POLICY_FILE" ]] && jq -e . "$POLICY_FILE" >/dev/null 2>&1; then
  BOT=$(jq -r '.external_review.bot // "chatgpt-codex-connector[bot]"' "$POLICY_FILE")
  [[ -n "$(jq -r '.external_review.head_marker // ""' "$POLICY_FILE")" ]] && MODE="findings"
fi

REVIEWED="unknown"

emit() { # emit <ok> <count> <summary> <first_url> <detail>
  jq -nc --argjson ok "$1" --argjson n "$2" --arg s "$3" --arg u "$4" --arg d "$5" \
    --arg r "$REVIEWED" \
    '{ok: $ok, count: $n, summary: $s, first_url: $u, reviewed: $r, detail: $d}'
  exit 0
}

# --- did anyone look at this head? -------------------------------------------
# Evaluated before the count, and never allowed to fail the count: an
# unreadable review history leaves reviewed=unknown, which the caller renders
# as its own state. Refusing to count findings we CAN read because we could not
# read who looked would trade one blind spot for a worse one.
pr_author=""
if [[ -z "$HEAD_SHA" ]]; then
  if pr_meta=$(gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER" 2>/dev/null) \
     && jq -e '.head.sha' >/dev/null 2>&1 <<<"$pr_meta"; then
    HEAD_SHA=$(jq -r '.head.sha' <<<"$pr_meta")
    pr_author=$(jq -r '.user.login // ""' <<<"$pr_meta")
  fi
elif pr_meta=$(gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER" 2>/dev/null); then
  pr_author=$(jq -r '.user.login // ""' <<<"$pr_meta")
fi

if [[ -n "$HEAD_SHA" ]]; then
  looked=""
  if reviews=$(gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER/reviews" --paginate 2>/dev/null \
               | jq -s 'add // []'); then
    # GitHub does not let an author review their own PR, so a review object
    # needs no author filter.
    looked=$(jq -r --arg sha "$HEAD_SHA" '
      [ .[]
        | select((.commit_id // "") == $sha)
        | select((.state // "") != "DISMISSED")
      ] | if length > 0 then "true" else "" end' <<<"$reviews")
    # No review object. A reviewer may instead report the commit it read in a
    # plain comment (the shape gate 5 accepts); the 10-character prefix is what
    # those reports print. Skipped entirely when the author is unknown —
    # without a name to exclude, the driver's own head-marker request comment
    # would prove the review it is asking for, and a false "reviewed" is worse
    # than an honest "unknown".
    if [[ "$looked" != "true" && -n "$pr_author" ]]; then
      if rev_comments=$(gh api "repos/{owner}/{repo}/issues/$PR_NUMBER/comments" --paginate 2>/dev/null \
                        | jq -s 'add // []'); then
        looked=$(jq -r --arg short "${HEAD_SHA:0:10}" --arg author "$pr_author" '
          [ .[]
            | select((.body // "") | contains($short))
            | select((.user.login // "") != $author)
          ] | if length > 0 then "true" else "false" end' <<<"$rev_comments")
      fi
    fi
  fi
  [[ -n "$looked" ]] && REVIEWED="$looked"
fi

# pipefail (set above) is load-bearing: without it the recorded status would be
# jq's, and a failed `gh api` would read as an empty thread list — i.e. as a
# clean PR.
if ! threads=$(gh api graphql -F owner='{owner}' -F repo='{repo}' -F pr="$PR_NUMBER" -f query='
  query($owner:String!,$repo:String!,$pr:Int!){
    repository(owner:$owner,name:$repo){ pullRequest(number:$pr){
      reviewThreads(first:100){
        pageInfo{ hasNextPage }
        nodes{ isResolved isOutdated comments(first:1){ nodes{ author{login} body url } } }
      } } } }' 2>/dev/null); then
  emit false 0 "" "" "gh api graphql failed"
fi
if ! jq -e '.data.repository.pullRequest.reviewThreads' >/dev/null 2>&1 <<<"$threads"; then
  emit false 0 "" "" "review threads unreadable for PR #$PR_NUMBER"
fi
if [[ "$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage' <<<"$threads")" == "true" ]]; then
  # Same bound as gate 5, same honesty: a partial count reported as a total
  # would understate exactly what this script exists to surface.
  emit false 0 "" "" "more than 100 review threads — not counted"
fi

result=$(jq -c --arg bot "$BOT" --arg mode "$MODE" '
  def norm: sub("^app/"; "") | sub("\\[bot\\]$"; "");
  # Severity from the badge, in either reviewer'"'"'s rendering. Anchored on the
  # badge markup — a bare "P1" substring also matches prose that merely
  # mentions P1, including a finding filed at another tier.
  # The tier is bound BEFORE the body is piped into test(): written the other
  # way round, the "\(.)" interpolation resolves against $body rather than the
  # tier, and every finding silently reads as unbadged.
  def tier($body):
    [ ["P0","P1","P2","P3"][] as $t
      | select(($body | test("alt=\"\($t)\"")) or ($body | test("\\[\($t) Badge\\]")))
      | $t ][0] // "";
  [ .data.repository.pullRequest.reviewThreads.nodes[]
    | select(.isResolved == false and .isOutdated == false)
    | .comments.nodes[0] // empty
    | { author: ((.author.login // "") | norm), url: (.url // ""), tier: tier(.body // "") }
    | select(.tier != "")
    # The one subtraction: what gate 5 already blocks on — in the only mode
    # where it blocks on threads at all.
    | select(($mode == "findings" and .author == ($bot | norm) and .tier == "P0") | not)
  ]
  | { count: length,
      summary: ( group_by(.tier) | sort_by(.[0].tier)
                 | map("\(length)x\(.[0].tier)") | join(", ") ),
      first_url: (.[0].url // "") }' <<<"$threads")

emit true \
  "$(jq -r '.count' <<<"$result")" \
  "$(jq -r '.summary' <<<"$result")" \
  "$(jq -r '.first_url' <<<"$result")" \
  ""
