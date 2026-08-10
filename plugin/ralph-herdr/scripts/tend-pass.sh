#!/usr/bin/env bash
# tend-pass.sh — cockpit action: one /ralph:tend pass in its own tab.
#
# Empty `next` means spawn nothing — the lane contract. The pass itself runs
# inside the spawned session; this script only reads the queue and builds
# herdr layout, then execs into notify-watch.sh so the cockpit pane becomes
# the pass's attention surface.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

billing_guard

next=$("$BOARD" tend-queue --json | jq -r '.next.number // empty')
if [ -z "$next" ]; then
  echo "tend queue empty — nothing to spawn"
  exit 0
fi

t=$("$HERDR" tab create --cwd "$REPO" --label "ralph-tend" --no-focus)
pane=$(jq -r '.result.root_pane.pane_id // empty' <<<"$t")
[ -n "$pane" ] || die "no pane id in tab response"

# One live pass per lane: the unique agent name is the interlock. A
# name-taken refusal means a pass is already live — die, never suffix.
"$HERDR" agent start ralph-tend --kind claude --pane "$pane" \
  || die "agent start ralph-tend failed — a tend pass is already live; not starting a second"
"$HERDR" agent prompt ralph-tend "/ralph:tend"

echo "spawned tend pass (queue head #$next, pane $pane, agent ralph-tend)"

exec "$SCRIPT_DIR/notify-watch.sh" ralph-tend
