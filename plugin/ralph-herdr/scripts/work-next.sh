#!/usr/bin/env bash
# work-next.sh — cockpit action: spawn one /ralph:work session for board-next.
#
# Thin caller: guards + one queue read + spawn_work_session (lib.sh owns the
# whole spawn path) + exec into notify-watch.sh so the cockpit pane becomes
# the session's attention surface. No board mutation happens here: `board
# next` is a read, and the claim is taken by /ralph:work inside the spawned
# session. Honors RALPH_HERDR_DRY_RUN=true (plan printed, nothing spawned).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

trap hold_pane EXIT

billing_guard

QUEUE_JSON=$("$BOARD" next --json)
N=$(jq -r '.next.number // empty' <<<"$QUEUE_JSON")
if [ -z "$N" ]; then
  echo "queue empty — nothing to spawn"
  exit 0
fi

# rc=2 is the sanctioned skip (agent gh-N already live) — that session already
# has its own attention surface, so don't stack a second watcher on it.
rc=0
spawn_work_session "$N" "$QUEUE_JSON" || rc=$?
case "$rc" in
  0) ;;
  2) exit 0 ;;
  *) die "spawn failed for GH-$N (see above)" ;;
esac

[ "${RALPH_HERDR_DRY_RUN:-}" = "true" ] && exit 0

exec "$SCRIPT_DIR/notify-watch.sh" "gh-$N"
