#!/usr/bin/env bash
# watch-event.sh — the ralph-herdr watcher's [[events]] hook target.
#
# The herdr server runs this once per subscribed event with the event name in
# HERDR_PLUGIN_EVENT and the payload in HERDR_PLUGIN_EVENT_JSON. Three
# subscriptions (herdr-plugin.toml):
#
#   pane.agent_status_changed  payload {pane_id, workspace_id, agent,
#                              agent_status, display_agent, state_labels,
#                              title} — ralph agents only (grammar-B or
#                              legacy): append a state event, update the state
#                              token, and on blocked show a notification.
#   pane.exited / pane.closed  payload {pane_id, workspace_id} — NO agent
#                              name: the ledger itself is the correlation
#                              (open agents whose latest record binds that
#                              pane). Append exit + run the orphan pass for
#                              the dead agent's children.
#
# Duplicate events are tolerated: the ledger is append-only (a second exit
# for an already-closed ref finds no open agent) and token updates are
# last-write-wins. RACING events need more than tolerance — the server runs
# hook commands concurrently, and pane.exited + pane.closed both fire for one
# pane death — so every read-decide-append section below runs under the
# per-ledger mutex (ralph_ledger_lock): the loser of the race re-reads a
# ledger the winner already amended and finds nothing left to do. This hook
# NEVER writes board state — blocked routes attention (notification +
# ledger); skills own transitions.
#
# Event-hook processes have no workspace cwd, so lib.sh (which discovers a
# board CLI relative to one) is deliberately NOT sourced at the top; the
# ledger root is scanned instead, and an agent seen before any ledger knew it
# gets its scope from its pane's cwd. The ONE exception is the refill branch
# (Phase 3): an ARMED fleet.json records the repo the human armed from, so
# refill_one sources lib.sh inside a contained subshell with that repo — a
# board-CLI discovery failure kills only the subshell, never the hook.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The Herdr boundary (GH-1774): strict transport + session/repository scoping.
# Sourced here rather than via lib.sh because lib.sh discovers a board CLI
# relative to a workspace cwd these hooks do not have — but the boundary itself
# has no such dependency, so both hooks get the same validation the cockpit has.
# shellcheck source=sanitize.sh
. "$SCRIPT_DIR/sanitize.sh"
# shellcheck source=transport.sh
. "$SCRIPT_DIR/transport.sh"
# shellcheck source=naming.sh
. "$SCRIPT_DIR/naming.sh"
# shellcheck source=ledger.sh
. "$SCRIPT_DIR/ledger.sh"
# shellcheck source=tokens.sh
. "$SCRIPT_DIR/tokens.sh"
# scope.sh after ledger.sh: repo scope reuses _ralph_ledger_scope.
# shellcheck source=scope.sh
. "$SCRIPT_DIR/scope.sh"
# shellcheck source=dirty.sh
. "$SCRIPT_DIR/dirty.sh"
# shellcheck source=fleet.sh
. "$SCRIPT_DIR/fleet.sh"

HERDR="${HERDR_BIN_PATH:-herdr}"
EVENT="${HERDR_PLUGIN_EVENT:-}"
PAYLOAD="${HERDR_PLUGIN_EVENT_JSON:-}"

# set -e can leave a locked section early — never strand the mutex.
trap ralph_ledger_unlock_held EXIT

log() { echo "$(date -u +%FT%TZ) watch-event: $*"; }

[ -n "$PAYLOAD" ] || { log "no HERDR_PLUGIN_EVENT_JSON — nothing to do"; exit 0; }
if [ -z "$EVENT" ]; then
  EVENT=$(jq -r '.event // .type // empty' <<<"$PAYLOAD" 2>/dev/null) || EVENT=""
fi

# pfield EXPR — read a payload field defensively: the payload is the EventData
# object today, but tolerate an {event, data} envelope shape too.
pfield() {
  jq -r "$1" <<<"$PAYLOAD" 2>/dev/null || true
}

ledger_root() { printf '%s\n' "${RALPH_HERDR_LEDGER_ROOT:-$HOME/.ralph}"; }

