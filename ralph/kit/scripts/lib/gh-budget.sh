#!/usr/bin/env bash
# scripts/lib/gh-budget.sh — the one reader of the GitHub API rate-limit budget,
# and the one place the rate-limit FAILURE SHAPE is named.
#
# GH-1817. Two defects that look alike and are not:
#
#   (A) An exhausted-budget `gh` write fails SILENTLY. Observed 2026-08-12: a
#       `gh pr comment` printed "GraphQL: API rate limit exceeded" and exited 0
#       into a background job's output file. The comment never posted, and
#       nothing surfaced until that file was read by hand. Exit code is not a
#       reliable signal for `gh` under rate limiting — the OUTPUT is.
#
#   (B) Any surface that polls this token can starve every other one. #1785
#       bounded the largest consumer (`board list`), but the loop that actually
#       drove the budget to 0/5000 was `gh pr view --json reviews` every 45 s
#       and read no board data at all. Bounding limits each consumer's cost;
#       only a pre-spend check limits the aggregate.
#
# The two get OPPOSITE failure directions, deliberately:
#
#   (A) fails CLOSED. A write we cannot confirm landed is a failure. A false
#       positive costs one re-run of an idempotent post; a false negative is
#       the defect this file exists to remove.
#   (B) fails OPEN. A budget check that cannot read its own budget must never
#       block work — that would convert a transient outage into a full stop,
#       and the check is an optimization, never a gate.
#
# The budget (B) reads is GraphQL's, and the authority for it is GraphQL's
# OWN `rateLimit` field, never REST `rate_limit`'s `graphql` sub-bucket
# (GH-2278). That sub-bucket MIRRORS `core`: measured five times first-hand
# during and after a real exhaustion, it reported `remaining 5000 used 0`
# byte-identical to `core` — reset epoch included, and that epoch slid with
# the clock the way `core`'s rolling window does — at the same instant
# GraphQL's own counter said `remaining 0, used 5024`. A guard reading that
# key could not fire; it never had. `core` is reported correctly by the same
# call, so the defect is one sub-bucket and the fix is per-resource: the
# graphql resource is read from the authority, anything else stays on REST.
# The `rateLimit` field is exempt from the budget it reports on (two
# consecutive probes leave `remaining` unchanged, though `cost` prints 1), so
# (B) is still cost-neutral — and it ANSWERS AT ZERO, which is the honest
# limit: a probe that returns is not a probe that answers, so recovery is
# read from `remaining`, never from "the call did not throw".
#
# Source it as:  . "$(dirname "$0")/lib/gh-budget.sh"

# Below this many GraphQL points remaining, a polling loop should back off
# rather than spend. 500 leaves room for the handful of reads a merge gate or a
# board mutation needs to finish what it already started.
: "${RALPH_GH_BUDGET_FLOOR:=500}"

# errexit discipline, same convention as merge-evidence.sh: a bare `set -e` in a
# sourced helper silently converts the caller's next tolerated non-zero exit
# into an abort, so save and restore rather than turning it on.
_gb_noerrexit() { case $- in *e*) _GB_ERREXIT=1; set +e ;; *) _GB_ERREXIT=0 ;; esac; }
_gb_errexit_restore() { [ "${_GB_ERREXIT:-0}" = 1 ] && set -e; return 0; }

# ---------------------------------------------------------------------------
# (A) Naming the failure shape
# ---------------------------------------------------------------------------

# gb_looks_rate_limited <text>
#
# Exit 0 when the text carries GitHub's own rate-limit signature. Deliberately
# NARROW: "rate limit" alone also spells the external review bot's own
# "Review rate limited" check description, which is an unrelated concern that
# several scripts here already match on. Requiring the exceeded/too-quickly
# half separates GitHub's API refusal from a reviewer's own throttling.
gb_looks_rate_limited() {
  local t
  t=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$t" in
    *"rate limit"*"exceed"*|*"exceed"*"rate limit"*) return 0 ;;
    *"rate limit"*"too quickly"*|*"submitted too quickly"*) return 0 ;;
  esac
  return 1
}

# gb_gh <gh args...>
#
# Run `gh` and refuse to let a rate-limited call look like a success. Use it at
# every site that WRITES through gh and never re-reads to confirm — those are
# the calls whose silent no-op is invisible.
#
# stdout stays stdout and stderr stays stderr, so this is a drop-in at any call
# site. BOTH streams are searched: gh has been observed putting the rate-limit
# text on either one, and a guard that watched only the stream it expected
# would reproduce the defect on the other. Exit codes:
#   0  gh succeeded and the output carries no rate-limit signature
#   4  rate limited (whatever gh itself exited) — retry after the reset
#   *  gh's own non-zero exit, unchanged
#
# A rate-limited call that gh ALREADY reported as a failure is still reported
# as 4 rather than passed through: the caller's correct response is "wait for
# the reset", not "this write is malformed", and those are different remedies.
gb_gh() {
  local out err rc
  err=$(mktemp) || return 1
  _gb_noerrexit
  out=$(gh "$@" 2>"$err")
  rc=$?
  _gb_errexit_restore
  [ -n "$out" ] && printf '%s\n' "$out"
  cat "$err" >&2
  if gb_looks_rate_limited "$out$(cat "$err")"; then
    rm -f "$err"
    echo "gh-budget: GitHub API rate limit hit — the call did NOT take effect (gh exited $rc)" >&2
    return 4
  fi
  rm -f "$err"
  return "$rc"
}

