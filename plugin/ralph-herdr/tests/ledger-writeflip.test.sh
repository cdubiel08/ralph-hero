#!/usr/bin/env bash
# ledger-writeflip.test.sh — tests for the sqlite-only writer inside
# ralph_ledger_append (GH-2311, phase D; supersedes the phase-B dual-write
# suite this file used to be). TAP-ish, like its siblings.
#
#   bash plugin/ralph-herdr/tests/ledger-writeflip.test.sh
#
# What is pinned here:
#   1. absent DB auto-create: a fresh machine starts a fresh tape (schema
#      v1), and a machine with a legacy JSONL gets it ADOPTED into the tape
#      before the first sqlite append (never an empty tape beside history).
#   2. the JSONL never grows on append (frozen; export via --export).
#   3. concurrent appends from separate processes all land, distinct seq.
#   4. the 4096-byte ceiling is lifted.
#   5. failures REFUSE loudly (rc 1) — no sqlite3, future schema — never a
#      silent drop.
#   6. export stays byte-faithful for the adopted prefix, and appended rows
#      carry the converter's own seq-salted phash.
#
# Pure-file tests: fixtures under $TMP, no server, no real ledger. Needs
# sqlite3 and jq. bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../scripts"
CONVERT="$SCRIPTS/ledger-convert.sh"
PARITY="$SCRIPTS/doctor-parity.sh"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-lwflip-test.XXXXXX") || exit 1
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

# Sourcing ledger.sh pulls in ledger-convert.sh's helpers (the writer's own
# dependency chain) — the tests below call ralph_lc_hash_line through it.
# shellcheck source=../scripts/ledger.sh
. "$SCRIPTS/ledger.sh"

L="$TMP/ledger.jsonl"
DB="$TMP/ledger.sqlite"
export RALPH_HERDR_LEDGER="$L"

# ── fresh machine: absent DB auto-creates the tape; no JSONL appears ─────────
OUT=$(ralph_ledger_append '{"ts":"t1","ev":"spawn","agent_ref":"w9-x#aa","pane_id":"p9"}' 2>&1); RC=$?
is "fresh-machine append exits 0" "0" "$RC"
is "fresh-machine append is silent" "" "$OUT"
[ -f "$DB" ] && ok "the tape was auto-created" || not_ok "the tape was auto-created"
[ -f "$L" ] && not_ok "no JSONL is created by the append path" || ok "no JSONL is created by the append path"
is "schema v1 stamped" "1" "$(sqlite3 "$DB" 'PRAGMA user_version;')"
is "the fact landed at seq 1" "1|spawn" "$(sqlite3 "$DB" 'SELECT seq||"|"||kind FROM facts;')"
is "typed columns projected" "t1|spawn|w9-x#aa|9" "$(sqlite3 "$DB" 'SELECT ts||"|"||kind||"|"||agent||"|"||unit FROM facts WHERE seq=1;')"
is "phash matches the converter's rule" \
  "$(ralph_lc_hash_line 1 "$(sqlite3 "$DB" 'SELECT payload FROM facts WHERE seq=1;')")" \
  "$(sqlite3 "$DB" 'SELECT phash FROM facts WHERE seq=1;')"

# ── the 4096-byte ceiling is lifted ──────────────────────────────────────────
BIG=$(printf 'x%.0s' $(seq 1 6000))
OUT=$(ralph_ledger_append "{\"ts\":\"t2\",\"ev\":\"state\",\"agent_ref\":\"w9-x#aa\",\"note\":\"$BIG\"}" 2>&1); RC=$?
is "a >4096-byte fact appends" "0" "$RC"
is "the oversize fact is whole in the tape" "1" \
  "$(sqlite3 "$DB" 'SELECT count(*) FROM facts WHERE length(payload) > 4096;')"

# ── concurrent appends from separate processes: all land, distinct seq ───────
rm -f "$DB" "$DB"-wal "$DB"-shm
for i in 1 2 3 4 5 6 7 8; do
  bash -c ". '$SCRIPTS/ledger.sh'; ralph_ledger_append '{\"ts\":\"c$i\",\"ev\":\"state\",\"agent_ref\":\"wc#$i\",\"state\":\"x\"}'" 2>"$TMP/cerr.$i" &
