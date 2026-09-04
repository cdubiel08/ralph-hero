#!/usr/bin/env bash
# refill.sh — the fleet refill decision, shared by both things that can trigger
# it. Sourced, never run: it defines functions and touches nothing at load.
#
# An armed fleet run (work-fleet.sh --refill) is topped back up to k from the
# frontier. The BOARD is the wait state — nothing idles in a pane — so every
# trigger is the same question asked at a different moment:
#
#   EDGE   watch-event.sh, when a w-lane session exits or finishes. Steady
#          state: one seat opens, one seat refills.
#   LEVEL  reconcile.sh phase F, once after the herdr server (re)starts.
#
# The level trigger exists because the edge trigger cannot survive the one
# event that matters most (GH-1862). A restart kills the process in EVERY pane
# at once, and a restored pane is a transcript at a prompt, never a worker
# mid-turn (thoughts/shared/research/2026-08-13-agent-pane-resume-probe.md) —
# so there is no surviving w-lane session left to emit the `exited`/`done` that
# would refill the seat it just vacated. reconcile.sh phase E releases those
# claims and the issues return to Backlog correctly; without a level trigger
# nobody ever picks them up, and an armed fleet.json sits on disk, unexpired
# and unread, until its TTL lapses. Safe, but not productive.
#
# ONE COPY, TWO CALLERS is the whole point of this file. A refill decision
# duplicated in reconcile.sh would be a second grammar that can disagree with
# the first about what "at capacity" or "still armed" means — and the bounds
# below are exactly the ones a restart storm is held by.
#
# Re-arming needs NO new opt-in key, by construction: every bound already lives
# in fleet.json, which only exists because a human typed --refill.
#
#   opt-in    absent fleet.json / armed=false → this file does nothing at all
#   TTL       expires_at, enforced at read time (ralph_fleet_state)
#   budget    budget_left is DURABLE ON DISK, so it is spent across restarts
#             rather than reset by one — N restarts drain the same budget and
#             then disarm, which is why a restart storm cannot become a spawn
#             storm without any restart-specific counter
#   capacity  k, re-checked under the ledger mutex with in-flight picks counted
#   set       the run's `spawned` list, so a refill never re-picks its own issue
#
#   scope     GH-2461: fleet.json's `epic` field (null for a plain fleet run,
#             an issue number for a team lead's staffing run — work-fleet.sh
#             --epic EPIC --refill, armed uncontained by work-team.sh) narrows
#             every candidate read here to EPIC's frontier via
#             ralph_fleet_frontier_json EPIC. This exists because the lead
#             cannot spawn from its own contained pane (GH-2266 denies it
#             write access to the checkout) — the watcher does the staffing
#             now, scoped to the team it is refilling.
#
# Callers must have sourced fleet.sh and ledger.sh, and must define log().

# NEVER on blocked — blocked is attention, not capacity. All herdr interaction
# goes through lib.sh (spawn_work_session, ralph_agents_json, notify).

