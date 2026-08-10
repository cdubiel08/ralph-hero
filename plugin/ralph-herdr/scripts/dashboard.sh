#!/usr/bin/env bash
# dashboard.sh — read-only board glance, refreshed on a poll.
#
# Board reads only: next / deliver-queue / tend-queue / list. Doctor is
# deliberately NOT in the loop — a full invariant sweep is too heavy to run
# every cycle; it has its own action ("Ralph: board doctor").
#
# Knobs:
#   RALPH_HERDR_DASH_INTERVAL   seconds between refreshes (default 120)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

INTERVAL="${RALPH_HERDR_DASH_INTERVAL:-120}"
# A zero/garbage interval would turn the poll into a hot loop against the
# GitHub API — refuse it.
[[ "$INTERVAL" =~ ^[1-9][0-9]*$ ]] || die "RALPH_HERDR_DASH_INTERVAL must be a positive integer (got '$INTERVAL')"
REPO_NAME=$(basename "$REPO")

while :; do
  # Read everything before clearing so a slow board call never leaves a
  # blank screen. A failed read shows as such — an empty queue and a failed
  # query are different facts.
  next_json=$("$BOARD" next --json 2>/dev/null) || next_json=""
  deliver_json=$("$BOARD" deliver-queue --json 2>/dev/null) || deliver_json=""
  tend_json=$("$BOARD" tend-queue --json 2>/dev/null) || tend_json=""
  # Human Needed count is best-effort: if the list subcommand's shape ever
  # differs, omit the line rather than erroring the whole dashboard.
  hn_count=$("$BOARD" list --state "Human Needed" --json 2>/dev/null | jq -r '.items | length' 2>/dev/null) || hn_count=""

  clear
  printf 'ralph board — %s — %s\n\n' "$REPO_NAME" "$(date -u +%FT%TZ)"

  if [ -n "$next_json" ]; then
    n=$(jq -r '.next.number // empty' <<<"$next_json")
    depth=$(jq -r '.queue | length' <<<"$next_json")
    if [ -n "$n" ]; then
      title=$(jq -r '.next.title // ""' <<<"$next_json")
      est=$(jq -r '.next.estimate // "-"' <<<"$next_json")
      printf 'work     next #%s [%s] %s  (queue %s)\n' "$n" "$est" "$title" "$depth"
    else
      printf 'work     queue empty\n'
    fi
  else
    printf 'work     (board read failed)\n'
  fi

  if [ -n "$deliver_json" ]; then
    dn=$(jq -r '.next.number // empty' <<<"$deliver_json")
    dq=$(jq -r '.queue | length' <<<"$deliver_json")
    if [ -n "$dn" ]; then
      dpr=$(jq -r '.next.pr // empty' <<<"$deliver_json")
      dreason=$(jq -r '.next.reason // "-"' <<<"$deliver_json")
      printf 'deliver  next #%s%s [%s]  (queue %s)\n' "$dn" "${dpr:+ pr#$dpr}" "$dreason" "$dq"
    else
      printf 'deliver  queue empty\n'
    fi
  else
    printf 'deliver  (board read failed)\n'
  fi

  if [ -n "$tend_json" ]; then
    tq=$(jq -r '.queue | length' <<<"$tend_json")
    printf 'tend     queue %s\n' "$tq"
  else
    printf 'tend     (board read failed)\n'
  fi

  case "$hn_count" in
    '' | *[!0-9]*) : ;; # unavailable — omitted, not an error
    *) printf 'human    %s item(s) in Human Needed\n' "$hn_count" ;;
  esac

  printf '\nrefresh every %ss — doctor is its own action (Ralph: board doctor)\n' "$INTERVAL"
  sleep "$INTERVAL"
done
