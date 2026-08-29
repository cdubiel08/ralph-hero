#!/usr/bin/env bash
# deliver-pass.sh — cockpit action: one /ralph:deliver pass, one lane tab.
#
# Empty `next` means spawn nothing — the lane contract. The pass itself runs
# inside the spawned session; this script only reads the queue and builds
# herdr layout, then execs into notify-watch.sh so this pane becomes the
# pass's attention surface.
#
# ONE TAB PER LANE (GH-2317): lane-open.sh placed this launcher pane as a
# tab in the repo's MAIN workspace — marked RALPH_HERDR_LANE_TAB=1, the
# opener's assertion that the tab is its own artifact — so this pane IS the
# lane tab's script-log pane: the agent gets a split beside it, and the tab
# is named from the LANE (the word the skill already spells: /ralph:deliver),
# never a third vocabulary. Without the marker the pre-GH-2317 shape
# survives — a fresh lane tab whose root pane hosts the agent, this
# terminal the watcher — because a pane WITHOUT it sits in a tab someone
# else owns (a bare shell, invoke.sh's default split placement, a
# hand-opened plugin pane) and renaming or splitting that tab would disrupt
# surfaces this lane never created.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

trap hold_pane EXIT

billing_guard
ralph_plugin_freshness_notice

lane=deliver
agent=ralph-deliver

next=$("$BOARD" deliver-queue --json | jq -r '.next.number // empty')
if [ -z "$next" ]; then
  echo "$lane queue empty — nothing to spawn"
  exit 0
fi

if [ "${RALPH_HERDR_DRY_RUN:-}" = "true" ]; then
  echo "DRY RUN — would spawn $lane pass (queue head #$next):"
  echo "  agent: $agent"
  if [ "${RALPH_HERDR_LANE_TAB:-}" = "1" ] && [ -n "${HERDR_PANE_ID:-}" ]; then
    echo "  $HERDR tab rename <own tab> $lane"
    echo "  $HERDR pane split $HERDR_PANE_ID --direction down --cwd $REPO --no-focus"
  else
    echo "  $HERDR tab create --cwd $REPO --label \"$lane\" --no-focus"
  fi
  echo "  $HERDR agent start $agent --kind claude --pane <captured>"
  echo "  $HERDR agent prompt $agent \"/ralph:$lane\""
  exit 0
fi

if [ "${RALPH_HERDR_LANE_TAB:-}" = "1" ] && [ -n "${HERDR_PANE_ID:-}" ]; then
  # In-tab shape — only under the opener's own-tab marker: rename our tab
  # from the lane (best-effort — the label is chrome and a failed rename may
  # not cost the pass), then split the agent pane below. Full width for both
  # surfaces; the logs stay on top.
  tab=$(ralph_herdr_call pane_info pane get "$HERDR_PANE_ID" 2>/dev/null \
    | jq -r '.pane.tab_id // empty' 2>/dev/null) || tab=""
  if [ -n "$tab" ]; then
    "$HERDR" tab rename "$tab" "$lane" >/dev/null 2>&1 || true
  fi
  rc=0
  s=$(ralph_herdr_call pane_info pane split "$HERDR_PANE_ID" --direction down --cwd "$REPO" --no-focus) || rc=$?
  case "$rc" in
    0) ;;
    2) die "herdr refused to split the $lane tab for the agent pane: $(ralph_herdr_err_code "$s") — $(ralph_herdr_err_message "$s")" ;;
    3) die "herdr did not answer the $lane agent-pane split (unreachable, or timed out — a timed-out split may still have landed; check the tab before retrying)" ;;
    *) die "herdr's answer to the $lane agent-pane split was not a response this plugin can read — see the transport error above" ;;
  esac
  pane=$(jq -r '.pane.pane_id // empty' <<<"$s")
  [ -n "$pane" ] || die "no pane id in split response"
  cleanup_pane="$pane" cleanup_tab=""
else
  t=$(ralph_herdr_tab_create "$lane")
  pane=$(jq -r '.root_pane.pane_id // empty' <<<"$t")
  [ -n "$pane" ] || die "no pane id in tab response"
  cleanup_pane="" cleanup_tab=$(jq -r '.tab.tab_id // empty' <<<"$t")
fi

# One live pass per lane: the unique agent name is the interlock. A
# name-taken refusal means a pass is already live — die, never suffix. On a
# REFUSED start the pane just created holds only an idle shell, so closing
# it is cleanup, not killing an agent — but an UNCERTAIN failure (transport
# error, silence) means the start may have LANDED, and the surface is left
# up rather than closed over a possibly-live agent (PR #2326 P1).
if ! agent_start_when_ready "$agent" "$pane"; then
  if [ "${RALPH_HERDR_START_OUTCOME:-uncertain}" = "refused" ]; then
    [ -n "$cleanup_pane" ] && "$HERDR" pane close "$cleanup_pane" >/dev/null 2>&1 || true
    [ -n "$cleanup_tab" ] && "$HERDR" tab close "$cleanup_tab" >/dev/null 2>&1 || true
    die "agent start $agent refused — see the herdr error above (a live $lane pass owning the name is the common cause, but exhausted startup retries land here too); cleaned up the empty agent pane"
  fi
  die "agent start $agent did not answer — the start MAY have landed, so the agent pane is left up rather than closed over a possibly-live agent; check it (herdr agent list) before retrying"
fi
# Past this point the agent is LIVE — a prompt failure must not strand it
# silently, and hold_pane must not claim "no session spawned" about it.
export RALPH_HERDR_AGENT_LIVE=1
ralph_herdr_agent_prompt "$agent" "/ralph:$lane" >/dev/null \
  || die "prompt delivery failed — agent $agent is LIVE and idle in pane $pane; prompt it manually: herdr agent prompt $agent \"/ralph:$lane\""

echo "spawned $lane pass (queue head #$next, pane $pane, agent $agent)"

exec "$SCRIPT_DIR/notify-watch.sh" "$agent"
