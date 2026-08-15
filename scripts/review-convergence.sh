#!/bin/bash
# Convergence stopping rule for iterative review (GH-1849).
#
# Usage: ./scripts/review-convergence.sh PR_NUMBER [--cap N]
#
# A review loop with no termination condition is not a review loop, it is a
# budget. Measured on this repo 2026-08-13: PR #1764 ran 33 policy-bot review
# rounds and #1755 ran 17, each fix pass touching more code and surfacing more
# findings — the documented "review paralysis" mode. Nothing stopped it because
# nothing was counting rounds.
#
# This script counts them, and answers one question: is the blocking-finding
# count still going DOWN? Two verdicts mean stop iterating and escalate to
# Human Needed rather than requesting another review:
#
#   stalled       the last two completed passes did not strictly decrease
#   cap-reached   the round budget is spent (hitting the cap is an escalation,
#                 not a failure — the work is fine, the loop is the problem)
#
# and `converged` — no blocking findings at the latest completed pass — is the
# terminal SUCCESS, checked before either of them. Zero is the floor: a loop
# cannot decrease below it, so a strict-decrease test applied there condemns
# every clean PR. That is not hypothetical, it is what the first draft of this
# file did to #1970, #1962, #1964 and #1949 when it was run against them.
#
# DERIVED, NEVER RECORDED. There is no marker comment, no state file, nothing
# to keep in sync and nothing to write before the rule can be read. A "pass" is
# a review REQUEST — the `<!-- ralph-review-head: <sha> -->` comment the driver
# already posts once per head (deliver's stated bound) — and the findings of
# that pass are the policy bot's blocking threads filed between that request
# and the next one. Both halves are already on the PR, so the rule evaluates
# retroactively on any PR in the repo's history, including the two that
# motivated it. A recorded counter would have been a second copy of a fact
# GitHub already stores, wrong the first time anyone pushed without it.
#
# WHAT IS COUNTED, AND WHY IT IS NOT THE GATE'S COUNT. Gate 5
# (codex-review-evidence.sh) counts blocking threads that are OUTSTANDING right
# now — unresolved and non-outdated — because it is deciding whether the PR may
# merge. This script deliberately does the opposite and counts every blocking
# thread the reviewer FILED in each pass, regardless of what later became of
# it. The subject here is the reviewer's output per round, not the backlog: a
# pass that raised six P0s which the driver then fixed still cost a round and
# still says the diff was not settling. Filtering to what survives would score
# a diligent driver's worst pass as its best.
#
# BLOCKING means what gate 5 blocks on: the policy bot, at P0. The badge is
# matched in BOTH renderings on this repo (Codex `[P0 Badge]`, Greptile
# `alt="P0"`) even though the policy bot today renders only one, because the
# policy file can name a different bot without this file changing (the spike in
# GH-1848 costed exactly that swap) and a taxonomy that silently counts zero
# for the new reviewer would report every loop as converging.
#
# AN INCOMPLETE TRAILING PASS IS NOT A DATA POINT. The most recent request may
# have no answer yet, and its window is open — so it has zero findings for the
# uninteresting reason that nobody has looked. Scored as a pass it reads as a
# decrease, i.e. the rule would certify convergence at precisely the moment it
# knows least. A pass counts only once the bot has answered inside its window
# (a review object or a comment); an unanswered trailing pass is dropped from
# the series and reported as `pending`. It still counts toward the round cap:
# the round was spent whether or not it was answered.
#
# THE CAP is rounds, not findings: --cap N, else $RALPH_REVIEW_ROUND_CAP, else
# 5. Attended lanes get the default; an unattended lane should set 2, because
# the thing a cap protects there is a session budget nobody is watching.
#
# This script gates NOTHING. It changes no verdict and blocks no merge — the
# same split GH-1945 settled for advisory findings: the measurement is code,
# the decision stays with the driver, and the escalation verb is the board's
# (`board move NNN human-needed`). There is no code path at "the driver decides
# to re-request", so a gate here would have nothing to sit in front of.
#
# Output: one line of JSON on stdout, always. Exit 0 for every verdict; 2 on
# usage error.
#   {"ok":true,"verdict":"stalled","passes":3,"series":[5,2,4],"pending":false,
#    "cap":5,"detail":"..."}
# ok=false is "not evaluated", never "converging": an unreadable history must
# not read as a healthy loop, which is the failure mode this whole file exists
# to remove.

set -euo pipefail

PR_NUMBER=""
CAP="${RALPH_REVIEW_ROUND_CAP:-5}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cap) CAP="${2:-}"; shift 2 ;;
    -*) echo "Usage: $0 PR_NUMBER [--cap N]" >&2; exit 2 ;;
    *) PR_NUMBER="$1"; shift ;;
  esac
