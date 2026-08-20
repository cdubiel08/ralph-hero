#!/bin/bash
# scripts/review-threads.sh — the one reader (and the two writers) of a PR's
# review threads.
#
# Usage:
#   ./scripts/review-threads.sh PR [--unresolved] [--json]
#   ./scripts/review-threads.sh PR --reply <threadId> -m "<msg>"
#   ./scripts/review-threads.sh PR --resolve <threadId>
#   ./scripts/review-threads.sh PR --reply <threadId> -m "<msg>" --resolve <threadId>
#
# Why this exists (ways-of-working audit, A4): 107 hand-rolled `reviewThreads`
# GraphQL literals across 7 sessions, plus per-worktree reply helpers — every
# review round re-invents this read, and `GATE-YOURS review` named the problem
# while handing back no tool. Unresolved review threads are the work list
# (they, not timestamps, are ground truth), so the reader ships once, here.
#
# Reads:
#   Default listing: one line per thread — id, resolved/outdated flags,
#   severity badge if present, path:line, author, first-comment excerpt.
#   A `gate-blocking` tag marks the threads gate 5 already blocks on (policy
#   bot + P0 in findings mode; every bot thread under review-request mode) —
#   the same subtraction advisory-findings.sh makes, read from the same
#   policy via scripts/lib/merge-evidence.sh so the two cannot drift.
#   --unresolved filters to isResolved == false (outdated ones stay visible,
#   flagged — gate 5 ignores them, but hiding them here would make this
#   listing a second opinion about the same evidence).
#   --json prints the enriched array instead of the human table.
#
#   The list is read PAGINATED (the GH-1842 lesson): a bounded window on a
#   long PR renders a real thread as absent. And an UNREADABLE list is a
#   distinct exit 3, never rendered as "no threads" — "none" and "could not
#   read" have opposite correct responses (act vs retry), the same rule
#   me_attestation_comment already carries.
#
# Writes (both wrapped in gb_gh from scripts/lib/gh-budget.sh — a rate-limited
# `gh` write can exit 0 having written nothing, GH-1817, and a reply that
# silently never posted is a review round that silently never ends):
#   --reply <threadId> -m "<msg>"   addPullRequestReviewThreadReply
#   --resolve <threadId>            resolveReviewThread, then post one PR
#                                   comment to nudge the required status to
#                                   recompute — resolving a thread fires no
#                                   workflow event GitHub accepts (GH-1847),
#                                   so without the nudge `ralph-attestation`
#                                   sits stale until something else moves.
#   When both are given, the reply lands first (answer, then resolve).
#
# Exit codes: 0 ok; 2 usage; 3 thread list unreadable (NOT "no threads");
# 75 rate-limited write (EX_TEMPFAIL — retry after the reset); anything else
# is gh's own exit, unchanged.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  review-threads.sh PR [--unresolved] [--json]        list review threads
  review-threads.sh PR --reply <threadId> -m "<msg>"  reply in-thread
  review-threads.sh PR --resolve <threadId>           resolve + recompute nudge

  --unresolved   only threads with isResolved == false
  --json         machine-readable array (id, resolved, outdated, tier, path,
                 line, author, url, excerpt, gating)
  --reply ID     post an in-thread reply (requires -m/--message)
  -m, --message  the reply body
  --resolve ID   resolve the thread, then post a PR comment so the required
                 status recomputes (GH-1847: resolving fires no workflow event)

Thread ids are the node ids this listing prints (PRRT_...). Severity is read
from the badge each reviewer renders (Greptile <img alt="P1">, Codex
![P1 Badge]); `gate-blocking` marks what merge gate 5 already blocks on.

Exit: 0 ok; 2 usage; 3 thread list unreadable (distinct from "no threads");
75 rate-limited write — retry after the reset.
EOF
}

# --help short-circuits BEFORE any policy/config evaluation (audit B3c): help
# must work in a repo with no policy, no gh auth, no network.
for a in "$@"; do
  case "$a" in
    -h|--help) usage; exit 0 ;;
  esac
done

