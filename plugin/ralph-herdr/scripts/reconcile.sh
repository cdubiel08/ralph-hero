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

# pane_cwd PANE — the pane's cwd from the pass-start snapshot, or empty. Read
# from `panes`, not `agents`: a restored pane whose agent registration did not
# come back still has a cwd, and that is precisely the case being recovered.
pane_cwd() {
  [ -n "${1-}" ] || return 0
  printf '%s' "$snapshot" | jq -r --arg p "$1" \
    '(.panes // [])[] | select(.pane_id == $p) | .cwd // empty' 2>/dev/null | head -1
}

# recover_claim REF LEDGER_FILE REASON — release REF's board claim, if the
# ledger binds it to an issue and the checkout it names really is the
# repository this ledger belongs to. Logs one line either way; never fails the
# pass. Shared by phases E and A so the two cannot drift on what "gone" earns.
#
# The scope check is the load-bearing one. A ledger path names owner/repo but
# not a checkout, and the checkout is where board.ts reads its own scope from —
# so a worktree that has since been repointed, or a pane cwd that wandered,
# could otherwise aim `board release` at a DIFFERENT board than the ledger this
# loop is walking. Mismatch is refused, not corrected.
recover_claim() {
  local ref="${1-}" file="${2-}" reason="${3-}" issue root scope dir owner repo outcome
  issue=$(_ralph_ledger_latest_issue "$ref" 2>/dev/null) || issue=""
  case "$issue" in
    '' | *[!0-9]*)
      log "claim not evaluated for $ref — the ledger binds it to no issue"
      return 0
      ;;
  esac
  root=$(_ralph_ledger_latest_checkout "$ref" 2>/dev/null) || root=""
  if [ -z "$root" ] || [ ! -d "$root" ]; then
    root=$(pane_cwd "$(_ralph_ledger_latest_pane "$ref" 2>/dev/null || true)")
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
for f in "$(ledger_root)"/*/*/ledger.jsonl; do
  [ -f "$f" ] || continue
  export RALPH_HERDR_LEDGER="$f"
  ralph_ledger_lock "$f"
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    verdict=$(ralph_worker_verdict \
      "$(_ralph_ledger_latest_pane "$ref" 2>/dev/null || true)" \
      "$(_ralph_ledger_latest_shell_pid "$ref" 2>/dev/null || true)" \
      "$(_ralph_ledger_latest '((try .tokens.harness catch null) // "")' "$ref" 2>/dev/null || true)")
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
    recover_claim "$ref" "$f" "$verdict"
  done < <(ralph_ledger_open_agents || true)
  ralph_ledger_unlock "$f"
done
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
for f in "$(ledger_root)"/*/*/ledger.jsonl; do
  [ -f "$f" ] || continue
  export RALPH_HERDR_LEDGER="$f"
  ralph_ledger_lock "$f"
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
    # Same rule as the pass-start read, and it matters MORE here: a corrupted
    # capture yields an empty fresh_names, and every candidate then gets an
    # exit reason=lost. Merging stderr would let one stray diagnostic line
    # close every open record in the ledger.
    _probe_err=$(ralph_diag_file)
    if fresh_snapshot=$(ralph_herdr_snapshot 2>"$_probe_err"); then
      rm -f "$_probe_err"
      fresh_names=$(ralph_names_for_ledger \
        "$(ralph_herd_by_scope "$fresh_snapshot" 2>/dev/null)" "$f") || fresh_names=""
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
      log "fresh herd re-probe failed ($(ralph_diag_read "$_probe_err")) — leaving$candidates open for the next reconcile [$f]"
      rm -f "$_probe_err"
      for ref in $candidates; do
        open_all="$open_all $(scope_key "$f")|${ref%%#*}"
      done
    fi
  fi
  ralph_ledger_unlock "$f"
done
unset RALPH_HERDR_LEDGER

# ── B: discover live ralph agents no ledger holds open ───────────────────────
while IFS= read -r a; do
  [ -n "$a" ] || continue
  name=$(jq -r '.name' <<<"$a")
  pane=$(jq -r '.pane // empty' <<<"$a")
  # Keyed by scope|name: a live `w42-fix` already ledgered in repo A must not
  # suppress the discovery of repo B's genuinely different `w42-fix`.
  agent_scope=$(jq -r '.scope // empty' <<<"$a" 2>/dev/null) || agent_scope=""
  agent_key="${agent_scope##*/}"
  [ -n "$agent_scope" ] && agent_key="$(printf '%s' "$agent_scope" | awk -F/ '{print $(NF-1)"/"$NF}')"
  case " $open_all " in *" $agent_key|$name "*) continue ;; esac
  if ! parsed=$(ralph_agent_parse "$name"); then
    # ralph-deliver / ralph-tend: legacy singleton lanes with no parseable
    # identity — watched live (lib.sh regex) but never ledgered.
    log "skip $name (legacy singleton, no ledger identity)"
    continue
  fi
  # The checkout came out of the snapshot join, which already preferred
  # server-recorded worktree provenance over a runtime cwd. Re-asking with a
  # per-agent `pane get` would be both weaker (a bare cwd, no provenance) and a
  # remote call per agent in a loop over the whole herd.
  cwd=$(jq -r '.checkout // empty' <<<"$a" 2>/dev/null) || cwd=""
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
done < <(printf '%s\n' "$live_json")
unset RALPH_HERDR_LEDGER

