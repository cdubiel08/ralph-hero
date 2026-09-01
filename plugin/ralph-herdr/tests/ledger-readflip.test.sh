#!/usr/bin/env bash
# ledger-readflip.test.sh — tests for ledger.sh's read path (GH-2309 phase C,
# re-scoped by GH-2311 phase D: a present tape is served FULL STOP; the
# legacy JSONL serves only when no tape exists, behind a one-line
# deprecation). TAP-ish, like its siblings.
#
#   bash plugin/ralph-herdr/tests/ledger-readflip.test.sh
#
# What is pinned here:
#   1. sqlite-served vs jsonl-served output is BYTE-IDENTICAL per helper, on
#      the same ledger (phase C's equivalence pin, unchanged). The proof that
#      sqlite is actually serving is a mid-file JSONL mutation: with a tape
#      present the mutation is invisible to every read.
#   2. a PRESENT but unservable tape — unreadable file, future user_version —
#      is an ERROR: empty output (never the frozen JSONL), a stamp for
#      doctor, one stderr line. NO fallback.
#   3. no tape at all → the legacy JSONL path still works, with ONE stderr
#      deprecation line per process naming ledger-convert.sh; exit codes
#      unchanged.
#   4. fresh sqlite-only machines (no jsonl file) read normally.
#   5. the exit-reason legacy-alias mapping (ralph_ledger_reason_canon).
#
# Pure-file tests: fixtures under $TMP, no server, no real ledger. Needs
# sqlite3 and jq. bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../scripts"
CONVERT="$SCRIPTS/ledger-convert.sh"
PARITY="$SCRIPTS/doctor-parity.sh"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-lflip-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}
has() { # DESC PATTERN TEXT
  if printf '%s\n' "$3" | grep -q "$2"; then ok "$1"; else not_ok "$1 — no match for '$2' in: $3"; fi
}

# shellcheck source=../scripts/ledger.sh
. "$SCRIPTS/ledger.sh"

L="$TMP/ledger.jsonl"
DB="$TMP/ledger.sqlite"
STAMP="$TMP/ledger-fallback.last"
export RALPH_HERDR_LEDGER="$L"

# ── fixture: a legacy JSONL exercising every reduce the helpers run ──────────
# Written directly (appends build a TAPE since phase D — the legacy read path
# under test only exists for a file that predates the writer flip).
printf '%s\n' \
  '{"ts":"t1","ev":"spawn","agent_ref":"w1-a#e1","pane_id":"p1","shell_pid":101,"checkout":"/co/a","tokens":{"parent":"","state":"working","issue":"1","harness":"claude","address":"acme/w1-a"},"session":"s1"}' \
  '{"ts":"t2","ev":"spawn","agent_ref":"w2-b#e2","pane_id":"p2","tokens":{"parent":"w1-a#e1","issue":"2"},"session":"s2"}' \
  '{"ts":"t3","ev":"state","agent_ref":"w1-a#e1","state":"blocked","session":"s1"}' \
  '{"ts":"t4","ev":"discover","agent_ref":"w3-c#e3","pane_id":"p3","via":"reconcile","session":"s1"}' \
  '{"ts":"t5","ev":"adopt","agent_ref":"w3-c#e3","parent":"w1-a#e1","prev_parent":"w2-b#e2","session":"s1"}' \
  '{"ts":"t6","ev":"exit","agent_ref":"w2-b#e2","reason":"pane_exited","pane_id":"p2","session":"s1"}' >"$L"

# each_helper — one line of output per helper invocation, all captured
# together so the equivalence comparison is a single byte-compare.
each_helper() {
  ralph_ledger_open_agents
  ralph_ledger_open_ref "w1-a"
  ralph_ledger_open_rows
  ralph_ledger_open_for_pane "p1"
  ralph_ledger_open_sessions
  ralph_ledger_last "w1-a#e1"
  ralph_ledger_children "w1-a#e1"
  _ralph_ledger_latest_parent "w3-c#e3"
  _ralph_ledger_latest_pane "w1-a#e1"
  _ralph_ledger_latest_state "w1-a#e1"
  _ralph_ledger_latest_tokens "w1-a#e1"
  _ralph_ledger_latest_address "w1-a#e1"
  _ralph_ledger_latest_shell_pid "w1-a#e1"
  _ralph_ledger_latest_checkout "w1-a#e1"
  _ralph_ledger_latest_issue "w1-a#e1"
}

