#!/usr/bin/env bash
# reconcile.sh — one startup reconciliation pass for the ralph-herdr watcher.
#
# The [[startup]] hook runs this once after the herdr server (re)starts; the
# "Ralph: reconcile watcher ledger" action and a bare `bash reconcile.sh` in
# any pane run the identical pass by hand. It heals the gap event hooks cannot
# cover — everything that happened while the server was down:
#
#   E  claim recovery (GH-1809) every open ledger agent whose PANE proves the
#                  worker is gone — the pane was rebuilt (herdr restarted) or
#                  no harness process is left in the same shell — gets
#                  {ev: exit, reason: restart_killed|crashed} and its board
#                  claim RELEASED. Runs first, so phase A only sees what it
#                  does not already explain. The ONLY board write in this file
#   A  exit lost   every open ledger agent with no live herdr agent of that
#                  name gets {ev: exit, reason: lost} — after a FRESH
#                  agent-list re-probe, so a spawn that completed mid-pass
#                  (ledger-open, absent from the pass-start snapshot) is
#                  never falsely exited. Ledger only: an absence is not
#                  evidence enough to touch the board (see the phase)
#   B  discover    every live ralph agent no ledger holds open gets a
#                  discover record (scope from its pane's cwd; a fresh
#                  name#epoch ref — the original spawn epoch died with the
#                  record that never got written)
#   C  token push  live agents re-receive the token map from their most
#                  recent ledger record (server restarts drop pane metadata)
#   D  orphan pass adoption policy for open children whose parent is no
#                  longer open — same pass watch-event.sh runs on pane death
#   F  re-arm      (GH-1862) an ARMED fleet run whose workers the restart
#                  killed is topped back up to k from the frontier — the level
#                  trigger for refill.sh, whose edge trigger a restart destroys
#                  along with the sessions that would have fired it. Inert
#                  unless a human armed a run with `work-fleet --refill`
#
# Single pass, then EXIT — no daemon, no sleep loop; the [[events]] hooks own
# steady-state.
#
# THE ONE BOARD WRITE (GH-1809). Every other phase here is an observation: the
# ledger and tokens describe the world, the board stays authoritative. Phases E
# and A break that for exactly one verb, `board release`, because the thing
# being corrected is a board fact no other actor can see — a claim whose holder
# died without releasing it. A dead worker cannot hand its claim back, and
# leaving it costs the full TTL (120 min) per issue in flight.
#
# The write is bounded to make that carve-out safe:
#   - only `release`, never a state move, never a claim take;
#   - only for an issue the LEDGER binds to this agent (tokens.issue);
#   - only when the PANE proves the worker is gone, by a reading that includes
#     the shell pid this ledger recorded at spawn — an unreadable answer, an
#     unknown pane, or a record with no recorded pid all release nothing;
#   - only when the board itself still reports In Progress WITH a claim, re-read
#     immediately before the write;
#   - only in a checkout whose board scope matches the ledger being walked, so
#     one repository's reconcile can never write another's board;
#   - and board.ts's own guardHolder still refuses a release by a non-holder,
#     which is the authority this pass defers to rather than reimplements.
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
# shellcheck source=claim-recover.sh
. "$SCRIPT_DIR/claim-recover.sh"
# fleet.sh then refill.sh (phase F): refill.sh calls ralph_fleet_*. Neither
# touches anything at source time, and both are inert unless a fleet.json exists.
# shellcheck source=fleet.sh
. "$SCRIPT_DIR/fleet.sh"
# shellcheck source=refill.sh
. "$SCRIPT_DIR/refill.sh"

HERDR="${HERDR_BIN_PATH:-herdr}"

# set -e can leave a locked section early — never strand the mutex.
trap ralph_ledger_unlock_held EXIT

log() { echo "$(date -u +%FT%TZ) reconcile: $*"; }

# Ledgers nest as <root>/<owner>/<repo>/ledger.jsonl (see ledger.sh).
ledger_root() { printf '%s\n' "${RALPH_HERDR_LEDGER_ROOT:-$HOME/.ralph}"; }

