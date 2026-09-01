#!/usr/bin/env bash
# lane-open.sh LANE — open a lane pass (deliver | tend) as ONE TAB in the
# repo's MAIN workspace (GH-2317).
#
# Runs in the ACTION process (the attend/cockpit-open pattern), never in a
# pane: its whole job is placement. Before this script the lane actions did
# `plugin pane open --placement split` inline, so one click produced two
# surfaces — the launcher pane split into whatever tab the human was looking
# at, plus a separate agent tab the launcher then created. The lane's home is
# the repo's main workspace (the space the fleet's worktrees nest under,
# GH-2246), one tab per lane: launcher pane + agent pane, both inside it.
# This script opens the launcher pane AS that tab; the launcher script
# (deliver-pass.sh / tend-pass.sh) splits the agent pane beside itself.
#
# Failure direction: placement is chrome, the pass is the point. An
# unreadable workspace list or an unresolvable main workspace falls back to
# opening the tab in the invoking workspace (a note says so) — inverted from
# dispatch-up's fail-closed, because this script creates no workspace and a
# mis-placed tab costs a drag, not a duplicate space.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

lane="${1:-}"
case "$lane" in
  deliver | tend) ;;
  *) die "usage: lane-open.sh <deliver|tend> — got '${lane:-}'" ;;
esac

# The source checkout: the lane acts on the repo, so the pane's cwd is the
# main checkout even when the action was invoked from a worktree workspace.
src=$(ralph_worktree_source_dir)

ws_id=""
if ws_out=$(ralph_herdr_call workspace_list workspace list 2>/dev/null); then
  ws_id=$(ralph_main_ws_from_list "$ws_out" "$src")
fi
ws_args=()
if [ -n "$ws_id" ]; then
  ws_args=(--workspace "$ws_id")
else
  echo "lane-open: could not resolve the repo's main workspace — opening the $lane tab in the invoking workspace" >&2
fi

# --focus is deliberate (the actions' own rule): the human clicked the lane,
# so its tab may take focus. The launcher pane IS the new tab's root pane;
# the pane entrypoint keeps the `<lane>-pass` id.
exec "$HERDR" plugin pane open \
  --plugin "${HERDR_PLUGIN_ID:-ralph-herdr}" --entrypoint "$lane-pass" \
  ${ws_args+"${ws_args[@]}"} --placement tab --cwd "$src" --focus
