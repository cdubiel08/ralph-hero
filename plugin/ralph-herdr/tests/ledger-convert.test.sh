#!/usr/bin/env bash
# ledger-convert.test.sh — tests for scripts/ledger-convert.sh (TAP-ish).
#
#   bash plugin/ralph-herdr/tests/ledger-convert.test.sh
#
# Pure-file tests: fixtures under $TMP, no server, no real ledger. Needs
# sqlite3 and jq (both are the script's own stated dependencies).
# bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONVERT="$SCRIPT_DIR/../scripts/ledger-convert.sh"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-lconv-test.XXXXXX") || exit 1
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

L="$TMP/ledger.jsonl"
DB="$TMP/ledger.sqlite"

# ── basic convert: facts land with typed columns ─────────────────────────────
cat >"$L" <<'EOF'
{"ts":"2026-08-30T01:00:00Z","ev":"spawn","agent_ref":"w123-fix#aaaa","pane_id":"p1","tokens":{"depth":"0"}}
{"ts":"2026-08-30T01:05:00Z","ev":"state","agent_ref":"w123-fix#aaaa","state":"working"}
{"ts":"2026-08-30T02:00:00Z","ev":"exit","agent_ref":"w123-fix#aaaa","reason":"lost","pane_id":"p1"}
EOF
OUT=$(bash "$CONVERT" "$L" 2>&1); RC=$?
is "convert exits 0" "0" "$RC"
[ -f "$DB" ] && ok "sqlite file created" || not_ok "sqlite file created"
is "3 facts" "3" "$(sqlite3 "$DB" 'SELECT count(*) FROM facts;')"
is "kind projected from .ev" "spawn|state|exit" "$(sqlite3 "$DB" 'SELECT group_concat(kind, "|") FROM (SELECT kind FROM facts ORDER BY seq);')"
is "unit parsed from agent ref" "123" "$(sqlite3 "$DB" 'SELECT DISTINCT unit FROM facts;')"
is "reason projected" "lost" "$(sqlite3 "$DB" 'SELECT reason FROM facts WHERE seq=3;')"
is "pane projected" "p1" "$(sqlite3 "$DB" 'SELECT pane FROM facts WHERE seq=1;')"
is "user_version is 1" "1" "$(sqlite3 "$DB" 'PRAGMA user_version;')"
is "journal mode is WAL" "wal" "$(sqlite3 "$DB" 'PRAGMA journal_mode;')"

# ── idempotence: a re-run inserts nothing ────────────────────────────────────
OUT=$(bash "$CONVERT" "$L" 2>&1); RC=$?
is "re-run exits 0" "0" "$RC"
has "re-run inserts nothing" "(0 new)" "$OUT"
is "count unchanged after re-run" "3" "$(sqlite3 "$DB" 'SELECT count(*) FROM facts;')"

# ── incremental: an appended line converts on the next run ───────────────────
echo '{"ts":"2026-08-30T03:00:00Z","ev":"discover","agent_ref":"w7-late#bbbb"}' >>"$L"
OUT=$(bash "$CONVERT" "$L" 2>&1)
has "incremental run inserts one" "(1 new)" "$OUT"
is "count grows to 4" "4" "$(sqlite3 "$DB" 'SELECT count(*) FROM facts;')"
is "new fact's seq is its line number" "4" "$(sqlite3 "$DB" 'SELECT seq FROM facts WHERE kind="discover";')"

# ── round-trip: --export is byte-identical to the input ──────────────────────
bash "$CONVERT" --export "$L" >"$TMP/export.jsonl" 2>/dev/null
if cmp -s "$L" "$TMP/export.jsonl"; then ok "export is byte-identical"; else not_ok "export is byte-identical"; fi

# ── duplicate identical lines survive (the phash seq-salt) ───────────────────
# ledger.sh tolerates duplicate events by construction, so the converter must
# not collapse them — this is the case that forced sha256(seq\tpayload) over
# the filing's sha256(payload).
DUP="$TMP/dup.jsonl"
printf '%s\n%s\n' '{"ts":"t","ev":"exit","agent_ref":"w1-a#cc"}' '{"ts":"t","ev":"exit","agent_ref":"w1-a#cc"}' >"$DUP"
bash "$CONVERT" "$DUP" >/dev/null 2>&1
is "duplicate lines both stored" "2" "$(sqlite3 "$TMP/dup.sqlite" 'SELECT count(*) FROM facts;')"
bash "$CONVERT" --export "$DUP" >"$TMP/dup-export.jsonl" 2>/dev/null
if cmp -s "$DUP" "$TMP/dup-export.jsonl"; then ok "duplicate round-trip byte-identical"; else not_ok "duplicate round-trip byte-identical"; fi
bash "$CONVERT" "$DUP" >/dev/null 2>&1
is "duplicates still idempotent on re-run" "2" "$(sqlite3 "$TMP/dup.sqlite" 'SELECT count(*) FROM facts;')"

