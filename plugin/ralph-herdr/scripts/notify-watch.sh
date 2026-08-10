#!/usr/bin/env bash
# notify-watch.sh TARGET — level-triggered watcher for one ralph agent.
#
# Hangs on purpose: `agent wait` with no timeout is the design — the pane
# that spawned the session becomes its attention surface, and the wait is
# server-owned and event-driven. Notifications are advisory; the board stays
# the sole source of truth. This script never kills the agent and never
# writes board state.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

TARGET="${1:-}"
[ -n "$TARGET" ] || die "usage: notify-watch.sh <agent-name-or-pane-id>"

REPO_NAME=$(basename "$REPO")

# The agent name clears when the session exits, so a failed wait/get usually
# means it is gone. Say so and stop watching — the board has the truth.
gone() {
  notify "$TARGET" "ralph: $TARGET gone" "agent no longer live in $REPO_NAME — check the board for where it left things"
  exit 0
}

# JSON responses are muted: the notify() echo lines are the pane's trail.
wait_for() { "$HERDR" agent wait "$TARGET" "$@" >/dev/null; }

echo "watching $TARGET (repo $REPO_NAME) — waiting for blocked/done/idle"

while :; do
  wait_for --until blocked --until "done" --until idle || gone

  state=$("$HERDR" agent get "$TARGET" 2>/dev/null | jq -r '.result.agent.agent_status // "unknown"') || state=""
  [ -n "$state" ] || gone

  notify "$TARGET" "ralph: $TARGET $state" "repo $REPO_NAME — attend the pane"

  case "$state" in
    blocked)
      # A session can block repeatedly. Re-arm only after the state moves
      # off blocked — the top-level wait matches the *current* state, so an
      # immediate re-wait would return instantly and spin-notify.
      wait_for --until working --until "done" --until idle || gone
      ;;
    done | idle)
      exit 0
      ;;
    *)
      # Snapshot moved on between wait and get (working/unknown) — re-arm.
      ;;
  esac
done
