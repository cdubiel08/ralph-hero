#!/usr/bin/env bash
# heal.sh — event-driven healing (GH-2212, unit D of #2208; design record
# thoughts/shared/plans/2026-08-28-herd-topology-design.md, D1.2/D3.3/D7.2).
# Sourced, never run: it defines functions and touches nothing at load.
#
# The operator rejected scheduled reconcile passes outright ("event driven,
# not batch" — D1.2), so the unattended half of the dispatch lane is these
# functions, called from watch-event.sh when the server reports a pane death:
#
#   respawn    a dead LEAD (o-lane) is respawned by re-running work-team.sh
#              EPIC --lead-only — the same idempotent re-run a human performs,
#              carrying the #2178 respawn authority that used to live in the
#              dispatch pass. The lead rehydrates from board state alone, so
#              a respawn loses nothing.
#   flag       the dead lead's team WORKSPACE is flagged in the ledger
#              (ev "orphan_space") — never removed here. Self-dissolve is the
#              lead's own final act (D3.3, unit G); sweep is the guaranteed
#              backstop, and this flag is what it reads.
#   heartbeat  <ledger dir>/dispatch-heartbeat records that the dispatch
#              lane's unattended half ran for this repo (D7.2). With no rota,
#              the writers are the event hooks and hero sittings; doctor's
#              advisory reads its age and names `dispatch up` as the remedy.
#
# STAND-DOWN (GH-2357): a lead whose epic is open but parked (every ready
# child is human-gated) is not dead, and respawning it every time its pane
# exits burns a full rehydration for nothing. `work-team.sh EPIC
# --stand-down` records the durable fact ({ev: exit, reason: "stood-down"})
# for the live lead BEFORE closing its workspace, so the pane-death event
# this produces finds the ref already closed and heals nothing — no exit
# reappend, no orphan flag, no respawn. `respawn` above still owns every
# OTHER death; stood-down is a third, deliberate outcome, distinct from both
# "crashed" (respawn) and "epic complete" (rc 4, self-dissolve backstop).
#
# PANE-PROVED OWNERSHIP (GH-1863) is the standing constraint on every
# event-driven repair, and it is honored by CONSTRUCTION rather than by a
# check here: the only refs a caller may hand ralph_heal_lead_death are the
# ones ralph_ledger_open_for_pane returned for the event's OWN pane, read
# under the ledger mutex — the open record NAMES the dead pane, which is the
# positive proof. The zombie-pane class (acting on an event about a pane
# whose record belongs to someone else) cannot arise from a correlation that
# starts at the pane id the server itself sent. The respawn side is doubly
# guarded because it is delegated whole to work-team.sh, whose herd read is
# fail-closed (it refuses to spawn without proving no live lead stands) and
# whose deterministic agent name makes the loser of a concurrent respawn
# race fail on the name collision.
#
# The RACE between pane.exited and pane.closed (both fire for one death) is
# settled upstream the same way the exit append is: the mutex loser re-reads
# a ledger where the ref is already closed and finds no refs to heal — so
# exactly one hook run reaches these functions per death.
#
# Callers must have sourced ledger.sh and must define log().

_RALPH_HEAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ralph_heartbeat_write LEDGER_FILE WRITER EVENT — stamp the dispatch
# heartbeat beside LEDGER_FILE. Last-write-wins, atomic via rename, and
# best-effort by contract: a failed heartbeat costs one advisory's freshness,
# never the event handling it rides on. Always rc 0.
ralph_heartbeat_write() {
  local file="${1-}" writer="${2-}" event="${3-}" dir hb tmp
  [ -n "$file" ] || return 0
  dir=$(dirname "$file")
  [ -d "$dir" ] || return 0
  hb="$dir/dispatch-heartbeat"
  tmp="$hb.tmp.$$"
  if jq -nc --arg ts "$(date -u +%FT%TZ)" --arg w "$writer" --arg e "$event" \
    '{ts: $ts, writer: $w, event: $e}' >"$tmp" 2>/dev/null; then
    mv -f "$tmp" "$hb" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
  else
    rm -f "$tmp" 2>/dev/null || true
  fi
  return 0
}

