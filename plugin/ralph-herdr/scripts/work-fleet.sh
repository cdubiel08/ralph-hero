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
# That filter is exactly as complete as the `board dep` graph, and the graph is
# sparser than the real dependency structure — dependencies get written in prose
# and only sometimes get wired (GH-2109). So every candidate additionally has
# its BODY scanned for OPEN own-repo references no edge records, and on the
# RANKED path one of those refuses the spawn: nobody chose that issue, and a
# claim, a branch, a worktree and a whole session are cheaper to not spend. The
# EXPLICIT list is the override by construction — the operator named it — which
# is what keeps a check that over-reports by design from being inescapable.
# Both paths print the dependency state the frontier asserted, because a guard
# nobody can see is one nobody has grounds to trust.
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
#   RALPH_HERDR_DEP_REF_CAP body references dep-refs.sh resolves per candidate
#                           (default 10; past the cap is reported, not dropped)
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

Every candidate prints the dependency state the frontier asserted about it
(`deps: #N CLOSED` / `deps: none`), so the guard is observable rather than
trusted. On the RANKED path only, a candidate whose BODY names an OPEN own-repo
issue that no `board dep` edge records is refused and named — wire the edge, or
name the issue explicitly, which is the override.

Knobs: RALPH_HERDR_FLEET, RALPH_HERDR_REFILL / _TTL_MIN / _BUDGET,
       RALPH_HERDR_DEP_REF_CAP (body references resolved per candidate, 10),
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

# dep_evidence N QUEUE_JSON — the dependency state the frontier ASSERTED about
# N, printed rather than trusted (GH-2109). The ranked path prints `── GH-N ──`
# and spawns; it printed no evidence a dependency check ran at all, deliberately
# ("re-asking the frontier of its own head would be a tautology"), which is
# right for the machine and wrong for the operator reading the output — an
# orchestrator running the cheat-sheet command could not tell "guarded and
# clean" from "unguarded", so it had no basis to trust the spawn. Same
# "absence and silence read alike" failure GH-1971 and GH-2052 fixed elsewhere.
#
# Free: `board frontier --json` already carries every edge with its state
# (frontierView, board.ts) and the `next` fallback carries the same fact under
# two keys. No extra read, so the evidence costs nothing to print.
#
# A board CLI old enough to carry NEITHER spelling says so. "not reported" and
# "none" must not render alike — that is this line's own subject.
dep_evidence() {
  local n="$1" q="$2"
  jq -r --argjson n "$n" '
    [.queue[]? | select(.number == $n)] | .[0] // {} |
    if has("blockers") then
      (.blockers // []) as $b
      | if ($b | length) == 0 then "deps: none (frontier reports no dependency edges)"
        else "deps: " + ($b | map("#" + (.number | tostring) + " " + (.state // "?")) | join(" ")) end
    elif (has("openBlockers") or has("closedBlockers")) then
      ((.openBlockers // []) | map("#" + tostring + " OPEN")) as $o
      | ((.closedBlockers // []) | map("#" + tostring + " CLOSED")) as $c
      | if (($o + $c) | length) == 0 then "deps: none (frontier reports no dependency edges)"
        else "deps: " + (($o + $c) | join(" ")) end
    else "deps: not reported by this board CLI (no blocker list in the frontier read) — NOT the same as none"
    end' <<<"$q" 2>/dev/null || echo "deps: not reported (frontier read unparseable) — NOT the same as none"
}

# unwired_refs N QUEUE_JSON — OPEN own-repo issues N's BODY names that the
# `board dep` graph does not record (GH-2109). Prints exactly one line, always,
# and returns 1 only when the spawn should be refused.
#
# The guard is exactly as complete as the dep graph, and that graph is sparser
# than the real dependency structure: dependencies get written in prose and only
# sometimes get wired. Measured on this board 2026-08-22, roughly half the open
# items carried a body reference no edge recorded.
#
# Fails OPEN, loudly. An unreadable body is a rate limit or a flap, not a clean
# board, and a guard that grounds the whole fleet during an outage would be
# ripped out within a week — but "not checked" is PRINTED rather than passed off
# as "checked and clean", which is the distinction this whole issue is about.
#
# Prints DIRECTLY rather than into a caller's command substitution: the passing
# verdicts are the ones worth reading, and a `why=$(...)` capture would discard
# precisely the evidence this line exists to produce.
#
# Wired edges are handed to the scanner out of the frontier read already in
# hand, so the graph half of the comparison costs no second board call.
unwired_refs() {
  local n="$1" q="$2" wired out detail
  [ -x "$SCRIPT_DIR/dep-refs.sh" ] || {
    echo "  body refs: NOT CHECKED — dep-refs.sh is absent from this install"
    return 0
  }
  wired=$(jq -r --argjson n "$n" '
    [.queue[]? | select(.number == $n)] | .[0] // {} |
    ((.blockers // []) | map(.number)) + (.openBlockers // []) + (.closedBlockers // [])
    | map(tostring) | join(",")' <<<"$q" 2>/dev/null) || wired=""
  out=$(bash "$SCRIPT_DIR/dep-refs.sh" "$n" "$wired" 2>/dev/null) || out=""
  detail=""
  [ -n "$out" ] && detail=$(jq -r '.detail // ""' <<<"$out" 2>/dev/null) || detail=""
  if [ -z "$out" ] || [ "$(jq -r '.ok // false' <<<"$out" 2>/dev/null)" != "true" ]; then
    echo "  body refs: NOT CHECKED — ${detail:-dep-refs.sh produced no verdict}"
    return 0
  fi
  if [ "$(jq -r '.count' <<<"$out")" -eq 0 ]; then
    echo "  body refs: no unwired OPEN reference${detail:+ ($detail)}"
    return 0
  fi
  printf 'SKIP body names OPEN %s with no dependency edge — wire it (board dep %s --on N) or name this issue explicitly (work-fleet %s)\n' \
    "$(jq -r '.summary' <<<"$out")" "$n" "$n"
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
  # Printed for BOTH paths and before either decision: the operator is owed the
  # dependency state whichever way the issue got here (GH-2109).
  echo "  $(dep_evidence "$n" "$QUEUE_JSON")"
  # The unwired-reference guard runs on the RANKED path only, and that is the
  # whole override. On an explicit list the operator NAMED this issue — that is
  # the "operator keeps individual autonomy" remedy this check was filed with,
  # and applying the guard there too would leave a heuristic that over-reports
  # by construction with no way past it. On the ranked path nobody chose the
  # issue, so a body reference to work that does not exist yet is reason enough
  # not to spend a claim, a branch, a worktree and a session on it.
  #
  # SKIP, never backfill with the next-ranked candidate: the guard's job is to
  # refuse a bad spawn, not to choose replacement work off a prose heuristic.
  # Under-spawning is visible in the summary and recoverable by naming the
  # issue; silently substituting different work is neither.
  if [ -z "$ISSUES" ] && ! unwired_refs "$n" "$QUEUE_JSON"; then
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