# scope_key LEDGER_FILE — the "owner/repo" a ledger path encodes. Used to key
# the cross-phase `open_all` set, because a bare NAME is not a unique key
# across repositories: two repos in one session both hold a `w42-fix`, and a
# name-keyed set would let one repository's live agent suppress the other's
# discovery — the very cross-repo leak this pass is supposed to prevent.
scope_key() {
  local dir
  dir=$(dirname "$1")
  printf '%s/%s' "$(basename "$(dirname "$dir")")" "$(basename "$dir")"
}

# Live ralph agents, each tagged with the repository its checkout resolves to.
# This pass walks EVERY ledger under the ledger root, so it is the one caller
# that legitimately spans repositories — and therefore the one that must never
# compare a name from repository A against a ledger belonging to repository B.
# Two repositories in one Herdr session both produce `w42-fix`; matching on the
# name alone would let A's live worker keep B's dead record open, and B's
# absence mark A's worker lost.
#
# A FAILED read aborts the whole pass: an empty answer from a sick server must
# never mark every agent lost.
# stderr to a FILE, never merged into the capture: on success `2>&1` prepends
# any stray diagnostic line to the JSON, jq rejects the whole value, and the
# scoped herd collapses to an empty list — re-erasing the "no agents" vs
# "could not find out" distinction the transport layer works to preserve.
_snap_err=$(ralph_diag_file)
if ! snapshot=$(ralph_herdr_snapshot 2>"$_snap_err"); then
  log "herdr snapshot failed — not reconciling ($(ralph_diag_read "$_snap_err"))"
  rm -f "$_snap_err"
  exit 0
fi
rm -f "$_snap_err"
# An empty enrichment is NOT an empty herd: phases A and D read absence as
# "mark lost / orphan the children", so a failure here must stop the pass
# rather than let it sweep against nothing.
if ! live_json=$(ralph_herd_by_scope "$snapshot" 2>/dev/null); then
  log "herd scope resolution failed — not reconciling (refusing to sweep against an unknown herd)"
  exit 0
fi


ts=$(date -u +%FT%TZ)
open_all="" # names open in ANY ledger (dedup channel for phase B)
dead_names="" # phase E's proven-gone worker names (capacity input for phase F)

# The ledger set, enumerated ONCE (GH-1775). Every phase below used to re-glob
# the ledger root, which cost five globs and — worse — let a ledger created
# mid-pass be visible to the later phases and not the earlier ones, so a single
# pass could discover an agent it had already declined to sweep. One list means
# every phase reconciles the same world.
ledgers=()
for f in "$(ledger_root)"/*/*/ledger.jsonl; do
  [ -f "$f" ] || continue
  ledgers+=("$f")
done
# bash 3.2 + `set -u`: an empty array is an unbound expansion, so every walk
# below goes through this guard rather than "${ledgers[@]}" directly.
walk_ledgers() { printf '%s\n' ${ledgers[@]+"${ledgers[@]}"}; }

# ── Ownership: which of these ledgers is THIS server's to sweep (GH-1863) ────
# herdr runs the [[startup]] hook for EVERY server that starts, including a
# scratch server from an isolated named session (`herdr --session x server`).
# That pass gets pointed at the real ledgers under the ledger root while
# answering about a herd it has never had, so the absence-driven phases read
# "no live agent of that name" and sweep another server's live workers.
# Observed live 2026-08-13: five running workers marked lost in one pass,
# including the session writing the fix.
#
# The evidence is POSITIVE, matching claim-recover.sh's doctrine that an
# absence proves nothing: a ledger is this server's when the server's own
# snapshot holds a pane that one of the ledger's open records names. A foreign
# server holds none of them, so it sweeps nothing. Everything else — a ledger
# with no open records, or open records that recorded no pane — is UNKNOWN and
# fails closed the same way: the absence-driven phases skip it, and the next
# pass from the server that does own it reconciles as before.
#
# Computed ONCE here, from the pass-start open rows, because phase E closes
# records: a ledger asked again after E could have lost the very row that
# proved it ours.
server_panes=$(printf '%s' "$snapshot" |
  jq -r '(.panes // [])[] | .pane_id // empty' 2>/dev/null | tr '\n' ' ') || server_panes=""
