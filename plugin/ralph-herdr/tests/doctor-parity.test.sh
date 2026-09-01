#!/usr/bin/env bash
# doctor-parity.test.sh — tests for scripts/doctor-parity.sh (TAP-ish).
#
#   bash plugin/ralph-herdr/tests/doctor-parity.test.sh
#
# Pure-file tests: RALPH_HERDR_LEDGER pins one fixture ledger under $TMP —
# no server, no real ledger, read-only by construction (the fixture sqlite
# is built by the real converter). bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARITY="$SCRIPT_DIR/../scripts/doctor-parity.sh"
CONVERT="$SCRIPT_DIR/../scripts/ledger-convert.sh"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-parity-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

export RALPH_HERDR_LEDGER="$TMP/ledger.jsonl"
L="$RALPH_HERDR_LEDGER"
DB="$TMP/ledger.sqlite"

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}
run() { RC=0; OUT=$(bash "$PARITY" 2>&1) || RC=$?; }
has_line() { # DESC PATTERN
  if printf '%s\n' "$OUT" | grep -q "$2"; then ok "$1"; else not_ok "$1 — no line matching '$2' in: $OUT"; fi
}

cat >"$L" <<'EOF'
{"ts":"2026-08-30T01:00:00Z","ev":"spawn","agent_ref":"w42-p#aa"}
{"ts":"2026-08-30T02:00:00Z","ev":"exit","agent_ref":"w42-p#aa","reason":"lost"}
EOF

# ── not converted yet: info, never a failure ─────────────────────────────────
run
is "unconverted ledger exits 0" "0" "$RC"
has_line "unconverted is a note" '^  note parity-.*not converted yet'

# ── in parity ────────────────────────────────────────────────────────────────
bash "$CONVERT" "$L" >/dev/null 2>&1
run
is "in parity exits 0" "0" "$RC"
has_line "parity is ok" '^  ok   parity-.*in parity (2 facts'

# ── behind with intact overlap: a note, not a finding ────────────────────────
echo '{"ts":"2026-08-30T03:00:00Z","ev":"discover","agent_ref":"w9-q#bb"}' >>"$L"
run
is "behind exits 0" "0" "$RC"
has_line "behind is a note naming the converter" '^  note parity-.*behind by 1 fact.*ledger-convert.sh'

# ── behind with a rewritten overlap: a GAP ───────────────────────────────────
sqlite3 "$DB" 'UPDATE facts SET phash="0000" WHERE seq=(SELECT max(seq) FROM facts);'
run
is "rewritten overlap exits 1" "1" "$RC"
has_line "rewritten overlap is a GAP" '^  GAP  parity-.*does not match the jsonl line there'

# ── same count, different last fact: a GAP ───────────────────────────────────
bash "$CONVERT" "$L" >/dev/null 2>&1 # heal the tamper is impossible (OR IGNORE); rebuild clean
rm -f "$DB"
bash "$CONVERT" "$L" >/dev/null 2>&1
sqlite3 "$DB" 'UPDATE facts SET phash="1111" WHERE seq=(SELECT max(seq) FROM facts);'
run
is "same-count divergence exits 1" "1" "$RC"
has_line "same-count divergence is a GAP" '^  GAP  parity-.*last fact disagrees'

# ── sqlite ahead of the jsonl (truncated source): a GAP ──────────────────────
rm -f "$DB"
bash "$CONVERT" "$L" >/dev/null 2>&1
head -1 "$L" >"$L.tmp" && mv "$L.tmp" "$L"
run
is "truncated jsonl exits 1" "1" "$RC"
has_line "truncated jsonl is a GAP naming --export" '^  GAP  parity-.*truncated or rewritten'

# ── future user_version: not evaluated, never ok and never a GAP ─────────────
sqlite3 "$DB" 'PRAGMA user_version=3;'
run
is "future user_version exits 0" "0" "$RC"
has_line "future user_version is not evaluated" '^  note parity-.*not evaluated.*user_version'

# ── missing sqlite3: not evaluable ───────────────────────────────────────────
RC=0; OUT=$(RALPH_SQLITE3_BIN=/nonexistent-sqlite3 bash "$PARITY" 2>&1) || RC=$?
is "missing sqlite3 exits 2" "2" "$RC"
has_line "missing sqlite3 names the install" 'not evaluable.*sqlite3'

# ── bad invocation ───────────────────────────────────────────────────────────
RC=0; OUT=$(bash "$PARITY" --bogus 2>&1) || RC=$?
is "arguments are refused" "64" "$RC"

echo "1..$n"
echo "# pass $pass fail $fail"
[ "$fail" -eq 0 ]
