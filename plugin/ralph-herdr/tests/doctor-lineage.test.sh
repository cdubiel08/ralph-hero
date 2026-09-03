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
  printf 'warning: chatty but harmless\n' >"$FAKE_HERDR_FIXTURES/api-snapshot.err"
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
has_line "the stale count is reported" '^  note lineage-stale-open — 1 stale open record'

# ── GH-2066: the remedy is split by what reconcile can do with the record ────
# A record with NO ownership proof — no session key, no pane this server holds
# — is one no reconcile pass can ever sweep, so naming the reconcile action for
# it is a remedy that provably never fires. It must name --adopt instead, with
# the ledger path resolved (the flag refuses a bare invocation by design).
cat >"$RALPH_HERDR_LEDGER" <<'EOF'
{"ts":"2020-01-01T00:00:00Z","ev":"spawn","agent_ref":"w854-pre#c854","pane_id":"pGONE","tokens":{"depth":"0"}}
EOF
run '[]'
is "an unownable stale record exits 1" "1" "$RC"
has_line "an unownable record names --adopt with the ledger resolved" \
  "^  GAP  lineage-w854-pre#c854 .*no ownership proof.*--adopt $RALPH_HERDR_LEDGER\$"
if printf '%s\n' "$OUT" | grep -q 'run the reconcile action'; then
  not_ok "an unownable record does not name the pass that cannot clear it — got: $OUT"
else
  ok "an unownable record does not name the pass that cannot clear it"
fi
has_line "the count says how many need an operator assertion" \
  '^  note lineage-stale-open — 1 stale open record(s) of 1 open; 1 of them have no ownership proof'
has_line "the finding line says the same" \
  '^  1 lineage finding(s) — 1 need an operator assertion'

# A record carrying a session key IS provable — some server wrote it, and that
# server's next pass sweeps it. Today's wording is correct for it.
cat >"$RALPH_HERDR_LEDGER" <<'EOF'
{"ts":"2020-01-01T00:00:00Z","ev":"spawn","agent_ref":"w855-keyed#c855","session":"somehost:9999","tokens":{"depth":"0"}}
EOF
run '[]'
has_line "a session-keyed record keeps the reconcile remedy" \
  '^  GAP  lineage-w855-keyed#c855 .*run the reconcile action$'
has_line "a session-keyed record is not counted as unownable" \
  '^  note lineage-stale-open — 1 stale open record(s) of 1 open$'

# So is a record whose pane THIS server still holds: the pane half of
# reconcile's proof. The pane outlives the agent, which is exactly the record
# phase A sweeps.
cat >"$RALPH_HERDR_LEDGER" <<'EOF'
{"ts":"2020-01-01T00:00:00Z","ev":"spawn","agent_ref":"w856-paned#c856","pane_id":"p0","tokens":{"depth":"0"}}
EOF
run '[{"name":"unrelated-pane-holder","agent_status":"idle","pane_id":"p0"}]'
has_line "a record on a pane this server holds keeps the reconcile remedy" \
  '^  GAP  lineage-w856-paned#c856 .*run the reconcile action$'

# ── the cap: many stale records enumerate boundedly, all of them count ───────
# GH-2023 — 36 of 39 open records were stale on the live ledgers, one remedy
# printed 36 times. The cap bounds the LISTING; a suppressed record is still a
# finding, and the count line says how many were withheld.
: >"$RALPH_HERDR_LEDGER"
i=1
while [ "$i" -le 12 ]; do
  printf '{"ts":"2020-01-01T00:00:00Z","ev":"spawn","agent_ref":"w%s-old#c%s","pane_id":"p3","tokens":{"depth":"0"}}\n' \
    "$i" "$i" >>"$RALPH_HERDR_LEDGER"
  i=$((i + 1))
done
export RALPH_LINEAGE_STALE_MAX=3
run '[]'
is "capped stale sweep still exits 1" "1" "$RC"
is "only the cap is listed" "3" "$(printf '%s\n' "$OUT" | grep -c '^  GAP  lineage-w')"
has_line "the withheld remainder is named" '^  note lineage-stale-open — 12 stale open record(s); 9 not listed'
has_line "every stale record still counts as a finding" '^  12 lineage finding(s) '

# A cap of 0 is meaningful: report the count, enumerate nothing.
export RALPH_LINEAGE_STALE_MAX=0
run '[]'
is "cap 0 lists no record" "0" "$(printf '%s\n' "$OUT" | grep -c '^  GAP  lineage-w')"
is "cap 0 still exits 1" "1" "$RC"
unset RALPH_LINEAGE_STALE_MAX

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

