#!/usr/bin/env bash
# cockpit-open.sh — the sanctioned "open the cockpit" path: focus the live
# cockpit for this board, or open one (GH-2074).
#
# Runs in the ACTION process (the attend/link-open pattern), never in a pane:
# a pane cannot decide not to exist, so the manifest's inline `plugin pane
# open` was unconditional by construction and a second invocation opened a
# second cockpit over the first. Measured 2026-08-18 on three live agent
# panes.
#
#   live cockpit for this board  → herdr plugin pane focus <pane_id>
#   none, or any unreadable read → plugin pane open (today's behavior)
#
# Fail-open is the direction on purpose: a duplicate pane costs a pane, a
# refusal costs the cockpit. See cockpit-pane.sh for what "live" means and why
# it is two facts rather than one.
#
# A deliberate SECOND cockpit stays reachable and needs no flag — the [[panes]]
# entrypoint is untouched, so `herdr plugin pane open --plugin ralph-herdr
# --entrypoint cockpit …` still opens one directly.
#
# --focus on the open is deliberate and matches the action it replaces: the
# human invoked this, so the resulting pane may take focus.
set -euo pipefail

HERDR="${HERDR_BIN_PATH:-herdr}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# lib.sh is NOT sourced: it dies without a board CLI, and opening the cockpit
# must survive a checkout whose board CLI is not yet resolvable — the cockpit
# is where a human goes to find out why.
# shellcheck source=ledger.sh
. "$SCRIPT_DIR/ledger.sh"
# shellcheck source=sanitize.sh
. "$SCRIPT_DIR/sanitize.sh"
# shellcheck source=transport.sh
. "$SCRIPT_DIR/transport.sh"
# shellcheck source=cockpit-pane.sh
. "$SCRIPT_DIR/cockpit-pane.sh"

log() { echo "$(date -u +%FT%TZ) cockpit-open: $*"; }

cwd="${1-}"
if [ -z "$cwd" ] && [ -n "${HERDR_PLUGIN_CONTEXT_JSON:-}" ]; then
  cwd=$(jq -r '.workspace_cwd // .focused_pane_cwd // empty' <<<"$HERDR_PLUGIN_CONTEXT_JSON" 2>/dev/null) || cwd=""
fi
[ -n "$cwd" ] || cwd="$PWD"

if pane=$(ralph_cockpit_live_pane "$cwd"); then
  log "cockpit already live in pane $pane — focusing it"
  exec "$HERDR" plugin pane focus "$pane"
fi

log "no live cockpit for this board — opening one"
exec "$HERDR" plugin pane open --plugin "${HERDR_PLUGIN_ID:-ralph-herdr}" \
  --entrypoint cockpit --placement split --direction right --cwd "$cwd" --focus
