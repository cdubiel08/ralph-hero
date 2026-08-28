#!/usr/bin/env bash
# dispatch-up.sh — DISPATCH UP (GH-2213, unit E of #2208; design record
# thoughts/shared/plans/2026-08-28-herd-topology-design.md, D3.1 — an
# operator DEVIATION: no rota, ever).
#
# One command ensures the named dispatch seat exists and is staffed:
#
#   1. the `<repo>/dispatch` WORKSPACE exists (label from `board name
#      dispatch` — the address is the board's to mint, GH-2209; this script
#      never spells the grammar itself)
#   2. the HERO pane is up in it (the attended face, GH-2182 — still
#      never-load-bearing, see hero.sh)
#   3. the roster prints (best-effort — `board roster`, unit C)
#
# RE-RUN HEALS, NEVER REFUSES (D3.1): a standing space is reused, a live
# hero sitting is left alone, a deleted space is recreated, a dead hero is
# reopened. Liveness is the cockpit's GH-2074 two-fact record
# (cockpit-pane.sh: pid alive AND pane in the live snapshot), scoped to the
# dispatch workspace — a hero standing in some OTHER workspace does not
# satisfy "the hero pane is up in the dispatch space", so one is opened
# where it belongs (two heroes are two complete disposable sessions, the
# stated non-conflict). Every unreadable liveness path fails OPEN toward
# opening a pane: a duplicate disposable pane is the cheap direction.
#
# IT ARMS NOTHING SCHEDULED. The unattended half of the dispatch lane is
# the event lane (watch-event.sh + heal.sh, GH-2212/D1.2) — this command
# installs no cron, no launchd, no rota. What it does stamp is the
# dispatch heartbeat (D7.2, best-effort): doctor's `dispatch-heartbeat`
# advisory names `dispatch up` as its remedy, so running the remedy is
# itself a heartbeat write.
#
# Failure directions, stated: the address read and the workspace read fail
# CLOSED (an unreadable workspace list cannot prove the space is absent —
# creating a second `<repo>/dispatch` is the one duplicate this command
# exists to prevent); the hero-liveness read and the roster print fail OPEN
# (their cost is a duplicate disposable pane / a missing printout).
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

case "${1-}" in
  -h | --help)
    trap - EXIT
    cat <<'EOF'
usage: dispatch-up.sh

Ensure the <repo>/dispatch workspace exists and the hero pane is up in it,
then print the roster. Idempotent: re-run heals (reopen space/pane) rather
than refusing. Arms nothing scheduled — the unattended half of dispatch is
the event lane (watch-event.sh).

Knobs: RALPH_ALLOW_API_BILLING (the hero session bills like any spawn).
EOF
    exit 0
    ;;
  "") ;;
  *) die "unknown argument '${1-}' (takes none; --help)" ;;
esac

# The hero session this stands up bills like any spawned one — refuse before
# creating anything, so a billing refusal leaves no half-built space.
billing_guard

# 1. The seat's NAME, minted by the board (GH-2209 — no second grammar).
addr=$("$BOARD" name dispatch --json 2>/dev/null | jq -r '.address // empty' 2>/dev/null) || addr=""
[ -n "$addr" ] || die "cannot derive the dispatch address (\`board name dispatch\` failed) — the space's name is the board's to mint; is the board configured here?"

src=$(ralph_worktree_source_dir)

# 2. The workspace, found by its canonical label — fail-closed: an unreadable
# list cannot prove absence, and a second dispatch space is the duplicate
# this command exists to prevent.
ws_out=$(ralph_herdr_call workspace_list workspace list) ||
  die "cannot read the workspace list ($(ralph_herdr_err_code "${ws_out:-}" || true)) — refusing to guess whether $addr already exists"
ws_id=$(jq -r --arg l "$addr" '[.workspaces[] | select(.label == $l)][0].workspace_id // empty' <<<"$ws_out" 2>/dev/null) || ws_id=""
n_match=$(jq -r --arg l "$addr" '[.workspaces[] | select(.label == $l)] | length' <<<"$ws_out" 2>/dev/null) || n_match=0
case "$n_match" in '' | *[!0-9]*) n_match=0 ;; esac
if [ "$n_match" -gt 1 ]; then
  echo "note: $n_match workspaces carry the label $addr — healing into the first ($ws_id); close the extras by hand" >&2
fi

space_state="standing"
if [ -z "$ws_id" ]; then
  # No worktree, no branch: dispatch reads the board and writes nothing, so
  # the space sits on the source checkout (the lead's own precedent,
  # work-team.sh). --no-focus: the summary + roster print HERE, in the
  # invoker's terminal — yanking focus mid-read would bury them.
  out=$(ralph_herdr_call workspace_created workspace create --cwd "$src" --label "$addr" --no-focus) ||
    die "workspace create failed for $addr ($(ralph_herdr_err_code "${out:-}" || true)) — see the diagnostic above"
  ws_id=$(jq -r '.workspace.workspace_id // empty' <<<"$out")
  [ -n "$ws_id" ] || die "no workspace id in the create response for $addr"
  space_state="created"
fi

# 3. The hero pane, healed into THIS space. The record proves a live sitting
# exists; pane list scopes it to the dispatch workspace. Both reads fail
# OPEN — an unreadable answer opens a pane, and a duplicate disposable pane
# is the stated cheap direction.
# The record is read under the same scope key hero.sh stamps it with ($REPO,
# the pane's cwd) — both resolve to the board's owner/repo, but mirroring the
# writer keeps the pair from drifting.
hero_pane="" hero_state="live"
if pane=$(ralph_hero_live_pane "$REPO"); then
  panes=$(ralph_herdr_call pane_list pane list --workspace "$ws_id" 2>/dev/null) || panes=""
  if [ -n "$panes" ] &&
    jq -e --arg p "$pane" '[.panes[]? | select(.pane_id == $p)] | length > 0' <<<"$panes" >/dev/null 2>&1; then
    hero_pane="$pane"
  fi
fi
if [ -z "$hero_pane" ]; then
  # A new tab in the dispatch space (not a split: the space's root pane is a
  # plain shell — a deliberate leftover, the human's scratch surface beside
  # the sitting). hero.sh stamps the record from inside the pane.
  out=$(ralph_herdr_call plugin_pane_opened plugin pane open \
    --plugin "${HERDR_PLUGIN_ID:-ralph-herdr}" --entrypoint hero \
    --workspace "$ws_id" --placement tab --cwd "$src" --focus) ||
    die "could not open the hero pane in $addr ($(ralph_herdr_err_code "${out:-}" || true)) — the space is up (workspace $ws_id); see the diagnostic above"
  # Probed on 0.8.x: the opened pane rides .plugin_pane.pane.pane_id.
  hero_pane=$(jq -r '.plugin_pane.pane.pane_id // empty' <<<"$out")
  hero_state="opened"
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
