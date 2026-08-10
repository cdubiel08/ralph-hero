#!/usr/bin/env bash
# attend.sh — jump to the first blocked ralph agent.
#
# No loop, no pane needed — safe to bind to a key. Reads the live agent list,
# picks the first blocked ralph agent (gh-* issue sessions before the
# ralph-deliver/ralph-tend lanes), focuses its pane, and toasts. The focus is
# the one deliberate exception to --no-focus discipline: attending IS the
# human clicking "take me there". When nothing is blocked it says so and
# exits 0. Read-only apart from focus + notification; never writes board
# state, never prompts or kills an agent.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

# One read; prefer issue sessions (gh-*) over lane sessions when both block.
target=$(ralph_agents_json | jq -rs '
  [.[] | select(.status == "blocked")]
  | (map(select(.name | startswith("gh-"))) + map(select(.name | startswith("gh-") | not)))
  | .[0].name // empty')

if [ -z "$target" ]; then
  notify herd "ralph: herd calm" "nothing blocked"
  exit 0
fi

"$HERDR" agent focus "$target" >/dev/null
notify "$target" "ralph: attending $target" "attending $target — pane focused"
