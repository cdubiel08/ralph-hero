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
#                              the dead agent's children; a dead o-lane LEAD
#                              additionally gets the event-driven healing
#                              (heal.sh, GH-2212): team-space flag + respawn
#                              via work-team.sh --lead-only.
#
# Both handlers stamp <ledger dir>/dispatch-heartbeat for the scope they
# acted on (GH-2212, D7.2): with no scheduled rota, this hook and hero
# sittings are the proof the dispatch lane's unattended half is alive, and
# doctor's advisory reads the heartbeat's age.
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
# shellcheck source=outcome.sh
. "$SCRIPT_DIR/outcome.sh"
# shellcheck source=fleet.sh
. "$SCRIPT_DIR/fleet.sh"
# refill.sh after fleet.sh (it calls ralph_fleet_*) and after log() is defined
# below — it only ever calls log() from inside a function body, so definition
# order at source time does not matter, but the dependency is real.
# shellcheck source=refill.sh
. "$SCRIPT_DIR/refill.sh"
# heal.sh after ledger.sh (it appends flags and reads records) — the
# event-driven healing half (GH-2212): dead-lead respawn, team-space flag,
# dispatch heartbeat. Like refill.sh it only ever calls log() from inside a
# function body.
# shellcheck source=heal.sh
. "$SCRIPT_DIR/heal.sh"

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

# title_agent TITLE — best-effort agent name recovered from a pane title
# (GH-2396). herdr composes a ralph pane's title as "<address> <glyph>"
# (tokens.sh's address-as-title rule, GH-2210/D6.2), where <address> is
# "<repo>[/<team>]/<name>" and <glyph> is one ASCII char — so the name is
# always the tail after the last "/" with one trailing " X" glyph stripped.
# Prints nothing (rc 1) when TITLE is empty or has no "/", which callers
# treat as "no candidate", never as a name.
title_agent() {
  local title="${1-}" tail
  [ -n "$title" ] || return 1
  case "$title" in
    */*) tail="${title##*/}" ;;
    *) return 1 ;;
  esac
  case "$tail" in
    *' '?) tail="${tail% ?}" ;;
  esac
  [ -n "$tail" ] || return 1
  printf '%s\n' "$tail"
}

ledger_root() { printf '%s\n' "${RALPH_HERDR_LEDGER_ROOT:-$HOME/.ralph}"; }