# ── rejects: a malformed line goes to the sidecar, counted, never dropped ────
REJ="$TMP/rej.jsonl"
cat >"$REJ" <<'EOF'
{"ts":"t1","ev":"spawn","agent_ref":"w5-x#dd"}
this line is not JSON at all
{"ts":"t3","ev":"exit","agent_ref":"w5-x#dd"}
EOF
OUT=$(bash "$CONVERT" "$REJ" 2>&1); RC=$?
is "rejects run exits 0" "0" "$RC"
has "rejects are counted in the summary" "1 reject(s)" "$OUT"
is "only valid lines stored" "2" "$(sqlite3 "$TMP/rej.sqlite" 'SELECT count(*) FROM facts;')"
is "sidecar holds the malformed line" "this line is not JSON at all" "$(cat "$REJ.rejects")"
is "reject leaves a seq gap (order preserved)" "3" "$(sqlite3 "$TMP/rej.sqlite" 'SELECT seq FROM facts WHERE kind="exit";')"
bash "$CONVERT" "$REJ" >/dev/null 2>&1
is "sidecar not doubled by a re-run" "1" "$(wc -l <"$REJ.rejects" | tr -d ' ')"

# ── future user_version: refused, fail closed ────────────────────────────────
sqlite3 "$TMP/rej.sqlite" 'PRAGMA user_version=2;'
OUT=$(bash "$CONVERT" "$REJ" 2>&1); RC=$?
is "future user_version refuses convert" "65" "$RC"
has "refusal names the version" "user_version=2" "$OUT"
OUT=$(bash "$CONVERT" --export "$REJ" 2>&1); RC=$?
is "future user_version refuses export too" "65" "$RC"

# ── missing sqlite3: named remedy, never a silent no-op ──────────────────────
OUT=$(RALPH_SQLITE3_BIN=/nonexistent-sqlite3 bash "$CONVERT" "$L" 2>&1); RC=$?
is "missing sqlite3 exits 69" "69" "$RC"
has "missing sqlite3 names the install" "install" "$OUT"

# ── missing ledger ───────────────────────────────────────────────────────────
OUT=$(bash "$CONVERT" "$TMP/absent.jsonl" 2>&1); RC=$?
is "missing ledger exits 66" "66" "$RC"

# ── export before convert ────────────────────────────────────────────────────
OUT=$(bash "$CONVERT" --export "$TMP/never.jsonl" 2>&1); RC=$?
is "export before convert exits 66" "66" "$RC"
has "export refusal names the convert" "run the convert first" "$OUT"

# ── bad invocation ───────────────────────────────────────────────────────────
OUT=$(bash "$CONVERT" --bogus 2>&1); RC=$?
is "unknown flag exits 64" "64" "$RC"

# ── kill mid-convert leaves NO partial ledger.sqlite ─────────────────────────
# A fresh build lands via atomic rename, so a kill during the (deliberately
# slow: one hash fork per line) build must leave nothing at the final path.
BIG="$TMP/big.jsonl"
i=0
while [ "$i" -lt 500 ]; do
  i=$((i + 1))
  printf '{"ts":"2026-08-30T00:00:00Z","ev":"state","agent_ref":"w%s-big#ee","state":"working"}\n' "$i"
done >"$BIG"
bash "$CONVERT" "$BIG" >/dev/null 2>&1 &
CPID=$!
sleep 0.4
kill "$CPID" 2>/dev/null
wait "$CPID" 2>/dev/null
if [ -f "$TMP/big.sqlite" ]; then
  not_ok "kill mid-convert leaves no ledger.sqlite"
else
  ok "kill mid-convert leaves no ledger.sqlite"
fi
OUT=$(bash "$CONVERT" "$BIG" 2>&1); RC=$?
is "convert completes after a killed run" "0" "$RC"
is "all facts land after the killed run" "500" "$(sqlite3 "$TMP/big.sqlite" 'SELECT count(*) FROM facts;')"

echo "1..$n"
echo "# pass $pass fail $fail"
[ "$fail" -eq 0 ]