# ---------------------------------------------------------------------------
# (B) Pre-spend budget awareness
# ---------------------------------------------------------------------------

# gb_snapshot [resource]
#
# Print "remaining limit reset_epoch" for the named resource (default graphql).
# Exit 3 when the budget cannot be read — never a guess, and never a zero: an
# unreadable budget and an exhausted one must not read alike, which is the same
# defect in miniature. Exit 4 when the probe ITSELF came back with GitHub's
# rate-limit signature (GH-2278 acceptance 2): an observed refusal is
# authoritative over any counter, and it is not "unreadable" — GitHub answered,
# and the answer was "no". The two exits are distinct because their remedies
# are: 3 means proceed (fail open), 4 means back off.
#
# The graphql resource is read from GraphQL's own `rateLimit` field; every
# other resource from REST `rate_limit`, where `core` is reported correctly.
# The reset is normalised to an epoch either way so callers do arithmetic on
# one shape.
gb_snapshot() {
  local res="${1:-graphql}" json err
  if [ "$res" = "graphql" ]; then
    err=$(mktemp) || return 3
    _gb_noerrexit
    json=$(gh api graphql -f query='{rateLimit{remaining limit resetAt}}' 2>"$err")
    _gb_errexit_restore
    if gb_looks_rate_limited "$json$(cat "$err")"; then rm -f "$err"; return 4; fi
    rm -f "$err"
    [ -z "$json" ] && return 3
    printf '%s' "$json" | jq -e -r '
      .data.rateLimit // empty
      | select((.remaining|type) == "number" and (.resetAt|type) == "string")
      | [(.remaining|tostring), (.limit|tostring), (.resetAt|fromdateiso8601|tostring)]
      | join(" ")
    ' 2>/dev/null || return 3
    return 0
  fi
  _gb_noerrexit
  json=$(gh api rate_limit 2>/dev/null)
  _gb_errexit_restore
  [ -z "$json" ] && return 3
  printf '%s' "$json" | jq -e -r --arg r "$res" '
    .resources[$r] // empty
    | [(.remaining|tostring), (.limit|tostring), (.reset|tostring)]
    | join(" ")
  ' 2>/dev/null || return 3
}

# When the probe itself is refused there is no reset to nap toward, and 0
# would render "GitHub said no" as "healthy" — the inversion this file exists
# to remove. A short fixed nap keeps the caller interruptible and re-probing.
GB_REFUSED_BACKOFF_SEC=60

# gb_backoff_seconds [floor]
#
# How long a polling loop should wait before spending again. Prints 0 when the
# budget is healthy OR unreadable (fail open — see the header), otherwise the
# seconds until reset, so a starved loop sleeps through the window instead of
# hammering it. Always exits 0: this is advice, not a verdict.
gb_backoff_seconds() {
  local floor="${1:-$RALPH_GH_BUDGET_FLOOR}" snap remaining reset now rc=0
  snap=$(gb_snapshot graphql) || rc=$?
  if [ "$rc" -eq 4 ]; then echo "$GB_REFUSED_BACKOFF_SEC"; return 0; fi
  if [ "$rc" -ne 0 ]; then echo 0; return 0; fi
  read -r remaining _ reset <<<"$snap"
  case "$remaining$reset" in *[!0-9]*|"") echo 0; return 0 ;; esac
  [ "$remaining" -ge "$floor" ] && { echo 0; return 0; }
  now=$(date +%s)
  if [ "$reset" -le "$now" ]; then echo 0; return 0; fi
  echo $((reset - now))
}

# gb_report_low [floor]
#
# One line to stderr naming a starved budget, or silence when it is healthy or
# unreadable. Separate from gb_backoff_seconds so a caller can narrate without
# changing its own cadence — the cockpit's lesson (#1787) was that a degraded
# read must never render as a normal one, and a backoff nobody can see is
# exactly that.
gb_report_low() {
  local floor="${1:-$RALPH_GH_BUDGET_FLOOR}" snap remaining limit reset rc=0
  snap=$(gb_snapshot graphql) || rc=$?
  if [ "$rc" -eq 4 ]; then
    echo "gh-budget: GraphQL budget exhausted — GitHub refused the budget probe itself (rate limited)" >&2
    return 0
  fi
  [ "$rc" -ne 0 ] && return 0
  read -r remaining limit reset <<<"$snap"
  case "$remaining" in *[!0-9]*|"") return 0 ;; esac
  [ "$remaining" -ge "$floor" ] && return 0
  echo "gh-budget: GraphQL budget low — ${remaining}/${limit} remaining, resets at $(date -r "$reset" '+%H:%M:%S' 2>/dev/null || echo "epoch $reset")" >&2
}
