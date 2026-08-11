#!/usr/bin/env bash
# work-fleet.sh — cockpit action: spawn up to FLEET parallel /ralph:work
# sessions from the top of the ranked queue.
#
# ATTENDED-ONLY, honestly labelled: this is a human clicking "give me a few
# sessions to shepherd", not a farm. The per-issue claim protocol inside each
# spawned /ralph:work session is the mutual-exclusion backstop (design doc
# §3.5 defers only UNATTENDED parallelism); this script never claims, never
# transitions, never writes board state — `board next` is its one read.
#
# Knobs:
#   RALPH_HERDR_FLEET     sessions to spawn (default 2; positive integer;
#                         hard cap 4 — above that you are not attending)
#   RALPH_HERDR_DRY_RUN   "true" → per-issue plans printed, nothing spawned
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

trap hold_pane EXIT

billing_guard

FLEET="${RALPH_HERDR_FLEET:-2}"
validate_pos_int RALPH_HERDR_FLEET "$FLEET"
[ "$FLEET" -le 4 ] || die "RALPH_HERDR_FLEET=$FLEET exceeds the hard cap of 4 — this is an attended tool, not a farm"

# ONE queue read; .queue is ranked and .next equals .queue[0].
QUEUE_JSON=$("$BOARD" next --json)
NUMBERS=$(jq -r --argjson k "$FLEET" '.queue[0:$k][]?.number' <<<"$QUEUE_JSON")
if [ -z "$NUMBERS" ]; then
  echo "queue empty — nothing to spawn"
  exit 0
fi

spawned="" skipped="" failed=""
for n in $NUMBERS; do
  echo "── GH-$n ──"
  rc=0
  spawn_work_session "$n" "$QUEUE_JSON" || rc=$?
  case "$rc" in
    # The agent name is derived inside spawn_work_session (grammar B, slug
    # from the issue title) and read back from its out-variable — the watcher
    # exec below needs the real names, never reconstructed ones.
    0) spawned="$spawned ${RALPH_HERDR_SPAWNED_AGENT:?spawn reported success without an agent name}" ;;
    2) skipped="$skipped GH-$n" ;;
    # One bad spawn must not strand the rest of the fleet — note and continue.
    *) failed="$failed GH-$n"; echo "GH-$n: spawn failed (see above) — continuing" >&2 ;;
  esac
done

echo
if [ "${RALPH_HERDR_DRY_RUN:-}" = "true" ]; then
  echo "fleet summary (DRY RUN — nothing spawned):"
  echo "  planned:${spawned:- (none)}"
else
  echo "fleet summary:"
  echo "  spawned:${spawned:- (none)}"
fi
echo "  skipped:${skipped:- (none)}"
echo "  failed: ${failed:- (none)}"

[ "${RALPH_HERDR_DRY_RUN:-}" = "true" ] && exit 0

if [ -n "$spawned" ]; then
  # shellcheck disable=SC2086  # intentional word-splitting: one argv per agent
  exec "$SCRIPT_DIR/notify-watch.sh" $spawned
fi
