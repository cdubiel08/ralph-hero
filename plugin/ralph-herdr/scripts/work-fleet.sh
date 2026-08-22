#!/usr/bin/env bash
# work-fleet.sh — cockpit action: spawn up to FLEET parallel /ralph:work
# sessions from the dependency-aware frontier, or from an EXPLICIT issue list.
#
#   work-fleet.sh [--refill] [ISSUE...]
#
# The frontier ranking is good default POLICY; it is not the only policy
# (GH-1780). Naming issues on the command line spawns exactly those, in the
# order given — same spawn primitive, same cap, same guards, same ledger and
# token writes; an argument, not a second code path. Each named issue is still
# validated against the frontier read, and one that is blocked or not eligible
# is SKIPPED with a named reason rather than killing the run: fleet callers
# must keep going. Bare invocation is unchanged.
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

usage() {
  cat <<'EOF'
usage: work-fleet.sh [--refill] [ISSUE...]

  (no ISSUE)  spawn the top RALPH_HERDR_FLEET (default 2, hard cap 4) issues of
              the ranked frontier — the default policy, unchanged.
  ISSUE...    spawn exactly these issues, in the order given (same hard cap 4).
              Each is validated against the same frontier read; one that is
              blocked or not eligible is SKIPPED with a reason and the rest
              still spawn. An issue a session already owns is skipped too.
  --refill    arm watcher refill for the run from the frontier. Frontier policy
              only — refused with an explicit list, which is a closed set.
  -h, --help  this.

Knobs: RALPH_HERDR_FLEET, RALPH_HERDR_REFILL / _TTL_MIN / _BUDGET,
       RALPH_HERDR_DRY_RUN=true (plans everything, spawns and arms nothing).
EOF
}

REFILL="${RALPH_HERDR_REFILL:-}"
ISSUES=""
for arg in "$@"; do
  case "$arg" in
    --refill) REFILL=1 ;;
    -h | --help)
      trap - EXIT # --help is a read, not a pane session: don't hold for Enter
      usage
      exit 0
      ;;
    *[!0-9]* | "") die "unknown argument '$arg' (--refill, --help, or issue numbers)" ;;
    *) ISSUES="$ISSUES $arg" ;;
  esac
done
[ "$REFILL" = "1" ] || REFILL=""

FLEET="${RALPH_HERDR_FLEET:-2}"
validate_pos_int RALPH_HERDR_FLEET "$FLEET"
[ "$FLEET" -le 4 ] || die "RALPH_HERDR_FLEET=$FLEET exceeds the hard cap of 4 — this is an attended tool, not a farm"

if [ -n "$ISSUES" ]; then
  # Refill tops the fleet back up FROM THE FRONTIER — a policy the caller just
  # overrode. Refusing beats silently spawning issues nobody named.
  [ -z "$REFILL" ] ||
    die "--refill refills from the ranked frontier; an explicit issue list is a closed set — run the list, then run work-fleet again"
  # shellcheck disable=SC2086  # intentional word-splitting: one argv per issue
  set -- $ISSUES
  [ "$#" -le 4 ] || die "$# issues named — the hard cap is 4 (this is an attended tool, not a farm)"
fi

# ONE candidate read (frontier verb when present, ranked queue otherwise);
# .queue is ranked and .next equals .queue[0] in both shapes. With an explicit
# list it is the eligibility oracle rather than the candidate source — and the
# title/parent source either way (spawn_work_session reads them out of it).
QUEUE_JSON=$(ralph_fleet_frontier_json)
if [ -n "$ISSUES" ]; then
  NUMBERS="$ISSUES"
  echo "explicit list:${ISSUES} (frontier read used to validate, not to choose)"
else
  NUMBERS=$(jq -r --argjson k "$FLEET" '.queue[0:$k][]?.number' <<<"$QUEUE_JSON")
  if [ -z "$NUMBERS" ]; then
    echo "frontier empty — nothing to spawn"
    exit 0
  fi
fi

# frontier_verdict N QUEUE_JSON — rc 0 when the frontier admits N; otherwise
# prints WHY (one line) and returns 1. The blocked section names the open
# dependency edges; anything else — claimed, in flight, closed, off-board — is
# named by the board's own one-line `get` view rather than guessed at here.
frontier_verdict() {
  local n="$1" q="$2" why line
  jq -e --argjson n "$n" '[.queue[]? | select(.number == $n)] | length > 0' <<<"$q" >/dev/null 2>&1 &&
    return 0
  why=$(jq -r --argjson n "$n" '
    [.blocked[]? | select(.number == $n)] | .[0] |
    if . == null then empty
    elif (.truncated // .blockersTruncated // .fieldValuesTruncated // false)
      then "blocked (dependency read truncated — fails closed)"
    else ((.blockers_open // .openBlockers // []) | map("#" + tostring) | join(" ")) as $b
      | if $b == "" then "blocked (open dependencies)" else "blocked by " + $b end
    end' <<<"$q" 2>/dev/null) || why=""
  if [ -n "$why" ]; then
    printf '%s\n' "$why"
    return 1
  fi
  line=$("$BOARD" get "$n" 2>/dev/null | head -1) || line=""
  printf 'not on the frontier — board says: %s\n' "${line:-#$n unreadable (is it on this board?)}"
  return 1
}

# One run id for the whole fleet: briefs land under it, and --refill arms it.
RALPH_HERDR_RUN_ID=$(ralph_run_id)
export RALPH_HERDR_RUN_ID

spawned="" spawned_issues="" skipped="" failed="" unprovisioned=""
for n in $NUMBERS; do
  echo "── GH-$n ──"
  # Only the explicit list needs the check — the frontier queue IS the eligible
  # set, so re-asking it of its own head would be a tautology.
  if [ -n "$ISSUES" ] && ! why=$(frontier_verdict "$n" "$QUEUE_JSON"); then
    echo "SKIP $why"
    skipped="$skipped GH-$n"
    continue
  fi
  rc=0
  spawn_work_session "$n" "$QUEUE_JSON" || rc=$?
  case "$rc" in
    # The agent name is derived inside spawn_work_session (grammar B, slug
    # from the issue title) and read back from its out-variable — the watcher
    # exec below needs the real names, never reconstructed ones.
    0)
      spawned="$spawned ${RALPH_HERDR_SPAWNED_AGENT:?spawn reported success without an agent name}"
      spawned_issues="$spawned_issues $n"
      # GH-2106: provisioning is fail-open, so a tree that never got its
      # install still spawns green — the only trace was one stderr line in the
      # middle of that spawn's own output, which is where a provisioner broken
      # on EVERY spawn hid for a whole run. Carried to the summary so the
      # operator sees it beside the agent names they are about to watch.
      case "${RALPH_HERDR_SPAWNED_PROVISION_RC:-}" in
        '' | 0) : ;;
        *) unprovisioned="$unprovisioned GH-$n(rc=$RALPH_HERDR_SPAWNED_PROVISION_RC)" ;;
      esac
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
# Printed only when something failed: unlike the three lines above, most runs
# attempt no provisioning at all (no host script, no lockfile), so a standing
# "(none)" would report "nothing failed" for runs where nothing ran.
if [ -n "$unprovisioned" ]; then
  echo "  provision FAILED:$unprovisioned — those worktrees may be uninstalled (provisioning is fail-open); provision by hand before trusting a build or test there"
fi

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
