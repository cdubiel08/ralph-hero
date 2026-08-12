#!/usr/bin/env bash
# work-fleet.sh — cockpit action: spawn up to FLEET parallel /ralph:work
# sessions from the dependency-aware frontier.
#
# ATTENDED-ONLY, honestly labelled: this is a human clicking "give me a few
# sessions to shepherd", not a farm. The per-issue claim protocol inside each
# spawned /ralph:work session is the mutual-exclusion backstop (design doc
# §3.5 defers only UNATTENDED parallelism); this script never claims, never
# transitions, never writes board state — the frontier read is its one board
# access. Each spawn is a depth-0 root from a human; spawn_work_session
# appends the C7 spawn record and pushes the spawn tokens per session
# (lib.sh owns it), and every spawn additionally gets a C3 FleetBrief in the
# run's briefs/ dir (fleet.sh owns it).
#
# Candidates come from `board frontier --json` when that verb exists, else
# from the ranked `board next` queue — whose eligibility filter is already
# dependency-aware (unclaimed Backlog, no open blockers, truncation fails
# closed). One probe, one read (fleet.sh normalizes both to {next, queue}).
#
# REFILL (--refill / RALPH_HERDR_REFILL=1) — STAYS OPT-IN: the claim-TTL probe
# (design §3.1/§5) ran 2026-08-11 and returned NO-GO for default/unattended
# arming — a restart restores pane topology but kills every pane's process, so
# an unattended armed run stalls its claims at TTL scale; see
# thoughts/shared/research/2026-08-11-claim-ttl-pane-persistence-probe.md §3.
# After the initial spawns this ARMS the run's fleet.json, and the watcher
# (watch-event.sh) tops the fleet back up to k from the frontier whenever a
# w-lane session exits or finishes — the BOARD is the wait state; nothing
# idles in a pane. Arming is bounded three ways: opt-in per run, a TTL
# (default 120 min), and a max-total-spawns budget (default 8, initial spawns
# included). Without the flag, behavior is today's one-shot fleet,
# byte-compatible in spirit.
#
# Knobs:
#   RALPH_HERDR_FLEET       sessions to spawn (default 2; positive integer;
#                           hard cap 4 — above that you are not attending)
#   RALPH_HERDR_REFILL      "1" → arm refill (same as --refill)
#   RALPH_HERDR_REFILL_TTL_MIN   arming TTL, minutes (default 120)
#   RALPH_HERDR_REFILL_BUDGET    max total spawns this run (default 8)
#   RALPH_HERDR_DRY_RUN     "true" → per-issue plans printed, nothing spawned,
#                           nothing armed, no briefs written
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

trap hold_pane EXIT

billing_guard

REFILL="${RALPH_HERDR_REFILL:-}"
for arg in "$@"; do
  case "$arg" in
    --refill) REFILL=1 ;;
    *) die "unknown argument '$arg' (only --refill)" ;;
  esac
done
[ "$REFILL" = "1" ] || REFILL=""

FLEET="${RALPH_HERDR_FLEET:-2}"
validate_pos_int RALPH_HERDR_FLEET "$FLEET"
[ "$FLEET" -le 4 ] || die "RALPH_HERDR_FLEET=$FLEET exceeds the hard cap of 4 — this is an attended tool, not a farm"

# ONE candidate read (frontier verb when present, ranked queue otherwise);
# .queue is ranked and .next equals .queue[0] in both shapes.
QUEUE_JSON=$(ralph_fleet_frontier_json)
NUMBERS=$(jq -r --argjson k "$FLEET" '.queue[0:$k][]?.number' <<<"$QUEUE_JSON")
if [ -z "$NUMBERS" ]; then
  echo "frontier empty — nothing to spawn"
  exit 0
fi

# One run id for the whole fleet: briefs land under it, and --refill arms it.
RALPH_HERDR_RUN_ID=$(ralph_run_id)
export RALPH_HERDR_RUN_ID

spawned="" spawned_issues="" skipped="" failed=""
for n in $NUMBERS; do
  echo "── GH-$n ──"
  rc=0
  spawn_work_session "$n" "$QUEUE_JSON" || rc=$?
  case "$rc" in
    # The agent name is derived inside spawn_work_session (grammar B, slug
    # from the issue title) and read back from its out-variable — the watcher
    # exec below needs the real names, never reconstructed ones.
    0)
      spawned="$spawned ${RALPH_HERDR_SPAWNED_AGENT:?spawn reported success without an agent name}"
      spawned_issues="$spawned_issues $n"
      # C3 FleetBrief per spawn — an observation; a failed write never costs
      # the session. Dry runs write nothing (the plan already printed).
      if [ "${RALPH_HERDR_DRY_RUN:-}" != "true" ]; then
        ralph_brief_write "${RALPH_HERDR_SPAWNED_REF:?spawn reported success without a ref}" "$n" >/dev/null ||
          echo "GH-$n: brief write failed — continuing (briefs are observations)" >&2
      fi
      ;;
    2) skipped="$skipped GH-$n" ;;
    # One bad spawn must not strand the rest of the fleet — note and continue.
    *) failed="$failed GH-$n"; echo "GH-$n: spawn failed (see above) — continuing" >&2 ;;
  esac
done

echo
if [ "${RALPH_HERDR_DRY_RUN:-}" = "true" ]; then
  echo "fleet summary (DRY RUN — nothing spawned):"
  echo "  planned:${spawned:- (none)}"
else
  echo "fleet summary (run $RALPH_HERDR_RUN_ID):"
  echo "  spawned:${spawned:- (none)}"
fi
echo "  skipped:${skipped:- (none)}"
echo "  failed: ${failed:- (none)}"

if [ -n "$REFILL" ]; then
  if [ "${RALPH_HERDR_DRY_RUN:-}" = "true" ]; then
    echo "  refill: DRY RUN — would arm run $RALPH_HERDR_RUN_ID (k=$FLEET, ttl ${RALPH_HERDR_REFILL_TTL_MIN:-120}m, budget ${RALPH_HERDR_REFILL_BUDGET:-8} total spawns)"
  else
    # shellcheck disable=SC2086  # intentional word-splitting: one argv per issue
    if fleet_file=$(ralph_fleet_arm "$FLEET" 1 $spawned_issues); then
      echo "  refill: ARMED (opt-in only — the claim-TTL probe says NO-GO for unattended arming; stay at the keyboard) — $fleet_file"
      echo "          k=$FLEET, ttl ${RALPH_HERDR_REFILL_TTL_MIN:-120}m, budget left $(jq -r '.budget_left' "$fleet_file") of ${RALPH_HERDR_REFILL_BUDGET:-8} total spawns"
      echo "          the watcher refills from the frontier when a w-lane session exits or finishes"
    else
      echo "  refill: arming FAILED — this run stays one-shot" >&2
    fi
  fi
fi

[ "${RALPH_HERDR_DRY_RUN:-}" = "true" ] && exit 0

if [ -n "$spawned" ]; then
  # shellcheck disable=SC2086  # intentional word-splitting: one argv per agent
  exec "$SCRIPT_DIR/notify-watch.sh" $spawned
fi