# ledger_for_agent NAME — find the ledger that holds NAME open; prints
# "FILE<TAB>REF" for the first match. rc 1 when no ledger knows the agent.
# Enumerated via ralph_ledger_enum (locator paths — post phase D a fresh
# machine's ledger is sqlite-only, invisible to a *.jsonl glob).
ledger_for_agent() {
  local name="$1" f ref
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    ref=$(RALPH_HERDR_LEDGER="$f" ralph_ledger_open_agents |
      awk -F'#' -v n="$name" '$1 == n { print; exit }') || ref=""
    if [ -n "$ref" ]; then
      printf '%s\t%s\n' "$f" "$ref"
      return 0
    fi
  done < <(RALPH_HERDR_LEDGER_ROOT="$(ledger_root)" ralph_ledger_enum)
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


# ── pane.agent_status_changed ────────────────────────────────────────────────
handle_status() {
  local agent status pane parsed legacy candidate entry file ref ts cwd repo_root
  local lane issue slug gen title labels body snapshot confirmed
  local prior checkout verdict addr csid
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
  # pre-GH-2342 lane-pass names (no parseable identity — they get attention
  # routing but no ledger record; reconcile skips them the same way). The
  # current passes, t0-tend / r0-deliver, parse and are ledgered like any
  # other agent.
  legacy=""
  if ! parsed=$(ralph_agent_parse "$agent"); then
    case "$agent" in
      ralph-deliver | ralph-tend) legacy=1 ;;
      *)
        # data.agent is the harness kind (herdr 0.8.2, GH-2396) — "claude",
        # not the pane name — on every payload this server sends. The real
        # name only survives in .title's composed address; try recovering it
        # from there before giving up on the event entirely. .agent stays
        # the first choice above, unchanged, for a payload that does carry
        # the name.
        candidate=$(title_agent "$(pfield '.title // .data.title // empty')") || candidate=""
        if [ -n "$candidate" ] && parsed=$(ralph_agent_parse "$candidate"); then
          agent="$candidate"
        else
          exit 0
        fi
        ;;
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
  csid=""
  if [ -n "$confirmed" ]; then
    status=$(printf '%s' "$confirmed" | jq -r '.status // empty')
    pane=$(printf '%s' "$confirmed" | jq -r '.pane // empty')
    # The worker's Claude session id (GH-2347), read off the same confirmed
    # row: herdr describes a claude pane by it once the conversation has
    # started. It rides the state event so the usage facts can find the
    # transcript — the spawn record was written before any session existed.
    csid=$(printf '%s' "$confirmed" | jq -r '.agent_session // empty' 2>/dev/null) || csid=""
    [ -n "$status" ] || exit 0
  else
    log "$agent not confirmed in a live snapshot — treating the event as a hint only, no durable write"
  fi

  # The GH-1907 verdict, computed BEFORE the ledger append so the record carries
  # it: `ralph_ledger_open_rows` reduces `state` from the ledger, and that is
  # what reconcile re-pushes after a server restart drops the pane tokens. A
  # verdict that lived only on the pane would be quietly replaced by the spawn
  # record's `spawned` on the next restart — the exact reading this fixes.
  verdict=""
  if [ "$status" = "done" ] && [ -n "$confirmed" ]; then
    prior=$(printf '%s' "$confirmed" | jq -r '.state_token // empty' 2>/dev/null) || prior=""
    checkout=$(printf '%s' "$confirmed" | jq -r '.checkout // empty' 2>/dev/null) || checkout=""
    verdict=$(ralph_session_outcome "$prior" "$checkout")
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
        --arg v "$verdict" --arg sid "$csid" \
        '{ts: $ts, ev: "state", agent_ref: $ref, agent_status: $st, pane_id: $p, via: "event"}
         + (if $sid == "" then {} else {claude_session: $sid} end)
         + (if $v == "" or $v == "finished" then {} else {state: $v} end)')" ||
        log "state append failed for $ref"
      # Live cost (GH-2347): `done` is a turn boundary — the transcript is
      # quiescent and complete up to here — so it is where the usage fact is
      # re-read while the worker is still running. A worker that never
      # reaches one still gets the exit-time fact below. Best-effort: the
      # helper's own stderr line names why nothing was measured.
      if [ "$status" = "done" ]; then
        ralph_ledger_usage_append "$ref" event >/dev/null 2>&1 || true
      fi
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
  # pushed (working→working, blocked→blocked). idle/unknown carry no honest
  # lifecycle claim — the token keeps its last value; the ledger's state event
  # above still records the raw status.
  #
  # `done` is the exception, and GH-1907 is why. It is a TURN boundary, not a
  # lifecycle outcome: an outage that kills a session mid-response ends its turn
  # exactly as a delivery does. Leaving the token at its last value made the two
  # indistinguishable — an outage-killed pair read `done … spawned`, identical to
  # a finished session, over worktrees full of uncommitted work. So a terminal
  # turn resolves to a VERDICT (outcome.sh) rather than to silence: `finished`
  # only when the session itself said so, `interrupted` on positive evidence of
  # unfinished work, `indeterminate` when nothing separates the two. A caller
  # deciding whether to retire the workspace may act on `finished` alone.
  #
  # Gated on $confirmed for the same reason refill is: an unverified payload may
  # not cause a durable claim about a session's fate. Unconfirmed leaves the
  # token untouched — the pre-GH-1907 behaviour, which is the safe direction
  # here because it is the one that never asserts completion.
  # Re-attach the herd address beside the state (GH-2210/D6.2): the title is
  # composed only by a push that carries the address, so a state-only push
  # would update the glyph token but never the title. The ledger already holds
  # the spawn-stamped address; re-pushing the same value is a no-op merge.
  # Empty (pre-grammar record, unreadable ledger) degrades to the state alone.
  addr=""
  if [ -n "$file" ] && [ -n "$ref" ]; then
    addr=$(RALPH_HERDR_LEDGER="$file" _ralph_ledger_latest_address "$ref" 2>/dev/null) || addr=""
  fi
  case "$status" in
    working | blocked)
      if [ -n "$pane" ]; then
        if [ -n "$addr" ]; then
          ralph_tokens_push "$pane" "state=$status" "address=$addr"
        else
          ralph_tokens_push "$pane" "state=$status"
        fi
      fi
      ;;
    done)
      if [ -n "$pane" ] && [ -n "$verdict" ]; then
        # `finished` is already spelled `reporting` on the pane — the session's
        # own word, and the token it is read from. Overwriting it would replace
        # a first-hand claim with a restatement of it, which is also why the
        # ledger record above omits it.
        if [ "$verdict" != finished ]; then
          if [ -n "$addr" ]; then
            ralph_tokens_push "$pane" "state=$verdict" "address=$addr"
          else
            ralph_tokens_push "$pane" "state=$verdict"
          fi
        fi
        log "$(ralph_outcome_note "$verdict" "$agent")"
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

  # Dispatch heartbeat (GH-2212, D7.2): the event lane just ran for this
  # repo's scope — say so where doctor's advisory can read it. Only when a
  # ledger scope was actually resolved: an event about another tool's agent
  # exited above, and one with no resolvable scope proves nothing about this
  # repo's dispatch lane.
  if [ -n "$file" ]; then
    ralph_heartbeat_write "$file" watch-event "status:$status" || true
  fi
}

