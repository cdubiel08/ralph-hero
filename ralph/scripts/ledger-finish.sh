#!/usr/bin/env bash
# ledger-finish.sh — the work skill's own close-out call (GH-2348): appends
# a `finish` fact (never `exit` — the pane is still live when this runs; see
# ledger.sh's own "finish facts" section for why closing it early is unsafe)
# for the calling pane's open agent_ref, right at the point the driver hands
# the unit off — `board move NNN in-review`, or a merge close-out — rather
# than waiting for the pane to physically close (watch-event's
# pane.exited/closed) or for reconcile's next sweep to notice it gone. Both
# of those measure the sweep clock, not the work: median 1,103 min against
# 17 min of real model-call span, on this repo's own ledger, before this
# existed.
#
# The mutation itself is ralph_ledger_finish_append, in
# plugin/ralph-herdr/scripts/ledger.sh (the "finish facts" section) — this
# script is only the cross-plugin discovery half. `ralph` cannot know at
# authorship time where a host repo installed `ralph-herdr`, so it resolves
# it the same way ralph/scripts/herdr-setup.sh already does for its own
# ralph-herdr-owned reads: the registry first (installed_plugins.json's
# sibling entry), then a vendored checkout (this repo, or ralph's own tree
# beside it), each candidate verified by a file only ralph-herdr ships —
# never guessed at.
#
# Usage: ledger-finish.sh PANE_ID [VIA]
#   PANE_ID   $HERDR_PANE_ID — required.
#   VIA       provenance tag on the finish fact (default work-skill). The
#             work skill passes review/done for the two GH-2348 hand-off
#             points — purely for the log/history.
#
# Best-effort by contract, like every other self-report surface the work
# skill uses (`herdr pane report-metadata`): one stderr line and exit 1 on
# ANY miss — ralph-herdr not installed, no board scope from this cwd, no
# open agent_ref bound to this pane — never a retry loop, never a blocked
# close-out. A lost self-report costs nothing beyond what every exit writer
# already produces without it: a later, honest-but-slower exit.
set -euo pipefail

PANE="${1:-}"
VIA="${2:-work-skill}"
if [ -z "$PANE" ]; then
  echo "ledger-finish: no pane id (usage: ledger-finish.sh PANE_ID [VIA])" >&2
  exit 1
fi
command -v jq >/dev/null 2>&1 || { echo "ledger-finish: jq is required" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${RALPH_HERDR_REPO:-$PWD}"

# Same discovery chain as herdr-setup.sh's reap/sweep prologue.
_rp_json="${RALPH_HERDR_PLUGINS_JSON:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins.json}"
_rp_root=""
[ -f "$_rp_json" ] && _rp_root=$(jq -r 'map(select(.plugin_id == "ralph-herdr")) | .[0].plugin_root // empty' "$_rp_json" 2>/dev/null) || _rp_root=""
_rp_scripts=""
for _cand in "${RALPH_HERDR_SCRIPTS_DIR:-}" "$_rp_root/scripts" "$REPO/plugin/ralph-herdr/scripts" "$SCRIPT_DIR/../../plugin/ralph-herdr/scripts"; do
  [ -n "$_cand" ] && [ -f "$_cand/ledger.sh" ] && { _rp_scripts="$_cand"; break; }
done
if [ -z "$_rp_scripts" ]; then
  echo "ledger-finish: the ralph-herdr plugin's ledger was not found — nothing to mark (install the herdr plugin, or run from a vendored checkout)" >&2
  exit 1
fi

# shellcheck source=/dev/null
. "$_rp_scripts/ledger.sh"
ralph_ledger_finish_append "$PANE" "$VIA"
