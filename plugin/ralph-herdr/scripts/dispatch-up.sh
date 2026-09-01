#!/usr/bin/env bash
# dispatch-up.sh — DISPATCH UP (GH-2213, unit E of #2208; design record
# thoughts/shared/plans/2026-08-28-herd-topology-design.md, D3.1 — an
# operator DEVIATION: no rota, ever. Placement amended by GH-2246).
#
# One command ensures the dispatch seat exists and is staffed:
#
#   1. the repo's MAIN workspace exists — the one whose checkout is the
#      source checkout, the same space every worker worktree nests under.
#      The seat lives THERE (GH-2246): a `<repo>/dispatch`-labeled sibling
#      workspace carries no worktree binding, so the sidebar renders it
#      detached from the fleet it exists to oversee. The dispatch ADDRESS
#      is untouched — `board name dispatch` still mints `<repo>/dispatch`
#      (GH-2209; this script never spells the grammar itself) — only the
#      pane's placement changed.
#   2. the HERO pane is up in it (the attended face, GH-2182 — still
#      never-load-bearing, see hero.sh)
#   3. the roster prints (best-effort — `board roster`, unit C)
#
# RE-RUN HEALS, NEVER REFUSES (D3.1): a standing space is reused, a live
# hero sitting is left alone, a deleted space is recreated, a dead hero is
# reopened. Liveness is the cockpit's GH-2074 two-fact record
# (cockpit-pane.sh: pid alive AND pane in the live snapshot), scoped to the
# main workspace — a hero standing in some OTHER workspace does not satisfy
# "the hero pane is up in the repo's main workspace", so one is opened
# where it belongs (two heroes are two complete disposable sessions, the
# stated non-conflict). ONE exception: a live hero still sitting in a
# LEGACY `<repo>/dispatch` workspace (created by this script before
# GH-2246) satisfies the seat for that run — a live sitting is left alone,
# and adopting it by `pane move` is foreclosed because pane ids are
# workspace-scoped and CHANGE on move (probed on 0.8.x: w9X:p1 → w9Y:p2),
# which would orphan the session's own $HERDR_PANE_ID self-reporting and
# stale the hero record. The legacy space is NOTED with its manual close
# command, never closed here — its root shell is the operator's scratch
# surface. Every unreadable liveness path fails OPEN toward opening a
# pane: a duplicate disposable pane is the cheap direction.
#
# IT ARMS NOTHING SCHEDULED. The unattended half of the dispatch lane is
# the event lane (watch-event.sh + heal.sh, GH-2212/D1.2) — this command
# installs no cron, no launchd, no rota. What it does stamp is the
# dispatch heartbeat (D7.2, best-effort): doctor's `dispatch-heartbeat`
# advisory names `dispatch up` as its remedy, so running the remedy is
# itself a heartbeat write.
#
# Failure directions, stated: the address read and the workspace read fail
# CLOSED (an unreadable workspace list cannot prove the main workspace is
# absent — creating a second workspace on the same checkout is the very
# duplicate GH-2246 removed); the hero-liveness reads and the roster print
# fail OPEN (their cost is a duplicate disposable pane / a missing
# printout).
#
# Runs from a shell (`bash dispatch-up.sh`) or as the cockpit pane
# entrypoint (the TOML action) — hold_pane and the TTY guards make both
# forms work.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"
# shellcheck source=cockpit-pane.sh
. "$SCRIPT_DIR/cockpit-pane.sh"
# shellcheck source=heal.sh
. "$SCRIPT_DIR/heal.sh"

trap hold_pane EXIT

focus=false
focus_only=false
case "${1-}" in
  -h | --help)
    trap - EXIT
    cat <<'EOF'
usage: dispatch-up.sh [--focus | --focus-only]

Ensure the hero pane is up in the repo's MAIN workspace (the one the
fleet's worktrees nest under — GH-2246; the dispatch address stays
`<repo>/dispatch`), then print the roster. Idempotent: re-run heals
(recreate space, reopen pane) rather than refusing. A live hero still
sitting in a legacy `<repo>/dispatch` workspace is left alone and noted.
Arms nothing scheduled — the unattended half of dispatch is the event
lane (watch-event.sh). By default the command ensures the seat without
changing focus; --focus enters the proven hero pane after healing it.
--focus-only focuses this repo's already-standing hero pane and exits;
it heals nothing, opens nothing, and prints no roster. Refuses when no
live hero is recorded.

Knobs: RALPH_ALLOW_API_BILLING (the hero session bills like any spawn).
EOF
    exit 0
    ;;
  --focus) focus=true ;;
  --focus-only) focus_only=true ;;
  "") ;;
  *) die "unknown argument '${1-}' (accepts --focus, --focus-only; --help)" ;;
