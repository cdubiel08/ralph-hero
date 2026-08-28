#!/usr/bin/env bash
# fleet-send.test.sh — standalone tests for scripts/fleet-send.sh (TAP-ish).
#
#   bash plugin/ralph-herdr/tests/fleet-send.test.sh   # exits 0 pass, 1 fail
#
# The subject is the GH-2216 role-agnostic to-address (--lead/--dispatch
# resolved through the board's phone book, refuse on zero-or-many, the C9
# board fallback named) and the versioned KIND stamp — plus the pre-existing
# lead --wait strip. Delivery rides fake-herdr.sh; resolution rides
# fake-board.sh. bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_SEND="$SCRIPT_DIR/../scripts/fleet-send.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

BIN="$TMP/bin"
FIX="$TMP/fixtures"
BLOG="$TMP/board.log"
HLOG="$TMP/herdr.log"
mkdir -p "$BIN" "$FIX"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-board.sh" >"$BIN/board"
chmod +x "$BIN/board"

run() {
  # run [ENV=VAL ...] -- ARGS...  — invoke fleet-send.sh with the shimmed
  # board + herdr; captures OUT/ERR/RC and resets both invocation logs.
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    envs+=("$1")
    shift
  done
  [ "${1-}" = "--" ] && shift
  : >"$BLOG"
  : >"$HLOG"
  OUT=$(env RALPH_HERDR_REPO="$TMP" RALPH_HERDR_BOARD="$BIN/board" \
    FAKE_BOARD_FIXTURES="$FIX" FAKE_BOARD_LOG="$BLOG" \
    HERDR_BIN_PATH="$SCRIPT_DIR/fake-herdr.sh" \
    FAKE_HERDR_FIXTURES="$FIX" FAKE_HERDR_LOG="$HLOG" \
    RALPH_HERDR_LEAD= "${envs[@]+"${envs[@]}"}" \
    bash "$FLEET_SEND" "$@" 2>"$TMP/err")
  RC=$?
  ERR=$(cat "$TMP/err")
}

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
assert_rc()      { if [ "$RC" -eq "$2" ]; then ok "$1"; else not_ok "$1 — rc $RC, wanted $2"; fi; }
assert_out_has() { if printf '%s' "$OUT" | grep -qF "$2"; then ok "$1"; else not_ok "$1 — stdout missing '$2': $OUT"; fi; }
assert_err_has() { if printf '%s' "$ERR" | grep -qF "$2"; then ok "$1"; else not_ok "$1 — stderr missing '$2': $ERR"; fi; }
assert_hlog_has() { if grep -qF "$2" "$HLOG"; then ok "$1"; else not_ok "$1 — herdr log missing '$2': $(cat "$HLOG")"; fi; }

# ── literal agent: the pre-existing lane, now with the versioned kind ───────
run -- w42-fake status -m "rebased; attesting next"
assert_rc "literal agent delivers" 0
assert_out_has "delivery reported" "delivered to w42-fake"
assert_hlog_has "KIND is stamped :v1 by the wrapper (D2.1)" "KIND: status:v1"
if [ ! -s "$BLOG" ]; then
  ok "a literal agent name never consults the board"
else
  not_ok "a literal agent name never consults the board — log: $(cat "$BLOG")"
fi

# ── --lead EPIC: enumerate via the phone book, one live → deliver ───────────
run -- --lead 2208 brief -m "frontier check please"
assert_rc "--lead EPIC resolves the one live lead" 0
assert_out_has "delivered to the grammar-matched lead" "delivered to o2208-fake"
assert_hlog_has "brief rides the same versioned protocol" "KIND: brief:v1"
if grep -q "who lead 2208" "$BLOG"; then
  ok "resolution delegated to board who lead (one grammar owner)"
else
  not_ok "resolution delegated to board who lead — log: $(cat "$BLOG")"
fi

# ── --lead EPIC: zero live → exit 5, the C9 lane named ──────────────────────
printf '{"repo":"fake-repo","issue":7,"epic":7,"address":"fake-repo/t7-fake/o7-fake","live":[],"agentsEvaluated":true}\n' >"$FIX/who.lead.7.json"
run -- --lead 7 brief -m x
assert_rc "no live lead is exit 5" 5
assert_err_has "refusal says no live pane matched" "no live lead for GH-7"
assert_err_has "the durable C9 lane is named (D2.3)" "human-needed"
assert_err_has "and the respawn remedy" "work-team.sh 7"

# ── --lead EPIC: two live → exit 6, both named, no guess ────────────────────
printf '{"repo":"fake-repo","issue":9,"epic":9,"address":"a","live":[{"name":"o9-one","pane":"p1","status":"idle"},{"name":"o9-two","pane":"p2","status":"idle"}],"agentsEvaluated":true}\n' >"$FIX/who.lead.9.json"
run -- --lead 9 brief -m x
assert_rc "ambiguous lead is exit 6" 6
assert_err_has "both live names surfaced" "o9-one, o9-two"
assert_err_has "instruction is name-one, never guess" "never guess"

# ── --lead bare: the spawn-stamped chain of command, board not consulted ────
run RALPH_HERDR_LEAD=o5-stamped -- --lead ack -m "seen"
assert_rc "--lead with \$RALPH_HERDR_LEAD delivers" 0
assert_out_has "the stamped address is used verbatim" "delivered to o5-stamped"
if [ ! -s "$BLOG" ]; then
  ok "the stamped lead skips the phone book (D4.2 — knowledge the spawn already handed over)"
else
  not_ok "the stamped lead skips the phone book — log: $(cat "$BLOG")"
fi

run -- --lead ack -m x
assert_rc "--lead bare without the stamp is a usage error" 64
assert_err_has "refusal names the missing epic and the stamp" "RALPH_HERDR_LEAD"

# ── --dispatch: token-stamped seat, and the D5.1 fallback ───────────────────
run -- --dispatch question -m "cap raise?"
assert_rc "--dispatch resolves the one live seat" 0
assert_out_has "delivered to the dispatch seat" "delivered to hero-fake"

printf '{"repo":"fake-repo","address":"fake-repo/dispatch","live":[],"agentsEvaluated":true}\n' >"$FIX/who.dispatch.json"
run -- --dispatch question -m x
assert_rc "no live dispatch seat is exit 5" 5
assert_err_has "the durable address is the board (D5.1)" "durable address IS the board"
rm -f "$FIX/who.dispatch.json"

# ── --wait is stripped on role targets (the standing-seat deadlock) ─────────
run -- --lead 2208 brief -m x --wait 500
assert_rc "--lead with --wait still delivers" 0
assert_err_has "--wait stripped, loudly" "stripped"

# ── verb validation survives the new parse ──────────────────────────────────
run -- w42-fake STATUS -m x
assert_rc "uppercase verb refused" 1

echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
