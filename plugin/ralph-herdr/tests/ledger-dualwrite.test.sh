#!/usr/bin/env bash
# ledger-dualwrite.test.sh — tests for the sqlite dual-write sink inside
# ralph_ledger_append (GH-2306, phase B). TAP-ish, like its siblings.
#
#   bash plugin/ralph-herdr/tests/ledger-dualwrite.test.sh
#
# Pure-file tests: fixtures under $TMP, no server, no real ledger. Needs
# sqlite3 and jq. bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../scripts"
CONVERT="$SCRIPTS/ledger-convert.sh"
PARITY="$SCRIPTS/doctor-parity.sh"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-ldual-test.XXXXXX") || exit 1
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

# Sourcing ledger.sh pulls in ledger-convert.sh's helpers (the sink's own
# dependency chain) — the tests below call ralph_lc_hash_line through it.
# shellcheck source=../scripts/ledger.sh
. "$SCRIPTS/ledger.sh"

L="$TMP/ledger.jsonl"
DB="$TMP/ledger.sqlite"
export RALPH_HERDR_LEDGER="$L"

# ── absent DB: silent skip, no DB created ────────────────────────────────────
OUT=$(ralph_ledger_append '{"ts":"t1","ev":"spawn","agent_ref":"w9-x#aa","pane_id":"p9"}' 2>&1); RC=$?
is "append with no sqlite exits 0" "0" "$RC"
is "append with no sqlite is silent" "" "$OUT"
is "jsonl holds the line" "1" "$(wc -l <"$L" | tr -d ' ')"
[ -f "$DB" ] && not_ok "no DB created by the append path" || ok "no DB created by the append path"

# ── happy path: converted machine, both sinks agree ──────────────────────────
bash "$CONVERT" "$L" >/dev/null 2>&1
is "converter adopts the machine" "1" "$(sqlite3 "$DB" 'SELECT count(*) FROM facts;')"
OUT=$(ralph_ledger_append '{"ts":"t2","ev":"state","agent_ref":"w9-x#aa","state":"working"}' 2>&1); RC=$?
is "dual-write append exits 0" "0" "$RC"
is "dual-write append is silent" "" "$OUT"
is "both sinks hold 2 facts" "2|$(wc -l <"$L" | tr -d ' ')" "$(sqlite3 "$DB" 'SELECT count(*) FROM facts;')|2"
is "payload is the exact line appended" "$(sed -n 2p "$L")" "$(sqlite3 "$DB" 'SELECT payload FROM facts WHERE seq=2;')"
is "phash matches the converter's rule" "$(ralph_lc_hash_line 2 "$(sed -n 2p "$L")")" "$(sqlite3 "$DB" 'SELECT phash FROM facts WHERE seq=2;')"
is "typed columns projected" "t2|state|w9-x#aa|9" "$(sqlite3 "$DB" 'SELECT ts||"|"||kind||"|"||agent||"|"||unit FROM facts WHERE seq=2;')"
OUT=$(bash "$PARITY" 2>&1); RC=$?
is "parity passes after a dual write" "0" "$RC"
has "parity reports agreement" "in parity" "$OUT"

# ── duplicate identical events dual-write as distinct rows (seq salt) ────────
ralph_ledger_append '{"ts":"t2","ev":"state","agent_ref":"w9-x#aa","state":"working"}' 2>/dev/null
is "duplicate event stored as its own row" "3" "$(sqlite3 "$DB" 'SELECT count(*) FROM facts;')"
is "duplicate rows carry distinct phashes" "3" "$(sqlite3 "$DB" 'SELECT count(DISTINCT phash) FROM facts;')"

# ── export byte-identity across mixed converter/dual-write provenance ────────
bash "$CONVERT" --export "$L" >"$TMP/export.jsonl" 2>/dev/null
if cmp -s "$L" "$TMP/export.jsonl"; then ok "export byte-identical after dual writes"; else not_ok "export byte-identical after dual writes"; fi

