#!/bin/bash
# Sub-P0 review findings, counted so they stop being invisible (GH-1945).
#
# Usage: ./scripts/advisory-findings.sh PR_NUMBER
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
# Output: one line of JSON on stdout, always. Exit 0 for every verdict; 2 on
# usage error.
#   {"ok":true,"count":3,"summary":"2xP1, 1xP2","first_url":"https://..."}
#   {"ok":false,"count":0,"summary":"","first_url":"","detail":"why not"}
# ok=false is "not evaluated", never "none": the caller must print that
# distinction rather than let an API failure read as a clean PR. That is the
# same defect this whole script exists to fix, one layer up.

set -euo pipefail

PR_NUMBER="${1:-}"
if [[ -z "$PR_NUMBER" ]]; then
  echo "Usage: $0 PR_NUMBER" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
POLICY_FILE="${RALPH_MERGE_POLICY_FILE:-$REPO_ROOT/.github/ralph-merge-policy.json}"

# The gating reviewer, read from the same policy file gate 5 reads, so "what
# the gate already blocks on" cannot drift from what this script subtracts.
BOT="chatgpt-codex-connector[bot]"
if [[ -f "$POLICY_FILE" ]] && jq -e . "$POLICY_FILE" >/dev/null 2>&1; then
  BOT=$(jq -r '.external_review.bot // "chatgpt-codex-connector[bot]"' "$POLICY_FILE")
fi

emit() { # emit <ok> <count> <summary> <first_url> <detail>
  jq -nc --argjson ok "$1" --argjson n "$2" --arg s "$3" --arg u "$4" --arg d "$5" \
    '{ok: $ok, count: $n, summary: $s, first_url: $u, detail: $d}'
  exit 0
}

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

result=$(jq -c --arg bot "$BOT" '
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
    # The one subtraction: what gate 5 already blocks on. Everything else is
    # advisory, which is the population this script reports.
    | select((.author == ($bot | norm) and .tier == "P0") | not)
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
