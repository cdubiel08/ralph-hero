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
#   RALPH_HERDR_WATCH_POLL   multi-target poll interval, and the backoff after
#                            an unreadable read in either mode, seconds
#                            (default 15; a malformed value warns and defaults)
#   RALPH_HERDR_WAIT_MAX_SEC ceiling on ONE server-owned `agent wait`, seconds
#                            (default 86400 — see wait_for)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

[ "$#" -ge 1 ] || die "usage: notify-watch.sh <agent-name-or-pane-id>…"

REPO_NAME=$(basename "$REPO")

# watch_poll — the poll/backoff interval, defaulting past an unusable value.
#
# Deliberately NOT validate_pos_int, which dies: every spawn path (deliver-pass,
# tend-pass, work-next, work-fleet, link-offer) `exec`s into this watcher AFTER
# its agent is live, and exec discards hold_pane's EXIT trap — so dying here
# closes the pane instantly, takes the error line with it, and leaves a live
# agent unwatched. RALPH_* vars are exported from shell profiles and inherited
# by every pane, so a stale value is a live route to exactly that. A poll
# interval is advisory; the watch is not.
watch_poll() {
  local v="${RALPH_HERDR_WATCH_POLL:-15}"
  case "$v" in
    '' | *[!0-9]* | 0*)
      echo "${0##*/}: ignoring RALPH_HERDR_WATCH_POLL='$(printf '%s' "$v" | ralph_sanitize)' (not a positive integer) — using 15s" >&2
      v=15
      ;;
  esac
  echo "$v"
}
POLL=$(watch_poll)

# _herdr_verdict BODY — the shared classification of an adapter refusal, so the
# two modes cannot drift on what "gone" means. rc 2 only for herdr's own
# no-such-agent answer; rc 1 for everything else it refused.
#
# From the returned BODY, never $RALPH_HERDR_ERR_CODE: the calls below run in
# command substitutions, so a global they set died with that subshell.
_herdr_verdict() {
  case "$(ralph_herdr_err_code "${1-}")" in
    agent_not_found | not_found) return 2 ;;
  esac
  return 1
}

# agent_status_of TARGET — the target's agent_status, through the transport
# adapter, with "I could not find out" kept distinct from every real state.
#
#   rc 0   the validated status is on stdout
#   rc 2   herdr says no such agent — it is gone (a real answer)
#   rc 1   unreadable: transport failure, unreachable server, or a success
#          envelope carrying no status
#
# The rc 1 case is why this exists. Both poll sites used to end in
# `// "unknown"`, which handed the caller a state string for a response nobody
# could parse — the "I could not find out" → "here is a fact" collapse the
# adapter exists to prevent (GH-1855). An unreadable poll now keeps the target
# on the watch list instead of describing it.
agent_status_of() {
  local out rc=0 status
  out=$(ralph_herdr_call agent_info agent get "$1") || rc=$?
  if [ "$rc" -eq 0 ]; then
    status=$(printf '%s' "$out" | jq -r '.agent.agent_status // empty')
    [ -n "$status" ] || return 1
    printf '%s' "$status"
    return 0
  fi
  _herdr_verdict "$out"
}

# ── Multi-target: portable poll loop ─────────────────────────────────────────
if [ "$#" -gt 1 ]; then
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
      # "Gone" and "unreadable" are different facts: the CLI exits non-zero for
      # server/read hiccups on agents that are still perfectly alive. Only
      # herdr's own no-such-agent refusal drops the target; anything the
      # adapter could not read keeps it on the watch list for the next poll.
      rc=0
      state=$(agent_status_of "$t") || rc=$?
      case "$rc" in
        0) ;;
        2) state="__gone__" ;;
        *)
          echo "$(date -u +%FT%TZ) read failed for $t — keeping it on the watch list"
          continue
          ;;
      esac
      case "$state" in
        "__gone__")
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

