#!/usr/bin/env bash
# cockpit-launch.sh — the cockpit degradation ladder in code. Every rung
# loses chrome, never a verb:
#
#   rung 1  cockpit/ralph-cockpit     the Go TUI, when built and executable
#   rung 2  the SAME binary, poll-only — the shipped mode today; herdr
#           event integration is Phase-6+ work. A documentation distinction,
#           not a script branch: rung 1 IS rung 2 until events land.
#   rung 3  cockpit-fzf.sh            verb-complete fzf fallback, when fzf
#                                     is on PATH
#   rung 4  dashboard.sh              read-only poll glance (verbs remain
#                                     one CLI away — the launcher only picks
#                                     a surface)
#   rung 5  `board` / `gh` standalone — README-documented usage, not a
#           branch here: with no herdr pane at all there is nothing for
#           this script to exec.
#
# One log line per taken rung — 'cockpit: rung N (<reason>)' — so a pane
# that opens on the "wrong" surface says why on its first line.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COCKPIT_BIN="$SCRIPT_DIR/../cockpit/ralph-cockpit"

if [ -x "$COCKPIT_BIN" ]; then
  echo "cockpit: rung 1 (built TUI at $COCKPIT_BIN; poll-only is the shipped mode — rung 2)"
  exec "$COCKPIT_BIN"
fi

if command -v fzf >/dev/null 2>&1; then
  echo "cockpit: rung 3 (no built TUI — scripts/build-cockpit.sh builds rung 1; fzf found on PATH)"
  exec bash "$SCRIPT_DIR/cockpit-fzf.sh"
fi

echo "cockpit: rung 4 (no built TUI, no fzf on PATH — read-only dashboard; the verbs stay one 'board' call away)"
exec bash "$SCRIPT_DIR/dashboard.sh"
