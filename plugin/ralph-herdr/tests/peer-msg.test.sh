#!/usr/bin/env bash
# peer-msg.test.sh — standalone tests for scripts/peer-msg.sh (TAP-ish).
#
#   bash plugin/ralph-herdr/tests/peer-msg.test.sh   # exits 0 on pass, 1 on fail
#
# No harness, no herdr: the subject is the DETERMINISTIC half peer-msg.sh
# owns — address resolution delegated to `board peer` (through fake-board.sh),
# the compose grammar, the namespace refusal, and the exit-code contract.
# Nothing here sends anything, which is also the script's own contract.
# bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PEER_MSG="$SCRIPT_DIR/../scripts/peer-msg.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

BIN="$TMP/bin"
FIX="$TMP/fixtures"
LOG="$TMP/board.log"
mkdir -p "$BIN" "$FIX"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-board.sh" >"$BIN/board"
chmod +x "$BIN/board"

run() {
  # run ARGS... — invoke peer-msg.sh with the shimmed board; captures stdout,
  # stderr, rc into globals OUT/ERR/RC and resets the board invocation log.
  : >"$LOG"
  OUT=$(RALPH_HERDR_REPO="$TMP" RALPH_HERDR_BOARD="$BIN/board" \
    FAKE_BOARD_FIXTURES="$FIX" FAKE_BOARD_LOG="$LOG" \
    bash "$PEER_MSG" "$@" 2>"$TMP/err")
  RC=$?
  ERR=$(cat "$TMP/err")
}

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
assert_rc()       { if [ "$RC" -eq "$2" ]; then ok "$1"; else not_ok "$1 — rc $RC, wanted $2"; fi; }
assert_out_has()  { if printf '%s' "$OUT" | grep -qF "$2"; then ok "$1"; else not_ok "$1 — stdout missing '$2': $OUT"; fi; }
assert_err_has()  { if printf '%s' "$ERR" | grep -qF "$2"; then ok "$1"; else not_ok "$1 — stderr missing '$2': $ERR"; fi; }

# ── brief: the enumerate-never-construct happy path ─────────────────────────
run brief 42 question --candidates "feat-42-fake-issue-01,feat-7-other-02" -m "does the walk page closed items?"
assert_rc "brief resolves and composes" 0
assert_out_has "TO is the resolver's answer, never constructed here" "TO: feat-42-fake-issue-01"
assert_out_has "grammar names the kind and verb" "[peer-msg] KIND: brief VERB: question RE: #42"
assert_out_has "free-form body carried" "does the walk page closed items?"
assert_out_has "omitted section prints '-' (nothing vs not-filled-in)" "FILE: -"
assert_out_has "reply instruction rides the body" "transport 'from' address, verbatim"
assert_err_has "sent ≠ read discipline on stderr" "sent; unknown whether read"
assert_err_has "nothing-sent contract stated" "nothing was sent by this script"
assert_err_has "durable-goes-to-board rule stated" "board comment"
if grep -q "peer 42 --candidates" "$LOG"; then
  ok "resolution delegated to board peer (one grammar owner)"
else
  not_ok "resolution delegated to board peer — log: $(cat "$LOG")"
fi

# ── brief: candidates on stdin ──────────────────────────────────────────────
OUT=$(printf 'feat-42-fake-issue-01\nunrelated-99-thing-03\n' |
  RALPH_HERDR_REPO="$TMP" RALPH_HERDR_BOARD="$BIN/board" FAKE_BOARD_FIXTURES="$FIX" \
    bash "$PEER_MSG" brief 42 finding -m x 2>/dev/null)
RC=$?
assert_rc "brief reads candidates from stdin" 0
assert_out_has "stdin path resolves the same address" "TO: feat-42-fake-issue-01"

# ── brief: no live peer → exit 2, board named as the lane ───────────────────
printf '{"number":7,"peerPrefix":"feat-7-gone","kind":"none"}\n' >"$FIX/peer.7.json"
echo 1 >"$FIX/peer.7.rc"
run brief 7 question --candidates "feat-42-fake-issue-01" -m x
assert_rc "no live peer is exit 2" 2
assert_err_has "refusal says the session is not running" "not running"
assert_err_has "refusal names the board as the lane" "board comment 7"

# ── brief: ambiguous → exit 3, both names surfaced, no guess ────────────────
printf '{"number":9,"peerPrefix":"feat-9-two","kind":"ambiguous","candidates":["feat-9-two-01","feat-9-two-02"]}\n' >"$FIX/peer.9.json"
echo 1 >"$FIX/peer.9.rc"
run brief 9 question --candidates "feat-9-two-01,feat-9-two-02" -m x
assert_rc "ambiguous is exit 3" 3
assert_err_has "both live sessions named" "feat-9-two-01, feat-9-two-02"
assert_err_has "instruction is name-one, never guess" "never guess"

# ── brief: unreadable resolver → exit 1, never a compose ────────────────────
printf 'GraphQL: rate limited\n' >"$FIX/peer.13.json.broken" # keep default json away
printf 'not json at all\n' >"$FIX/peer.13.json"
echo 1 >"$FIX/peer.13.rc"
run brief 13 question --candidates "feat-13-x-01" -m x
assert_rc "resolver failure is exit 1, not a guess" 1
assert_err_has "the resolver's own error is printed" "not json at all"

# ── reply: from-address verbatim, no board call ─────────────────────────────
run reply feat-1888-retire-lineage-02 correction --re 1888 -m "the ledger shows one spawn event, no state events"
assert_rc "reply composes" 0
assert_out_has "TO is the from address, verbatim" "TO: feat-1888-retire-lineage-02"
assert_out_has "reply carries --re context" "RE: #1888"
if [ ! -s "$LOG" ]; then
  ok "reply never consults the board — the transport already answered the addressing question"
else
  not_ok "reply never consults the board — log: $(cat "$LOG")"
fi

# ── reply: herdr agent names are a different namespace — refused ────────────
run reply w1743-fix-claim-race status -m x
assert_rc "herdr w-name refused (the observed GH-1890 §9.1 bounce)" 64
assert_err_has "refusal names the namespace split" "herdr agent name"
assert_err_has "refusal points at the herdr lane" "fleet-send.sh"

run reply o2176-teams-dispatch answer -m x
assert_rc "herdr o-name refused too" 64

# ── verb validation (fleet-send parity) ─────────────────────────────────────
run brief 42 "Question Time" --candidates "feat-42-fake-issue-01"
assert_rc "multi-word verb refused" 64
run brief 42 STATUS --candidates "feat-42-fake-issue-01"
assert_rc "uppercase verb refused" 64

# ── live: the liveness check alone ──────────────────────────────────────────
run live 42 --candidates "feat-42-fake-issue-01"
assert_rc "live resolves" 0
if [ "$OUT" = "feat-42-fake-issue-01" ]; then
  ok "live prints the address alone (script-friendly stdout)"
else
  not_ok "live prints the address alone — got: $OUT"
fi

run live 7 --candidates "feat-42-fake-issue-01"
assert_rc "live on a dead session is exit 2" 2

# ── usage ───────────────────────────────────────────────────────────────────
run frobnicate 42
assert_rc "unknown subcommand is exit 64" 64
run brief 42
assert_rc "brief without a verb is usage" 64

echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
