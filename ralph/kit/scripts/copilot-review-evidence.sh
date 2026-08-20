#!/bin/bash
# Findings-mode external-review evidence, review-request protocol (GH-2087).
#
# Usage: ./scripts/copilot-review-evidence.sh PR_NUMBER HEAD_SHA
#
# The reviewer this mode is written for (GitHub Copilot code review) differs
# from the comment-marker protocol (codex-review-evidence.sh) in three
# measured ways — public-corpus captures, 2026-08-19, n=31 reviews across ~35
# PRs (thoughts/shared/research/2026-08-19-copilot-review-evidence-measurement.md):
#
#   1. It is engaged via a GitHub REVIEW REQUEST, not a comment mention. The
#      login one requests is `Copilot`; the reviews are filed by
#      `copilot-pull-request-reviewer[bot]` (REST) /
#      `copilot-pull-request-reviewer` (GraphQL) — me_norm bridges the [bot]
#      halves; the request half is matched on both spellings below. A request
#      is NOT head-bound (GitHub review requests are PR-level), but the ANSWER
#      is: every Copilot review carries commit_id. That is the binding gate 5
#      reads, so no head-marker comment protocol exists in this mode.
#      A request on an unentitled repo FAILS SILENTLY (200, nothing recorded),
#      so the remedy text tells the caller to read the request back.
#
#   2. A clean diff still produces a review object — "generated no comments" /
#      "Comments generated: 0" (both formats observed) — so unlike Codex there
#      is no plain-comment fallback: the review object is always the answer,
#      and the GH-1847 unsatisfiable-predicate trap does not apply. BUT the
#      inverse trap is live: a quota-exhausted or cannot-review Copilot ALSO
#      files a real COMMENTED review at the head ("Copilot was unable to
#      review this pull request because the user who requested the review has
#      reached their quota limit." — 9 of the 31 sampled; "Copilot wasn't able
#      to review any files in this pull request."). A bare review-object
#      predicate scores those as answered. The failure family is excluded by
#      body prefix — the ONLY body parsing here, because the summary format is
#      demonstrably unstable (two shapes in one sample) and counts must come
#      from thread ground truth. An unrecognized future failure phrasing would
#      read as answered (fail-open on that edge); the thread count still
#      gates, and the driver sees the review body on the PR.
#
#   3. It emits NO machine-readable severity — inline comments are plain
#      prose, no badges (unlike Codex's ![P0 Badge] or Greptile's <img
#      alt="P1">). So the predicate cannot be "zero P0": it is "answered at
#      this head, zero unresolved non-outdated threads from the bot". Every
#      thread blocks until fixed (the thread goes outdated) or resolved
#      (adjudicated, audit-logged) — the same two verbs as the Codex mode,
#      applied to all findings instead of the top tier.
#
# OUTDATED threads do not block, for the reason stated in
# codex-review-evidence.sh: the reviewer does not resolve its own threads, so
# a finding fixed by a push would otherwise block forever with no verb to
# clear it.
#
# Output contract is IDENTICAL to codex-review-evidence.sh, so
# me_run_evidence_script and all three callers (merge-pr.sh,
# validate-attestation.sh, pr-gate-watch.sh) treat both scripts
# interchangeably:
#   {"ok":true|false,"turn":"yours"|"reviewer"|"","detail":"...",
#    "reviewer":"...","review_url":"..."}
#   ok=false is "not yet" (retry-able), never a negative verdict: gate 1
#   already catches CHANGES_REQUESTED.
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
# shellcheck source=lib/merge-evidence.sh
. "$SCRIPT_DIR/lib/merge-evidence.sh"
POLICY_FILE="$(me_policy_file "$REPO_ROOT")"

# A malformed or absent policy falls back to the defaults rather than failing
# closed: this script is a PREDICATE its callers run, and gates 4-5 already
# refuse an unreadable policy before they ever reach it.
set +e
POLICY=$(me_policy_load "$POLICY_FILE")
POLICY_RC=$?
set -e
[[ "$POLICY_RC" -eq 0 ]] || POLICY=$(jq -n "$ME_JQ_LIB me_policy_none")
BOT=$(me_policy_get "$POLICY" bot)
# Run standalone with no policy, the loader's review-mode default (the Codex
# connector) is not this protocol's reviewer. Floor to the measured login.
[[ -n "$BOT" && "$BOT" != "chatgpt-codex-connector[bot]" ]] \
  || BOT="copilot-pull-request-reviewer[bot]"

# The measured failure family: a real COMMENTED review object whose body says
# the reviewer reviewed NOTHING. Anchored at the start of the body — every
# observed success body opens differently ("## Pull request overview") — and
# the apostrophe is a dot because typographic vs ASCII quoting is exactly the
# kind of rendering detail that shifts under our feet.
FAILURE_BODY_RE="^Copilot (was unable|wasn.t able) to review"

