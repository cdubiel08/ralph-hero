#!/usr/bin/env bash
# deliver-pass.sh — cockpit action: one /ralph:deliver pass in its own tab.
#
# Empty `next` means spawn nothing — the lane contract. The pass itself runs
# inside the spawned session; this script only reads the queue and builds
# herdr layout, then execs into notify-watch.sh so the cockpit pane becomes
# the pass's attention surface.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

trap hold_pane EXIT

billing_guard

next=$("$BOARD" deliver-queue --json | jq -r '.next.number // empty')
if [ -z "$next" ]; then
  echo "deliver queue empty — nothing to spawn"
  exit 0
fi

t=$("$HERDR" tab create --cwd "$REPO" --label "ralph-deliver" --no-focus)
pane=$(jq -r '.result.root_pane.pane_id // empty' <<<"$t")
[ -n "$pane" ] || die "no pane id in tab response"

# One live pass per lane: the unique agent name is the interlock. A
# name-taken refusal means a pass is already live — die, never suffix. The
# just-created tab holds only an idle shell at this point (start failed), so
# closing it is cleanup, not killing an agent.
if ! agent_start_when_ready ralph-deliver "$pane"; then
  tab_id=$(jq -r '.result.tab.tab_id // empty' <<<"$t")
  [ -n "$tab_id" ] && "$HERDR" tab close "$tab_id" >/dev/null 2>&1 || true
  die "agent start ralph-deliver failed — see the herdr error above (a live deliver pass owning the name is the common cause, but exhausted startup retries land here too); cleaned up the empty tab"
fi
# Past this point the agent is LIVE — a prompt failure must not strand it
# silently, and hold_pane must not claim "no session spawned" about it.
export RALPH_HERDR_AGENT_LIVE=1
"$HERDR" agent prompt ralph-deliver "/ralph:deliver" \
  || die "prompt delivery failed — agent ralph-deliver is LIVE and idle in pane $pane; prompt it manually: herdr agent prompt ralph-deliver \"/ralph:deliver\""

echo "spawned deliver pass (queue head #$next, pane $pane, agent ralph-deliver)"

exec "$SCRIPT_DIR/notify-watch.sh" ralph-deliver
