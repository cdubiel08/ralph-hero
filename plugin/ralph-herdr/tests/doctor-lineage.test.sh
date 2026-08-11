#!/usr/bin/env bash
# doctor-lineage.test.sh — tests for scripts/doctor-lineage.sh (TAP-ish).
#
#   bash plugin/ralph-herdr/tests/doctor-lineage.test.sh
#
# Uses a stub herdr binary (fixture agent lists) and RALPH_HERDR_LEDGER
# fixtures under $TMP — no server, no real ledger, read-only by construction.
# bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCTOR="$SCRIPT_DIR/../scripts/doctor-lineage.sh"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-lineage-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

# Stub herdr: `agent list` prints the fixture in $RALPH_TEST_AGENTS.
cat >"$TMP/herdr" <<'EOF'
#!/bin/bash
if [ "${1-}" = "agent" ] && [ "${2-}" = "list" ]; then
  cat "${RALPH_TEST_AGENTS:?}"
  exit 0
fi
exit 1
EOF
chmod +x "$TMP/herdr"
export HERDR_BIN_PATH="$TMP/herdr"
export RALPH_HERDR_LEDGER="$TMP/ledger.jsonl"

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}
# run FIXTURE_JSON — run the doctor against an agent-list fixture; sets
# OUT and RC for the assertions.
run() {
  printf '%s\n' "$1" >"$TMP/agents.json"
  RC=0
  OUT=$(RALPH_TEST_AGENTS="$TMP/agents.json" bash "$DOCTOR" 2>&1) || RC=$?
}
has_line() { # DESC PATTERN — assert OUT contains a line matching PATTERN
  if printf '%s\n' "$OUT" | grep -q "$2"; then ok "$1"; else not_ok "$1 — no line matching '$2' in: $OUT"; fi
}

NOW=$(date -u +%FT%TZ)

# ── closed: one live agent, one open record ──────────────────────────────────
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"w123-fix#aaaa","pane_id":"p1","tokens":{"role":"w","issue":"123","slug":"fix","depth":"0","state":"spawned"}}
EOF
run '{"result":{"agents":[{"name":"w123-fix","agent_status":"working","pane_id":"p1"}]}}'
is "closed herd exits 0" "0" "$RC"
has_line "live agent with one record is ok" '^  ok   lineage-w123-fix '

# ── live agent with NO open record → GAP, exit 1 ─────────────────────────────
run '{"result":{"agents":[{"name":"w123-fix","agent_status":"working","pane_id":"p1"},{"name":"w7-lost","agent_status":"idle","pane_id":"p2"}]}}'
is "unledgered live agent exits 1" "1" "$RC"
has_line "unledgered live agent is a GAP" '^  GAP  lineage-w7-lost .*NO open ledger record'

# ── duplicate open records for one live name → GAP ───────────────────────────
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"w123-fix#aaaa","pane_id":"p1","tokens":{"depth":"0"}}
{"ts":"$NOW","ev":"spawn","agent_ref":"w123-fix#bbbb","pane_id":"p1","tokens":{"depth":"0"}}
EOF
run '{"result":{"agents":[{"name":"w123-fix","agent_status":"working","pane_id":"p1"}]}}'
is "duplicate identity exits 1" "1" "$RC"
has_line "duplicate identity is a GAP" '^  GAP  lineage-w123-fix .*2 open ledger records'

# ── open record, no live agent, older than TTL → GAP ─────────────────────────
cat >"$RALPH_HERDR_LEDGER" <<'EOF'
{"ts":"2020-01-01T00:00:00Z","ev":"spawn","agent_ref":"w9-old#cccc","pane_id":"p3","tokens":{"depth":"0"}}
EOF
run '{"result":{"agents":[]}}'
is "stale open record exits 1" "1" "$RC"
has_line "stale open record is a GAP" '^  GAP  lineage-w9-old#cccc .*reconcile'

# ── open record, no live agent, WITHIN TTL → note only, exit 0 ───────────────
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"w9-new#dddd","pane_id":"p3","tokens":{"depth":"0"}}
EOF
run '{"result":{"agents":[]}}'
is "fresh un-live record exits 0" "0" "$RC"
has_line "fresh un-live record is a note" '^  note lineage-w9-new#dddd '

# ── exited records are closed — not flagged ──────────────────────────────────
cat >"$RALPH_HERDR_LEDGER" <<'EOF'
{"ts":"2020-01-01T00:00:00Z","ev":"spawn","agent_ref":"w9-done#eeee","pane_id":"p4","tokens":{"depth":"0"}}
{"ts":"2020-01-01T01:00:00Z","ev":"exit","agent_ref":"w9-done#eeee","reason":"pane_closed"}
EOF
run '{"result":{"agents":[]}}'
is "a closed (exited) record is not a finding" "0" "$RC"

# ── legacy singletons are noted, never gapped ────────────────────────────────
: >"$RALPH_HERDR_LEDGER"
run '{"result":{"agents":[{"name":"ralph-deliver","agent_status":"working","pane_id":"p5"}]}}'
is "legacy singleton exits 0" "0" "$RC"
has_line "legacy singleton is a note" '^  note lineage-ralph-deliver .*no ledger identity'

# ── server unreachable → exit 2, not evaluable ───────────────────────────────
RC=0
OUT=$(HERDR_BIN_PATH=/usr/bin/false bash "$DOCTOR" 2>&1) || RC=$?
is "unreachable server exits 2" "2" "$RC"
has_line "unreachable server is not evaluable" '^  note lineage .*not evaluable'

echo "1..$n"
echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
