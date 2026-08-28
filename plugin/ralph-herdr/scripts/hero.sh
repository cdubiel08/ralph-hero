#!/usr/bin/env bash
# hero.sh — cockpit pane: /ralph:hero, the ATTENDED face of the dispatch lane
# (GH-2182, unit F of #2176; design decision 6 in thoughts/shared/plans/
# 2026-08-26-teams-dispatch-inbox-design.md).
#
# One touch brings up a session the human sits AT: this pane execs an
# interactive harness whose first input is the /ralph:hero skill, which
# rehydrates from `board brief` + `board who` + `board inbox` and stands as
# the human's single point of contact for the sitting. The authorities it
# exercises are /ralph:dispatch's — that skill text is the normative record;
# nothing here grants anything.
#
# NEVER LOAD-BEARING (the unit's own bar): hero takes no claim, holds no
# lock, owns no worktree, and is deliberately NOT a herdr agent — no `agent
# start`, no ledger row, no watcher lifecycle, no C8 tokens. Killing this
# pane loses nothing; the next invoke re-derives everything from the board.
# Exec-ing the harness directly instead of going through spawn_work_session
# is that decision in code: registering hero would hand reconcile a session
# whose disappearance is NORMAL, and give the one surface defined by its
# disposability a record something could start to lean on.
#
# The work-these template: TOML action + this script, no build step. The
# hero ACTION still has no focus-or-open — a human who clicks it twice can
# see the pane they already have, and a second hero is two complete,
# disposable sessions, not a conflict. What GH-2213 (dispatch up) added is
# the cockpit's GH-2074 record (hero.pane.json, cockpit-pane.sh) so that
# `dispatch up`'s IDEMPOTENT re-run can tell a live sitting from a dead one
# without stacking heroes. The record stays inside the never-load-bearing
# bar: display-only, read by dispatch-up.sh alone, fail-open on every
# unreadable path (the cost is a duplicate disposable pane), and invisible
# to reconcile — it is not the ledger and carries no lifecycle.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

trap hold_pane EXIT

# The session this pane starts bills like any spawned one; same guard, same
# explicit opt-in (RALPH_ALLOW_API_BILLING=true) as every sibling action.
billing_guard

# Panes inherit the SERVER's environment (lib.sh's BOARD resolution note), so
# the harness may be missing from a PATH that a login shell would have. Probe
# before exec: a failed exec under `set -e` would fire hold_pane with only a
# shell error to read.
command -v claude >/dev/null 2>&1 ||
  die "no 'claude' on this pane's PATH — herdr panes inherit the server's environment; restart the herdr server from a shell where 'claude' resolves"

# The exec'd session is herdr-hosted by construction (HERDR_PANE_ID is
# exported into plugin panes — measured, see cockpit-pane.sh), so say so the
# way agent panes do: the skill reads HERDR_ENV to know the cockpit surfaces
# (herdr agent list, pane tokens) are available.
export HERDR_ENV=1

# Dispatch heartbeat (GH-2212, D7.2): a hero sitting IS the attended half of
# the dispatch lane, so opening one stamps the heartbeat doctor's advisory
# reads. Best-effort by contract — a failed stamp never blocks the sitting.
# shellcheck source=heal.sh
. "$SCRIPT_DIR/heal.sh"
if hb_ledger=$(ralph_ledger_path "$REPO" 2>/dev/null); then
  ralph_heartbeat_write "$hb_ledger" hero sitting || true
fi

# The GH-2074-style record (header: what it is and is not). $$ survives the
# exec below, so the pid recorded here is the harness's own.
# shellcheck source=cockpit-pane.sh
. "$SCRIPT_DIR/cockpit-pane.sh"
ralph_hero_pane_stamp "$REPO" "${HERDR_PANE_ID:-}" $$

exec claude "/ralph:hero"