# The request command in remedy strings. The requestable login is `Copilot` —
# requesting the bot's own filing login is silently dropped (measured).
REQUEST_CMD="gh api -X POST repos/{owner}/{repo}/pulls/$PR_NUMBER/requested_reviewers -f 'reviewers[]=Copilot'"

verdict() { # verdict <ok:true|false> <turn> <detail> [reviewer] [review_url]
  jq -nc --argjson ok "$1" --arg t "$2" --arg d "$3" --arg r "${4:-}" --arg u "${5:-}" \
    '{ok: $ok, turn: $t, detail: $d, reviewer: $r, review_url: $u}'
  exit 0
}

# pipefail (set at the top) is load-bearing in every `if !` below: without it
# the recorded status would be jq's, so a failed `gh api` would read as EMPTY
# EVIDENCE — "no review yet" — instead of an unavailable API.
if ! reviews=$(gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER/reviews" --paginate 2>/dev/null | jq -s 'add // []'); then
  verdict false reviewer "cannot read PR reviews (gh api failed) — retry"
fi

# Bot reviews bound to the COMPLETE head sha, non-dismissed. Split into the
# answers (reviewed something — possibly nothing wrong) and the failure family
# (reviewed nothing while looking like an answer).
at_head=$(jq -c --arg bot "$BOT" --arg sha "$HEAD_SHA" '
  def norm: sub("^app/"; "") | sub("\\[bot\\]$"; "");
  [ .[]
    | select(((.user.login // "") | norm) == ($bot | norm))
    | select((.commit_id // "") == $sha)
    | select((.state // "") != "DISMISSED")
  ]' <<<"$reviews")
answer=$(jq -c --arg re "$FAILURE_BODY_RE" '
  [ .[] | select((.body // "") | test($re) | not) ] | last // empty' <<<"$at_head")
failed=$(jq -c --arg re "$FAILURE_BODY_RE" '
  [ .[] | select((.body // "") | test($re)) ] | last // empty' <<<"$at_head")

if [[ -z "$answer" ]]; then
  if [[ -n "$failed" ]]; then
    # A failure review is the reviewer's OWN report that it reviewed nothing.
    # Re-requesting is the only verb that produces a real answer, so the turn
    # is the caller's — waiting on a review that already declined cannot
    # terminate.
    why=$(jq -r '.body // "" | (. / "\n")[0]' <<<"$failed")
    verdict false yours "$BOT declined to review ${HEAD_SHA:0:8} (\"$why\") — re-request once the cause clears: $REQUEST_CMD"
  fi
  # No answer at this head. Whose turn depends on whether a request is
  # pending: a review request is PR-level (not head-bound), and a pending one
  # means the reviewer will answer at (approximately) the current head.
  if ! requested=$(gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER/requested_reviewers" 2>/dev/null); then
    verdict false reviewer "cannot read requested reviewers (gh api failed) — retry"
  fi
  pending=$(jq -r --arg bot "$BOT" '
    def norm: sub("^app/"; "") | sub("\\[bot\\]$"; "") | ascii_downcase;
    [ (.users // [])[] | (.login // "") | norm
      | select(. == ($bot | norm) or . == "copilot") ] | length' <<<"$requested")
  if [[ "${pending:-0}" -gt 0 ]]; then
    verdict false reviewer "$BOT review requested — waiting for its review at ${HEAD_SHA:0:8}"
  fi
  verdict false yours "no $BOT review at head ${HEAD_SHA:0:8} and no pending request — request one: $REQUEST_CMD (then read the request back: a request on a repo without Copilot code review is silently dropped)"
fi
reviewer=$(jq -r '.user.login // ""' <<<"$answer")
review_url=$(jq -r '.html_url // ""' <<<"$answer")

# Resolution state is GraphQL-only; REST review comments carry no isResolved.
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

# EVERY unresolved, non-outdated thread from the bot blocks — no badge filter,
# because no badge exists (measured). The driver's verbs are the Codex mode's:
# fix (the thread goes outdated) or resolve (adjudicated).
blocking=$(jq -c --arg bot "$BOT" '
  def norm: sub("^app/"; "") | sub("\\[bot\\]$"; "");
  [ .data.repository.pullRequest.reviewThreads.nodes[]
    | select(.isResolved == false and .isOutdated == false)
    | .comments.nodes[0] // empty
    | select(((.author.login // "") | norm) == ($bot | norm))
  ]' <<<"$threads")
blocking_n=$(jq -r 'length' <<<"$blocking")
if [[ "$blocking_n" -gt 0 ]]; then
  first=$(jq -r '.[0].url // ""' <<<"$blocking")
  verdict false yours "$blocking_n unresolved $BOT finding(s) at ${HEAD_SHA:0:8} — fix (the thread goes outdated) or resolve the thread once adjudicated: $first"
fi

verdict true "" "$BOT reviewed ${HEAD_SHA:0:8} with no unresolved findings" "$reviewer" "$review_url"