# ralph_heal_lead_death LEDGER_FILE REF WORKSPACE_ID REASON — one dead lead's
# healing, in a CONTAINED SUBSHELL (refill_one's pattern): any failure kills
# only the subshell, never the hook. REF must be a ref the caller proved
# against the event's own pane (see the header). Always rc 0.
#
# The respawn is work-team.sh EPIC --lead-only, run from the checkout the
# lead's own spawn record names — every guard the human path has (billing,
# spawn edge, fail-closed liveness, closed/complete epic) runs unchanged
# inside it. Exit 4 from work-team.sh is the CLEAN refusal ("the epic is
# complete — no team to stand up"): that is the self-dissolve backstop
# working, so it is logged and never notified. Every other failure is
# attention: the lead is dead and the heal could not stand a new one up, so
# a notification names it — the one surface a human sees without a rota.
#
# RALPH_HERDR_WORK_TEAM overrides the work-team.sh path (tests).
ralph_heal_lead_death() (
  ledger="${1-}" ref="${2-}" ws="${3-}" reason="${4-pane_exited}"
  herdr="${HERDR_BIN_PATH:-herdr}"
  [ -n "$ledger" ] && [ -n "$ref" ] || exit 0
  # The epic is read off the ref's own grammar (o<EPIC>-<slug>#<epoch>) — the
  # name is derived from the epic at spawn, so this is the spawn-time fact,
  # not a guess. A ref that does not parse is not a lead; nothing to do.
  epic=${ref#o}
  epic=${epic%%-*}
  case "$epic" in '' | *[!0-9]*) exit 0 ;; esac

  # GH-2357: a lead can be deliberately parked (`work-team.sh EPIC
  # --stand-down`) rather than crashing. The open-for-pane contract above
  # already makes this branch unreachable through today's one caller —
  # --stand-down appends {ev: exit, reason: stood-down} and closes the pane's
  # workspace ONLY after that append lands, so by the time any death event
  # for this pane could fire, ralph_ledger_open_for_pane no longer counts the
  # ref as open and watch-event never hands it here at all. The check stays
  # as a second, cheap guard against a future or direct caller that hands
  # this function a ref without re-proving it is still open: a stood-down
  # ref must never be respawned OR flagged orphaned, no matter how it
  # arrives here.
  last_reason=$(RALPH_HERDR_LEDGER="$ledger" _ralph_ledger_latest '.reason' "$ref" 2>/dev/null) || last_reason=""
  if [ "$(ralph_ledger_reason_canon "$last_reason")" = "stood-down" ]; then
    log "lead $ref stood down by operator — no respawn, no orphan flag (GH-2357)"
    exit 0
  fi

  # Durable flag for the sweep backstop (unit G reads the ledger, not the
  # herd): the team space the dead lead owned, named by the event's own
  # workspace_id. Append-only and idempotent to re-observe — the mutex
  # upstream already guarantees one hook run per death.
  if [ -n "$ws" ]; then
    RALPH_HERDR_LEDGER="$ledger" ralph_ledger_append "$(jq -nc \
      --arg ts "$(date -u +%FT%TZ)" --arg ref "$ref" --arg ws "$ws" --arg r "$reason" \
      '{ts: $ts, ev: "orphan_space", agent_ref: $ref, workspace_id: $ws, reason: $r, via: "event"}')" ||
      log "orphan_space append failed for $ref (workspace $ws)"
    log "team space $ws flagged orphaned (lead $ref, reason $reason) — sweep removes it if the respawn does not reclaim the epic"
  fi

  checkout=$(RALPH_HERDR_LEDGER="$ledger" _ralph_ledger_latest '.checkout // empty' "$ref" 2>/dev/null) || checkout=""
  if [ -z "$checkout" ] || [ ! -d "$checkout" ]; then
    # A record with no usable checkout predates the spawn-record checkout
    # stamp or its tree is gone — the respawn has no ground to stand on, and
    # inventing one (PWD, another ledger's repo) is exactly the cross-scope
    # write the pane proof exists to prevent. Fail toward attention.
    log "lead $ref died (reason $reason) — no usable checkout recorded, cannot respawn GH-$epic's lead"
    "$herdr" notification show "lead $ref died — not respawned" \
      --body "no usable checkout recorded; respawn by hand: work-team.sh $epic --lead-only" >/dev/null 2>&1 || true
    exit 0
  fi

  team_sh="${RALPH_HERDR_WORK_TEAM:-$_RALPH_HEAL_DIR/work-team.sh}"
  rc=0
  out=$(cd "$checkout" && RALPH_HERDR_REPO="$checkout" RALPH_HERDR_INVOKED_BY=scheduler \
    bash "$team_sh" "$epic" --lead-only </dev/null 2>&1) || rc=$?
  case "$rc" in
    0)
      log "lead $ref died (reason $reason) — respawn ran for GH-$epic: $(printf '%s' "$out" | tail -1)"
      ;;
    4)
      # work-team.sh's clean refusal: the epic is closed or complete. This is
      # the self-dissolve path's backstop reading correctly — a finished
      # lead's death needs no successor, only the sweep.
      log "lead $ref died with GH-$epic complete — no respawn (self-dissolve backstop; the flagged team space awaits sweep)"
      ;;
    *)
      log "lead $ref died (reason $reason) — respawn FAILED for GH-$epic (rc $rc)"
      "$herdr" notification show "lead $ref died — respawn failed" \
        --body "$(printf '%s' "$out" | tail -1 | tr '\r\n' '  ' | cut -c1-240)" >/dev/null 2>&1 || true
      ;;
  esac
  exit 0
)
