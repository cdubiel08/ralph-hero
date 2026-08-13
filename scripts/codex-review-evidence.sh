#!/bin/bash
# Findings-mode external-review evidence: ONE scoped review per head (GH-1847).
#
# Usage: ./scripts/codex-review-evidence.sh PR_NUMBER HEAD_SHA
#
# The reviewer this mode is written for (Codex) has no APPROVED verb. It emits
# findings, each carrying its own severity badge, as review THREADS. Measured
# on this repo 2026-08-13: 67 Codex reviews, 0 of them clean. A gate that waits
# for a clean verdict therefore waits on a signal the reviewer is documented
# not to produce, and — because every fix widens the diff and the wider diff
# draws new findings — it does not terminate on large PRs (#1764: 33 rounds,
# findings grew 5 -> 19 -> 22). That is an unlegislated diff-size cap, not a
# quality bar.
#
# So the evidence is inverted. Not "the reviewer said yes" but "the reviewer
# LOOKED at this head, and nothing it raised at the top severity is still
# open":
#
#   1. a head-bound request comment (the policy trigger + the head marker), so
#      the review that counts is the one asked for at THIS head, scoped;
#   2. a review by the policy bot at that head, submitted after the request;
#   3. zero unresolved P0 threads from that bot.
#
# P1/P2 are advisory by construction — visible on the PR, adjudicated by the
# driver, never blocking. That is the whole bound: one pass, top severity only.
#
# OUTDATED threads do not block. GitHub marks a thread outdated when the lines
# it anchors to change — the code it was about is gone. Counting those would
# rebuild the trap this replaces: Codex does not resolve its own threads, so a
# P0 that was fixed by a push would block forever with no verb to clear it.
# The remaining verbs are real ones: fix the code (the thread goes outdated),
# or resolve the thread (adjudicated, audit-logged).
#
# Honest limits: findings stated only in a review BODY (not a thread) are not
# seen — Codex files findings as threads; and >100 threads is not evaluated
# rather than guessed at (it reports not-ok, naming the remedy).
#
# Output: one line of JSON on stdout, always.
#   {"ok":true|false,"turn":"yours"|"reviewer"|"","detail":"...",
#    "reviewer":"...","review_url":"..."}
#   ok=false is "not yet" (retry-able), never a negative verdict: gate 1
#   already catches CHANGES_REQUESTED. Callers map it to PENDING. `turn` is
#   for pr-gate-watch.sh, so the watcher classifies whose move it is from the
#   same evaluation rather than re-deriving one of its own.
# Exit 0 for every verdict; 2 on usage error.

set -euo pipefail

PR_NUMBER="${1:-}"
HEAD_SHA="${2:-}"
if [[ -z "$PR_NUMBER" || -z "$HEAD_SHA" ]]; then
  echo "Usage: $0 PR_NUMBER HEAD_SHA" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
POLICY_FILE="${RALPH_MERGE_POLICY_FILE:-$REPO_ROOT/.github/ralph-merge-policy.json}"

BOT="chatgpt-codex-connector[bot]"
TRIGGER="@codex review"
HEAD_MARKER_KEY="ralph-review-head"
if [[ -f "$POLICY_FILE" ]] && jq -e . "$POLICY_FILE" >/dev/null 2>&1; then
  BOT=$(jq -r '.external_review.bot // "chatgpt-codex-connector[bot]"' "$POLICY_FILE")
  TRIGGER=$(jq -r '.external_review.trigger // "@codex review"' "$POLICY_FILE")
  HEAD_MARKER_KEY=$(jq -r '.external_review.head_marker // "ralph-review-head"' "$POLICY_FILE")
fi

# The one place the severity taxonomy is named. Codex renders severity as a
# shields.io badge whose ALT TEXT is the tier ("![P0 Badge](...)"), so match the
# alt text — a bare "P0" substring also matches a P2 finding whose prose
# mentions P0.
BLOCKING_BADGE='\[P0 Badge\]'

verdict() { # verdict <ok:true|false> <turn> <detail> [reviewer] [review_url]
  jq -nc --argjson ok "$1" --arg t "$2" --arg d "$3" --arg r "${4:-}" --arg u "${5:-}" \
    '{ok: $ok, turn: $t, detail: $d, reviewer: $r, review_url: $u}'
  exit 0
}