owned="" # ledger paths this server's snapshot proves it owns
while IFS= read -r f; do
  [ -n "$f" ] || continue
  export RALPH_HERDR_LEDGER="$f"
  while IFS=$'\037' read -r ref pane _pid _harness _parent _state _issue _checkout _toks; do
    [ -n "$ref" ] || continue
    [ -n "$pane" ] || continue
    case " $server_panes " in
      *" $pane "*)
        owned="$owned $f"
        break
        ;;
    esac
  done < <(ralph_ledger_open_rows || true)
  case " $owned " in
    *" $f "*) : ;;
    *) log "not this server's ledger — no open record names a pane this server holds; sweeping nothing in $f" ;;
  esac
done < <(walk_ledgers)
unset RALPH_HERDR_LEDGER

# ledger_is_ours FILE — the prepass verdict. Gates the phases whose evidence is
# an ABSENCE (A's exit-lost sweep, D's orphan pass); phase E asks the pane
# directly and is already safe against a foreign server, and phase C writes
# only where the herd matched a record, which a foreign server never does.
ledger_is_ours() {
  case " $owned " in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

# live_rows — the herd as US-separated columns, derived once:
#   name  status  pane  scope  checkout
# Phase B walked live_json with four jq forks per agent to read exactly these.
live_rows=$(printf '%s\n' "$live_json" | jq -r '
  [(.name // ""), (.status // ""), (.pane // ""), (.scope // ""), (.checkout // "")]
  | join("\u001f")' 2>/dev/null) || live_rows=""

# pane_cwd PANE — the pane's cwd from the pass-start snapshot, or empty. Read
# from `panes`, not `agents`: a restored pane whose agent registration did not
# come back still has a cwd, and that is precisely the case being recovered.
pane_cwd() {
  [ -n "${1-}" ] || return 0
  printf '%s' "$snapshot" | jq -r --arg p "$1" \
    '(.panes // [])[] | select(.pane_id == $p) | .cwd // empty' 2>/dev/null | head -1
}

# recover_claim REF LEDGER_FILE REASON ISSUE CHECKOUT PANE — release REF's
# board claim, if the ledger binds it to an issue and the checkout it names
# really is the repository this ledger belongs to. Logs one line either way;
# never fails the pass. Shared by phases E and A so the two cannot drift on
# what "gone" earns.
#
# ISSUE/CHECKOUT/PANE are passed in rather than re-read (GH-1775): they come off
# the same ralph_ledger_open_rows line the caller is already holding, so this
# no longer re-slurps the whole ledger three more times per dead worker.
#
# The scope check is the load-bearing one. A ledger path names owner/repo but
# not a checkout, and the checkout is where board.ts reads its own scope from —
# so a worktree that has since been repointed, or a pane cwd that wandered,
# could otherwise aim `board release` at a DIFFERENT board than the ledger this
# loop is walking. Mismatch is refused, not corrected.
recover_claim() {
  local ref="${1-}" file="${2-}" reason="${3-}" issue="${4-}" root="${5-}" pane="${6-}"
  local scope dir owner repo outcome
  case "$issue" in
    '' | *[!0-9]*)
      log "claim not evaluated for $ref — the ledger binds it to no issue"
      return 0
      ;;
  esac
  if [ -z "$root" ] || [ ! -d "$root" ]; then
    root=$(pane_cwd "$pane")
  fi
  if [ -z "$root" ] || [ ! -d "$root" ]; then
    log "claim NOT released for GH-$issue ($ref) — no checkout resolvable; it will expire at TTL"
    return 0
  fi
  root=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null) || root=""
  if [ -z "$root" ]; then
    log "claim NOT released for GH-$issue ($ref) — checkout is not a git repository; it will expire at TTL"
    return 0
  fi
  dir=$(dirname "$file")
  repo=$(basename "$dir")
  owner=$(basename "$(dirname "$dir")")
  scope=$(ralph_repo_scope "$root" 2>/dev/null) || scope=""
  case "$scope" in
    *"/$owner/$repo") : ;;
    *)
      log "claim NOT released for GH-$issue ($ref) — checkout $root resolves to scope '${scope:-unreadable}', not $owner/$repo; refusing to write another board"
      return 0
      ;;
  esac
  outcome=$(ralph_claim_release "$root" "$issue" "$ref" "$reason")
  case "$outcome" in
    released) log "released the claim on GH-$issue ($ref, $reason)" ;;
    not-in-progress) log "claim untouched on GH-$issue ($ref) — no longer In Progress; the worker got somewhere before it died" ;;
    not-claimed) log "claim untouched on GH-$issue ($ref) — already unclaimed" ;;
    no-board) log "claim NOT released for GH-$issue ($ref) — no board CLI found from $root" ;;
    *) log "claim NOT released for GH-$issue ($ref) — $outcome" ;;
  esac
}