# ledger_for_agent NAME — find the ledger that holds NAME open; prints
# "FILE<TAB>REF" for the first match. rc 1 when no ledger knows the agent.
# Ledgers nest as <root>/<owner>/<repo>/ledger.jsonl (see ledger.sh).
ledger_for_agent() {
  local name="$1" f ref
  for f in "$(ledger_root)"/*/*/ledger.jsonl; do
    [ -f "$f" ] || continue
    ref=$(RALPH_HERDR_LEDGER="$f" ralph_ledger_open_agents |
      awk -F'#' -v n="$name" '$1 == n { print; exit }') || ref=""
    if [ -n "$ref" ]; then
      printf '%s\t%s\n' "$f" "$ref"
      return 0
    fi
  done
  return 1
}

# live_names — space-separated names of the live herdr agents belonging to the
# repository this event is about (the orphan pass only needs membership).
#
# Scoped, because adoption re-parents a ledger record: an unscoped read would
# let repository A's live `w42-fix` be adopted as the new parent of repository
# B's orphan, wiring one repository's lineage into another's. The event's own
# repository is the boundary — which is why this takes a root rather than
# reading whatever the process happens to be pointed at.
#
# A failed read yields the empty set: adoption then conservatively falls back
# to orphaned, and the next reconcile heals it. That direction is deliberate
# here and the opposite of the refill path's — an unnecessary orphan record is
# repairable, an unnecessary adoption rewrites lineage.
live_names() {
  ralph_scoped_agents_now "${1:-$PWD}" 2>/dev/null |
    jq -r 'select(.name != null) | .name' 2>/dev/null |
    tr '\n' ' ' || true
}

# ── refill (Phase 3 — opt-in only; claim-TTL probe said NO-GO by default) ────
# The board is the wait state: when a w-lane session exits or finishes, an
# ARMED fleet run (work-fleet --refill) is topped back up to k from the
# frontier. NEVER on blocked — blocked is attention, not capacity. All
# bounds live in fleet.json (TTL checked at read time, max-total-spawns
# budget, per-run spawned set) and all herdr interaction goes through lib.sh
# (spawn_work_session, ralph_agents_json, notify).

# maybe_refill LEDGER_FILE — try every run of LEDGER_FILE's scope. Cheap when
# nothing is armed (one jq read per fleet.json); always rc 0.
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