# ── containment: expected pair renders nothing extra (GH-2361) ───────────────
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"t99-hygiene#aaaa","pane_id":"p9","tokens":{"role":"tender","depth":"0"},"tool_binding":"accepted","process_containment":"applied"}
EOF
run '[{"name":"t99-hygiene","agent_status":"working","pane_id":"p9"}]'
is "expected pair exits 0" "0" "$RC"
is "expected pair renders no containment line" "0" "$(printf '%s\n' "$OUT" | grep -c 'containment-t99-hygiene')"

# ── containment: a contained role that never achieved binding is named ───────
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"t99-hygiene#aaaa","pane_id":"p9","tokens":{"role":"tender","depth":"0"},"tool_binding":"not_applied","process_containment":"applied"}
EOF
run '[{"name":"t99-hygiene","agent_status":"working","pane_id":"p9"}]'
is "not_applied tool_binding exits 1" "1" "$RC"
has_line "not_applied tool_binding is a GAP naming the achieved words" \
  '^  GAP  containment-t99-hygiene .*tool_binding=not_applied process_containment=applied'

# ── containment: an unverified process containment is named ─────────────────
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"t99-hygiene#aaaa","pane_id":"p9","tokens":{"role":"tender","depth":"0"},"tool_binding":"accepted","process_containment":"unverified"}
EOF
run '[{"name":"t99-hygiene","agent_status":"working","pane_id":"p9"}]'
is "unverified process_containment exits 1" "1" "$RC"
has_line "unverified process_containment is a GAP" \
  '^  GAP  containment-t99-hygiene .*process_containment=unverified'

# ── containment: an investigator's inapplicable containment is expected ─────
# (review finding on this unit, GH-2361): the default investigator grants no
# Bash, so its own spawn path records process_containment=inapplicable even
# though the role's registry row requires the mechanism — a correct
# recording, never a false GAP.
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"i1-scan#aaaa","pane_id":"p2","tokens":{"role":"investigator","depth":"1"},"tool_binding":"accepted","process_containment":"inapplicable"}
EOF
run '[{"name":"i1-scan","agent_status":"working","pane_id":"p2"}]'
is "investigator inapplicable exits 0" "0" "$RC"
is "investigator inapplicable renders no containment line" "0" "$(printf '%s\n' "$OUT" | grep -c 'containment-i1-scan')"

# ── containment: `inapplicable` is investigator-only, not a blanket pass ────
# (review finding on this unit, GH-2361 — a second pass caught by the same
# reviewers): tender keeps Bash (ralph_tool_binding_args only touches
# Edit/Write/NotebookEdit), so an `inapplicable` process containment there
# would be exactly the unsandboxed-writer hole this check exists to catch —
# it must still GAP, unlike the investigator's genuine `inapplicable`.
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"t99-hygiene#aaaa","pane_id":"p9","tokens":{"role":"tender","depth":"0"},"tool_binding":"accepted","process_containment":"inapplicable"}
EOF
run '[{"name":"t99-hygiene","agent_status":"working","pane_id":"p9"}]'
is "tender inapplicable exits 1 — not a blanket pass" "1" "$RC"
has_line "tender inapplicable is still a GAP" \
  '^  GAP  containment-t99-hygiene .*process_containment=inapplicable'

# ── containment: an investigator that never got a sandbox at all is named ───
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"i1-scan#aaaa","pane_id":"p2","tokens":{"role":"investigator","depth":"1"},"tool_binding":"accepted","process_containment":"not_available"}
EOF
run '[{"name":"i1-scan","agent_status":"working","pane_id":"p2"}]'
is "investigator not_available exits 1" "1" "$RC"
has_line "investigator not_available is still a GAP" \
  '^  GAP  containment-i1-scan .*process_containment=not_available'

# ── containment: the driver's not_requested pair is expected, not a gap ──────
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"w123-fix#aaaa","pane_id":"p1","tokens":{"role":"driver","depth":"0"},"tool_binding":"not_requested","process_containment":"not_requested"}
EOF
run '[{"name":"w123-fix","agent_status":"working","pane_id":"p1"}]'
is "driver's not_requested pair exits 0" "0" "$RC"

# ── containment: a record predating the role model is skipped, not flagged ──
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"w123-fix#aaaa","pane_id":"p1","tokens":{"depth":"0"}}
EOF
run '[{"name":"w123-fix","agent_status":"working","pane_id":"p1"}]'
is "no role recorded exits 0 — not recorded is not a finding" "0" "$RC"

# ── containment: a record predating GH-2267 (role, no words) is skipped ─────
cat >"$RALPH_HERDR_LEDGER" <<EOF
{"ts":"$NOW","ev":"spawn","agent_ref":"t99-hygiene#aaaa","pane_id":"p9","tokens":{"role":"tender","depth":"0"}}
EOF
run '[{"name":"t99-hygiene","agent_status":"working","pane_id":"p9"}]'
is "role but no words exits 0 — not recorded is not off" "0" "$RC"

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
