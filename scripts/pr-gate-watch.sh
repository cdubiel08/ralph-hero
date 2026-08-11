#!/usr/bin/env bash
# pr-gate-watch — answer exactly one question about a PR: whose turn is it?
#
# Why this exists: on a repo running the GH-1589 merge gate,
#   until ! gh pr checks PR | grep -q pending; do sleep 30; done
# can never terminate. `ralph-attestation` is published as a pending status
# and stays pending until someone runs scripts/attest-pr.sh — the check is
# waiting on *you*. So the loop sits armed forever, and its silence is
# indistinguishable from "CI is still running". Observed repeatedly, most
# recently on PR #1740 (green for ~1h; the watcher never fired).
#
# The second false signal is subtler and points the other way: a
# rate-limited CodeRabbit check reports bucket=pass with description
# "Review rate limited" and reviews nothing. So "every check is green" is
# *also* not merge-ready — merge-pr.sh requires an external review, and
# attest-pr.sh hard-refuses with "no prior review".
#
# Verdicts, in precedence order — the actionable one always wins:
#
#   GATE-DONE               PR no longer open; nothing to wait for   exit 0
#   GATE-FAIL               check failed/cancelled, or CHANGES_REQUESTED  exit 0
#   GATE-WAIT ci            non-attestation checks still running     exit 10
#   GATE-YOURS review       no verdict AND the reviewer needs a nudge  exit 0
#   GATE-WAIT review        reviewer simply has not posted yet        exit 10
#   GATE-WAIT attestation   attested at this head; validator running  exit 10
#   GATE-YOURS attestation  everything else green; attestation left   exit 0
#   GATE-READY              green + reviewed + attested → merge       exit 0
#
# GATE-YOURS review outranks GATE-YOURS attestation deliberately:
# attest-pr.sh refuses when no review verdict exists, so reporting
# attestation first would send the caller into a guaranteed failure.
#
# Review identity comes from the REST reviews endpoint, not `gh pr view
# --json reviews`: the GraphQL shape omits the review URL and strips the
# `[bot]` suffix from bot logins, and both are needed verbatim for
# attest-pr.sh's --reviewer/--review-url. Same reason gate 5 of merge-pr.sh
# reads REST. Whether a CHANGES_REQUESTED is still *live* is taken from
# GitHub's own reviewDecision, which accounts for dismissals.
#
# Usage:
#   scripts/pr-gate-watch.sh PR              one-shot; prints one verdict line
#   scripts/pr-gate-watch.sh PR --watch      poll; one line per state CHANGE,
#                                            exits on the first terminal verdict
#
# Exit codes: 0 terminal verdict, 10 still waiting, 2 usage, 1 gh unreachable.
# Env: PR_GATE_ATTEST_CHECK (default "ralph-attestation") names the status
# published by validate-attestation.yml, for repos that renamed it.
#
# Honest limit: the attested-at-this-head check reads `gh pr view --json
# comments`, so on a PR with more comments than that window returns, the
# attestation comment can fall outside it and the verdict reverts to
# GATE-YOURS attestation. That errs in the safe direction — attest-pr.sh
# updates its existing comment rather than duplicating it, so acting on the
# stale verdict is idempotent. validate-attestation.sh reads the same window.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: pr-gate-watch.sh PR_NUMBER [--watch] [--interval SECONDS]

  --watch             poll until a terminal verdict; print each state change
  --interval SECONDS  poll interval in --watch mode (default 30)

Verdicts: GATE-READY | GATE-YOURS | GATE-WAIT | GATE-FAIL | GATE-DONE
Exit: 0 terminal, 10 still waiting, 2 usage error.
EOF
}

PR=""
WATCH=false
INTERVAL=30

while [ $# -gt 0 ]; do
  case "$1" in
    --watch) WATCH=true; shift ;;
    --interval)
      INTERVAL="${2:-}"
      [ -n "$INTERVAL" ] || { echo "--interval needs a value" >&2; exit 2; }
      shift 2
      ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; usage >&2; exit 2 ;;
    *)
      [ -z "$PR" ] || { echo "unexpected argument: $1" >&2; exit 2; }
      PR="$1"
      shift
      ;;
  esac
done

[ -n "$PR" ] || { usage >&2; exit 2; }
case "$PR" in
  '' | *[!0-9]*) echo "PR must be a number, got: $PR" >&2; exit 2 ;;
esac
case "$INTERVAL" in
  '' | *[!0-9]*) echo "--interval must be a number, got: $INTERVAL" >&2; exit 2 ;;
esac

ATTEST_CHECK="${PR_GATE_ATTEST_CHECK:-ralph-attestation}"
# Must stay in sync with MARKER in attest-pr.sh and validate-attestation.sh,
# which hardcode the same literal.
ATTEST_MARKER='<!-- ralph-attestation:v1 -->'

