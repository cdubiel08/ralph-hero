#!/usr/bin/env bash
# work-next.sh — cockpit action: spawn one /ralph:work session for board-next.
#
# Thin caller: guards + one queue read + spawn_work_session (lib.sh owns the
# whole spawn path — including the C7 spawn-record ledger append and the
# spawn-time pane tokens; this spawn is a depth-0 root from a human) + exec
# into notify-watch.sh so the cockpit pane becomes the session's attention
# surface. No board mutation happens here: `board next` is a read, and the
# claim is taken by /ralph:work inside the spawned session. Honors
# RALPH_HERDR_DRY_RUN=true (plan printed, nothing spawned).
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

# rc=2 is the sanctioned skip (a session already owns GH-N) — that session
# already has its own attention surface, so don't stack a second watcher on it.
rc=0
spawn_work_session "$N" "$QUEUE_JSON" || rc=$?
case "$rc" in
  0) ;;
  2) exit 0 ;;
  *) die "spawn failed for GH-$N (see above)" ;;
esac

[ "${RALPH_HERDR_DRY_RUN:-}" = "true" ] && exit 0

# The agent name is derived inside spawn_work_session (grammar B, slug from
# the issue title) and read back from its out-variable — never reconstructed.
exec "$SCRIPT_DIR/notify-watch.sh" "${RALPH_HERDR_SPAWNED_AGENT:?spawn reported success without an agent name}"