# ── kill between sinks: parity flags it, convert heals it ────────────────────
# Simulated as the death IS: the JSONL line landed, the sqlite insert never
# ran (a bare append writes exactly what a process killed between sinks
# leaves behind).
echo '{"ts":"t3","ev":"exit","agent_ref":"w9-x#aa","reason":"lost","session":"k"}' >>"$L"
OUT=$(bash "$PARITY" 2>&1); RC=$?
is "parity exits 0 on a benign gap" "0" "$RC"
has "sqlite behind is a note, not a GAP" "behind by 1" "$OUT"
bash "$CONVERT" "$L" >/dev/null 2>&1
is "convert backfills the missed row" "4" "$(sqlite3 "$DB" 'SELECT count(*) FROM facts;')"
OUT=$(bash "$PARITY" 2>&1); RC=$?
is "parity passes after the heal" "0" "$RC"

# ── sqlite3 unavailable: warns, never blocks the append ──────────────────────
OUT=$(RALPH_SQLITE3_BIN=/nonexistent-sqlite3 ralph_ledger_append '{"ts":"t4","ev":"state","agent_ref":"w9-x#aa","state":"blocked"}' 2>&1); RC=$?
is "append without sqlite3 exits 0" "0" "$RC"
has "append without sqlite3 warns" "sqlite sink skipped" "$OUT"
is "jsonl still got the line" "5" "$(wc -l <"$L" | tr -d ' ')"
is "sqlite untouched" "4" "$(sqlite3 "$DB" 'SELECT count(*) FROM facts;')"
bash "$CONVERT" "$L" >/dev/null 2>&1  # heal before the next case

# ── newer schema: warns and proceeds, db untouched ───────────────────────────
sqlite3 "$DB" 'PRAGMA user_version=2;'
OUT=$(ralph_ledger_append '{"ts":"t5","ev":"state","agent_ref":"w9-x#aa","state":"working"}' 2>&1); RC=$?
is "append against a newer schema exits 0" "0" "$RC"
has "newer schema warns" "user_version" "$OUT"
is "newer-schema db not written" "5" "$(sqlite3 "$DB" 'SELECT count(*) FROM facts;')"
sqlite3 "$DB" 'PRAGMA user_version=1;'
bash "$CONVERT" "$L" >/dev/null 2>&1
is "convert heals the schema-warn gap" "6" "$(sqlite3 "$DB" 'SELECT count(*) FROM facts;')"

# ── lost seq race: read-back mismatch skips, never inserts a wrong row ───────
OUT=$(_ralph_ledger_sqlite_insert "$L" '{"not":"the tail line"}' 2>&1); RC=$?
is "mismatched tail exits 0" "0" "$RC"
has "mismatched tail warns as a moved tail" "moved the tail" "$OUT"
is "mismatched tail inserts nothing" "6" "$(sqlite3 "$DB" 'SELECT count(*) FROM facts;')"

# ── a payload with SQL metacharacters survives verbatim ──────────────────────
ralph_ledger_append '{"ts":"t6","ev":"state","agent_ref":"w9-x#aa","note":"it'"'"'s a; DROP TABLE facts; --"}' 2>/dev/null
is "quoted payload row lands" "7" "$(sqlite3 "$DB" 'SELECT count(*) FROM facts;')"
is "quoted payload stored verbatim" "$(sed -n 7p "$L")" "$(sqlite3 "$DB" 'SELECT payload FROM facts WHERE seq=7;')"
bash "$CONVERT" --export "$L" >"$TMP/export2.jsonl" 2>/dev/null
if cmp -s "$L" "$TMP/export2.jsonl"; then ok "export still byte-identical"; else not_ok "export still byte-identical"; fi

# ── pre-existing DIVERGENT row at our seq: warned, never overwritten ─────────
# The parity check's count+last-phash shape can miss a mid-file divergence,
# so the sink warns at the one moment the divergent row is touched — and
# leaves it standing (nothing on the append path overwrites, phase A's rule).
sqlite3 "$DB" "INSERT INTO facts(seq, ts, kind, payload, phash) VALUES (8, 'tx', 'poison', 'not our line', 'deadbeef');"
OUT=$(ralph_ledger_append '{"ts":"t7","ev":"state","agent_ref":"w9-x#aa","state":"working"}' 2>&1); RC=$?
is "append over a divergent row exits 0" "0" "$RC"
has "divergent row is warned" "DIFFERENT fact at seq 8" "$OUT"
is "jsonl still got the line" "8" "$(wc -l <"$L" | tr -d ' ')"
is "divergent row left standing" "not our line" "$(sqlite3 "$DB" 'SELECT payload FROM facts WHERE seq=8;')"

echo "1..$n"
echo "# pass $pass fail $fail"
[ "$fail" -eq 0 ]