# The precedence ladder, as one jq program so it reads top-to-bottom in a
# single place and the shell holds no branching logic of its own. Kept in a
# quoted heredoc: the program contains single quotes, which cannot appear
# inside a single-quoted shell string.
read -r -d '' CLASSIFY_JQ <<'JQ' || true
def is_attest: .name == $attest or ((.description // "") | test("attest-pr\\.sh"));

($checks // [])                                        as $all
| ($all | map(select(is_attest)))                       as $att
| ($all | map(select(is_attest | not)))                 as $rest
| ($rest | map(select(.bucket == "fail" or .bucket == "cancel"))) as $bad
| ($rest | map(select(.bucket == "pending")))           as $running
| ($att  | map(select(.bucket == "pending")))           as $att_pending
# A rate-limited CodeRabbit check PASSES but reviews nothing — the one case
# where an all-green board still needs a human nudge to make progress.
| ($all | map(select(
    ((.name // "") | test("coderabbit"; "i")) and
    ((.description // "") | test("rate limit"; "i"))
  )))                                                   as $ratelimited
| ($reviews | map(select(.state == "APPROVED")))        as $approved
| ($reviews | map(select(.state == "COMMENTED")))       as $commented
| ($approved | last)                                    as $verdict
| ($att_pending | map(.name) | join(", "))              as $att_names
# Is there already an attestation for the CURRENT head? The status stays
# pending for the minute or two validate-attestation.yml takes to recompute,
# and during that window the next move is to wait, not to attest again. The
# same comparison covers the other direction: after a new push the recorded
# sha no longer matches, so re-attesting is correctly demanded.
| (($pr.comments // [])
   | map(select(.body | contains($marker)))
   | last | (.body // "")
   | (try (split("```json") | .[1] | split("```") | .[0] | fromjson | .head_sha)
      catch null) // "")                                as $attested_sha
| (($attested_sha != "") and ($attested_sha == ($pr.headRefOid // "")))
                                                        as $attested_current

| if ($pr.state // "OPEN") != "OPEN" then
    "GATE-DONE \($pr.state | ascii_downcase): PR #\($num) is not open — nothing to wait for"
  elif ($bad | length) > 0 then
    "GATE-FAIL ci: \($bad | map(.name) | join(", ")) — fix before attesting"
  elif ($pr.reviewDecision // "") == "CHANGES_REQUESTED" then
    "GATE-FAIL review: CHANGES_REQUESTED is live — adjudicate the threads, then re-attest"
  elif ($running | length) > 0 then
    "GATE-WAIT ci: \($running | length) running (\($running | map(.name) | join(", ")))"
  elif ($approved | length) == 0 and ($ratelimited | length) > 0 then
    "GATE-YOURS review: CodeRabbit rate-limited — its check PASSES but it reviewed nothing; post `@coderabbitai review`"
  elif ($approved | length) == 0 and ($commented | length) > 0 then
    "GATE-YOURS review: \($commented | length) comment-only review(s), no verdict — adjudicate threads, then attest with the real verdict"
  elif ($approved | length) == 0 then
    "GATE-WAIT review: no review verdict posted yet"
  elif ($att_pending | length) > 0 and $attested_current then
    "GATE-WAIT attestation: attested at \($attested_sha[0:8]) — validate-attestation is recomputing \($att_names)"
  elif ($att_pending | length) > 0 then
    "GATE-YOURS attestation: \($att_names) is the only check left — bash scripts/attest-pr.sh \($num) --run \"<test cmd>\" --review-verdict APPROVED --reviewer \"\($verdict.user.login // "unknown")\" --review-url \"\($verdict.html_url // "")\""
  else
    "GATE-READY: green + reviewed + attested — bash scripts/merge-pr.sh \($num)"
  end
JQ

# classify <checks-json> <pr-json> <reviews-json> -> one verdict line.
classify() {
  jq -n -r \
    --argjson checks "$1" \
    --argjson pr "$2" \
    --argjson reviews "$3" \
    --arg attest "$ATTEST_CHECK" \
    --arg marker "$ATTEST_MARKER" \
    --arg num "$PR" \
    "$CLASSIFY_JQ"
}

# json_array_or_empty <text> -> the text if it parses as a JSON array, else [].
json_array_or_empty() {
  if [ -n "$1" ] && printf '%s' "$1" | jq -e 'type == "array"' >/dev/null 2>&1; then
    printf '%s' "$1"
  else
    printf '[]'
  fi
}

# snapshot -> one verdict line, or non-zero if gh could not be reached.
snapshot() {
  local checks pr_json reviews
  # `gh pr checks` exits non-zero whenever any check is pending or failing,
  # and errors outright when a PR has no checks at all. Neither is an error
  # here, so the exit status is deliberately ignored; only an unparseable
  # payload is treated as "no checks".
  checks=$(gh pr checks "$PR" --json name,bucket,description 2>/dev/null) || true
  checks=$(json_array_or_empty "$checks")

  reviews=$(gh api "repos/{owner}/{repo}/pulls/$PR/reviews" 2>/dev/null) || true
  reviews=$(json_array_or_empty "$reviews")

  # PR state is the one query whose failure means we genuinely cannot judge.
  pr_json=$(gh pr view "$PR" \
    --json state,reviewDecision,headRefOid,comments 2>/dev/null) || return 1
  [ -n "$pr_json" ] || return 1

  classify "$checks" "$pr_json" "$reviews"
}

is_terminal() {
  case "$1" in
    GATE-WAIT*) return 1 ;;
    *) return 0 ;;
  esac
}

if [ "$WATCH" = false ]; then
  if ! line=$(snapshot); then
    echo "GATE-ERROR: could not query PR #$PR via gh" >&2
    exit 1
  fi
  printf '%s\n' "$line"
  if is_terminal "$line"; then exit 0; fi
  exit 10
fi

# --watch: emit only on state change, so a Monitor gets one notification per
# meaningful transition rather than one per poll. Transient gh failures must
# not kill a long watch, so they are tolerated until they look permanent.
last=""
fails=0
while :; do
  if line=$(snapshot); then
    fails=0
    if [ "$line" != "$last" ]; then
      printf '%s\n' "$line"
      last="$line"
    fi
    if is_terminal "$line"; then exit 0; fi
  else
    fails=$((fails + 1))
    if [ "$fails" -ge 3 ]; then
      echo "GATE-ERROR: gh unreachable for $fails consecutive polls — giving up"
      exit 1
    fi
  fi
  sleep "$INTERVAL"
done