done
wait
is "8 concurrent appends all land" "8" "$(sqlite3 "$DB" 'SELECT count(*) FROM facts;')"
is "distinct seq per fact" "8" "$(sqlite3 "$DB" 'SELECT count(DISTINCT seq) FROM facts;')"
is "no provisional phash left behind" "0" \
  "$(sqlite3 "$DB" "SELECT count(*) FROM facts WHERE phash LIKE 'provisional:%';")"
CERR=$(cat "$TMP"/cerr.* 2>/dev/null)
is "concurrent appends refused nothing" "" "$CERR"

# ── legacy machine: first append ADOPTS the JSONL, then lands at N+1 ─────────
rm -f "$DB" "$DB"-wal "$DB"-shm
printf '%s\n' \
  '{"ts":"a1","ev":"spawn","agent_ref":"w1-a#e1","session":"s1"}' \
  '{"ts":"a2","ev":"state","agent_ref":"w1-a#e1","state":"working","session":"s1"}' >"$L"
OUT=$(ralph_ledger_append '{"ts":"a3","ev":"exit","agent_ref":"w1-a#e1","reason":"finished"}' 2>&1); RC=$?
is "append onto a legacy JSONL exits 0" "0" "$RC"
is "the legacy history was adopted first" "spawn|state|exit" \
  "$(sqlite3 "$DB" 'SELECT group_concat(kind, "|") FROM (SELECT kind FROM facts ORDER BY seq);')"
is "the JSONL did not grow" "2" "$(grep -c '' <"$L")"
# The adopted prefix stays byte-faithful under --export.
bash "$CONVERT" --export "$L" >"$TMP/export.jsonl" 2>/dev/null
if head -2 "$TMP/export.jsonl" | cmp -s - "$L"; then
  ok "export is byte-identical for the adopted prefix"
else
  not_ok "export is byte-identical for the adopted prefix"
fi
is "export carries the appended fact too" "3" "$(grep -c '' <"$TMP/export.jsonl")"

# ── the JSONL stays frozen across further appends ────────────────────────────
before=$(grep -c '' <"$L")
ralph_ledger_append '{"ts":"a4","ev":"state","agent_ref":"w1-a#e1","state":"blocked"}' 2>/dev/null
is "no JSONL growth on append" "$before" "$(grep -c '' <"$L")"
is "the tape grew instead" "4" "$(sqlite3 "$DB" 'SELECT count(*) FROM facts;')"

# ── a payload with SQL metacharacters survives verbatim ──────────────────────
ralph_ledger_append '{"ts":"a5","ev":"state","agent_ref":"w1-a#e1","note":"it'"'"'s a; DROP TABLE facts; --"}' 2>/dev/null
is "quoted payload row lands" "5" "$(sqlite3 "$DB" 'SELECT count(*) FROM facts;')"
has "quoted payload stored verbatim" "DROP TABLE facts" \
  "$(sqlite3 "$DB" 'SELECT payload FROM facts WHERE seq=5;')"

# ── duplicate identical events land as distinct rows (seq salt) ──────────────
ralph_ledger_append '{"ts":"a6","ev":"state","agent_ref":"w1-a#e1","state":"working"}' 2>/dev/null
ralph_ledger_append '{"ts":"a6","ev":"state","agent_ref":"w1-a#e1","state":"working"}' 2>/dev/null
is "duplicate events stored as their own rows" "7" "$(sqlite3 "$DB" 'SELECT count(*) FROM facts;')"
is "duplicate rows carry distinct phashes" "7" "$(sqlite3 "$DB" 'SELECT count(DISTINCT phash) FROM facts;')"

# ── a tape TRAILING its legacy jsonl is backfilled before the append ─────────
# (A phase-B sink skip never healed: appending at max(seq)+1 would occupy the
# seq the converter needs for the jsonl's own line there, and INSERT OR
# IGNORE could never heal it — the divergence would be permanent.)
rm -f "$DB" "$DB"-wal "$DB"-shm
printf '%s\n' \
  '{"ts":"b1","ev":"spawn","agent_ref":"w7-t#e7","session":"s7"}' \
  '{"ts":"b2","ev":"state","agent_ref":"w7-t#e7","state":"working","session":"s7"}' \
  '{"ts":"b3","ev":"state","agent_ref":"w7-t#e7","state":"blocked","session":"s7"}' >"$L"