done
if [[ -z "$PR_NUMBER" ]] || ! [[ "$CAP" =~ ^[0-9]+$ ]] || [[ "$CAP" -lt 1 ]]; then
  echo "Usage: $0 PR_NUMBER [--cap N]   (N a positive integer)" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
POLICY_FILE="${RALPH_MERGE_POLICY_FILE:-$REPO_ROOT/.github/ralph-merge-policy.json}"

# Same three policy reads, same defaults, as codex-review-evidence.sh and
# advisory-findings.sh — so "who is the reviewer" and "what marks a pass"
# cannot drift between the gate and the rule that decides to stop feeding it.
BOT="chatgpt-codex-connector[bot]"
TRIGGER="@codex review"
HEAD_MARKER_KEY="ralph-review-head"
if [[ -f "$POLICY_FILE" ]] && jq -e . "$POLICY_FILE" >/dev/null 2>&1; then
  BOT=$(jq -r '.external_review.bot // "chatgpt-codex-connector[bot]"' "$POLICY_FILE")
  TRIGGER=$(jq -r '.external_review.trigger // "@codex review"' "$POLICY_FILE")
  HEAD_MARKER_KEY=$(jq -r '.external_review.head_marker // "ralph-review-head"' "$POLICY_FILE")
fi

emit() { # emit <ok> <verdict> <passes> <series-json> <pending> <detail>
  jq -nc --argjson ok "$1" --arg v "$2" --argjson p "$3" --argjson s "$4" \
    --argjson pend "$5" --argjson cap "$CAP" --arg d "$6" \
    '{ok: $ok, verdict: $v, passes: $p, series: $s, pending: $pend, cap: $cap, detail: $d}'
  exit 0
}

# pipefail (set above) is load-bearing in every `if !`: without it the recorded
# status would be jq's, so a failed `gh api` would read as an empty comment
# list — i.e. as a PR that has never been reviewed, which scores as converging.
if ! comments=$(gh api "repos/{owner}/{repo}/issues/$PR_NUMBER/comments" --paginate 2>/dev/null | jq -s 'add // []'); then
  emit false not-evaluated 0 '[]' false "cannot read PR comments (gh api failed) — retry"