# The agent name clears when the session exits, so herdr answers agent_not_found
# for a departed session (probed on 0.8.x, both `agent get` and `agent wait`).
# THAT is what ends a watch — not any nonzero exit. Say so and stop watching;
# the board has the truth.
gone() {
  notify "$TARGET" "ralph: $TARGET gone" "agent no longer live in $REPO_NAME — check the board for where it left things"
  exit 0
}

# wait_for ARG… — `agent wait`, through the same adapter and the same three
# outcomes (rc 0 / rc 2 gone / rc 1 unreadable). Its JSON is discarded; the
# notify() lines are the pane's trail.
#
# This is the call GH-1855 left behind: `"$HERDR" agent wait … ; wait_for ||
# gone` read ANY nonzero — a herdr outage, a dropped socket, a missing binary —
# as "the agent departed", which is the fail-open the adapter exists to remove,
# and it disagreed with the multi-target loop about the same fact.
#
# The bound is why it needed thought rather than a straight swap. `agent wait`
# blocks until a state matches — server-owned and unbounded is the DESIGN of
# the single-target watch — while ralph_herdr_call applies
# RALPH_HERDR_TIMEOUT_SEC (30s) to every call, which would cut every wait short
# and report rc 3. So this call carries its own ceiling: long enough never to
# fire on a live session, finite so a wedged server eventually surfaces as an
# unreadable read instead of hanging the pane forever. The override rides
# inside the command substitution, so it cannot leak to any other call.
wait_for() {
  local out rc=0
  out=$(RALPH_HERDR_TIMEOUT_SEC="${RALPH_HERDR_WAIT_MAX_SEC:-86400}" \
    ralph_herdr_call agent_info agent wait "$TARGET" "$@") || rc=$?
  [ "$rc" -eq 0 ] && return 0
  _herdr_verdict "$out"
}

# wait_or_backoff ARG… — one wait, with the three outcomes resolved: rc 0 to
# carry on, an exit through gone() when herdr says the agent is not there, and
# rc 1 after a backoff when the answer was unreadable. Callers write
# `wait_or_backoff … || continue`, so both waits below agree — and agree with
# the multi-target loop — that an unreachable server is not a departure.
wait_or_backoff() {
  local rc=0
  wait_for "$@" || rc=$?
  [ "$rc" -eq 0 ] && return 0
  [ "$rc" -eq 2 ] && gone   # exits
  echo "$(date -u +%FT%TZ) wait failed for $TARGET — retrying in ${POLL}s"
  sleep "$POLL"
  return 1
}

echo "watching $TARGET (repo $REPO_NAME) — waiting for blocked/done/idle"

while :; do
  # Bare wait: blocked/done/idle are agent wait's default until-set.
  wait_or_backoff || continue

  rc=0
  state=$(agent_status_of "$TARGET") || rc=$?
  case "$rc" in
    0) ;;
    2) gone ;;
    *)
      # Unreadable, not gone. The wait above returned, so the agent was there a
      # moment ago; announcing "gone" off a response nobody could parse would
      # end the watch on a fabricated fact. Back off and re-arm.
      echo "$(date -u +%FT%TZ) read failed for $TARGET — retrying in ${POLL}s"
      sleep "$POLL"
      continue
      ;;
  esac

  notify "$TARGET" "ralph: $TARGET $state" "repo $REPO_NAME — attend the pane"

  case "$state" in
    blocked)
      # A session can block repeatedly. Re-arm only after the state moves
      # off blocked — the top-level wait matches the *current* state, so an
      # immediate re-wait would return instantly and spin-notify.
      #
      # A transient failure retries THIS wait rather than falling back to the
      # loop top, because the bare wait's default until-set includes blocked:
      # while the agent is still blocked it would return at once and fire a
      # second notification for an episode that never re-transitioned. The
      # backoff lives in wait_or_backoff, and a departed agent still exits
      # through gone(), so this cannot spin.
      until wait_or_backoff --until working --until "done" --until idle; do :; done
      ;;
    done | idle)
      exit 0
      ;;
    *)
      # Snapshot moved on between wait and get (working/unknown) — re-arm.
      ;;
  esac
done