# ── E: claims whose worker the pane proves is gone (GH-1809) ────────────────
# Before phase A, and looking at a DIFFERENT question. Phase A asks "is this
# name in the herd?"; a restart answers yes for a pane that was rebuilt around
# a fresh shell and may hold nothing but a relaunched `claude --resume` sitting
# at a prompt. So this phase asks the pane instead, and only a positive answer
# — rebuilt, or no harness process left — closes the record and releases the
# claim. `alive` and `unknown` are both left entirely to phase A.
#
# One ralph_ledger_open_rows read per ledger supplies every field this phase and
# recover_claim need (GH-1775). It used to take six whole-file jq slurps per
# open worker — pane, shell_pid and harness for the verdict, then issue,
# checkout and pane again to recover the claim — so the ledger's size was a
# per-worker cost.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  export RALPH_HERDR_LEDGER="$f"
  ralph_ledger_lock "$f"
  while IFS=$'\037' read -r ref pane pid harness _parent _state issue checkout _toks; do
    [ -n "$ref" ] || continue
    verdict=$(ralph_worker_verdict "$pane" "$pid" "$harness")
    case "$verdict" in
      restart_killed | crashed) : ;;
      *) continue ;;
    esac
    ralph_ledger_append "$(jq -nc --arg ts "$ts" --arg ref "$ref" --arg r "$verdict" \
      '{ts: $ts, ev: "exit", agent_ref: $ref, reason: $r, via: "reconcile"}')" || {
      log "exit-$verdict append failed for $ref — leaving the claim alone"
      continue
    }
    log "exit $ref (reason $verdict) [$f]"
    # Phase F needs these NAMES (GH-1862). This phase exists precisely because
    # a restart-rebuilt pane is still ANSWERED by `agent list` — that is why the
    # verdict comes from the pane and not from the herd — so the herd read that
    # refill uses for capacity would count every one of these dead workers as an
    # occupied seat and refuse to spawn. The set of workers proven gone is
    # computed exactly once, here, and handed forward.
    dead_names="$dead_names ${ref%%#*}"
    recover_claim "$ref" "$f" "$verdict" "$issue" "$checkout" "$pane"
  done < <(ralph_ledger_open_rows || true)
  ralph_ledger_unlock "$f"
done < <(walk_ledgers)
unset RALPH_HERDR_LEDGER

# ── A: exit reason=lost for open ledger agents with no live counterpart ──────
# The pass-start snapshot ages while the pass runs, and lib.sh appends a
# spawn record only AFTER `agent start` succeeded — so an open ref absent
# from the snapshot may be a spawn that completed mid-pass, live and working.
# Never exit on the stale read alone: collect candidates, then re-probe ONE
# fresh `agent list` and mark lost only what the fresh read also lacks (an
# agent whose record exists was live before the record was written, so a
# truly-live agent always survives the re-probe). A failed re-probe leaves
# the candidates open for the next reconcile — same fail-closed posture as
# the pass-start read.
#
# The re-probe is ONE snapshot for the whole pass, not one per ledger
# (GH-1775). It used to sit inside this loop, so a machine with N boards under
# the ledger root paid N+1 session.snapshot calls in a pass whose stated
# contract is one per session. Hoisting it is also strictly more correct:
# every ledger is now swept against ONE consistent fresh view of the herd
# instead of N views drifting apart as the pass runs. It stays LAZY — a pass
# where nothing looks lost never asks — and its outcome is remembered so a
# failed probe is not retried per ledger either.
fresh_json=""   # scoped herd from the one fresh re-probe
fresh_state=""  # "" not yet asked | ok | failed
fresh_err=""    # the diagnostic from a failed probe, for the log line
reprobe() {
  [ -z "$fresh_state" ] || return 0
  # Same rule as the pass-start read, and it matters MORE here: a corrupted
  # capture yields an empty herd, and every candidate then gets an exit
  # reason=lost. Merging stderr would let one stray diagnostic line close
  # every open record in every ledger.
  local err snap
  err=$(ralph_diag_file)
  if snap=$(ralph_herdr_snapshot 2>"$err"); then
    fresh_json=$(ralph_herd_by_scope "$snap" 2>/dev/null) || fresh_json=""
    fresh_state=ok
  else
    fresh_err=$(ralph_diag_read "$err")
    fresh_state=failed
  fi
  rm -f "$err"
}

