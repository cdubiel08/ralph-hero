#!/usr/bin/env bash
# reconcile.sh — one startup reconciliation pass for the ralph-herdr watcher.
#
# The [[startup]] hook runs this once after the herdr server (re)starts; the
# "Ralph: reconcile watcher ledger" action and a bare `bash reconcile.sh` in
# any pane run the identical pass by hand. It heals the gap event hooks cannot
# cover — everything that happened while the server was down:
#
#   A  exit lost   every open ledger agent with no live herdr agent of that
#                  name gets {ev: exit, reason: lost} — after a FRESH
#                  agent-list re-probe, so a spawn that completed mid-pass
#                  (ledger-open, absent from the pass-start snapshot) is
#                  never falsely exited
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
# steady-state. Board state is never written; the ledger and tokens are
# observations, the board stays authoritative.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=naming.sh
. "$SCRIPT_DIR/naming.sh"
# shellcheck source=ledger.sh
. "$SCRIPT_DIR/ledger.sh"
# shellcheck source=tokens.sh
. "$SCRIPT_DIR/tokens.sh"

HERDR="${HERDR_BIN_PATH:-herdr}"

# set -e can leave a locked section early — never strand the mutex.
trap ralph_ledger_unlock_held EXIT

log() { echo "$(date -u +%FT%TZ) reconcile: $*"; }

# Ledgers nest as <root>/<owner>/<repo>/ledger.jsonl (see ledger.sh).
ledger_root() { printf '%s\n' "${RALPH_HERDR_LEDGER_ROOT:-$HOME/.ralph}"; }

# Live ralph agents as {name, status, pane} JSON lines — mirrors lib.sh's
# ralph_agents_json (change them together; lib.sh is not sourceable here
# because it discovers a board CLI relative to a workspace cwd this hook does
# not have). A FAILED read aborts the whole pass: an empty answer from a sick
# server must never mark every agent lost.
if ! raw=$("$HERDR" agent list 2>&1); then
  log "herdr agent list failed — not reconciling (${raw:0:120})"
  exit 0
fi
live_json=$(jq -c '
  .result.agents[]?
  | select(.name != null)
  | select(.name | test("^gh-[0-9]+$|^ralph-(deliver|tend)$|^[a-z][0-9]+-[a-z].*$"))
  | {name: .name, status: .agent_status, pane: .pane_id}' <<<"$raw" 2>/dev/null) || live_json=""
live_names=$(jq -r '.name' <<<"$live_json" 2>/dev/null | tr '\n' ' ') || live_names=""

ts=$(date -u +%FT%TZ)
open_all="" # names open in ANY ledger (dedup channel for phase B)

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
  candidates=""
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    name=${ref%%#*}
    case " $live_names " in
      *" $name "*)
        open_all="$open_all $name"
        continue
        ;;
    esac
    candidates="$candidates $ref"
  done < <(ralph_ledger_open_agents || true)
  if [ -n "$candidates" ]; then
    if fresh_raw=$("$HERDR" agent list 2>&1); then
      fresh_names=$(jq -r '.result.agents[]? | select(.name != null) | .name' <<<"$fresh_raw" 2>/dev/null | tr '\n' ' ') || fresh_names=""
      for ref in $candidates; do
        name=${ref%%#*}
        case " $fresh_names " in
          *" $name "*)
            log "spared $ref — went live mid-pass (fresh re-probe) [$f]"
            open_all="$open_all $name"
            continue
            ;;
        esac
        ralph_ledger_append "$(jq -nc --arg ts "$ts" --arg ref "$ref" \
          '{ts: $ts, ev: "exit", agent_ref: $ref, reason: "lost", via: "reconcile"}')" ||
          log "exit-lost append failed for $ref"
        log "exit $ref (reason lost) [$f]"
      done
    else
      log "fresh agent list failed — leaving$candidates open for the next reconcile [$f]"
      for ref in $candidates; do
        open_all="$open_all ${ref%%#*}"
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
  case " $open_all " in *" $name "*) continue ;; esac
  if ! parsed=$(ralph_agent_parse "$name"); then
    # ralph-deliver / ralph-tend: legacy singleton lanes with no parseable
    # identity — watched live (lib.sh regex) but never ledgered.
    log "skip $name (legacy singleton, no ledger identity)"
    continue
  fi
  cwd=$("$HERDR" pane get "$pane" 2>/dev/null |
    jq -r '.result.pane.foreground_cwd // .result.pane.cwd // empty' 2>/dev/null) || cwd=""
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
    open_all="$open_all $name"
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
  open_all="$open_all $name"
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
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    name=${ref%%#*}
    pane=$(jq -r --arg n "$name" 'select(.name == $n) | .pane // empty' <<<"$live_json" 2>/dev/null | head -1) || pane=""
    [ -n "$pane" ] || continue
    status=$(jq -r --arg n "$name" 'select(.name == $n) | .status // empty' <<<"$live_json" 2>/dev/null | head -1) || status=""
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

log "reconcile complete"
exit 0