# maybe_refill LEDGER_FILE — the EDGE trigger: try every run of LEDGER_FILE's
# scope, one spawn apiece. Cheap when nothing is armed (one jq read per
# fleet.json); always rc 0. One seat was vacated, so one spawn per run is the
# whole answer — refill_one's rc 10 is deliberately swallowed here. Restart
# recovery, where every seat vacated at once, is refill_to_capacity below.
maybe_refill() {
  local file="$1" runs ff
  runs="$(dirname "$file")/runs"
  [ -d "$runs" ] || return 0
  for ff in "$runs"/*/fleet.json; do
    [ -f "$ff" ] || continue
    refill_one "$file" "$ff" || true
  done
  return 0
}

# refill_all_to_capacity LEDGER_FILE — the LEVEL trigger: maybe_refill's shape,
# filling every seat rather than one. reconcile.sh phase F's entry point.
#
# OWNERSHIP (GH-1905). herdr runs the [[startup]] hook for EVERY server that
# starts, including a scratch one from an isolated named session, and that pass
# is pointed at the real ledger root. GH-1863 gated the two ABSENCE-driven
# phases on a positive ownership proof; this one was not gated, and it is the
# phase that starts processes: on a foreign server the herd read is empty, every
# seat looks free, and an armed fleet.json is topped back up to k — real workers
# spawned into a scratch server, taking real claims.
#
# It cannot reuse GH-1863's predicate. That proof is read off the ledger's OPEN
# records (a pane this server holds, or a record this server wrote), and the
# scenario phase F exists for — a restart of a fleet whose workers all exited
# cleanly — has zero open records, so the predicate would refuse the re-arm in
# precisely the case it is needed. The run's own provenance answers instead:
# fleet.json records the arming server's session key (ralph_fleet_arm), which is
# a fact about the RUN and outlives every worker in it.
#
# Fail closed, on both unknowns. A fleet.json with no `session` is a legacy
# arming whose server is unknowable — and unknown may not spawn. A missing
# ralph_session_key (this file is sourced by callers that need not have loaded
# ledger.sh) is the same answer for the same reason. Both cost at most one
# armed run one TTL, which is the bound GH-1809 already established; the
# alternative costs a foreign server a fleet.
#
# The EDGE trigger needs no such gate: it fires from watch-event.sh on a w-lane
# session's own exit event, which only the server hosting that session receives.
refill_all_to_capacity() {
  local file="$1" runs ff this_session ff_session
  runs="$(dirname "$file")/runs"
  [ -d "$runs" ] || return 0
  this_session=""
  if command -v ralph_session_key >/dev/null 2>&1; then
    this_session=$(ralph_session_key 2>/dev/null) || this_session=""
  fi
  for ff in "$runs"/*/fleet.json; do
    [ -f "$ff" ] || continue
    # Read straight from the file, not ralph_fleet_state: this decides whether
    # to look at the run at all, and an unarmed or lapsed run is refill_one's
    # to report (it writes the TTL disarm down). A run we do not own is one we
    # must not touch either way.
    ff_session=$(jq -r '.session // ""' "$ff" 2>/dev/null) || ff_session=""
    if [ -z "$this_session" ] || [ -z "$ff_session" ] || [ "$ff_session" != "$this_session" ]; then
      # Silent unless it would otherwise have acted — an unarmed fleet.json is
      # the common case and phase F is supposed to be inert against it.
      if [ "$(jq -r '.armed // false' "$ff" 2>/dev/null)" = "true" ]; then
        log "refill: $ff was armed by session '${ff_session:-none recorded}', not this server ('${this_session:-unresolved}') — not refilling it here"
      fi
      continue
    fi
    refill_to_capacity "$file" "$ff" || true
  done
  return 0
}