while IFS= read -r f; do
  [ -n "$f" ] || continue
  export RALPH_HERDR_LEDGER="$f"
  ralph_ledger_lock "$f"
  if ! ledger_is_ours "$f"; then
    # Not ours to sweep (GH-1863). Every open name still counts as open, so
    # phase B does not mint a second epoch for a worker this pass declined to
    # judge.
    while IFS= read -r ref; do
      [ -n "$ref" ] || continue
      open_all="$open_all $(scope_key "$f")|${ref%%#*}"
    done < <(ralph_ledger_open_agents || true)
    ralph_ledger_unlock "$f"
    continue
  fi
  live_names=$(ralph_names_for_ledger "$live_json" "$f")
  candidates=""
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    name=${ref%%#*}
    case " $live_names " in
      *" $name "*)
        open_all="$open_all $(scope_key "$f")|$name"
        continue
        ;;
    esac
    candidates="$candidates $ref"
  done < <(ralph_ledger_open_agents || true)
  if [ -n "$candidates" ]; then
    reprobe
    if [ "$fresh_state" = ok ]; then
      fresh_names=$(ralph_names_for_ledger "$fresh_json" "$f") || fresh_names=""
      for ref in $candidates; do
        name=${ref%%#*}
        case " $fresh_names " in
          *" $name "*)
            log "spared $ref — went live mid-pass (fresh re-probe) [$f]"
            open_all="$open_all $(scope_key "$f")|$name"
            continue
            ;;
        esac
        ralph_ledger_append "$(jq -nc --arg ts "$ts" --arg ref "$ref" \
          '{ts: $ts, ev: "exit", agent_ref: $ref, reason: "lost", via: "reconcile"}')" ||
          log "exit-lost append failed for $ref"
        log "exit $ref (reason lost) [$f]"
        # NO claim release here, deliberately. Phase A's evidence is an
        # ABSENCE — this name is not in the herd — and an absence does not
        # survive being asked of the wrong server. herdr runs [[startup]] for
        # every server that starts, so a scratch server from an isolated
        # session gets this pass pointed at the real ledgers while answering
        # about a herd it has never had. Observed live 2026-08-13: exactly
        # that marked all five running workers `lost` in one sweep. Closing a
        # ledger record on that basis is recoverable (the next pass rediscovers
        # a live agent); releasing five working agents' claims is not.
        # Phase E releases instead, on a positive reading of the pane.
      done
    else
      log "fresh herd re-probe failed ($fresh_err) — leaving$candidates open for the next reconcile [$f]"
      for ref in $candidates; do
        open_all="$open_all $(scope_key "$f")|${ref%%#*}"
      done
    fi
  fi
  ralph_ledger_unlock "$f"
done < <(walk_ledgers)
unset RALPH_HERDR_LEDGER