# refill_one LEDGER_FILE FLEET_FILE — one refill attempt for one run, in a
# CONTAINED SUBSHELL: it sources lib.sh against the repo recorded at arm
# time (fleet.json carries it because this process has no workspace cwd),
# and any lib.sh refusal — no board CLI, billing guard — kills only the
# subshell.
#
# LOCK DISCIPLINE: everything server- or network-priced runs OUTSIDE the
# scope's ledger mutex — the SPAWN (agent-start retries alone can outlast
# the 15s stale-lock break), and equally the agent-list and FRONTIER reads
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
  live_w=$(jq -s 'map(select(.name | test("^w[0-9]+-|^gh-[0-9]+$"))) | length' <<<"$agents")
  if [ "$live_w" -ge "$k" ]; then
    exit 0 # at capacity — stays armed for the next exit
  fi
  live_issues=$(jq -s '[.[] | .name
    | select(test("^w[0-9]+-|^gh-[0-9]+$"))
    | sub("^w"; "") | sub("^gh-"; "") | split("-")[0] | tonumber]' <<<"$agents")
  frontier=$(ralph_fleet_frontier_json) || {
    log "refill $run_id: frontier read failed — leaving armed"
    exit 0
  }

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
  cand=$(jq -r --argjson live "$live_issues" --argjson frontier "$frontier" '
    (.spawned // []) as $done | $frontier
    | ([.queue[]?.number] - $live - $done) | first // empty' <<<"$state")
  if [ -z "$cand" ]; then
    ralph_fleet_disarm "$ff" "frontier empty" || true
    ralph_ledger_unlock "$ledger"
    notify fleet "fleet run $run_id complete" "frontier empty — refill disarmed"
    exit 0
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
  log "refill $run_id: spawning GH-$cand (depth $depth, budget left $budget_left)"
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
  ralph_fleet_spawn_done "$ff" "$cand" || true
  if [ "$budget_left" -le 0 ]; then
    ralph_fleet_disarm "$ff" "budget exhausted" || true
    notify fleet "fleet run $run_id complete" "spawn budget exhausted — refill disarmed"
  fi
  exit 0
)

# ── pane.agent_status_changed ────────────────────────────────────────────────
handle_status() {
  local agent status pane parsed legacy entry file ref ts cwd repo_root
  local lane issue slug gen title labels body snapshot confirmed
  agent=$(pfield '.agent // .data.agent // empty')
  status=$(pfield '.agent_status // .data.agent_status // empty')
  pane=$(pfield '.pane_id // .data.pane_id // empty')
  [ -n "$agent" ] || exit 0
  [ -n "$status" ] || exit 0

  # Confirmation happens below, AFTER the ralph-name check: an event about
  # another tool's agent must cost zero herdr calls, and the session emits far
  # more of those than ours.
  #
  # The payload is a HINT. Before anything durable is written, confirm the
  # agent against one validated snapshot and take the authoritative status and
  # pane from THAT.
  #
  # Events are unordered and undeduplicated, and carry no durable identity. So
  # a payload can describe a state the agent has already left, an agent that
  # has since exited, or — worst — a name that has been reused by a newer
  # worker, in which case the payload's own fields are describing one agent
  # while naming another. The snapshot is the only thing that can tell those
  # apart, and it is also what makes the write idempotent: reprocessing the
  # same event writes the same current state.
  #
  # Unconfirmable means unmutated. Attention routing still runs below, because
  # a notification is chrome — being wrong about it costs a stray toast, while
  # being wrong in the ledger costs a lie the next session inherits.

  # Ralph agents only: grammar-B / gh-N via ralph_agent_parse, plus the two
  # legacy singleton lanes (which have no parseable identity — they get
  # attention routing but no ledger record; reconcile skips them the same way).
  legacy=""
  if ! parsed=$(ralph_agent_parse "$agent"); then
    case "$agent" in
      ralph-deliver | ralph-tend) legacy=1 ;;
      *) exit 0 ;;
    esac
  fi

  snapshot=$(ralph_herdr_snapshot 2>/dev/null) || snapshot=""
  confirmed=""
  if [ -n "$snapshot" ]; then
    # Matched on name AND the event's own pane, not name alone. A name is
    # unique only among live agents in ONE repository, so a bare name match in
    # a shared session can resolve to another repository's agent — and then
    # both the recorded status and the pane the state token is pushed to would
    # be theirs. The pane comes from the event, which is correct by
    # construction: the server sent this event ABOUT that pane.
    # The pane predicate is REQUIRED, never optional. Making it conditional on
    # a non-empty $p left a hole: an event that omits pane_id fell back to a
    # bare name match against the whole session — exactly the cross-repository
    # resolution the pane binding exists to prevent. An event with no pane
    # cannot be bound to an agent, so it confirms nothing and stays a hint.
    if [ -n "$pane" ]; then
      confirmed=$(ralph_all_agents "$snapshot" 2>/dev/null |
        jq -c --arg n "$agent" --arg p "$pane" \
          'select(.name == $n and .pane == $p)' 2>/dev/null | head -1) || confirmed=""
    fi
  fi
  if [ -n "$confirmed" ]; then
    status=$(printf '%s' "$confirmed" | jq -r '.status // empty')
    pane=$(printf '%s' "$confirmed" | jq -r '.pane // empty')
    [ -n "$status" ] || exit 0
  else
    log "$agent not confirmed in a live snapshot — treating the event as a hint only, no durable write"
  fi

  ts=$(date -u +%FT%TZ)
  file="" ref=""
  if [ -z "$legacy" ]; then
    if entry=$(ledger_for_agent "$agent"); then
      IFS=$'\t' read -r file ref <<<"$entry"
    else
      # First sighting: no ledger holds this agent open (spawned before the
      # watcher existed, or by hand). Minting a durable identity from an event
      # payload is exactly the mutation events may not perform — the payload
      # carries no durable identity, the delivery is unordered, and a reused
      # agent name would bind the record to the wrong worker. Resolve the scope
      # far enough to mark it dirty, then let reconcile do the discovering
      # against a snapshot it can actually verify.
      cwd=$(printf '%s' "$confirmed" | jq -r '.checkout // empty' 2>/dev/null) || cwd=""
      repo_root=""
      if [ -n "$cwd" ]; then
        repo_root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || repo_root="$cwd"
      fi
      if [ -n "$repo_root" ]; then
        file=$(ralph_ledger_path "$repo_root" 2>/dev/null) || file=""
      fi
      if [ -n "$file" ]; then
        ralph_dirty_mark "$file" "unledgered agent $agent seen via event"
        log "unledgered $agent (pane $pane) — marked $(dirname "$file") dirty; reconcile mints the identity"
      else
        log "no ledger scope resolvable for $agent (pane $pane) — routing attention without a ledger record"
      fi
      # No ledger record to append against; attention routing below still runs.
      file=""
    fi
  fi

  # A state append, and ONLY against an identity the ledger already holds open
  # for an agent the snapshot just confirmed. Two writes an event used to make
  # are gone:
  #
  #   discover — minting a durable ref from an event payload. The payload has
  #     no durable identity, so the ref was derived from the NAME; names are
  #     reusable after exit, so a delayed event could mint an identity that
  #     binds a dead agent's record to a live successor. Reconcile discovers
  #     instead, from a snapshot, which is why the dirty mark above exists.
  #
  #   state for an unconfirmed agent — recording a lifecycle transition for
  #     something that may already be gone.
  #
  # What remains is idempotent by construction: the same event reprocessed
  # writes the same snapshot-derived status against the same existing ref.
  if [ -n "$file" ] && [ -n "$ref" ] && [ -n "$confirmed" ]; then
    export RALPH_HERDR_LEDGER="$file"
    ralph_ledger_lock "$file"
    # Re-read under the mutex: a concurrent hook may have closed this ref
    # between the lookup above and here, and appending a state to a closed
    # agent would resurrect it.
    if ralph_ledger_open_agents 2>/dev/null |
      awk -F'#' -v r="$ref" '$0 == r { found = 1 } END { exit !found }'; then
      ralph_ledger_append "$(jq -nc --arg ts "$ts" --arg ref "$ref" --arg st "$status" --arg p "$pane" \
        '{ts: $ts, ev: "state", agent_ref: $ref, agent_status: $st, pane_id: $p, via: "event"}')" ||
        log "state append failed for $ref"
    else
      log "$ref is no longer open — dropping a late state event rather than reopening it"
    fi
    ralph_ledger_unlock "$file"
  elif [ -n "$file" ] && [ -n "$ref" ]; then
    # Ledgered but unconfirmed: the snapshot could not vouch for the agent, so
    # the scope earns a reconcile rather than a write taken on faith.
    ralph_dirty_mark "$file" "unconfirmed status event for $agent"
  fi

  # State token: only herdr statuses with a clean C8 lifecycle mapping are
  # pushed (working→working, blocked→blocked). idle/done/unknown carry no
  # honest lifecycle claim — the token keeps its last value; the ledger's
  # state event above still records the raw status.
  case "$status" in
    working | blocked)
      if [ -n "$pane" ]; then
        ralph_tokens_push "$pane" "state=$status"
      fi
      ;;
  esac

  if [ "$status" = "blocked" ]; then
    title=$(pfield '.title // .data.title // empty')
    labels=$(pfield '(.state_labels // .data.state_labels // {}) | to_entries | map(.value) | join("; ")')
    body="$title"
    if [ -n "$labels" ]; then
      body="${body:+$body — }$labels"
    fi
    [ -n "$body" ] || body="attend the pane"
    body=$(printf '%s' "$body" | tr '\r\n' '  ')
    body=${body:0:240}
    "$HERDR" notification show "$agent blocked" --body "$body" >/dev/null 2>&1 || true
    log "notified: $agent blocked — $body"
  fi

  # Refill trigger: a w-lane session reporting DONE frees capacity — top an
  # armed fleet back up from the frontier. done ONLY: blocked is attention,
  # not capacity (handled above, never refilled); idle carries no completion
  # claim. Runs after every lock above is released.
  # Gated on $confirmed: refill SPAWNS, which is the one durable mutation the
  # "events are hints" contract forbids an unverified payload from causing. An
  # unconfirmed `done` is exactly the stale hint that would free capacity for
  # an agent still working.
  if [ "$status" = "done" ] && [ -n "$confirmed" ] && [ -n "$file" ] && [ -z "$legacy" ]; then
    case "${parsed%% *}" in
      w) maybe_refill "$file" ;;
    esac
  fi
}