bash "$CONVERT" "$L" >/dev/null 2>&1
sqlite3 "$DB" 'DELETE FROM facts WHERE seq=3;' # simulate the un-healed sink skip
OUT=$(bash -c ". '$SCRIPTS/ledger.sh'; ralph_ledger_append '{\"ts\":\"b4\",\"ev\":\"exit\",\"agent_ref\":\"w7-t#e7\",\"reason\":\"finished\"}'" 2>&1); RC=$?
is "append onto a trailing tape exits 0" "0" "$RC"
is "the jsonl's missing fact was backfilled at ITS seq" \
  "$(sed -n 3p "$L")" "$(sqlite3 "$DB" 'SELECT payload FROM facts WHERE seq=3;')"
is "the new fact landed AFTER the backfill" "4|exit" \
  "$(sqlite3 "$DB" 'SELECT seq||"|"||kind FROM facts WHERE seq=4;')"
rm -f "$DB" "$DB"-wal "$DB"-shm
printf '%s\n' \
  '{"ts":"a1","ev":"spawn","agent_ref":"w1-a#e1","session":"s1"}' \
  '{"ts":"a2","ev":"state","agent_ref":"w1-a#e1","state":"working","session":"s1"}' >"$L"
bash "$CONVERT" "$L" >/dev/null 2>&1
for ev in exit state state state state state; do
  ralph_ledger_append "{\"ts\":\"r\",\"ev\":\"$ev\",\"agent_ref\":\"w1-a#e1\",\"state\":\"x\"}" 2>/dev/null
done
# (restore the pre-existing 7-fact shape the assertions below expect: 2 seeded + 6 appends = 8)
sqlite3 "$DB" 'DELETE FROM facts WHERE seq=8;'

# ── parity: healthy post-D shape (tape ahead of the frozen jsonl) ────────────
OUT=$(bash "$PARITY" 2>&1); RC=$?
is "parity passes on the healthy post-D shape" "0" "$RC"
has "parity reports the frozen jsonl" "jsonl frozen at 2 facts (export-only since" "$OUT"

# ── no sqlite3: the append REFUSES loudly, drops nothing silently ────────────
before=$(sqlite3 "$DB" 'SELECT count(*) FROM facts;')
OUT=$(RALPH_SQLITE3_BIN=/nonexistent-sqlite3 ralph_ledger_append '{"ts":"a7","ev":"state","agent_ref":"w1-a#e1","state":"x"}' 2>&1); RC=$?
is "append without sqlite3 exits 1" "1" "$RC"
has "append without sqlite3 says the fact was NOT recorded" "NOT recorded" "$OUT"
is "tape untouched by the refusal" "$before" "$(sqlite3 "$DB" 'SELECT count(*) FROM facts;')"
[ "$(grep -c '' <"$L")" = "2" ] && ok "JSONL untouched by the refusal" || not_ok "JSONL untouched by the refusal"

# ── newer schema: REFUSES, tape untouched ────────────────────────────────────
sqlite3 "$DB" 'PRAGMA user_version=2;'
OUT=$(ralph_ledger_append '{"ts":"a8","ev":"state","agent_ref":"w1-a#e1","state":"x"}' 2>&1); RC=$?
is "append against a newer schema exits 1" "1" "$RC"
has "newer schema names user_version" "user_version" "$OUT"
is "newer-schema tape not written" "$before" "$(sqlite3 "$DB" 'SELECT count(*) FROM facts;')"
sqlite3 "$DB" 'PRAGMA user_version=1;'

# ── invalid input still refused at the door ──────────────────────────────────
OUT=$(ralph_ledger_append 'not json' 2>&1); RC=$?
is "invalid JSON refused" "1" "$RC"
OUT=$(ralph_ledger_append '{"a":1}
{"b":2}' 2>&1); RC=$?
is "multiple documents refused" "1" "$RC"

# ── session stamped exactly as before ────────────────────────────────────────
ralph_ledger_append '{"ts":"a9","ev":"state","agent_ref":"w1-a#e1","state":"y"}' 2>/dev/null
is "session key stamped on the appended fact" "0" \
  "$(sqlite3 "$DB" "SELECT count(*) FROM facts WHERE seq=8 AND payload NOT LIKE '%\"session\"%';")"

echo "1..$n"
echo "# pass $pass fail $fail"
[ "$fail" -eq 0 ]