# ── 1. the legacy path: serves, and warns exactly once per process ───────────
DEPR=$(bash -c ". '$SCRIPTS/ledger.sh'; $(declare -f each_helper)
each_helper >/dev/null
each_helper >/dev/null" 2>&1)
is "legacy path: deprecation line fires exactly once per invocation" "1" \
  "$(printf '%s\n' "$DEPR" | grep -c 'deprecated')"
has "the deprecation names ledger-convert.sh" "ledger-convert.sh" "$DEPR"
JSONL_OUT=$(each_helper 2>/dev/null)
has "jsonl-served: open set has the live refs" "w3-c#e3" "$JSONL_OUT"
rm -f "$STAMP"

# ── 2. equivalence: jsonl-served then sqlite-served, byte-identical ──────────
bash "$CONVERT" "$L" >/dev/null 2>&1
is "converter built the tape" "1" "$(sqlite3 "$DB" 'PRAGMA user_version;')"
SQLITE_OUT=$(each_helper 2>"$TMP/err2")
is "sqlite-served output is byte-identical to jsonl-served" "$JSONL_OUT" "$SQLITE_OUT"
is "sqlite-served reads keep stderr clean" "" "$(cat "$TMP/err2")"
[ -f "$STAMP" ] && not_ok "tape reads leave no stamp" || ok "tape reads leave no stamp"

# Proof sqlite is actually serving: mutate a MID-FILE jsonl line — with a
# present tape the frozen jsonl must be invisible to every read.
cp "$L" "$L.orig"
awk 'NR==3 {sub(/blocked/, "MUTATED")} {print}' "$L.orig" >"$L"
is "the mutation landed in the jsonl" "1" "$(grep -c MUTATED "$L")"
MUT_OUT=$(each_helper 2>/dev/null)
is "reads still serve the ORIGINAL facts (the tape is answering)" "$JSONL_OUT" "$MUT_OUT"
cp "$L.orig" "$L"

# ── 3. a PRESENT but unservable tape is an ERROR, never the frozen jsonl ─────
check_error() { # DESC WHY_PATTERN
  local out err why
  out=$(each_helper 2>"$TMP/err")
  err=$(cat "$TMP/err")
  is "$1: output is EMPTY (never the frozen jsonl)" "" "$out"
  has "$1: stderr names the refusal" "NOT serving the frozen JSONL" "$err"
  if [ -f "$STAMP" ]; then
    why=$(jq -r '.why // ""' "$STAMP")
    has "$1: stamp records why" "$2" "$why"
    is "$1: stamp records a ts" "0" "$(jq -r '.ts' "$STAMP" | grep -cv '^....-..-..T' | tr -d ' ')"
  else
    not_ok "$1: no stamp written"
    not_ok "$1: no stamp written (ts)"
  fi
  rm -f "$STAMP"
}

if [ "$(id -u)" = "0" ]; then
  ok "unreadable tape: skipped (running as root)"
else
  chmod 000 "$DB"
  check_error "unreadable tape" "user_version"
  chmod 644 "$DB"
fi

sqlite3 "$DB" 'PRAGMA user_version=2;'
check_error "future user_version" "user_version='2'"
sqlite3 "$DB" 'PRAGMA user_version=1;'

# ── 4. sqlite-only machine (no jsonl at all) reads normally ──────────────────
mv "$L" "$L.away"
ONLY_OUT=$(each_helper 2>"$TMP/err4")
is "sqlite-only: output equals the served baseline" "$JSONL_OUT" "$ONLY_OUT"
is "sqlite-only: stderr is clean (no deprecation — nothing legacy here)" "" "$(cat "$TMP/err4")"
mv "$L.away" "$L"

# ── 5. absent tape AND absent jsonl: empty, silent, rc 0 ─────────────────────
EMPTY_OUT=$(RALPH_HERDR_LEDGER="$TMP/nowhere/ledger.jsonl" bash -c ". '$SCRIPTS/ledger.sh'; ralph_ledger_open_agents" 2>&1); RC=$?
is "no ledger at all: rc 0" "0" "$RC"
is "no ledger at all: empty and silent" "" "$EMPTY_OUT"

# ── 6. doctor-parity renders the stamp ───────────────────────────────────────
OUT=$(bash "$PARITY" 2>&1)
has "doctor-parity: no stamp reads 'no fallback recorded'" "no fallback recorded" "$OUT"
has "doctor-parity: frozen wording on the healthy shape" "jsonl frozen at 6 facts (export-only since" "$OUT"
sqlite3 "$DB" 'PRAGMA user_version=2;'
each_helper >/dev/null 2>&1
sqlite3 "$DB" 'PRAGMA user_version=1;'
OUT=$(bash "$PARITY" 2>&1)
has "doctor-parity: stamp renders age + why" "read fallback .*ago — .*user_version" "$OUT"
rm -f "$STAMP"

# ── 7. the exit-reason legacy-alias mapping ──────────────────────────────────
is "canon: lost → swept-unknown" "swept-unknown" "$(ralph_ledger_reason_canon lost)"
is "canon: pane_exited → pane-exited" "pane-exited" "$(ralph_ledger_reason_canon pane_exited)"
is "canon: pane_closed → pane-closed" "pane-closed" "$(ralph_ledger_reason_canon pane_closed)"
is "canon: restart_killed → restart-killed" "restart-killed" "$(ralph_ledger_reason_canon restart_killed)"
is "canon: enum values pass through" "swept-unknown" "$(ralph_ledger_reason_canon swept-unknown)"
is "canon: crashed passes through" "crashed" "$(ralph_ledger_reason_canon crashed)"
is "canon: empty passes through" "" "$(ralph_ledger_reason_canon '')"

# ── 8. historical rows are never rewritten by the flip ───────────────────────
is "the frozen jsonl still spells the legacy fixture reason verbatim" "1" \
  "$(grep -c '"reason":"pane_exited"' "$L")"
is "the tape payload spells it verbatim too" "1" \
  "$(sqlite3 "$DB" "SELECT count(*) FROM facts WHERE payload LIKE '%\"reason\":\"pane_exited\"%';")"

echo "# $pass passed, $fail failed of $n"
[ "$fail" -eq 0 ] || exit 1
exit 0