# ── B: discover live ralph agents no ledger holds open ───────────────────────
# Reads the pre-derived live_rows columns rather than re-parsing each agent
# (GH-1775): this loop used to fork four jq and an awk per live agent to pull
# out name/pane/scope/checkout that one pass had already produced.
while IFS=$'\037' read -r name _status pane agent_scope cwd; do
  [ -n "$name" ] || continue
  # Keyed by scope|name: a live `w42-fix` already ledgered in repo A must not
  # suppress the discovery of repo B's genuinely different `w42-fix`.
  agent_key="${agent_scope##*/}"
  if [ -n "$agent_scope" ]; then
    # "host/owner/repo" -> "owner/repo": the last two path components, taken
    # with shell suffix/prefix trims rather than an awk fork per agent.
    agent_key="${agent_scope%/*}"
    agent_key="${agent_key##*/}/${agent_scope##*/}"
  fi
  case " $open_all " in *" $agent_key|$name "*) continue ;; esac
  if ! parsed=$(ralph_agent_parse "$name"); then
    # ralph-deliver / ralph-tend: legacy singleton lanes with no parseable
    # identity — watched live (lib.sh regex) but never ledgered.
    log "skip $name (legacy singleton, no ledger identity)"
    continue
  fi
  # `cwd` is the checkout column, which came out of the snapshot join and
  # already preferred server-recorded worktree provenance over a runtime cwd.
  # Re-asking with a per-agent `pane get` would be both weaker (a bare cwd, no
  # provenance) and a remote call per agent in a loop over the whole herd.
  repo_root=""
  if [ -n "$cwd" ]; then
    repo_root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || repo_root="$cwd"
  fi
  file=""
  if [ -n "$repo_root" ]; then
    file=$(ralph_ledger_path "$repo_root" 2>/dev/null) || file=""
  fi
  if [ -z "$file" ]; then
    log "skip $name — no board scope resolvable from pane $pane (cwd '$cwd')"
    continue
  fi
  if ! ref=$(ralph_agent_ref "$name" 2>/dev/null); then
    log "skip $name — no durable ref derivable"
    continue
  fi
  # shellcheck disable=SC2086  # intentional: parse output is space-separated
  set -- $parsed
  lane="$1" issue="$2" slug="$3"
  [ "$slug" = "''" ] && slug=""
  export RALPH_HERDR_LEDGER="$file"
  # Locked re-check before minting an identity: an event hook can discover
  # this agent concurrently — one ref per agent, never two epochs.
  # Deliberately NOT hoisted out of the loop: the whole point is to re-read the
  # open set INSIDE the lock, because an event hook can ledger this agent while
  # this loop is running. A cached open set would reintroduce the double-epoch
  # race the lock exists to close, so this read stays per-candidate.
  ralph_ledger_lock "$file"
  if ralph_ledger_open_agents 2>/dev/null |
    awk -F'#' -v n="$name" '$1 == n { found = 1 } END { exit !found }'; then
    log "skip $name — already ledgered (an event hook won the race)"
    open_all="$open_all $(scope_key "$file")|$name"
    ralph_ledger_unlock "$file"
    continue
  fi
  ralph_ledger_append "$(jq -nc --arg ts "$ts" --arg ref "$ref" --arg p "$pane" \
    --arg lane "$lane" --arg issue "$issue" --arg slug "$slug" \
    '{ts: $ts, ev: "discover", agent_ref: $ref, pane_id: $p, via: "reconcile",
      tokens: ({role: $lane, issue: $issue} + (if $slug == "" then {} else {slug: $slug} end))}')" ||
    { log "discover append failed for $name"; ralph_ledger_unlock "$file"; continue; }
  ralph_ledger_unlock "$file"
  log "discover $ref (pane $pane) in $file"
  open_all="$open_all $(scope_key "$file")|$name"
done < <(printf '%s\n' "$live_rows")
unset RALPH_HERDR_LEDGER