PR_NUMBER=""
UNRESOLVED_ONLY=false
AS_JSON=false
REPLY_THREAD=""
REPLY_MSG=""
RESOLVE_THREAD=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --unresolved) UNRESOLVED_ONLY=true; shift ;;
    --json)       AS_JSON=true; shift ;;
    --reply)      REPLY_THREAD="${2:?--reply needs a thread id}"; shift 2 ;;
    -m|--message) REPLY_MSG="${2:?-m needs a message}"; shift 2 ;;
    --resolve)    RESOLVE_THREAD="${2:?--resolve needs a thread id}"; shift 2 ;;
    -*)           echo "unknown flag: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -z "$PR_NUMBER" ]]; then PR_NUMBER="$1"; else
        echo "unexpected argument: $1" >&2; usage >&2; exit 2
      fi
      shift
      ;;
  esac
done

[[ -n "$PR_NUMBER" ]] || { usage >&2; exit 2; }
case "$PR_NUMBER" in
  *[!0-9]*) echo "PR must be a number, got: $PR_NUMBER" >&2; exit 2 ;;
esac
if [[ -n "$REPLY_THREAD" && -z "$REPLY_MSG" ]]; then
  echo "--reply needs -m/--message with the reply body" >&2
  exit 2
fi
if [[ -z "$REPLY_THREAD" && -n "$REPLY_MSG" ]]; then
  echo "-m/--message is only meaningful with --reply" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/merge-evidence.sh
. "$SCRIPT_DIR/lib/merge-evidence.sh"
# shellcheck source=lib/gh-budget.sh
. "$SCRIPT_DIR/lib/gh-budget.sh"

# EX_TEMPFAIL, the repo's retry-after-the-reset convention (attest-pr.sh,
# apply-evidence.sh). Consumers key on the message token, never the code.
REFUSED_EXIT=75

# The gating reviewer, from the same policy file gate 5 reads, so the
# `gate-blocking` tag cannot drift from what the gate actually blocks on.
# This script gates nothing, so an unreadable policy falls back to defaults
# rather than failing closed — the same choice advisory-findings.sh makes.
POLICY_FILE="$(me_policy_file "$REPO_ROOT")"
set +e
POLICY=$(me_policy_load "$POLICY_FILE")
POLICY_RC=$?
set -e
[[ "$POLICY_RC" -eq 0 ]] || POLICY=$(jq -n "$ME_JQ_LIB me_policy_none")
BOT=$(me_policy_get "$POLICY" bot)
MODE=$(me_policy_get "$POLICY" mode)
REQUEST_MODE=$(me_policy_get "$POLICY" requestMode)
[[ -n "$BOT" ]] || BOT="chatgpt-codex-connector[bot]"

# ---------------------------------------------------------------------------
# writes
# ---------------------------------------------------------------------------

# refuse_rate_limited <what> — the shared rate-limit refusal for both writes.
refuse_rate_limited() {
  echo "THREAD WRITE NOT APPLIED — rate limited; the $1 did NOT land" >&2
  echo "NEXT: re-run this exact command after the rate-limit reset" >&2
  exit "$REFUSED_EXIT"
}

if [[ -n "$REPLY_THREAD" ]]; then
  rc=0
  out=$(gb_gh api graphql \
    -f query='mutation($t: ID!, $b: String!) {
      addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $t, body: $b}) {
        comment { url }
      } }' \
    -F t="$REPLY_THREAD" -F b="$REPLY_MSG") || rc=$?
  [[ $rc -eq 4 ]] && refuse_rate_limited "reply"
  if [[ $rc -ne 0 ]]; then
    echo "ERROR: reply mutation failed (gh exit $rc)" >&2
    echo "NEXT: confirm the thread id with: bash scripts/review-threads.sh $PR_NUMBER --unresolved" >&2
    exit "$rc"
  fi
  reply_url=$(jq -r '.data.addPullRequestReviewThreadReply.comment.url // ""' <<<"$out" 2>/dev/null || echo "")
  if [[ -z "$reply_url" ]]; then
    echo "ERROR: reply mutation returned no comment — the reply may not have landed: $out" >&2
    exit 1
  fi
  echo "REPLIED — thread $REPLY_THREAD: $reply_url"
fi

