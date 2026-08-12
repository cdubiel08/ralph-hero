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

# The shared fake, not an ad-hoc stub: the herd read is a protocol-19 session
# snapshot now (GH-1774), and a local stub answering the old `agent list` shape
# would be asserting against a response the real server cannot produce.
export HERDR_BIN_PATH="$SCRIPT_DIR/fake-herdr.sh"
export FAKE_HERDR_FIXTURES="$TMP/fixtures"
mkdir -p "$FAKE_HERDR_FIXTURES"

# A checkout the fixture agents are scoped to. This suite pins ONE ledger via
# RALPH_HERDR_LEDGER, which puts doctor-lineage in single-ledger mode — there
# is no cross-repository ambiguity to resolve, so scope matching is bypassed
# and these cases stay about lineage closure rather than containment.
REPO_DIR="$TMP/repo"
mkdir -p "$REPO_DIR"
printf '{"owner":"acme","repo":"demo","projectNumber":1}\n' >"$REPO_DIR/.ralph.json"
# shellcheck source=herd-fixture.sh
. "$SCRIPT_DIR/herd-fixture.sh"

export RALPH_HERDR_LEDGER="$TMP/ledger.jsonl"

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}
# run AGENTS_JSON — run the doctor against a herd described as a JSON array of
# partial agents (herd_fixture builds the snapshot join); sets OUT and RC.
run() {
  herd_fixture "$1"
  RC=0
  OUT=$(bash "$DOCTOR" 2>&1) || RC=$?
}
has_line() { # DESC PATTERN — assert OUT contains a line matching PATTERN
  if printf '%s\n' "$OUT" | grep -q "$2"; then ok "$1"; else not_ok "$1 — no line matching '$2' in: $OUT"; fi
}

NOW=$(date -u +%FT%TZ)

# ── closed: one live agent, one open record ──────────────────────────────────
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"w123-fix#aaaa","pane_id":"p1","tokens":{"role":"w","issue":"123","slug":"fix","depth":"0","state":"spawned"}}
EOF
run '[{"name":"w123-fix","agent_status":"working","pane_id":"p1"}]'
is "closed herd exits 0" "0" "$RC"
has_line "live agent with one record is ok" '^  ok   lineage-w123-fix '

# ── live agent with NO open record → GAP, exit 1 ─────────────────────────────
run '[{"name":"w123-fix","agent_status":"working","pane_id":"p1"},{"name":"w7-lost","agent_status":"idle","pane_id":"p2"}]'
is "unledgered live agent exits 1" "1" "$RC"
has_line "unledgered live agent is a GAP" '^  GAP  lineage-w7-lost .*NO open ledger record'

# ── duplicate open records for one live name → GAP ───────────────────────────
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"w123-fix#aaaa","pane_id":"p1","tokens":{"depth":"0"}}
{"ts":"$NOW","ev":"spawn","agent_ref":"w123-fix#bbbb","pane_id":"p1","tokens":{"depth":"0"}}
EOF
run '[{"name":"w123-fix","agent_status":"working","pane_id":"p1"}]'
is "duplicate identity exits 1" "1" "$RC"
has_line "duplicate identity is a GAP" '^  GAP  lineage-w123-fix .*2 open ledger records'

# ── open record, no live agent, older than TTL → GAP ─────────────────────────
cat >"$RALPH_HERDR_LEDGER" <<'EOF'
{"ts":"2020-01-01T00:00:00Z","ev":"spawn","agent_ref":"w9-old#cccc","pane_id":"p3","tokens":{"depth":"0"}}
EOF
run '[]'
is "stale open record exits 1" "1" "$RC"
has_line "stale open record is a GAP" '^  GAP  lineage-w9-old#cccc .*reconcile'

# ── open record, no live agent, WITHIN TTL → note only, exit 0 ───────────────
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"w9-new#dddd","pane_id":"p3","tokens":{"depth":"0"}}
EOF
run '[]'
is "fresh un-live record exits 0" "0" "$RC"
has_line "fresh un-live record is a note" '^  note lineage-w9-new#dddd '

# ── exited records are closed — not flagged ──────────────────────────────────
cat >"$RALPH_HERDR_LEDGER" <<'EOF'
{"ts":"2020-01-01T00:00:00Z","ev":"spawn","agent_ref":"w9-done#eeee","pane_id":"p4","tokens":{"depth":"0"}}
{"ts":"2020-01-01T01:00:00Z","ev":"exit","agent_ref":"w9-done#eeee","reason":"pane_closed"}
EOF
run '[]'
is "a closed (exited) record is not a finding" "0" "$RC"

# ── legacy singletons are noted, never gapped ────────────────────────────────
: >"$RALPH_HERDR_LEDGER"
run '[{"name":"ralph-deliver","agent_status":"working","pane_id":"p5"}]'
is "legacy singleton exits 0" "0" "$RC"
has_line "legacy singleton is a note" '^  note lineage-ralph-deliver .*no ledger identity'

# ── containment: one session, two repositories ───────────────────────────────
# Unpinned (no RALPH_HERDR_LEDGER), so scope matching is live. Both repos have
# a `w42-fix`; only ours has a ledger. Without scoping, THEIR live agent would
# be matched against OUR ledger record and the check would report closure —
# hiding the fact that our own agent has no record. The check must not invent
# closure out of another repository's agent.
LROOT="$TMP/lroot"
mkdir -p "$LROOT/acme/demo"
cat >"$LROOT/acme/demo/ledger.jsonl" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"w42-fix#aaaa","pane_id":"p1","tokens":{"role":"w","issue":"42","slug":"fix","depth":"0","state":"spawned"}}
EOF
herd_fixture_foreign \
  '[]' \
  '[{"name":"w42-fix","agent_status":"working"}]' \
  "$REPO_DIR"
RC=0
OUT=$(RALPH_HERDR_LEDGER= RALPH_HERDR_LEDGER_ROOT="$LROOT" bash "$DOCTOR" 2>&1) || RC=$?
is "multi-repo: exits 0 — no findings invented from a foreign agent" "0" "$RC"
has_line "multi-repo: the foreign agent is not counted as one of ours" \
  '^  ok   lineage — closed (0 live ledgered agent(s)'


# ── server unreachable → exit 2, not evaluable ───────────────────────────────
RC=0
OUT=$(HERDR_BIN_PATH=/usr/bin/false bash "$DOCTOR" 2>&1) || RC=$?
is "unreachable server exits 2" "2" "$RC"
has_line "unreachable server is not evaluable" '^  note lineage .*not evaluable'

echo "1..$n"
echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
