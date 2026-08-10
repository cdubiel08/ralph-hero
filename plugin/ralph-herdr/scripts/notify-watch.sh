#!/usr/bin/env bash
# notify-watch.sh TARGET [TARGET…] — level-triggered watcher for ralph agents.
#
# Single target: hangs on purpose — `agent wait` with no timeout is the
# design; the pane that spawned the session becomes its attention surface and
# the wait is server-owned and event-driven.
#
# Multiple targets: bash 3.2 has no `wait -n`, so a fleet is watched with a
# portable poll loop (`agent get` per live target every
# RALPH_HERDR_WATCH_POLL seconds, default 15). Each target notifies on its
# first transition into blocked (re-armed once it moves off blocked), and
# once on done/idle/gone — then drops from the watch list; the watcher exits
# when the list is empty.
#
# Notifications are advisory; the board stays the sole source of truth. This
# script never kills an agent and never writes board state.
#
# Knobs:
#   RALPH_HERDR_WATCH_POLL   multi-target poll interval, seconds (default 15)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

[ "$#" -ge 1 ] || die "usage: notify-watch.sh <agent-name-or-pane-id>…"

REPO_NAME=$(basename "$REPO")

# ── Multi-target: portable poll loop ─────────────────────────────────────────
if [ "$#" -gt 1 ]; then
  POLL="${RALPH_HERDR_WATCH_POLL:-15}"
  validate_pos_int RALPH_HERDR_WATCH_POLL "$POLL"

  # bash 3.2: space-separated string lists, membership via case globs.
  watch_list="$*"
  blocked_seen=""   # targets already notified for their current blocked episode

  in_list() { case " $1 " in *" $2 "*) return 0 ;; *) return 1 ;; esac; }
  drop_from() {  # drop_from "LIST" NAME — prints the list without NAME
    local out="" w
    for w in $1; do [ "$w" = "$2" ] || out="$out $w"; done
    echo "${out# }"
  }

  echo "watching ${watch_list} (repo $REPO_NAME) — polling every ${POLL}s"

  while [ -n "$watch_list" ]; do
    for t in $watch_list; do
      state=$("$HERDR" agent get "$t" 2>/dev/null \
        | jq -r '.result.agent.agent_status // empty' 2>/dev/null) || state=""
      case "$state" in
        "")
          notify "$t" "ralph: $t gone" "agent no longer live in $REPO_NAME — check the board for where it left things"
          watch_list=$(drop_from "$watch_list" "$t")
          blocked_seen=$(drop_from "$blocked_seen" "$t")
          ;;
        done | idle)
          notify "$t" "ralph: $t $state" "repo $REPO_NAME — session finished; check the pane"
          watch_list=$(drop_from "$watch_list" "$t")
          blocked_seen=$(drop_from "$blocked_seen" "$t")
          ;;
        blocked)
          if ! in_list "$blocked_seen" "$t"; then
            notify "$t" "ralph: $t blocked" "repo $REPO_NAME — attend the pane"
            blocked_seen="$blocked_seen $t"
          fi
          ;;
        *)
          # working/unknown — re-arm the blocked edge for this target.
          blocked_seen=$(drop_from "$blocked_seen" "$t")
          ;;
      esac
    done
    [ -n "$watch_list" ] && sleep "$POLL"
  done
  echo "all watched agents finished — watcher exiting"
  exit 0
fi

# ── Single target: event-driven server-owned wait (unchanged) ────────────────
TARGET="$1"

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
  # Bare wait: blocked/done/idle are agent wait's default until-set.
  wait_for || gone

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