# ── C: re-push tokens for live agents from their latest ledger records ───────
# Server restarts drop pane metadata; the ledger remembers. Two token names
# have LATER ledger truth than the spawn/discover token map and are overlaid
# rather than replayed wholesale: state (the CURRENT herdr status when it
# maps cleanly, else the latest recorded lifecycle state — adopt/orphan
# passes append state events the token map never sees) and parent (adopt
# events re-parent a child; replaying the spawn map would restore the dead
# ref the adopt path promised to supersede).
for f in "$(ledger_root)"/*/*/ledger.jsonl; do
  [ -f "$f" ] || continue
  export RALPH_HERDR_LEDGER="$f"
  # Scoped like phases A and D. A token push is a WRITE onto a pane, so an
  # unscoped name lookup here does not merely mis-read — it stamps this
  # repository's role/issue/branch metadata onto another repository's agent,
  # and makes our own record look live because THEIR agent is.
  scope_tail=$(basename "$(dirname "$(dirname "$f")")")/$(basename "$(dirname "$f")")
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    name=${ref%%#*}
    agent_row=$(jq -c --arg n "$name" --arg tail "$scope_tail" \
      'select(.name == $n and .scope != null and (.scope | endswith($tail)))' \
      <<<"$live_json" 2>/dev/null | head -1) || agent_row=""
    [ -n "$agent_row" ] || continue
    pane=$(jq -r '.pane // empty' <<<"$agent_row" 2>/dev/null) || pane=""
    [ -n "$pane" ] || continue
    status=$(jq -r '.status // empty' <<<"$agent_row" 2>/dev/null) || status=""
    statekv=""
    case "$status" in
      working | blocked) statekv="state=$status" ;;
    esac
    if [ -z "$statekv" ]; then
      st=$(_ralph_ledger_latest_state "$ref") || st=""
      [ -n "$st" ] && statekv="state=$st"
    fi
    par=$(_ralph_ledger_latest_parent "$ref") || par=""
    toks=$(_ralph_ledger_latest_tokens "$ref") || toks=""
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
      ralph_tokens_push "$pane" "$@"
      log "re-pushed $# token(s) for $ref (pane $pane)"
    fi
  done < <(ralph_ledger_open_agents || true)
done
unset RALPH_HERDR_LEDGER

# ── C2: re-arm the cockpit agent view (best-effort, chrome only) ─────────────
# Server restarts drop any agent view along with the pane metadata; re-arm it
# after the tokens are back so a token-based sort has tokens to sort on.
# cockpit-view.sh is a documented no-op until the herdr CLI grows an
# agent-view surface (see its header); either way it never fails this pass.
bash "$SCRIPT_DIR/cockpit-view.sh" || true

# ── D: orphan pass — open children whose parent is no longer open ────────────
for f in "$(ledger_root)"/*/*/ledger.jsonl; do
  [ -f "$f" ] || continue
  export RALPH_HERDR_LEDGER="$f"
  ralph_ledger_lock "$f"
  # Re-scoped per ledger: phase A's loop variable belongs to phase A's
  # iteration, and reusing it here would hand this repository's orphan pass
  # whichever repository happened to be last in that earlier loop.
  live_names=$(ralph_names_for_ledger "$live_json" "$f")
  open=$(ralph_ledger_open_agents) || open=""
  deads=""
  for ref in $open; do
    p=$(_ralph_ledger_latest_parent "$ref") || p=""
    [ -n "$p" ] || continue
    pname=${p%%#*}
    if printf '%s\n' "$open" | awk -F'#' -v n="$pname" '$1 == n { found = 1 } END { exit !found }'; then
      continue # parent still open — not an orphan edge
    fi
    case " $deads " in
      *" $p "*) : ;;
      *) deads="$deads $p" ;;
    esac
  done
  for d in $deads; do
    ralph_ledger_orphan_pass "$d" "$live_names"
  done
  ralph_ledger_unlock "$f"
done
unset RALPH_HERDR_LEDGER

# Clear the dirty markers events left behind. LAST, after every phase: a marker
# dropped earlier would be a promise this pass had already looked, and any
# event arriving mid-pass would land in the window between the clear and the
# read that was supposed to answer it. Clearing here instead means such an
# event re-marks the scope and earns one more pass — a redundant reconcile,
# never a missed one.
for f in "$(ledger_root)"/*/*/ledger.jsonl; do
  [ -f "$f" ] || continue
  if ralph_dirty_check "$f"; then
    log "cleared the dirty mark for $(dirname "$f")"
    ralph_dirty_clear "$f"
  fi
done

log "reconcile complete"
exit 0
