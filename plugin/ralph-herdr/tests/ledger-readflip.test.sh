#!/usr/bin/env bash
# ledger-readflip.test.sh — tests for the sqlite read flip inside ledger.sh's
# read helpers (GH-2309, phase C). TAP-ish, like its siblings.
#
#   bash plugin/ralph-herdr/tests/ledger-readflip.test.sh
#
# What is pinned here:
#   1. sqlite-served vs jsonl-served output is BYTE-IDENTICAL per helper, on
#      the same ledger. The proof that sqlite is actually serving is a
#      mid-file JSONL mutation that preserves the last line: the tail probe
#      passes, so an sqlite-served read keeps answering from the ORIGINAL
#      facts while a jsonl-served read would see the mutation.
#   2. Every fallback trigger — absent db, unreadable db, future
#      user_version, parity-probe miss — actually falls back to the JSONL
#      path AND stamps ledger-fallback.last ({ts, why}), with stderr clean.
#   3. The exit-reason legacy-alias mapping (ralph_ledger_reason_canon).
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

# ── fixture: a ledger exercising every reduce the helpers run ────────────────
ralph_ledger_append '{"ts":"t1","ev":"spawn","agent_ref":"w1-a#e1","pane_id":"p1","shell_pid":101,"checkout":"/co/a","tokens":{"parent":"","state":"working","issue":"1","harness":"claude","address":"acme/w1-a"},"session":"s1"}'
ralph_ledger_append '{"ts":"t2","ev":"spawn","agent_ref":"w2-b#e2","pane_id":"p2","tokens":{"parent":"w1-a#e1","issue":"2"},"session":"s2"}'
ralph_ledger_append '{"ts":"t3","ev":"state","agent_ref":"w1-a#e1","state":"blocked"}'
ralph_ledger_append '{"ts":"t4","ev":"discover","agent_ref":"w3-c#e3","pane_id":"p3","via":"reconcile","session":"s1"}'
ralph_ledger_append '{"ts":"t5","ev":"adopt","agent_ref":"w3-c#e3","parent":"w1-a#e1","prev_parent":"w2-b#e2"}'
ralph_ledger_append '{"ts":"t6","ev":"exit","agent_ref":"w2-b#e2","reason":"pane_exited","pane_id":"p2"}'

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

# ── 1. equivalence: jsonl-served then sqlite-served, byte-identical ──────────
JSONL_OUT=$(each_helper 2>/dev/null)
has "jsonl-served: open set has the three live refs" "w3-c#e3" "$JSONL_OUT"
rm -f "$STAMP"

bash "$CONVERT" "$L" >/dev/null 2>&1
is "converter built the sqlite sibling" "1" "$(sqlite3 "$DB" 'PRAGMA user_version;')"
SQLITE_OUT=$(each_helper 2>/dev/null)
is "sqlite-served output is byte-identical to jsonl-served" "$JSONL_OUT" "$SQLITE_OUT"
[ -f "$STAMP" ] && not_ok "eligible reads leave no fallback stamp" || ok "eligible reads leave no fallback stamp"

# Proof sqlite is actually serving: mutate a MID-FILE jsonl line, preserving
# the last line — the tail probe still passes, so reads keep answering from
# the original facts. (This is also the probe's honestly-stated limit.)
cp "$L" "$L.orig"
awk 'NR==3 {sub(/blocked/, "MUTATED")} {print}' "$L.orig" >"$L"
is "the mutation landed in the jsonl" "1" "$(grep -c MUTATED "$L")"
MUT_OUT=$(each_helper 2>/dev/null)
is "reads still serve the ORIGINAL facts (sqlite is answering)" "$JSONL_OUT" "$MUT_OUT"
[ -f "$STAMP" ] && not_ok "mid-file mutation: probe passed, no stamp" || ok "mid-file mutation: probe passed, no stamp"
cp "$L.orig" "$L"