if [[ -n "$RESOLVE_THREAD" ]]; then
  rc=0
  out=$(gb_gh api graphql \
    -f query='mutation($t: ID!) {
      resolveReviewThread(input: {threadId: $t}) {
        thread { id isResolved }
      } }' \
    -F t="$RESOLVE_THREAD") || rc=$?
  [[ $rc -eq 4 ]] && refuse_rate_limited "resolve"
  if [[ $rc -ne 0 ]]; then
    echo "ERROR: resolve mutation failed (gh exit $rc)" >&2
    echo "NEXT: confirm the thread id with: bash scripts/review-threads.sh $PR_NUMBER --unresolved" >&2
    exit "$rc"
  fi
  resolved=$(jq -r '.data.resolveReviewThread.thread.isResolved // false' <<<"$out" 2>/dev/null || echo "false")
  if [[ "$resolved" != "true" ]]; then
    echo "ERROR: resolve mutation did not report isResolved=true — not claiming it landed: $out" >&2
    exit 1
  fi
  echo "RESOLVED — thread $RESOLVE_THREAD"
  # The GH-1847 workaround, automated: resolving a thread fires no workflow
  # event GitHub accepts (`pull_request_review_thread` invalidates the whole
  # `on:` block when tried), so the required `ralph-attestation` status never
  # recomputes on its own. Any PR comment makes it recompute; this is that
  # comment. Its failure is NOT the resolve's failure — the resolve landed —
  # so it gets its own message and the same EX_TEMPFAIL when rate limited.
  rc=0
  gb_gh pr comment "$PR_NUMBER" \
    --body "Resolved review thread \`$RESOLVE_THREAD\` via scripts/review-threads.sh. This comment nudges the required status to recompute (GH-1847: resolving a thread fires no workflow event GitHub accepts)." \
    >/dev/null || rc=$?
  if [[ $rc -eq 4 ]]; then
    echo "THREAD RESOLVED but the recompute-nudge comment did NOT post (rate limited) — the required status will stay stale until any PR comment lands" >&2
    echo "NEXT: gh pr comment $PR_NUMBER --body 'recompute nudge (GH-1847)'   # after the rate-limit reset" >&2
    exit "$REFUSED_EXIT"
  fi
  if [[ $rc -ne 0 ]]; then
    echo "THREAD RESOLVED but the recompute-nudge comment failed (gh exit $rc)" >&2
    echo "NEXT: gh pr comment $PR_NUMBER --body 'recompute nudge (GH-1847)'" >&2
    exit "$rc"
  fi
  echo "NUDGED — posted the status-recompute comment on PR #$PR_NUMBER"
fi

# A write invocation is done here; the listing below is the read path.
if [[ -n "$REPLY_THREAD" || -n "$RESOLVE_THREAD" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# read: the paginated thread list
# ---------------------------------------------------------------------------

QUERY='query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $pr) {
    reviewThreads(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id isResolved isOutdated path line
        comments(first: 1) { nodes { author { login } body url } }
      } } } } }'

# unreadable <detail> — the distinct exit for a failed read. Never prints a
# thread count: an unreadable list rendered as "no threads" is the defect this
# script's read path exists to avoid (the GH-1842 shape).
unreadable() {
  echo "REVIEW THREADS UNREADABLE for PR #$PR_NUMBER — $1 (NOT the same as no threads)" >&2
  echo "NEXT: retry: bash scripts/review-threads.sh $PR_NUMBER" >&2
  exit 3
}

nodes='[]'
cursor=""
pages=0
while :; do
  pages=$((pages + 1))
  # 20 pages = 2,000 threads. Past that, a summary would be of a list we
  # never finished reading, and a partial count reported as a total is the
  # same dishonesty as an unreadable one reported as empty.
  [[ $pages -gt 20 ]] && unreadable "more than 2000 threads — refusing to render a partial list as the whole"
  if [[ -n "$cursor" ]]; then
    resp=$(gh api graphql -F owner='{owner}' -F repo='{repo}' -F pr="$PR_NUMBER" \
      -F cursor="$cursor" -f query="$QUERY" 2>/dev/null) || unreadable "gh api graphql failed (page $pages)"
  else
    resp=$(gh api graphql -F owner='{owner}' -F repo='{repo}' -F pr="$PR_NUMBER" \
      -f query="$QUERY" 2>/dev/null) || unreadable "gh api graphql failed (page $pages)"
  fi
  jq -e '.data.repository.pullRequest.reviewThreads' >/dev/null 2>&1 <<<"$resp" \
    || unreadable "response carried no reviewThreads connection (page $pages)"
  nodes=$(jq -c --argjson acc "$nodes" \
    '$acc + .data.repository.pullRequest.reviewThreads.nodes' <<<"$resp") \
    || unreadable "could not accumulate page $pages"
  has_next=$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage' <<<"$resp")
  [[ "$has_next" == "true" ]] || break
  cursor=$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor // ""' <<<"$resp")
  [[ -n "$cursor" ]] || unreadable "hasNextPage without an endCursor (page $pages)"