# pipefail (set at the top) is load-bearing in every `if !` below: without it
# the recorded status would be jq's, so a failed `gh api` would read as EMPTY
# EVIDENCE — "no review yet" — instead of an unavailable API.
if ! comments=$(gh api "repos/{owner}/{repo}/issues/$PR_NUMBER/comments" --paginate 2>/dev/null | jq -s 'add // []'); then
  verdict false reviewer "cannot read PR comments (gh api failed) — retry"
fi

# Bind the request to the COMPLETE head sha: a push cannot inherit an older
# review, and a prefix collision cannot satisfy an exact HTML marker. Editing a
# request counts as a new request for ordering, or an old comment could be
# rewritten with the new sha and inherit review evidence from before the edit.
head_marker="<!-- $HEAD_MARKER_KEY: $HEAD_SHA -->"
request_at=$(jq -r --arg trigger "$TRIGGER" --arg marker "$head_marker" '
  [ .[]
    | select((.body // "") | contains($trigger))
    | select((.body // "") | contains($marker))
    | .updated_at // .created_at // empty
  ] | max // ""' <<<"$comments")
if [[ -z "$request_at" ]]; then
  verdict false yours "no review request at head ${HEAD_SHA:0:8} — comment '$TRIGGER' with '$head_marker'"
fi

if ! reviews=$(gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER/reviews" --paginate 2>/dev/null | jq -s 'add // []'); then
  verdict false reviewer "cannot read PR reviews (gh api failed) — retry"
fi

# The review that answers THIS request. `>=` rather than `>` on a second-
# precision timestamp: a review takes minutes, so the same-second case is
# theoretical, while failing closed on it would strand a real review behind a
# request that can only be re-posted (moving the bound forward again).
review=$(jq -c --arg bot "$BOT" --arg sha "$HEAD_SHA" --arg req "$request_at" '
  def norm: sub("^app/"; "") | sub("\\[bot\\]$"; "");
  [ .[]
    | select(((.user.login // "") | norm) == ($bot | norm))
    | select((.commit_id // "") == $sha)
    | select((.state // "") != "DISMISSED")
    | select((.submitted_at // "") >= $req)
  ] | last // empty' <<<"$reviews")
if [[ -z "$review" ]]; then
  verdict false reviewer "$BOT has not reviewed head ${HEAD_SHA:0:8} yet (requested $request_at)"
fi
reviewer=$(jq -r '.user.login // ""' <<<"$review")
review_url=$(jq -r '.html_url // ""' <<<"$review")

# Resolution state is GraphQL-only; REST review comments carry no isResolved.
# {owner}/{repo} are gh's own placeholders and resolve from the git remote.
if ! threads=$(gh api graphql -F owner='{owner}' -F repo='{repo}' -F pr="$PR_NUMBER" -f query='
  query($owner:String!,$repo:String!,$pr:Int!){
    repository(owner:$owner,name:$repo){ pullRequest(number:$pr){
      reviewThreads(first:100){
        pageInfo{ hasNextPage }
        nodes{ isResolved isOutdated comments(first:1){ nodes{ author{login} body url } } }
      } } } }' 2>/dev/null); then
  verdict false reviewer "cannot read review threads (gh api graphql failed) — retry"
fi
if ! jq -e '.data.repository.pullRequest.reviewThreads' >/dev/null 2>&1 <<<"$threads"; then
  verdict false reviewer "review threads unreadable for PR #$PR_NUMBER — retry"
fi
if [[ "$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage' <<<"$threads")" == "true" ]]; then
  verdict false yours "PR has more than 100 review threads — not evaluated; resolve threads to bring it back in range"
fi

blocking=$(jq -c --arg bot "$BOT" --arg badge "$BLOCKING_BADGE" '
  def norm: sub("^app/"; "") | sub("\\[bot\\]$"; "");
  [ .data.repository.pullRequest.reviewThreads.nodes[]
    | select(.isResolved == false and .isOutdated == false)
    | .comments.nodes[0] // empty
    | select(((.author.login // "") | norm) == ($bot | norm))
    | select((.body // "") | test($badge))
  ]' <<<"$threads")
blocking_n=$(jq -r 'length' <<<"$blocking")
if [[ "$blocking_n" -gt 0 ]]; then
  first=$(jq -r '.[0].url // ""' <<<"$blocking")
  verdict false yours "$blocking_n unresolved P0 finding(s) at ${HEAD_SHA:0:8} — fix (the thread goes outdated) or resolve the thread once adjudicated: $first"
fi

verdict true "" "$BOT reviewed ${HEAD_SHA:0:8} with no unresolved P0 findings" "$reviewer" "$review_url"