# ── 2. fallback triggers: each falls back AND stamps, stderr clean ───────────
check_fallback() { # DESC WHY_PATTERN
  local out err why
  out=$(each_helper 2>"$TMP/err")
  err=$(cat "$TMP/err")
  is "$1: output equals the jsonl-served baseline" "$JSONL_OUT" "$out"
  is "$1: stderr is clean" "" "$err"
  if [ -f "$STAMP" ]; then
    why=$(jq -r '.why // ""' "$STAMP")
    has "$1: stamp records why" "$2" "$why"
    is "$1: stamp records a ts" "0" "$(jq -r '.ts' "$STAMP" | grep -cv '^....-..-..T' | tr -d ' ')"
  else
    not_ok "$1: no fallback stamp written"
    not_ok "$1: no fallback stamp written (ts)"
  fi
  rm -f "$STAMP"
}

mv "$DB" "$DB.away"
check_fallback "absent db" "absent"
mv "$DB.away" "$DB"

if [ "$(id -u)" = "0" ]; then
  ok "unreadable db: skipped (running as root)"
else
  chmod 000 "$DB"
  check_fallback "unreadable db" "user_version"
  chmod 644 "$DB"
fi

sqlite3 "$DB" 'PRAGMA user_version=2;'
check_fallback "future user_version" "user_version='2'"
sqlite3 "$DB" 'PRAGMA user_version=1;'

# probe miss: a raw append that bypasses the dual-write sink — the jsonl tail
# is now a line the sqlite side has never seen.
echo '{"ts":"t7","ev":"state","agent_ref":"w1-a#e1","state":"working","session":"s1"}' >>"$L"
JSONL_OUT=$(RALPH_HERDR_LEDGER="$L" bash -c ". '$SCRIPTS/ledger.sh'; $(declare -f each_helper); rm -f '$STAMP'; each_helper" 2>/dev/null)
# ^ re-derive the baseline over the grown jsonl in a fresh shell (the stamp
# from that derivation is removed inside it; the outer capture below is the
# assertion run).
check_fallback "parity probe miss" "probe miss"
bash "$CONVERT" "$L" >/dev/null 2>&1
rm -f "$STAMP"

# ── 3. doctor-parity renders the stamp ───────────────────────────────────────
OUT=$(bash "$PARITY" 2>&1)
has "doctor-parity: no stamp reads 'no fallback recorded'" "no fallback recorded" "$OUT"
has "doctor-parity: still in parity" "in parity" "$OUT"
mv "$DB" "$DB.away"
each_helper >/dev/null 2>&1
mv "$DB.away" "$DB"
OUT=$(bash "$PARITY" 2>&1)
has "doctor-parity: stamp renders age + why" "read fallback .*ago — .*absent" "$OUT"
rm -f "$STAMP"

# ── 4. the exit-reason legacy-alias mapping ──────────────────────────────────
is "canon: lost → swept-unknown" "swept-unknown" "$(ralph_ledger_reason_canon lost)"
is "canon: pane_exited → pane-exited" "pane-exited" "$(ralph_ledger_reason_canon pane_exited)"
is "canon: pane_closed → pane-closed" "pane-closed" "$(ralph_ledger_reason_canon pane_closed)"
is "canon: restart_killed → restart-killed" "restart-killed" "$(ralph_ledger_reason_canon restart_killed)"
is "canon: enum values pass through" "swept-unknown" "$(ralph_ledger_reason_canon swept-unknown)"
is "canon: crashed passes through" "crashed" "$(ralph_ledger_reason_canon crashed)"
is "canon: empty passes through" "" "$(ralph_ledger_reason_canon '')"

# ── 5. historical rows are never rewritten by the flip ───────────────────────
is "the jsonl still spells the legacy fixture reason verbatim" "1" \
  "$(grep -c '"reason":"pane_exited"' "$L")"
is "the sqlite payload spells it verbatim too" "1" \
  "$(sqlite3 "$DB" "SELECT count(*) FROM facts WHERE payload LIKE '%\"reason\":\"pane_exited\"%';")"

echo "# $pass passed, $fail failed of $n"
[ "$fail" -eq 0 ] || exit 1
exit 0
