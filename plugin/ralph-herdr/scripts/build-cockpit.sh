#!/usr/bin/env bash
# build-cockpit.sh — the manifest [[build]] wrapper for the Go cockpit TUI.
#
# herdr treats a failed build command as a failed INSTALL. But the TUI is
# rung 1 of a degradation ladder whose whole point is that losing a rung
# costs chrome, never verbs: cockpit-launch.sh probes for the binary at run
# time and falls through to the fzf fallback (rung 3) or the dashboard
# (rung 4). So this wrapper NEVER fails the install — a host without Go, a
# Go that cannot build (offline module cache, broken toolchain), or a
# checkout where cockpit/ has not landed yet all get a loud warning and
# exit 0, and the launcher does the rest. The one thing it never does is
# lie: every skip names its reason, so `herdr plugin log` shows exactly why
# rung 1 is absent.
#
# Deliberate choice, documented here and in the README: a build failure on a
# host WITH Go also warns-and-exits-0 rather than aborting the install —
# the binary is optional chrome, and blocking every action in the plugin
# because a TUI didn't compile would invert the ladder's contract. Build by
# hand to see the real error: (cd cockpit && go build -o ralph-cockpit .).
#
# Runs from the manifest's [[build]] hook or by hand; no arguments;
# bash 3.2 compatible.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COCKPIT_DIR="$SCRIPT_DIR/../cockpit"

log() { echo "build-cockpit: $*"; }

if [ ! -d "$COCKPIT_DIR" ]; then
  log "no cockpit/ source dir at $COCKPIT_DIR — skipping the TUI build (launcher rungs 3/4 cover it)"
  exit 0
fi

if ! command -v go >/dev/null 2>&1; then
  log "go not found on PATH — skipping the TUI build (launcher rungs 3/4 cover it; install Go and re-run scripts/build-cockpit.sh for rung 1)"
  exit 0
fi

if (cd "$COCKPIT_DIR" && go build -o ralph-cockpit .); then
  log "built $COCKPIT_DIR/ralph-cockpit ($(go version | awk '{print $3}'))"
else
  # `go build` leaves a PREVIOUS output binary untouched on failure — remove
  # it, or the launcher would run a STALE TUI as rung 1 while this log claims
  # the install has no TUI. Falling to rungs 3/4 honestly beats lying chrome.
  rm -f "$COCKPIT_DIR/ralph-cockpit"
  log "go build FAILED — installing without the TUI, and any previously built binary was removed so the launcher cannot run a stale rung 1 (rungs 3/4 cover it); build by hand to see the error: (cd $COCKPIT_DIR && go build -o ralph-cockpit .)"
fi
exit 0