esac
[ "$#" -le 1 ] || die "unknown argument '${2-}' (accepts --focus, --focus-only; --help)"

# --focus-only: the attended day's LAST act (rh day). Focus is deliberately
# separated from the ensure phases — the phases print into the invoking
# terminal, so focusing before they finish buries their output. Refuses rather
# than guessing: a stale, dead, or never-written hero record and an unreadable
# snapshot are one rc-1 answer from ralph_hero_live_pane, and focusing some
# other pane on that evidence is worse than not moving at all. It runs BEFORE
# billing_guard: this mode spawns and bills nothing.
if [ "$focus_only" = true ]; then
  pane=$(ralph_hero_live_pane "$REPO") ||
    die "no live dispatch hero recorded for this repo — run \`dispatch up\` first"
  "$HERDR" plugin pane focus "$pane" >/dev/null ||
    die "could not focus the hero pane $pane"
  echo "dispatch focus: hero pane $pane"
  exit 0
fi

# The hero session this stands up bills like any spawned one — refuse before
# creating anything, so a billing refusal leaves no half-built space.
billing_guard

# 1. The seat's ADDRESS, minted by the board (GH-2209 — no second grammar).
# Placement no longer uses it (GH-2246), but the roster identity, the legacy
# detection below, and the summary line all do.
addr=$("$BOARD" name dispatch --json 2>/dev/null | jq -r '.address // empty' 2>/dev/null) || addr=""
[ -n "$addr" ] || die "cannot derive the dispatch address (\`board name dispatch\` failed) — the seat's name is the board's to mint; is the board configured here?"

src=$(ralph_worktree_source_dir)
base=$(basename "$src")

# 2. The repo's MAIN workspace, found by cwd match on the source checkout
# (GH-2246) — fail-closed: an unreadable list cannot prove absence, and a
# second workspace on the same checkout is the duplicate this command
# exists to prevent. The worktree binding is the primary key (it is what
# makes the sidebar nest the fleet's worktrees underneath); the label
# fallback covers a main workspace this script itself created, which herdr
# reports without a worktree object.
ws_out=$(ralph_herdr_call workspace_list workspace list) ||
  die "cannot read the workspace list ($(ralph_herdr_err_code "${ws_out:-}" || true)) — refusing to guess whether the repo's main workspace exists"
ws_id=$(jq -r --arg src "$src" \
  '[.workspaces[] | select(((.worktree.is_linked_worktree // false) | not) and ((.worktree.checkout_path // "") == $src))][0].workspace_id // empty' \
  <<<"$ws_out" 2>/dev/null) || ws_id=""
if [ -z "$ws_id" ]; then
  ws_id=$(jq -r --arg l "$base" \
    '[.workspaces[] | select((.label == $l) and ((.worktree.is_linked_worktree // false) | not) and ((.worktree.checkout_path // "") == ""))][0].workspace_id // empty' \
    <<<"$ws_out" 2>/dev/null) || ws_id=""
fi
n_match=$(jq -r --arg src "$src" \
  '[.workspaces[] | select(((.worktree.is_linked_worktree // false) | not) and ((.worktree.checkout_path // "") == $src))] | length' \
  <<<"$ws_out" 2>/dev/null) || n_match=0
case "$n_match" in '' | *[!0-9]*) n_match=0 ;; esac
if [ "$n_match" -gt 1 ]; then
  echo "note: $n_match workspaces sit on $src — healing into the first ($ws_id); close the extras by hand" >&2
fi

space_state="standing"
if [ -z "$ws_id" ]; then
  # No worktree, no branch: dispatch reads the board and writes nothing, so
  # the space sits on the source checkout (the lead's own precedent,
  # work-team.sh). Labeled by the checkout's basename — the same label herdr
  # gives a main workspace it opens itself — NEVER by the dispatch address:
  # an address-labeled space is the GH-2246 sibling. --no-focus: the summary
  # + roster print HERE, in the invoker's terminal — yanking focus mid-read
  # would bury them.
  out=$(ralph_herdr_call workspace_created workspace create --cwd "$src" --label "$base" --no-focus) ||
    die "workspace create failed for $src ($(ralph_herdr_err_code "${out:-}" || true)) — see the diagnostic above"
  ws_id=$(jq -r '.workspace.workspace_id // empty' <<<"$out")
  [ -n "$ws_id" ] || die "no workspace id in the create response for $src"
  space_state="created"
fi