done

# Enrichment. tier() is the dual badge parser measured in
# scripts/advisory-findings.sh (Greptile renders <img alt="P1">, Codex renders
# ![P1 Badge](…) — a parser written against either alone misses the other's
# findings entirely). Reimplemented minimally here because that script exposes
# only a count; advisory-findings.sh's header is the source of truth for the
# forms. me_norm comes from the shared library (GH-1843), prepended.
enriched=$(jq -c --arg bot "$BOT" --arg mode "$MODE" --arg reqmode "$REQUEST_MODE" "$ME_JQ_LIB"'
  def tier($body):
    [ ["P0","P1","P2","P3"][] as $t
      | select(($body | test("alt=\"\($t)\"")) or ($body | test("\\[\($t) Badge\\]")))
      | $t ][0] // "";
  [ .[]
    | (.comments.nodes[0] // {}) as $c
    | { id: .id,
        resolved: .isResolved,
        outdated: .isOutdated,
        path: (.path // ""),
        line: (.line // null),
        author: (($c.author.login // "") | me_norm),
        url: ($c.url // ""),
        tier: tier($c.body // ""),
        excerpt: (($c.body // "")
                  | split("\n") | map(select(test("^[[:space:]]*$") | not))
                  | (.[0] // "") | .[0:100]) }
    # The gate-blocking tag: exactly what merge gate 5 blocks on, and only in
    # the mode where it blocks on threads at all — the policy bot'"'"'s P0 in
    # findings mode, every unresolved bot thread under review-request
    # (GH-2087, Copilot emits no severity markup to scope by). Same
    # subtraction advisory-findings.sh makes, same policy read.
    | .gating = ($mode == "findings"
                 and .resolved == false and .outdated == false
                 and .author == ($bot | me_norm)
                 and ($reqmode == "review-request" or .tier == "P0")) ]' <<<"$nodes")

if [[ "$UNRESOLVED_ONLY" == "true" ]]; then
  enriched=$(jq -c '[.[] | select(.resolved == false)]' <<<"$enriched")
fi

if [[ "$AS_JSON" == "true" ]]; then
  jq . <<<"$enriched"
  exit 0
fi

total=$(jq -r 'length' <<<"$enriched")
if [[ "$total" -eq 0 ]]; then
  # Printed, never left as silence: this is a successful read of an empty
  # list, which must not look like a read that never happened (exit 3 above).
  if [[ "$UNRESOLVED_ONLY" == "true" ]]; then
    echo "no unresolved review threads on PR #$PR_NUMBER"
  else
    echo "no review threads on PR #$PR_NUMBER"
  fi
  exit 0
fi

jq -r '.[] |
  [ .id,
    ((if .resolved then "resolved" else "UNRESOLVED" end)
     + (if .outdated then ",outdated" else "" end)),
    ((if .tier == "" then "-" else .tier end)
     + (if .gating then "(gate-blocking)" else "" end)),
    (if .path == "" then "-" else (.path + (if .line != null then ":\(.line)" else "" end)) end),
    ("@" + (if .author == "" then "?" else .author end)),
    .excerpt
  ] | join("  ")' <<<"$enriched"

jq -r --arg filtered "$UNRESOLVED_ONLY" '
  "\(length) thread(s)\(if $filtered == "true" then " (unresolved only)" else "" end): "
  + "\([.[] | select(.resolved == false)] | length) unresolved, "
  + "\([.[] | select(.gating)] | length) gate-blocking — "
  + "reply: --reply <id> -m \"...\"; resolve: --resolve <id>"' <<<"$enriched"