# ── pane.exited / pane.closed ────────────────────────────────────────────────
handle_gone() {
  local reason="$1" pane ws live live_json snapshot f refs ref ts ref_ts w_exited o_exited
  pane=$(pfield '.pane_id // .data.pane_id // empty')
  ws=$(pfield '.workspace_id // .data.workspace_id // empty')
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
  # Locator enumeration (ralph_ledger_enum), never a *.jsonl glob: post
  # phase D a fresh machine's ledger is sqlite-only and a glob on the frozen
  # extension would sweep right past it.
  while IFS= read -r f; do
    [ -n "$f" ] || continue
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
    w_exited="" o_exited=""
    for ref in $refs; do
      # GH-2348: an honest end for the swept-unknown/pane-* population too —
      # the transcript's own last-call moment when one resolves, else the
      # detection instant above unchanged. Bounded cost: at most the handful
      # of refs one pane death can ever bind, never a ledger-wide scan.
      ref_ts=$(_ralph_ledger_exit_ts "$ref" "$ts")
      ralph_ledger_append "$(jq -nc --arg ts "$ref_ts" --arg ref "$ref" --arg r "$reason" --arg p "$pane" \
        '{ts: $ts, ev: "exit", agent_ref: $ref, reason: $r, pane_id: $p}')" ||
        log "exit append failed for $ref"
      log "exit $ref (reason $reason, pane $pane)"
      # The final usage fact (GH-2347): the pane is gone but the transcript
      # is on disk. Appended after the exit so a reader that stops at the
      # exit still finds the last heartbeat; a worker whose session was
      # never confirmed logs why and records nothing.
      ralph_ledger_usage_append "$ref" event 2>&1 | while IFS= read -r l; do log "$l"; done || true
      ralph_ledger_orphan_pass "$ref" "$live"
      # w-lane (grammar-B w<N>-* or legacy gh-N) exits free fleet capacity;
      # o-lane exits are dead LEADS, the event-healing case (GH-2212).
      case "$ref" in
        w[0-9]* | gh-[0-9]*) w_exited=1 ;;
        o[0-9]*) o_exited="$o_exited $ref" ;;
      esac
    done
    ralph_ledger_unlock "$f"
    # Everything server- or network-priced runs AFTER the mutex is released —
    # maybe_refill takes it itself for its decide-and-consume section, and a
    # lead respawn is a whole spawn path. The mutex loser of the
    # exited/closed race found no open refs above, so exactly one hook run
    # reaches the healing per death (heal.sh's pane-proved contract).
    if [ -n "$w_exited" ]; then
      maybe_refill "$f"
    fi
    for ref in $o_exited; do
      ralph_heal_lead_death "$f" "$ref" "$ws" "$reason" || true
    done
    # Dispatch heartbeat (GH-2212, D7.2): written only for the scope the
    # event actually acted on — a ledger this pane was never in learns
    # nothing about its dispatch lane from this event.
    if [ -n "$refs" ]; then
      ralph_heartbeat_write "$f" watch-event "$reason" || true
    fi
  done < <(RALPH_HERDR_LEDGER_ROOT="$(ledger_root)" ralph_ledger_enum)
}

case "$EVENT" in
  pane.agent_status_changed | pane_agent_status_changed) handle_status ;;
  pane.exited | pane_exited) handle_gone pane_exited ;;
  pane.closed | pane_closed) handle_gone pane_closed ;;
  *) exit 0 ;;
esac