fi
if ! reviews=$(gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER/reviews" --paginate 2>/dev/null | jq -s 'add // []'); then
  emit false not-evaluated 0 '[]' false "cannot read PR reviews (gh api failed) — retry"
fi

# Ordering is by created_at, not updated_at. Gate 5 binds a request to a head
# with max(updated_at) because an edited request must not inherit review
# evidence from before the edit; here the question is the opposite one — when
# did this round START — and an edit to round 2 must not reorder it after
# round 5.
requests=$(jq -c --arg trigger "$TRIGGER" --arg key "<!-- $HEAD_MARKER_KEY:" '
  [ .[]
    | select((.body // "") | contains($trigger))
    | select((.body // "") | contains($key))
    | {at: (.created_at // empty)}
    | select(.at != null)
  ] | sort_by(.at)' <<<"$comments")
passes=$(jq 'length' <<<"$requests")

if [[ "$passes" -eq 0 ]]; then
  emit true no-passes 0 '[]' false "no review request found on PR #$PR_NUMBER — the loop has not started"
fi

if ! threads=$(gh api graphql -F owner='{owner}' -F repo='{repo}' -F pr="$PR_NUMBER" -f query='
  query($owner:String!,$repo:String!,$pr:Int!){
    repository(owner:$owner,name:$repo){ pullRequest(number:$pr){
      reviewThreads(first:100){
        pageInfo{ hasNextPage }
        nodes{ comments(first:1){ nodes{ author{login} createdAt body } } }
      } } } }' 2>/dev/null); then
  emit false not-evaluated "$passes" '[]' false "gh api graphql failed"
fi
if ! jq -e '.data.repository.pullRequest.reviewThreads' >/dev/null 2>&1 <<<"$threads"; then
  emit false not-evaluated "$passes" '[]' false "review threads unreadable for PR #$PR_NUMBER"
fi
if [[ "$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage' <<<"$threads")" == "true" ]]; then
  # Same bound and same honesty as gate 5 and advisory-findings: a partial
  # series is a WRONG series, not a small one — the dropped threads land in
  # whichever passes GitHub happened to page last, so any comparison built on
  # it is arbitrary. Report not-evaluated. A PR that has filed more than 100
  # blocking threads is, in any case, the case this rule exists to catch, and
  # the round cap still reads.
  emit false not-evaluated "$passes" '[]' false "more than 100 review threads — series not computable"
fi

# Everything the bot said, as timestamps: findings (blocking threads it filed)
# and answers (any review object or comment it produced). A pass is complete
# when an ANSWER lands in its window — never when a FINDING does, since the
# whole point of a converging loop is that late passes have no findings.
findings=$(jq -c --arg bot "$BOT" '
  def norm: sub("^app/"; "") | sub("\\[bot\\]$"; "");
  [ .data.repository.pullRequest.reviewThreads.nodes[]
    | .comments.nodes[0] // empty
    | select(((.author.login // "") | norm) == ($bot | norm))
    # Both renderings, anchored on the badge markup: a bare "P0" substring
    # also matches a P1 finding whose prose merely mentions P0.
    | select(((.body // "") | test("\\[P0 Badge\\]")) or ((.body // "") | test("alt=\"P0\"")))
    | .createdAt ]' <<<"$threads")

answers=$(jq -c --arg bot "$BOT" --argjson c "$comments" '
  def norm: sub("^app/"; "") | sub("\\[bot\\]$"; "");
  [ (.[] | select(((.user.login // "") | norm) == ($bot | norm)) | .submitted_at // empty),
    ($c[] | select(((.user.login // "") | norm) == ($bot | norm)) | .created_at // empty) ]' <<<"$reviews")

# Window k is [request_k, request_{k+1}) — half-open, so a finding filed at the
# exact instant of the next request belongs to the round that asked for it.
series_json=$(jq -c -n --argjson req "$requests" --argjson f "$findings" --argjson a "$answers" '
  [ range(0; ($req | length)) as $i
    | { lo: $req[$i].at,
        hi: (if $i + 1 < ($req | length) then $req[$i+1].at else null end) }
    | . as $w
    | { n:        [ $f[] | select(. >= $w.lo) | select($w.hi == null or . < $w.hi) ] | length,
        answered: ([ $a[] | select(. >= $w.lo) | select($w.hi == null or . < $w.hi) ] | length) > 0 } ]')

# Only completed passes carry a count. An unanswered pass in the MIDDLE of the
# series is dropped too, not just a trailing one: a round the bot never
# answered contributes no evidence about whether findings are shrinking, and
# scoring its empty window as zero would fabricate a decrease.
complete=$(jq -c '[ .[] | select(.answered) | .n ]' <<<"$series_json")
pending=$(jq -c '.[-1].answered | not' <<<"$series_json")
n_complete=$(jq 'length' <<<"$complete")

detail_series=$(jq -r 'join(", ")' <<<"$complete")

last=$(jq -r 'if length > 0 then .[-1] else -1 end' <<<"$complete")

# ZERO IS THE FLOOR, NOT A STALL — and this ordering is the whole reason the
# rule was run against live PRs before it was believed. A strict-decrease test
# reads "0 then 0" as a failure to improve, so the first draft escalated #1970,
# #1962, #1964 and #1949 — every one of them a clean PR that merged, several of
# them clean from the very first pass. The loop cannot decrease below zero, so
# a latest pass with no blocking findings IS the terminal success state and is
# reported before any other test, including the cap: capping a PR whose review
# has converged would block a mergeable diff for the offence of having been
# pushed often, and pushes here happen for CI and attestation reasons that have
# nothing to do with review iteration.
if [[ "$last" -eq 0 ]]; then
  emit true converged "$passes" "$complete" "$pending" \
    "no blocking findings at the latest completed pass ($passes round(s) spent) — the loop has converged"
fi

# Cap next: terminal regardless of the trend, and only reachable now that the
# latest pass still carries blocking findings — i.e. genuinely mid-iteration.
# Hitting the cap is an escalation, not a failure: the work may be fine, it is
# the loop that is out of budget.
if [[ "$passes" -ge "$CAP" ]]; then
  # $last is -1 when no pass has been answered at all; say so rather than
  # printing a negative count. Rounds spent still counts them: nine unanswered
  # requests is a loop worth stopping, not a loop with no data.
  if [[ "$n_complete" -eq 0 ]]; then
    still="no pass answered yet"
  else
    still="still $last blocking finding(s)"
  fi
  emit true cap-reached "$passes" "$complete" "$pending" \
    "round cap reached: $passes review request(s) against a cap of $CAP, $still — escalate to Human Needed rather than requesting another review"
fi

if [[ "$n_complete" -lt 2 ]]; then
  emit true insufficient-data "$passes" "$complete" "$pending" \
    "$n_complete completed pass(es) of $passes request(s) — need two to compare"
fi

prev=$(jq -r '.[-2]' <<<"$complete")
if [[ "$last" -ge "$prev" ]]; then
  emit true stalled "$passes" "$complete" "$pending" \
    "blocking findings did not decrease across the last two passes ($prev then $last; series: $detail_series) — escalate to Human Needed rather than requesting another review"
fi

emit true converging "$passes" "$complete" "$pending" \
  "blocking findings decreasing ($prev then $last; series: $detail_series), $passes of $CAP round(s) spent"
