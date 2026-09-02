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
# lock, owns no worktree, and has no ledger row or watcher lifecycle. Killing
# this pane loses nothing; the next invoke re-derives everything from the
# board. Exec-ing the harness directly instead of going through
# spawn_work_session is that decision in code: ledgering hero would hand
# reconcile a session whose disappearance is NORMAL, and give the one surface
# defined by its disposability a record something could start to lean on.
# What GH-2315 added — a NAME on both messaging planes and the `address` C8
# token — stays inside the bar, because the name deliberately does not parse
# as grammar B and reconcile/watch-event admit agents by that parse: the seat
# is messageable live, and still invisible to every lifecycle sweep (see the
# seat-name section below).
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
ralph_plugin_freshness_notice

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

# ── The seat's derived agent name (GH-2315) ──────────────────────────────────
# Operator decision 2026-09-01: the seat MUST be addressable — a unique,
# derived name leads and peers can always message. The name is minted by
# `board name dispatch` (contracts.ts formatDispatchAgentName — the hyphenated
# form of the GH-2209 address, e.g. ralph-hero-dispatch); reading it here
# instead of rebuilding it keeps one grammar (GH-1807). It serves BOTH planes:
#
#   peer plane   the harness starts under `claude --name <seat>`, so
#                SendMessage/ListAgents carry the derived name and
#                `board peer dispatch` resolves it exactly.
#   herd plane   herdr auto-detects the harness as an anonymous agent; the
#                backgrounded helper below waits for that detection, renames
#                the agent to the same name, and only THEN stamps the
#                `address` C8 token — so a `board who dispatch` live row
#                always carries a promptable name, and fleet-send --dispatch
#                reaches the pane.
#
# The NEVER-LOAD-BEARING bar survives intact, and the name itself is the
# carve-out: it deliberately does not parse as grammar B, and reconcile and
# watch-event admit agents by that parse — so the seat is messageable live but
# never ledgered, never swept, never adopted (the precedent the lane passes
# set before GH-2342 gave them grammar-B names). Still no claim, no lock, no
# worktree, no ledger row; killing the
# pane loses nothing, and a herdr server restart drops the name and token with
# the sitting (there is no ledger record to re-push from — the next
# `dispatch up` re-derives everything, which is the bar working as stated).
#
# Every step is best-effort: a board that cannot answer, a taken name (a
# second hero, or a stale seat), or a herdr refusal costs the CHROME — the
# seat degrades to the anonymous status quo and the sitting proceeds. The
# honest surface is `board who dispatch`, which renders a token-less hero as
# "no live binding visible" rather than pretending.
SEAT_NAME="" SEAT_ADDR=""
if names=$(cd "$REPO" && "$BOARD" name dispatch --json 2>/dev/null); then
  SEAT_NAME=$(printf '%s' "$names" | jq -r '.agentName // empty' 2>/dev/null) || SEAT_NAME=""
  SEAT_ADDR=$(printf '%s' "$names" | jq -r '.address // empty' 2>/dev/null) || SEAT_ADDR=""
fi

if [ -n "$SEAT_NAME" ] && [ -n "${HERDR_PANE_ID:-}" ]; then
  # Rename-then-token, detached: the agent record does not exist until the
  # exec'd harness is detected, so the helper polls for it. Output is
  # discarded — after the exec this shell's streams are the harness's screen,
  # and a warning painted into a TUI is worse than none; the observable truth
  # lives in `board who dispatch`. Rename BEFORE token: a token-stamped
  # dispatch row must always carry a promptable name (fleet-send reads .name),
  # so a refused rename (name taken — a second hero) leaves the token off too.
  # The whole subshell is stream-detached: after the exec these fds are the
  # harness's screen, and a helper that inherits a caller's capture pipe
  # would hold it open for the poll's whole lifetime.
  (
    for _ in $(seq 1 30); do
      sleep 2
      out=$("${HERDR_BIN_PATH:-herdr}" agent get "$HERDR_PANE_ID" 2>/dev/null) || continue
      jq -e '.result.agent' <<<"$out" >/dev/null 2>&1 || continue
      "${HERDR_BIN_PATH:-herdr}" agent rename "$HERDR_PANE_ID" "$SEAT_NAME" || exit 0
      [ -n "$SEAT_ADDR" ] && ralph_tokens_push "$HERDR_PANE_ID" "address=$SEAT_ADDR"
      exit 0
    done
  ) >/dev/null 2>&1 &
  disown 2>/dev/null || true
fi

# --name is newer than some installed harnesses; probe rather than assume — an
# unknown flag would abort the exec and hold the pane on a usage error. Absent
# support degrades the PEER name only; the herd-plane rename above still runs.
if [ -n "$SEAT_NAME" ] && claude --help 2>/dev/null | grep -q -- '--name'; then
  exec claude --name "$SEAT_NAME" "/ralph:hero"
fi
exec claude "/ralph:hero"