# Legacy `<repo>/dispatch` spaces (pre-GH-2246 siblings). Detected for the
# note and for the live-sitting carve-out below; never closed here.
legacy_ids=$(jq -r --arg l "$addr" --arg ws "$ws_id" \
  '[.workspaces[] | select(.label == $l and .workspace_id != $ws) | .workspace_id] | join(" ")' \
  <<<"$ws_out" 2>/dev/null) || legacy_ids=""

# _pane_in_workspace PANE WS — is PANE in workspace WS? Scoped server-side
# and re-checked client-side on the returned rows; any unreadable answer is
# "no" (fail open — the cost is a duplicate disposable pane).
_pane_in_workspace() {
  local pane="$1" ws="$2" panes
  panes=$(ralph_herdr_call pane_list pane list --workspace "$ws" 2>/dev/null) || return 1
  jq -e --arg p "$pane" --arg w "$ws" \
    '[.panes[]? | select(.pane_id == $p and (.workspace_id // $w) == $w)] | length > 0' \
    <<<"$panes" >/dev/null 2>&1
}

# 3. The hero pane, healed into the MAIN workspace. The record proves a live
# sitting exists; pane list scopes it. All reads fail OPEN — an unreadable
# answer opens a pane, and a duplicate disposable pane is the stated cheap
# direction.
# The record is read under the same scope key hero.sh stamps it with ($REPO,
# the pane's cwd) — both resolve to the board's owner/repo, but mirroring the
# writer keeps the pair from drifting.
hero_pane="" hero_state="live" hero_legacy_ws=""
if pane=$(ralph_hero_live_pane "$REPO"); then
  if _pane_in_workspace "$pane" "$ws_id"; then
    hero_pane="$pane"
  else
    # The live-sitting carve-out: a hero still seated in a legacy dispatch
    # space is left alone (see header — pane move would re-id the pane).
    for lw in $legacy_ids; do
      if _pane_in_workspace "$pane" "$lw"; then
        hero_pane="$pane" hero_state="live-legacy" hero_legacy_ws="$lw"
        break
      fi
    done
  fi
fi
if [ -z "$hero_pane" ]; then
  # A new tab in the main space (not a split: the space's existing panes are
  # the operator's own — this seat arrives beside them, never over them).
  # hero.sh stamps the record from inside the pane.
  out=$(ralph_herdr_call plugin_pane_opened plugin pane open \
    --plugin "${HERDR_PLUGIN_ID:-ralph-herdr}" --entrypoint hero \
    --workspace "$ws_id" --placement tab --cwd "$src" --no-focus) ||
    die "could not open the hero pane in the main workspace ($(ralph_herdr_err_code "${out:-}" || true)) — the space is up (workspace $ws_id); see the diagnostic above"
  # Probed on 0.8.x: the opened pane rides .plugin_pane.pane.pane_id.
  hero_pane=$(jq -r '.plugin_pane.pane.pane_id // empty' <<<"$out")
  hero_state="opened"
fi

# The default contract is ensure-only. The attended day path opts into one
# final focus after the hero pane has been proven live or successfully opened,
# avoiding an intermediate jump while the rest of the surface is prepared.
if [ "$focus" = true ]; then
  "$HERDR" plugin pane focus "$hero_pane" >/dev/null ||
    die "could not focus the hero pane $hero_pane — the dispatch seat is up but the day surface could not enter it"
fi

# The legacy note — the migration half GH-2246 owes live machines. Never a
# close: the space's root shell is the operator's scratch surface.
if [ -n "$legacy_ids" ]; then
  if [ "$hero_state" = "live-legacy" ]; then
    echo "note: the live hero sitting is still in legacy dispatch workspace $hero_legacy_ws ($addr) — left alone; when it ends, re-run \`dispatch up\` to seat the hero in the main workspace, then close the legacy space by hand (herdr workspace close $hero_legacy_ws)" >&2
  else
    echo "note: legacy dispatch workspace(s) $legacy_ids ($addr) still stand — the seat lives in the repo's main workspace now; close them by hand (herdr workspace close <id>)" >&2
  fi
fi

# 4. Heartbeat (D7.2), best-effort: running doctor's named remedy IS a
# heartbeat write.
if hb_ledger=$(ralph_ledger_path "$REPO" 2>/dev/null); then
  ralph_heartbeat_write "$hb_ledger" dispatch-up "space-$space_state hero-$hero_state" || true
fi

echo "dispatch up: $addr — workspace $ws_id ($space_state), hero pane ${hero_pane:-?} ($hero_state)"

# 5. The roster — best-effort by contract: the seat is up either way, and a
# failed read may not fail the command that just healed it.
"$BOARD" roster 2>&1 || echo "roster read failed — the space is up; run \`board roster\` by hand"