# refill_one LEDGER_FILE FLEET_FILE — one refill attempt for one run, in a
# CONTAINED SUBSHELL: it sources lib.sh against the repo recorded at arm
# time (fleet.json carries it because this process has no workspace cwd),
# and any lib.sh refusal — no board CLI, billing guard — kills only the
# subshell.
#
# LOCK DISCIPLINE: everything server- or network-priced runs OUTSIDE the
# scope's ledger mutex — the SPAWN (agent-start retries alone can outlast
# the 15s stale-lock break), and equally the agent-list, FRONTIER, and
# unwired-body-reference reads
# (`board next` paginates the whole project; a large board takes longer than
# the break, after which a waiter would recreate the lock and this holder's
# identity check would falsely pass — unserializing the very consume the
# mutex exists to close). The mutex guards ONLY the fleet.json
# decide-and-consume: re-read state → capacity check (live w-agents from the
# pre-lock snapshot PLUS the run's unexpired `inflight` picks, since a
# mid-spawn agent is invisible to `agent list`) → pick a frontier item →
# consume a budget unit recording the pick. Racing hooks therefore never
# double-pick, and a burst of triggers never overshoots k. Both pre-lock
# reads fail CLOSED (skip the refill, stay armed): unknown capacity must
# never spawn into an unknown herd. The spawned session's own claim protocol
# is the cross-run backstop, as everywhere.
refill_one() (
  ledger="$1" ff="$2"
  state=$(ralph_fleet_state "$ff" 2>/dev/null) || exit 0
  if [ "$(jq -r '.armed' <<<"$state")" != "true" ]; then
    # Expiry is enforced at read time (state forces armed=false), but the
    # FILE may still say armed=true — write the disarm down ONCE so the
    # audit trail names why and the run reads as lapsed everywhere. No
    # toast: a TTL lapse is the planned bound, not a completion. Under the
    # scope mutex like every other fleet.json rewrite.
    if [ "$(jq -r '.expired' <<<"$state")" = "true" ] &&
      [ "$(jq -r '.armed // false' "$ff" 2>/dev/null)" = "true" ]; then
      ralph_ledger_lock "$ledger"
      state=$(ralph_fleet_state "$ff" 2>/dev/null) || state=""
      if [ -n "$state" ] && [ "$(jq -r '.expired' <<<"$state")" = "true" ]; then
        ralph_fleet_disarm "$ff" "ttl expired" || true
        log "refill $(jq -r '.run_id' <<<"$state"): arming TTL expired — disarmed"
      fi
      ralph_ledger_unlock "$ledger"
    fi
    exit 0
  fi
  run_id=$(jq -r '.run_id' <<<"$state")
  # GH-2461: a run armed via `work-fleet.sh --epic EPIC --refill` (the team
  # lead's staffing path — moved uncontained, into work-team.sh, since the
  # lead's own pane cannot fetch) records EPIC in fleet.json. Threaded into
  # every frontier read below via ralph_fleet_frontier_json's own EPIC
  # argument (empty here just means "unscoped", byte-identical to today).
  epic=$(jq -r '.epic // empty' <<<"$state")
  repo=$(jq -r '.repo // empty' <<<"$state")
  if [ -z "$repo" ] || [ ! -d "$repo" ]; then
    log "refill $run_id: armed but repo '$repo' is gone — disarming"
    ralph_fleet_disarm "$ff" "repo missing" || true
    exit 0
  fi
  export RALPH_HERDR_REPO="$repo" RALPH_HERDR_LEDGER="$ledger"
  # lib.sh discovers the board CLI (dies loudly if none) and runs the
  # billing guard's env check at spawn time; both are contained here.
  # shellcheck source=lib.sh
  . "$SCRIPT_DIR/lib.sh"
  billing_guard
  ralph_plugin_freshness_notice
  trap ralph_ledger_unlock_held EXIT

  # Pre-lock snapshots (see the header): fail CLOSED — the conservative
  # direction for REFILL is to skip and stay armed, never to spawn against
  # an unknown herd (live_names' empty-on-failure convention is conservative
  # for the orphan pass, and exactly backwards here).
  k=$(jq -r '.k' <<<"$state")
  agents=$(ralph_agents_json 2>/dev/null) || {
    log "refill $run_id: herd read failed — leaving armed, not spawning into an unknown herd"
    exit 0
  }
  # RALPH_HERDR_REFILL_EXCLUDE — worker names an authoritative reading has
  # already proven gone, discounted from BOTH the seat count and the
  # already-being-worked set (GH-1862).
  #
  # Nothing sets this on the edge path, where the herd read needs no help: the
  # session whose exit triggered the refill is gone from `agent list` by the
  # time the hook asks. It exists for the LEVEL path, where the herd read is
  # actively misleading. A restart REBUILDS panes and their agent registrations,
  # so `agent list` answers "alive" for workers whose processes it just killed —
  # the exact illusion reconcile.sh phase E was written to see through by asking
  # the pane instead. Without this, phase F would read k occupied seats, exit at
  # capacity, and the restart-refill gap this whole file documents would remain
  # open with a level trigger sitting uselessly on top of it.
  #
  # It only ever SUBTRACTS from a count, and only names whose worker a positive
  # pane reading disproved — never a name absent from the herd, which is the
  # unknown that must not spawn. An empty or unset value changes nothing.
  live_w=$(jq -s --arg ex "${RALPH_HERDR_REFILL_EXCLUDE:-}" '
    ($ex | split(" ") | map(select(. != ""))) as $dead
    | map(select((.name | test("^w[0-9]+-|^gh-[0-9]+$")) and (.name | IN($dead[]) | not)))
    | length' <<<"$agents")
  if [ "$live_w" -ge "$k" ]; then
    exit 0 # at capacity — stays armed for the next exit
  fi
  live_issues=$(jq -s --arg ex "${RALPH_HERDR_REFILL_EXCLUDE:-}" '
    ($ex | split(" ") | map(select(. != ""))) as $dead
    | [.[] | .name
    | select(test("^w[0-9]+-|^gh-[0-9]+$")) | select(IN($dead[]) | not)
    | sub("^w"; "") | sub("^gh-"; "") | split("-")[0] | tonumber]' <<<"$agents")
  frontier=$(ralph_fleet_frontier_json "$epic") || {
    log "refill $run_id: frontier read failed — leaving armed"
    exit 0
  }

  # Unwired body references (GH-2120, work-fleet's GH-2109 guard at this
  # surface). OUTSIDE the mutex like every other network read — dep-refs.sh is
  # two GraphQL calls. Refill's failure semantics deliberately differ from
  # work-fleet's SKIP-and-leave-the-slot-empty: work-fleet may not substitute
  # work into an operator-chosen top-k slice, but refill's mandate is "fill
  # seats from the frontier" and it already skips live/spawned candidates, so
  # advancing past a refused one is the same class of pick, not a
  # substitution. The rest of the decision, journaled on GH-2120:
  #
  #   budget   a refusal spends NO unit — the budget bounds spawn attempts and
  #            a refusal never reaches the spawn. API spend is bounded by the
  #            refusal cap instead (RALPH_HERDR_REFILL_DEP_MAX, default 3;
  #            0 disables the guard).
  #   cap      past the cap the next candidate spawns UNVETTED, loudly — never
  #            a stall. The guard over-reports by construction and has no
  #            operator to override it; a fleet that stops refilling because
  #            the frontier's top carries prose refs is the grounded-fleet
  #            failure the guard's own header warns about. Unvetted is the
  #            pre-guard norm for every spawn — strictly no worse.
  #   durable  refusals are NOT written to fleet.json: re-derived per refill
  #            event, so wiring the edge or closing the referenced issue
  #            self-heals with no state to expire.
  #   fail     OPEN, loudly — an unreadable verdict is a rate limit, not a
  #            clean board, and it spawns with "NOT CHECKED" in the log.
  dep_max="${RALPH_HERDR_REFILL_DEP_MAX:-3}"
  case "$dep_max" in '' | *[!0-9]*) dep_max=3 ;; esac
  refused='[]'
  vetted=""
  if [ "$dep_max" -gt 0 ] && command -v ralph_dep_refs_verdict >/dev/null 2>&1; then
    while IFS= read -r c; do
      [ -n "$c" ] || continue
      verdict=$(ralph_dep_refs_verdict "$c" "$frontier")
      if [ "$(jq -r '.ok // false' <<<"$verdict")" != "true" ]; then
        log "refill $run_id: GH-$c body refs NOT CHECKED ($(jq -r '.detail // empty' <<<"$verdict")) — spawning over the failed read"
        vetted="$c"
        break
      fi
      if [ "$(jq -r '.count' <<<"$verdict")" -eq 0 ]; then
        vetted="$c"
        break
      fi
      refused=$(jq -c --argjson n "$c" '. + [$n]' <<<"$refused")
      log "refill $run_id: GH-$c refused — body names OPEN $(jq -r '.summary' <<<"$verdict") with no dependency edge (wire it: board dep $c --on N; no budget spent)"
      if [ "$(jq -r 'length' <<<"$refused")" -ge "$dep_max" ]; then
        log "refill $run_id: unwired-ref refusal cap ($dep_max) reached — the next candidate spawns unvetted"
        break
      fi
    done < <(jq -r --argjson live "$live_issues" \
      --argjson done "$(jq -c '.spawned // []' <<<"$state")" '
      ([.queue[]?.number] - $live - $done) | .[]' <<<"$frontier")
  fi

  ralph_ledger_lock "$ledger"
  state=$(ralph_fleet_state "$ff" 2>/dev/null) || { ralph_ledger_unlock "$ledger"; exit 0; }
  if [ "$(jq -r '.armed' <<<"$state")" != "true" ]; then
    ralph_ledger_unlock "$ledger"
    exit 0
  fi
  if [ "$(jq -r '.budget_left' <<<"$state")" -le 0 ]; then
    # A racer's leftover: the consumer of the LAST unit disarms and
    # notifies after its spawn — disarm silently here, never double-toast.
    ralph_fleet_disarm "$ff" "budget exhausted" || true
    ralph_ledger_unlock "$ledger"
    exit 0
  fi
  # Capacity, re-checked under the lock with in-flight picks counted: a
  # racing hook's consume is visible in `inflight` long before its agent
  # shows up in `agent list`. Entries older than 10 min are a dead hook's
  # leftovers (spawns take seconds, not minutes) and never block; ones
  # whose agent already appeared are subtracted, never double-counted.
  cutoff=$(_ralph_fleet_expiry -10)
  inflight=$(jq -r --argjson live "$live_issues" --arg cutoff "$cutoff" '
    ([(.inflight // [])[] | select(.ts > $cutoff) | .issue] - $live) | length' <<<"$state")
  if [ $((live_w + inflight)) -ge "$k" ]; then
    ralph_ledger_unlock "$ledger"
    exit 0 # at capacity once in-flight spawns count — stays armed
  fi
  cand=$(jq -r --argjson live "$live_issues" --argjson frontier "$frontier" \
    --argjson refused "$refused" '
    (.spawned // []) as $done | $frontier
    | ([.queue[]?.number] - $live - $done - $refused) | first // empty' <<<"$state")
  if [ -z "$cand" ]; then
    # Refusals explaining the emptiness may NOT disarm: the frontier is not
    # empty, and "frontier empty" would kill the run permanently on a prose
    # heuristic. Wiring the edge or closing the referenced issue re-qualifies
    # the candidate at the next trigger; the TTL bounds the wait as always.
    if [ "$(jq -r 'length' <<<"$refused")" -gt 0 ]; then
      ralph_ledger_unlock "$ledger"
      log "refill $run_id: every remaining candidate refused on unwired body refs — staying armed, nothing spawned"
      exit 0
    fi
    ralph_fleet_disarm "$ff" "frontier empty" || true
    ralph_ledger_unlock "$ledger"
    notify fleet "fleet run $run_id complete" "${epic:+GH-$epic }frontier empty — refill disarmed"
    exit 0
  fi
  # A racer between our pre-lock vetting and this pick can advance the pick
  # past the candidate we vetted. Rare (bounded by k), and the safe direction
  # is the pre-guard norm — spawn it — but say so rather than letting an
  # unvetted spawn render as a vetted one.
  if [ -n "$vetted" ] && [ "$cand" != "$vetted" ]; then
    log "refill $run_id: picked GH-$cand under the mutex (raced past vetted GH-$vetted) — spawning unvetted"
  fi
  budget_left=$(ralph_fleet_consume_budget "$ff" "$cand") || {
    ralph_ledger_unlock "$ledger"
    exit 0
  }
  ralph_ledger_unlock "$ledger"

  # Spawn outside the mutex. Depth guard on the orchestrator plane (refill
  # spawns are parentless peers of the human's fleet — depth 0 by
  # construction, but the guard call keeps the contract wired); identity is
  # threaded honestly: this spawn is machine-initiated.
  depth=$(ralph_depth_guard "") || exit 0
  export RALPH_HERDR_INVOKED_BY=scheduler RALPH_HERDR_RUN_ID="$run_id"
  # A team run's lead identity (GH-2461, review finding): this process has no
  # lead env, so restore it from the arming record — spawn_work_session then
  # stamps the worker's parent/root lineage from the ref and injects
  # RALPH_HERDR_LEAD into its pane from the name, exactly as a lead-launched
  # fleet did. Absent (a plain run) means a depth-0 root as before.
  lead=$(jq -r '.lead // empty' <<<"$state")
  lead_ref=$(jq -r '.lead_ref // empty' <<<"$state")
  [ -z "$lead" ] || export RALPH_HERDR_TEAM_LEAD="$lead"
  [ -z "$lead_ref" ] || export RALPH_HERDR_TEAM_LEAD_REF="$lead_ref"
  log "refill $run_id: spawning GH-$cand${epic:+ (under GH-$epic frontier scope)} (depth $depth, budget left $budget_left)"
  rc=0
  spawn_work_session "$cand" "$frontier" || rc=$?
  case "$rc" in
    0)
      ralph_brief_write "${RALPH_HERDR_SPAWNED_REF:?refill spawn without a ref}" "$cand" >/dev/null ||
        log "refill $run_id: brief write failed for GH-$cand"
      ralph_ledger_append "$(jq -nc --arg ts "$(date -u +%FT%TZ)" \
        --arg run "$run_id" --arg ref "$RALPH_HERDR_SPAWNED_REF" \
        --argjson n "$cand" --argjson left "$budget_left" \
        '{ts: $ts, ev: "refill_spawn", run_id: $run, agent_ref: $ref,
          issue: $n, budget_left: $left}')" ||
        log "refill $run_id: refill_spawn append failed for GH-$cand"
      log "refill $run_id: spawned $RALPH_HERDR_SPAWNED_AGENT for GH-$cand"
      ;;
    2) log "refill $run_id: GH-$cand already owned elsewhere — budget unit spent (attempts count)" ;;
    *) log "refill $run_id: spawn failed for GH-$cand — budget unit spent (attempts count, no auto-retry)" ;;
  esac
  # The attempt is over (any outcome): stop counting it as capacity-in-flight.
  #
  # Unless the caller is filling several seats in a tight loop (GH-1862), which
  # is the one case where the assumption behind this clear does not hold. It is
  # safe on the edge path because the NEXT refill is a future event, by which
  # time `agent list` reports the agent just spawned. refill_to_capacity asks
  # again immediately, and a seconds-old agent is not in that read yet — so
  # clearing here would make the very next iteration see a free seat that is
  # already taken, and a k=2 fleet would spawn until the BUDGET stopped it
  # rather than until k did.
  #
  # Leaving the marker up is what `inflight` is already for — "a mid-spawn agent
  # is invisible to agent list" is its stated job, and it self-cleans two ways
  # that both still apply: entries are subtracted once the agent appears in the
  # herd, and ignored outright after 10 minutes. So this leaks nothing; it just
  # declines to discard the only evidence the next iteration has.
  if [ "${RALPH_HERDR_REFILL_KEEP_INFLIGHT:-}" != "1" ]; then
    ralph_fleet_spawn_done "$ff" "$cand" || true
  fi
  if [ "$budget_left" -le 0 ]; then
    ralph_fleet_disarm "$ff" "budget exhausted" || true
    notify fleet "fleet run $run_id complete" "spawn budget exhausted — refill disarmed"
  fi
  # 10 = a budget unit was spent, so the run may still be below k and worth
  # asking again (refill_to_capacity's loop condition). It is NOT "the spawn
  # worked" — an attempt that failed or lost the issue to another owner spent
  # its unit too, and the honest thing for a caller filling several seats is to
  # move on to the next candidate rather than retry this one. Every other exit
  # is 0 and means "nothing more to do here", including the disarms above: the
  # next iteration re-reads armed=false and stops on its own.
  exit 10
)

# refill_to_capacity LEDGER_FILE FLEET_FILE — refill_one until the run is at
# capacity, out of budget, out of frontier, or disarmed. Always rc 0.
#
# The edge trigger fires once per vacated seat, so ONE spawn per call is exactly
# right there. A restart vacates every seat at once, so the level trigger has to
# ask repeatedly — otherwise a k=4 fleet comes back holding one worker and waits
# for an event that, by the argument in this file's header, is never coming.
#
# The loop adds NO new bound. It re-enters the same guarded decision, and every
# guard is re-taken from disk each time — so it stops at whichever of k, budget,
# and frontier binds first. The iteration cap is belt-and-braces against a
# refill_one that reports progress without consuming anything: k's hard cap is
# 4, and one extra pass lets the final at-capacity answer be read from state
# rather than assumed by the loop.
refill_to_capacity() {
  local ledger="$1" ff="$2" k i rc
  k=$(ralph_fleet_state "$ff" 2>/dev/null | jq -r '.k // 0' 2>/dev/null) || k=0
  case "$k" in '' | *[!0-9]*) k=0 ;; esac
  # See the spawn_done note in refill_one: within this loop the herd read lags
  # our own spawns, so the in-flight markers ARE the capacity signal.
  export RALPH_HERDR_REFILL_KEEP_INFLIGHT=1
  for ((i = 0; i <= k; i++)); do
    rc=0
    refill_one "$ledger" "$ff" || rc=$?
    [ "$rc" = "10" ] || break
  done
  unset RALPH_HERDR_REFILL_KEEP_INFLIGHT
  return 0
}