# ── pane.exited / pane.closed ────────────────────────────────────────────────
handle_gone() {
  local reason="$1" pane live live_json snapshot f refs ref ts w_exited
  pane=$(pfield '.pane_id // .data.pane_id // empty')
  [ -n "$pane" ] || exit 0
  # ONE snapshot for the whole sweep, scoped per ledger below. A pane death is
  # a single moment; asking the server again for every ledger would let the
  # herd shift underneath one event's own handling.
  # An unreadable herd yields an EMPTY candidate set, which the orphan pass
  # reads as "no live parent" and acts on. That is tolerable only because the
  # orphan record is repairable by the next reconcile — but it must be logged,
  # not silent, or a transport outage looks like a genuine mass orphaning.
  snapshot=$(ralph_herdr_snapshot 2>/dev/null) || snapshot=""
  live_json=""
  if [ -n "$snapshot" ]; then
    live_json=$(ralph_herd_by_scope "$snapshot" 2>/dev/null) || live_json=""
  fi
  [ -n "$live_json" ] ||
    log "herd unreadable for the $reason sweep — children adopt conservatively (orphaned); reconcile heals"
  ts=$(date -u +%FT%TZ)
  for f in "$(ledger_root)"/*/*/ledger.jsonl; do
    [ -f "$f" ] || continue
    export RALPH_HERDR_LEDGER="$f"
    # Adoption re-parents records, so the candidate parents must come from THIS
    # ledger's repository. An empty set (unreadable herd, foreign repository)
    # conservatively orphans rather than adopting — see live_names.
    live=$(ralph_names_for_ledger "$live_json" "$f")
    # Locked read-decide-append: pane.exited and pane.closed both fire for
    # one pane death and the hooks run concurrently — whichever takes the
    # mutex second re-reads a ledger where the ref is already closed (and
    # the children already adopted/orphaned) and appends/notifies nothing.
    ralph_ledger_lock "$f"
    refs=$(ralph_ledger_open_for_pane "$pane") || refs=""
    w_exited=""
    for ref in $refs; do
      ralph_ledger_append "$(jq -nc --arg ts "$ts" --arg ref "$ref" --arg r "$reason" --arg p "$pane" \
        '{ts: $ts, ev: "exit", agent_ref: $ref, reason: $r, pane_id: $p}')" ||
        log "exit append failed for $ref"
      log "exit $ref (reason $reason, pane $pane)"
      ralph_ledger_orphan_pass "$ref" "$live"
      # w-lane (grammar-B w<N>-* or legacy gh-N) exits free fleet capacity.
      case "$ref" in
        w[0-9]* | gh-[0-9]*) w_exited=1 ;;
      esac
    done
    ralph_ledger_unlock "$f"
    # Refill AFTER the mutex is released — maybe_refill takes it itself for
    # its decide-and-consume section.
    if [ -n "$w_exited" ]; then
      maybe_refill "$f"
    fi
  done
}

case "$EVENT" in
  pane.agent_status_changed | pane_agent_status_changed) handle_status ;;
  pane.exited | pane_exited) handle_gone pane_exited ;;
  pane.closed | pane_closed) handle_gone pane_closed ;;
  *) exit 0 ;;
esac
