#!/usr/bin/env bash
# work-issue-fleet.sh — cockpit action: a SHARED-CLAIM fleet — K sibling
# /ralph:work sessions on ONE issue, one worktree, one branch.
#
# Thin caller over spawn_issue_fleet (fleet.sh owns the whole flow): sibling
# 1 takes the normal spawn path (worktree resolved once, claims inside the
# session); siblings 2..K are pane splits in that workspace, each briefed
# with the SHARED branch. The claim join runs AFTER the spawns, gated on
# the issue reaching In Progress (sibling 1's session claiming it) — `board
# claim join` refuses anything else; a bounded wait then joins each sibling,
# and a timeout or refusal warns with the manual join (never blocks). Claim
# v2 holds up to 8 holders; the sibling cap here is 4 — attended
# parallelism, same bar as work-fleet.
#
# The issue number comes from $1, else RALPH_HERDR_ISSUE, else an
# interactive prompt in the pane (actions carry no arguments — the pane is
# the input surface). Honors RALPH_HERDR_DRY_RUN.
#
# Knobs:
#   RALPH_HERDR_ISSUE          issue number (skips the interactive prompt)
#   RALPH_HERDR_SIBLINGS       fleet size K (default 2; 1..4)
#   RALPH_HERDR_JOIN_WAIT_SEC  bound on the In Progress wait before the
#                              claim-join pass (default 180; 0 = one check)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

trap hold_pane EXIT

billing_guard

N="${1:-${RALPH_HERDR_ISSUE:-}}"
if [ -z "$N" ]; then
  printf 'issue number for the sibling fleet: GH-'
  read -r N || die "no issue number given"
fi
case "$N" in '' | *[!0-9]*) die "issue must be a number (got '$N')" ;; esac

K="${RALPH_HERDR_SIBLINGS:-2}"
case "$K" in
  [1-4]) : ;;
  *) die "RALPH_HERDR_SIBLINGS=$K must be 1..4 — this is an attended tool, not a farm" ;;
esac

# One run id for the fleet's briefs; the queue read only feeds slug/label
# derivation — GH-$N need not be in it (the slug then falls back to "work").
RALPH_HERDR_RUN_ID=$(ralph_run_id)
export RALPH_HERDR_RUN_ID
QUEUE_JSON=$("$BOARD" next --json 2>/dev/null) || QUEUE_JSON=""

rc=0
spawn_issue_fleet "$N" "$K" "$QUEUE_JSON" || rc=$?
case "$rc" in
  0) ;;
  2) exit 0 ;; # a session already owns GH-N — its watcher already exists
  *) die "issue fleet failed for GH-$N (see above)" ;;
esac

echo
echo "issue fleet (run $RALPH_HERDR_RUN_ID): GH-$N × ${RALPH_HERDR_FLEET_AGENTS:-(none)}"

[ "${RALPH_HERDR_DRY_RUN:-}" = "true" ] && exit 0

if [ -n "${RALPH_HERDR_FLEET_AGENTS:-}" ]; then
  # shellcheck disable=SC2086  # intentional word-splitting: one argv per agent
  exec "$SCRIPT_DIR/notify-watch.sh" $RALPH_HERDR_FLEET_AGENTS
fi