# ── C: re-push tokens for live agents from their latest ledger records ───────
# Server restarts drop pane metadata; the ledger remembers. Two token names
# have LATER ledger truth than the spawn/discover token map and are overlaid
# rather than replayed wholesale: state (the CURRENT herdr status when it
# maps cleanly, else the latest recorded lifecycle state — adopt/orphan
# passes append state events the token map never sees) and parent (adopt
# events re-parent a child; replaying the spawn map would restore the dead
# ref the adopt path promised to supersede).
#
# Two keyed joins replace two linear scans (GH-1775). The live agent was looked
# up by re-filtering the WHOLE herd per open ref — the exact O(agents x
# workers) shape scope.sh warns against — and state/parent/tokens were three
# more whole-ledger slurps per ref. Now the herd is indexed once per ledger and
# the ledger fields ride in on the row.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  export RALPH_HERDR_LEDGER="$f"
  # Scoped like phases A and D. A token push is a WRITE onto a pane, so an
  # unscoped name lookup here does not merely mis-read — it stamps this
  # repository's role/issue/branch metadata onto another repository's agent,
  # and makes our own record look live because THEIR agent is.
  scope_tail=$(basename "$(dirname "$(dirname "$f")")")/$(basename "$(dirname "$f")")
  # name -> "pane<US>status" for THIS ledger's repository only. `first` keeps
  # the previous `head -1` tie-break, so a duplicate name resolves identically.
  herd_index=$(jq -cs --arg tail "$scope_tail" '
    map(select(.scope != null and (.scope | endswith($tail))))
    | group_by(.name)
    | map({key: (.[0].name // ""), value: [(.[0].pane // ""), (.[0].status // "")]})
    | from_entries' <<<"$live_json" 2>/dev/null) || herd_index='{}'
  [ -n "$herd_index" ] || herd_index='{}'
  while IFS=$'\037' read -r ref _pane _pid _harness par state _issue _checkout toks; do
    [ -n "$ref" ] || continue
    name=${ref%%#*}
    hit=$(jq -r --arg n "$name" '(.[$n] // []) | join("\u001f")' <<<"$herd_index" 2>/dev/null) || hit=""
    [ -n "$hit" ] || continue
    pane=${hit%%$'\037'*}
    status=${hit#*$'\037'}
    [ -n "$pane" ] || continue
    statekv=""
    case "$status" in
      working | blocked) statekv="state=$status" ;;
    esac
    if [ -z "$statekv" ] && [ -n "$state" ]; then
      statekv="state=$state"
    fi
    set --
    if [ -n "$toks" ]; then
      while IFS= read -r kv; do
        [ -n "$kv" ] || continue
        set -- "$@" "$kv"
      done < <(jq -r '
        to_entries[]
        | select(.key != "state" and .key != "parent")
        | select((.value | tostring | test("[\\r\\n]")) | not)
        | "\(.key)=\(.value | tostring)"' <<<"$toks" 2>/dev/null || true)
    fi
    if [ -n "$par" ]; then
      set -- "$@" "parent=$par"
    fi
    if [ -n "$statekv" ]; then
      set -- "$@" "$statekv"
    fi
    if [ "$#" -ge 1 ]; then
      # One `pane report-metadata` per live worker, and irreducibly so: this is
      # a WRITE addressed to one pane, and protocol 19 has no bulk form. It is
      # the reason this phase is O(workers) in herdr calls while every READ
      # above is O(1) — a distinction the call-count test pins deliberately.
      ralph_tokens_push "$pane" "$@"
      log "re-pushed $# token(s) for $ref (pane $pane)"
    fi
  done < <(ralph_ledger_open_rows || true)
done < <(walk_ledgers)
unset RALPH_HERDR_LEDGER

# ── C2: re-arm the cockpit agent view (best-effort, chrome only) ─────────────
# Server restarts drop any agent view along with the pane metadata; re-arm it
# after the tokens are back so a token-based sort has tokens to sort on.
# cockpit-view.sh is a documented no-op until the herdr CLI grows an
# agent-view surface (see its header); either way it never fails this pass.
bash "$SCRIPT_DIR/cockpit-view.sh" || true

# ── D: orphan pass — open children whose parent is no longer open ────────────
# Was O(refs^2) plus a whole-ledger slurp per ref (GH-1775): the parent edge
# came from _ralph_ledger_latest_parent, then the entire open list was re-piped
# through awk to ask whether that parent was still open. Both are now one pass:
# the parents ride in on the row, and open NAMES are collected into a
# membership string first — the same substring-set idiom `open_all` already
# uses a few phases up.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  export RALPH_HERDR_LEDGER="$f"
  ralph_ledger_lock "$f"
  if ! ledger_is_ours "$f"; then
    # Same guard as phase A (GH-1863): adoption is decided against live_names,
    # and a foreign server's live_names is empty for every ledger.
    ralph_ledger_unlock "$f"
    continue
  fi
  # Re-scoped per ledger: phase A's loop variable belongs to phase A's
  # iteration, and reusing it here would hand this repository's orphan pass
  # whichever repository happened to be last in that earlier loop.
  live_names=$(ralph_names_for_ledger "$live_json" "$f")
  rows=$(ralph_ledger_open_rows) || rows=""
  # Membership is by full ref, never by name part (GH-1776): a parent edge
  # pointing at a DEAD generation whose name a live agent has since recycled
  # would read as "parent still open" and the orphan pass would never run —
  # the child stays silently parented to a worker that no longer exists, which
  # is the ghost this phase exists to clear.
  open_refs=""
  while IFS=$'\037' read -r ref _p _pid _h _par _st _i _co _t; do
    [ -n "$ref" ] || continue
    open_refs="$open_refs $ref"
  done <<EOF
$rows
EOF
  deads=""
  while IFS=$'\037' read -r ref _pane _pid _harness p _state _issue _checkout _toks; do
    [ -n "$ref" ] || continue
    [ -n "$p" ] || continue
    case " $open_refs " in
      *" $p "*) continue ;; # parent still open — not an orphan edge
    esac
    case " $deads " in
      *" $p "*) : ;;
      *) deads="$deads $p" ;;
    esac
  done <<EOF
$rows
EOF
  for d in $deads; do
    ralph_ledger_orphan_pass "$d" "$live_names"
  done
  ralph_ledger_unlock "$f"
done < <(walk_ledgers)
unset RALPH_HERDR_LEDGER

# ── F: re-arm the fleet a restart emptied (GH-1862) ─────────────────────────
# LAST of the phases, because it is the only one that acts on the world the
# others just corrected. Phase E released the dead workers' claims, so those
# issues are back in Backlog and back on the frontier; this phase is what
# notices and spawns onto them.
#
# The gap it closes: refill is EDGE-triggered from watch-event.sh, on a w-lane
# session exiting or finishing. A restart kills every pane's process at once and
# restores panes holding a transcript at a prompt rather than a worker, so no
# surviving session is left to emit the event that would refill the seat it just
# vacated. An armed fleet.json then sits on disk, unexpired and unread, until
# its TTL lapses — safe (GH-1809 made sure of that) but not productive. A
# restart is an edge that destroys its own listeners, so it needs the same
# question asked at a level instead: once, here, after the server comes back.
#
# NO NEW OPT-IN KEY, and no new bound. Every bound already lives in fleet.json,
# which only exists because a human typed `work-fleet --refill`, and refill.sh
# re-takes all of them from disk. `budget_left` in particular is durable, so a
# restart STORM drains one shared budget and then disarms rather than getting a
# fresh allowance per restart — the acceptance criterion is met by the existing
# bound rather than by a restart-specific counter. With nothing armed this phase
# is one jq read per fleet file and no board access whatsoever.
#
# Phase E's `dead_names` is load-bearing, not an optimization: see the
# RALPH_HERDR_REFILL_EXCLUDE note in refill.sh. A restart's rebuilt panes still
# answer `agent list`, so without it the capacity check counts the very workers
# phase E just proved dead and this phase spawns nothing.
#
# Safe to reach a sick server: the pass already aborted above if the herdr
# snapshot or scope resolution failed, and refill.sh's own herd and frontier
# reads fail closed — an unreadable answer leaves the run armed for the next
# reconcile rather than spawning into an unknown herd.
export RALPH_HERDR_REFILL_EXCLUDE="$dead_names"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  refill_all_to_capacity "$f" || true
done < <(walk_ledgers)
unset RALPH_HERDR_REFILL_EXCLUDE

# Clear the dirty markers events left behind. LAST, after every phase: a marker
# dropped earlier would be a promise this pass had already looked, and any
# event arriving mid-pass would land in the window between the clear and the
# read that was supposed to answer it. Clearing here instead means such an
# event re-marks the scope and earns one more pass — a redundant reconcile,
# never a missed one.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if ralph_dirty_check "$f"; then
    log "cleared the dirty mark for $(dirname "$f")"
    ralph_dirty_clear "$f"
  fi
done < <(walk_ledgers)

log "reconcile complete"
exit 0
