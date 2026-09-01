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
#   --no-focus                   → ensure it exists without changing focus
#   --beside-focused             → require the attended cockpit in the
#                                  focused pane's tab; target new splits
#                                  at that pane
#   --beside-hero                → the same topology, keyed on this repo's
#                                  live dispatch hero: the target is derived
#                                  from the hero record and the snapshot,
#                                  never from focus, because focus is a live
#                                  UI property that can move between the
#                                  phase that sets it and the phase that
#                                  reads it
#
# Fail-open is the normal direction on purpose: a duplicate pane costs a pane, a
# refusal costs the cockpit. See cockpit-pane.sh for what "live" means and why
# it is two facts rather than one. The attended --beside-focused mode is the
# exception: an unreadable/ambiguous focus cannot prove the requested topology,
# so it refuses instead of opening into an arbitrary workspace.
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

cwd=""
focus_arg="--focus"
beside_focused=false
beside_hero=false
# `beside` is what gates the --no-focus requirement and the tab/workspace
# comparison below: both modes prove a target pane, they differ only in how.
beside=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-focus) focus_arg="--no-focus" ;;
    --beside-focused) beside_focused=true beside=true ;;
    --beside-hero) beside_hero=true beside=true ;;
    -h | --help)
      echo "usage: cockpit-open.sh [--no-focus [--beside-focused|--beside-hero]] [CWD]"
      exit 0
      ;;
    --*)
      echo "cockpit-open.sh: unknown argument '$1'" >&2
      exit 64
      ;;
    *)
      if [ -n "$cwd" ]; then
        echo "cockpit-open.sh: only one CWD may be supplied" >&2
        exit 64
      fi
      cwd="$1"
      ;;
  esac
  shift
done
if [ "$beside_focused" = true ] && [ "$beside_hero" = true ]; then
  echo "cockpit-open.sh: --beside-focused and --beside-hero are mutually exclusive" >&2
  exit 64
fi
if [ "$beside" = true ] && [ "$focus_arg" != "--no-focus" ]; then
  echo "cockpit-open.sh: --beside-focused/--beside-hero requires --no-focus" >&2
  exit 64
fi
if [ -z "$cwd" ] && [ -n "${HERDR_PLUGIN_CONTEXT_JSON:-}" ]; then
  cwd=$(jq -r '.workspace_cwd // .focused_pane_cwd // empty' <<<"$HERDR_PLUGIN_CONTEXT_JSON" 2>/dev/null) || cwd=""
fi
[ -n "$cwd" ] || cwd="$PWD"

target_pane="" target_workspace="" target_tab="" hero_pane="" snapshot=""
# ONE snapshot serves both modes: the target's workspace and tab are read from
# the same rows its proof came from, so a pane that moved between two reads
# cannot put the cockpit in a tab nobody is looking at.
if [ "$beside" = true ]; then
  if ! snapshot=$(ralph_herdr_snapshot); then
    if [ "$beside_focused" = true ]; then
      log "cannot prove one focused dispatch pane — the Herdr snapshot is unavailable" >&2
    else
      log "cannot prove this repo's live dispatch hero — the Herdr snapshot is unavailable" >&2
    fi
    exit 1
  fi
fi
if [ "$beside_focused" = true ]; then
  focused_count=$(jq -r '[.panes[]? | select(.focused == true)] | length' <<<"$snapshot" 2>/dev/null) || focused_count=0
  if [ "$focused_count" != "1" ]; then
    log "cannot prove one focused dispatch pane — snapshot reported $focused_count" >&2
    exit 1
  fi
  target_pane=$(jq -r '[.panes[] | select(.focused == true)][0].pane_id // empty' <<<"$snapshot")
  target_workspace=$(jq -r '[.panes[] | select(.focused == true)][0].workspace_id // empty' <<<"$snapshot")
  target_tab=$(jq -r '[.panes[] | select(.focused == true)][0].tab_id // empty' <<<"$snapshot")
  if [ -z "$target_pane" ] || [ -z "$target_workspace" ] || [ -z "$target_tab" ]; then
    log "cannot prove one focused dispatch pane — its pane, workspace, or tab id is missing" >&2
    exit 1
  fi
  hero_pane=$(ralph_hero_live_pane "$cwd") || {
    log "cannot prove this repo's live dispatch hero — refusing an ambient focus target" >&2
    exit 1
  }
  if [ "$target_pane" != "$hero_pane" ]; then
    log "focused pane $target_pane is not this repo's live dispatch hero $hero_pane — refusing a cross-repo cockpit target" >&2
    exit 1
  fi
elif [ "$beside_hero" = true ]; then
  hero_pane=$(ralph_hero_live_pane "$cwd") || {
    log "cannot prove this repo's live dispatch hero — refusing an ambient cockpit target" >&2
    exit 1
  }
  target_pane="$hero_pane"
  target_workspace=$(jq -r --arg p "$hero_pane" '[.panes[]? | select(.pane_id == $p)][0].workspace_id // empty' <<<"$snapshot" 2>/dev/null) || target_workspace=""
  target_tab=$(jq -r --arg p "$hero_pane" '[.panes[]? | select(.pane_id == $p)][0].tab_id // empty' <<<"$snapshot" 2>/dev/null) || target_tab=""
  if [ -z "$target_workspace" ] || [ -z "$target_tab" ]; then
    log "this repo's live dispatch hero $hero_pane carries no workspace or tab id in the snapshot — refusing an unprovable cockpit target" >&2
    exit 1
  fi
fi

if pane=$(ralph_cockpit_live_pane "$cwd"); then
  if [ "$focus_arg" = "--no-focus" ]; then
    if [ "$beside" = true ]; then
      cockpit_workspace=$(jq -r --arg p "$pane" '[.panes[]? | select(.pane_id == $p)][0].workspace_id // empty' <<<"$snapshot")
      cockpit_tab=$(jq -r --arg p "$pane" '[.panes[]? | select(.pane_id == $p)][0].tab_id // empty' <<<"$snapshot")
      if [ -n "$cockpit_workspace" ] && [ "$cockpit_workspace" = "$target_workspace" ] &&
        [ -n "$cockpit_tab" ] && [ "$cockpit_tab" = "$target_tab" ]; then
        log "cockpit already live in pane $pane in the focused tab — leaving focus on dispatch"
        exit 0
      fi
      log "cockpit pane $pane is live outside the focused tab — opening one beside dispatch"
    else
      log "cockpit already live in pane $pane — leaving focus on the current seat"
      exit 0
    fi
  else
    log "cockpit already live in pane $pane — focusing it"
    exec "$HERDR" plugin pane focus "$pane"
  fi
fi

if [ -n "$target_pane" ]; then
  log "no satisfying cockpit in the focused tab — opening one beside dispatch"
  exec "$HERDR" plugin pane open --plugin "${HERDR_PLUGIN_ID:-ralph-herdr}" \
    --entrypoint cockpit --placement split --direction right --target-pane "$target_pane" \
    --cwd "$cwd" "$focus_arg"
else
  log "no live cockpit for this board — opening one"
  exec "$HERDR" plugin pane open --plugin "${HERDR_PLUGIN_ID:-ralph-herdr}" \
    --entrypoint cockpit --placement split --direction right --cwd "$cwd" "$focus_arg"
fi
