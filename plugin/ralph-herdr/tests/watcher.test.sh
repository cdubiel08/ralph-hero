#!/usr/bin/env bash
# watcher.test.sh — executable tests for the Phase-2 watcher bash layer
# (TAP-ish, matching naming.test.sh's structure).
#
#   bash plugin/ralph-herdr/tests/watcher.test.sh    # exits 0 on pass, 1 on fail
#
# Covers: ledger append atomicity contract, the open-agents reduction,
# watch-event.sh on pane.agent_status_changed (state event + token push +
# blocked→notify exactly once per transition), pane.exited orphan policy
# (adopt-to-grandparent when live, orphaned+notify otherwise), reconcile.sh
# discover/lost + token re-push, and the spawn depth guard's refusal at
# depth 2. All herdr traffic goes through tests/fake-herdr.sh on PATH — no
# server, no panes, no writes outside $TMP. bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../scripts"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-watcher-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

# ── the herdr PATH shim ──────────────────────────────────────────────────────
# A wrapper (not a symlink) so the repo file's exec bit is never load-bearing.
BIN="$TMP/bin"
mkdir -p "$BIN"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-herdr.sh" >"$BIN/herdr"
chmod +x "$BIN/herdr"
export PATH="$BIN:$PATH"
export HERDR_BIN_PATH="$BIN/herdr"
export FAKE_HERDR_FIXTURES="$TMP/fixtures"

# herd_fixture scopes agents to this root, and a scoped read resolves that
# root's BOARD identity — so the fake checkout must carry board config naming
# the same owner/repo the test ledgers nest under ($ROOT/acme/demo/…). Pointing
# this at the real repo checkout would scope every fixture agent to ralph-hero
# and match no test ledger at all.
REPO_DIR="$TMP/checkout"
mkdir -p "$REPO_DIR"
printf '{"owner":"acme","repo":"demo","projectNumber":1}\n' >"$REPO_DIR/.ralph.json"

# Herd fixtures: a scoped herd read resolves agent -> workspace -> worktree
# provenance, so the snapshot fixture must carry that join (herd-fixture.sh).
# shellcheck source=herd-fixture.sh
. "$SCRIPT_DIR/herd-fixture.sh"

export FAKE_HERDR_LOG="$TMP/herdr.log"
mkdir -p "$FAKE_HERDR_FIXTURES"
: >"$FAKE_HERDR_LOG"
# Guard: no subprocess may ever fall back to the real ~/.ralph — every run
# below passes its own root explicitly, and this export catches a miss.
export RALPH_HERDR_LEDGER_ROOT="$TMP/guard-root"

# ledger.sh is sourced for the unit tests AND the post-run ledger assertions.
# RALPH_HERDR_LEDGER is set (never exported) per section: in-shell functions
# see it; the watch-event/reconcile subprocesses must not.
# shellcheck source=../scripts/ledger.sh
. "$SCRIPTS/ledger.sh"

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}
fails() {
  local desc="$1" out rc=0
  shift
  out=$("$@" 2>/dev/null) || rc=$?
  if [ "$rc" -ne 0 ]; then ok "$desc"; else not_ok "$desc — expected failure, got rc 0 ('$out')"; fi
}
# lcount FILE JQ_BOOL_EXPR — number of ledger records matching the expression
lcount() { jq -rs "[.[] | select($2)] | length" <"$1"; }
# log_count REGEX / log_fcount FIXED_STRING — matching lines in the herdr log
log_count()  { grep -c -- "$1" "$FAKE_HERDR_LOG" || true; }
log_fcount() { grep -cF -- "$1" "$FAKE_HERDR_LOG" || true; }
# line_has DESC LINE SUBSTR / line_lacks DESC LINE SUBSTR
line_has() {
  case "$2" in *"$3"*) ok "$1" ;; *) not_ok "$1 — no '$3' in '$2'" ;; esac
}
line_lacks() {
  case "$2" in *"$3"*) not_ok "$1 — unexpected '$3' in '$2'" ;; *) ok "$1" ;; esac
}
# run_event EVENT PAYLOAD LEDGER_ROOT — run watch-event.sh as the herdr
# server would; sets OUT and RC.
run_event() {
  RC=0
  OUT=$(HERDR_PLUGIN_EVENT="$1" HERDR_PLUGIN_EVENT_JSON="$2" \
    RALPH_HERDR_LEDGER_ROOT="$3" bash "$SCRIPTS/watch-event.sh" 2>&1) || RC=$?
}
# run_reconcile LEDGER_ROOT — run reconcile.sh; sets OUT and RC.
run_reconcile() {
  RC=0
  OUT=$(RALPH_HERDR_LEDGER_ROOT="$1" bash "$SCRIPTS/reconcile.sh" 2>&1) || RC=$?
}

# ═══ 1. ledger append — the atomicity contract ═══════════════════════════════
RALPH_HERDR_LEDGER="$TMP/unit/ledger.jsonl"

rc=0; ralph_ledger_append '{"ts": "2026-08-11T00:00:00Z", "ev": "spawn", "agent_ref": "w1-a#0001"}' || rc=$?
is "append: valid JSON lands (rc 0)" "0" "$rc"
is "append: stored compact, one line" \
  '{"ts":"2026-08-11T00:00:00Z","ev":"spawn","agent_ref":"w1-a#0001"}' \
  "$(cat "$RALPH_HERDR_LEDGER")"

fails "append: refuses non-JSON" ralph_ledger_append 'not json'
fails "append: refuses two documents on one line" ralph_ledger_append '{"a":1} {"b":2}'
fails "append: refuses two documents split by a newline" ralph_ledger_append '{"a":1}
{"b":2}'
big=$(printf '%4200s' '' | tr ' ' 'x')
fails "append: refuses an oversize line (>= 4096B breaks O_APPEND atomicity)" \
  ralph_ledger_append "{\"pad\":\"$big\"}"

rc=0; ralph_ledger_append '{"ev":"state","agent_ref":"w1-a#0001","note":"line1\nline2"}' || rc=$?
is "append: an ESCAPED newline in a value is fine (rc 0)" "0" "$rc"
is "append: refused writes never touched the file (2 lines)" "2" \
  "$(wc -l <"$RALPH_HERDR_LEDGER" | tr -d ' ')"

# ═══ 2. open-agents reduction — spawn→exit lifecycle ═════════════════════════
RALPH_HERDR_LEDGER="$TMP/unit2/ledger.jsonl"

is "open: missing ledger is empty (rc 0)" "" "$(ralph_ledger_open_agents)"
ralph_ledger_append '{"ts":"t1","ev":"spawn","agent_ref":"w1-a#0001","pane_id":"pA"}'
ralph_ledger_append '{"ts":"t2","ev":"spawn","agent_ref":"w2-b#0002","pane_id":"pB","tokens":{"parent":"w1-a#0001"}}'
is "open: two spawns are both open" "w1-a#0001 w2-b#0002" \
  "$(ralph_ledger_open_agents | sort | tr '\n' ' ' | sed 's/ *$//')"
ralph_ledger_append '{"ts":"t3","ev":"state","agent_ref":"w1-a#0001","agent_status":"working"}'
is "open: a state event opens/closes nothing" "w1-a#0001 w2-b#0002" \
  "$(ralph_ledger_open_agents | sort | tr '\n' ' ' | sed 's/ *$//')"
is "open: pane correlation finds the ref bound to pA" "w1-a#0001" \
  "$(ralph_ledger_open_for_pane pA)"
is "open: parent edges resolve children" "w2-b#0002" \
  "$(ralph_ledger_children w1-a#0001)"
ralph_ledger_append '{"ts":"t4","ev":"exit","agent_ref":"w1-a#0001","reason":"pane_closed"}'
is "open: exit closes exactly that ref" "w2-b#0002" \
  "$(ralph_ledger_open_agents | sort | tr '\n' ' ' | sed 's/ *$//')"
is "open: a closed ref no longer answers for its pane" "" \
  "$(ralph_ledger_open_for_pane pA)"
ralph_ledger_append '{"ts":"t5","ev":"discover","agent_ref":"w3-c#0003","pane_id":"pC"}'
is "open: discover opens like spawn" "w2-b#0002 w3-c#0003" \
  "$(ralph_ledger_open_agents | sort | tr '\n' ' ' | sed 's/ *$//')"
ralph_ledger_append '{"ts":"t6","ev":"exit","agent_ref":"w2-b#0002","reason":"lost"}'
ralph_ledger_append '{"ts":"t7","ev":"exit","agent_ref":"w3-c#0003","reason":"pane_exited"}'
is "open: full lifecycle drains to empty" "" "$(ralph_ledger_open_agents)"

# ═══ 2b. ledger path — nested scope dirs, injective, board.ts-parity scope ═══
PROOT="$TMP/proot"
mkdir -p "$TMP/scopeA" "$TMP/scopeB" "$TMP/scopeC/.claude" "$TMP/scopeD" "$TMP/scopeE"
printf '{"owner":"foo-bar","repo":"baz"}\n' >"$TMP/scopeA/.ralph.json"
printf '{"owner":"foo","repo":"bar-baz"}\n' >"$TMP/scopeB/.ralph.json"
pA=$(RALPH_HERDR_LEDGER= RALPH_HERDR_LEDGER_ROOT="$PROOT" ralph_ledger_path "$TMP/scopeA")
pB=$(RALPH_HERDR_LEDGER= RALPH_HERDR_LEDGER_ROOT="$PROOT" ralph_ledger_path "$TMP/scopeB")
is "path: owner and repo nest as separate dirs" "$PROOT/foo-bar/baz/ledger.jsonl" "$pA"
if [ "$pA" != "$pB" ]; then
  ok "path: foo-bar/baz and foo/bar-baz resolve DIFFERENT ledgers (injective)"
else
  not_ok "path: foo-bar/baz and foo/bar-baz collided on '$pA'"
fi
# Wholesale per file (board.ts loadConfig parity): a partial .ralph.json is
# refused outright — never completed from settings.json or process env.
printf '{"owner":"acme"}\n' >"$TMP/scopeC/.ralph.json"
printf '{"env":{"RALPH_GH_OWNER":"other","RALPH_GH_REPO":"filled"}}\n' >"$TMP/scopeC/.claude/settings.json"
rc=0
out=$(RALPH_HERDR_LEDGER= RALPH_GH_OWNER=envo RALPH_GH_REPO=envr \
  RALPH_HERDR_LEDGER_ROOT="$PROOT" ralph_ledger_path "$TMP/scopeC" 2>/dev/null) || rc=$?
is "path: partial .ralph.json refused — no cross-file/env completion" "1" "$rc"
rc=0
out=$(RALPH_HERDR_LEDGER= RALPH_GH_OWNER=envo RALPH_GH_REPO=envr \
  RALPH_HERDR_LEDGER_ROOT="$PROOT" ralph_ledger_path "$TMP/scopeD" 2>/dev/null) || rc=$?
is "path: process env alone resolves NO scope (scope is repo-anchored)" "1" "$rc"
printf '{"owner":"..","repo":"x"}\n' >"$TMP/scopeE/.ralph.json"
pE=$(RALPH_HERDR_LEDGER= RALPH_HERDR_LEDGER_ROOT="$PROOT" ralph_ledger_path "$TMP/scopeE")
is "path: a '..' scope component cannot traverse out of the root" \
  "$PROOT/_../x/ledger.jsonl" "$pE"

# ═══ 2c. latest readers are epoch-exact — recycled names inherit nothing ═════
RALPH_HERDR_LEDGER="$TMP/unit3/ledger.jsonl"
ralph_ledger_append '{"ts":"t0","ev":"spawn","agent_ref":"s0-root#0001","tokens":{"role":"s","issue":"0","depth":"0"}}'
ralph_ledger_append '{"ts":"t1","ev":"spawn","agent_ref":"o10-orch#aaaa","pane_id":"pX","tokens":{"role":"o","issue":"10","parent":"s0-root#0001","depth":"1"}}'
ralph_ledger_append '{"ts":"t2","ev":"exit","agent_ref":"o10-orch#aaaa","reason":"pane_closed"}'
ralph_ledger_append '{"ts":"t3","ev":"discover","agent_ref":"o10-orch#bbbb","pane_id":"pY","tokens":{"role":"o","issue":"10"}}'
rc=0; out=$(_ralph_ledger_latest_parent 'o10-orch#bbbb' 2>/dev/null) || rc=$?
is "latest: a recycled name's NEW epoch inherits no parent edge (rc 1)" "1" "$rc"
is "latest: the dead epoch still answers for itself" "s0-root#0001" \
  "$(_ralph_ledger_latest_parent 'o10-orch#aaaa')"
is "latest: pane reads are epoch-exact too" "pY" "$(_ralph_ledger_latest_pane 'o10-orch#bbbb')"

# ═══ 3. watch-event: pane.agent_status_changed ═══════════════════════════════
WROOT="$TMP/wroot"
WLEDGER="$WROOT/acme/demo/ledger.jsonl"
mkdir -p "$WROOT/acme/demo"
cat >"$WLEDGER" <<'EOF'
{"ts":"2026-08-11T00:00:00Z","ev":"spawn","agent_ref":"w123-fix#aaaa","pane_id":"p1","tokens":{"role":"w","issue":"123","slug":"fix","root":"w123-fix#aaaa","depth":"0","state":"spawned","branch":"feature/GH-123","harness":"claude","spawn_epoch":"aaaa"}}
EOF

# A status event is a HINT now (GH-1774): the durable write only happens for an
# agent a live snapshot confirms, with the status read from the SNAPSHOT rather
# than the payload. So the herd has to actually contain the agent — and the
# fixture's status is the one that gets recorded.
herd_fixture '[{"name":"w123-fix","agent_status":"working","pane_id":"p1"}]'
: >"$FAKE_HERDR_LOG"
run_event pane.agent_status_changed \
  '{"pane_id":"p1","agent":"w123-fix","agent_status":"working","title":"Fix the flaky test"}' "$WROOT"
is "status working: exits 0" "0" "$RC"
is "status working: one state event appended" "1" \
  "$(lcount "$WLEDGER" '.ev=="state" and .agent_ref=="w123-fix#aaaa" and .agent_status=="working" and .via=="event"')"
is "status working: state token pushed" "1" \
  "$(log_count '^pane report-metadata p1 --source ralph-herdr --token state=working$')"
is "status working: no notification" "0" "$(log_count '^notification show')"

herd_fixture '[{"name":"w123-fix","agent_status":"blocked","pane_id":"p1"}]'
: >"$FAKE_HERDR_LOG"
run_event pane.agent_status_changed \
  '{"pane_id":"p1","agent":"w123-fix","agent_status":"blocked","title":"Fix the flaky test","state_labels":{"blocked":"needs a decision"}}' "$WROOT"
is "blocked: exits 0" "0" "$RC"
is "blocked: one state event appended" "1" \
  "$(lcount "$WLEDGER" '.ev=="state" and .agent_ref=="w123-fix#aaaa" and .agent_status=="blocked"')"
is "blocked: state token pushed" "1" \
  "$(log_count '^pane report-metadata p1 --source ralph-herdr --token state=blocked$')"
is "blocked: notified exactly once for the transition" "1" "$(log_count '^notification show')"
is "blocked: title + labels in the body" "1" \
  "$(log_fcount 'notification show w123-fix blocked --body Fix the flaky test')"

# idle carries no honest lifecycle claim: ledgered, but no state token push.
herd_fixture '[{"name":"w123-fix","agent_status":"idle","pane_id":"p1"}]'
: >"$FAKE_HERDR_LOG"
run_event pane.agent_status_changed \
  '{"pane_id":"p1","agent":"w123-fix","agent_status":"idle"}' "$WROOT"
is "idle: state event still recorded" "1" \
  "$(lcount "$WLEDGER" '.ev=="state" and .agent_status=="idle"')"
is "idle: no token push, no notification" "0" "$(log_count '^pane report-metadata\|^notification show')"

# Event-name fallback: no HERDR_PLUGIN_EVENT, payload .type carries it.
herd_fixture '[{"name":"w123-fix","agent_status":"working","pane_id":"p1"}]'
run_event "" \
  '{"type":"pane.agent_status_changed","pane_id":"p1","agent":"w123-fix","agent_status":"working"}' "$WROOT"
is "payload .type fallback: exits 0" "0" "$RC"
is "payload .type fallback: second working state event" "2" \
  "$(lcount "$WLEDGER" '.ev=="state" and .agent_status=="working"')"

# Non-ralph agents and unknown events are ignored without side effects.
: >"$FAKE_HERDR_LOG"
lines_before=$(wc -l <"$WLEDGER" | tr -d ' ')
run_event pane.agent_status_changed \
  '{"pane_id":"p9","agent":"random","agent_status":"blocked"}' "$WROOT"
is "non-ralph agent: exits 0" "0" "$RC"
run_event pane.focus_changed '{"pane_id":"p1"}' "$WROOT"
is "unknown event: exits 0" "0" "$RC"
is "non-ralph/unknown: ledger untouched" "$lines_before" "$(wc -l <"$WLEDGER" | tr -d ' ')"
is "non-ralph/unknown: no herdr calls at all" "0" "$(wc -l <"$FAKE_HERDR_LOG" | tr -d ' ')"

before_unconfirmed=$(lcount "$WLEDGER" '.ev=="state"')
before_working=$(lcount "$WLEDGER" '.ev=="state" and .agent_status=="working"')
# ── events are hints, not authority (GH-1774) ───────────────────────────────
# A status event names an agent, a status and a pane, and Herdr documents no
# ordering, no deduplication and no replay cursor for any of it. So a payload
# can describe a state the agent already left, an agent that already exited, or
# a name a NEWER agent has since reused. None of those may write durable state.
herd_fixture '[]'
: >"$FAKE_HERDR_LOG"
run_event pane.agent_status_changed \
  '{"pane_id":"p1","agent":"w123-fix","agent_status":"working"}' "$WROOT"
is "hint: an unconfirmed agent exits 0 (a hint is never an error)" "0" "$RC"
line_has "hint: and says it declined to write" "$OUT" "not confirmed in a live snapshot"
is "hint: no state event is appended for an unconfirmed agent" "$before_unconfirmed" \
  "$(lcount "$WLEDGER" '.ev=="state"')"

# The payload's status loses to the snapshot's. This is the case that matters
# for refill: a stale `done` must not free capacity while the agent works on.
herd_fixture '[{"name":"w123-fix","agent_status":"working","pane_id":"p1"}]'
run_event pane.agent_status_changed \
  '{"pane_id":"p1","agent":"w123-fix","agent_status":"done"}' "$WROOT"
# Counted, not timestamp-matched: binding an assertion to the current second
# makes it fail whenever the clock ticks mid-test.
is "hint: the SNAPSHOT status is recorded, not the payload's" "$((before_working + 1))" \
  "$(lcount "$WLEDGER" '.ev=="state" and .agent_status=="working"')"
is "hint: the payload's stale 'done' never reached the ledger" "0" \
  "$(lcount "$WLEDGER" '.ev=="state" and .agent_status=="done"')"

# Minting a durable identity from an event payload is gone: the payload has no
# durable identity, so the ref could only be derived from the NAME — and names
# are reusable after exit. Reconcile discovers instead, against a snapshot.
DROOT="$TMP/dirty"
DLEDG="$DROOT/acme/demo/ledger.jsonl"
mkdir -p "$(dirname "$DLEDG")"
: >"$DLEDG"
herd_fixture '[{"name":"w777-fresh","agent_status":"working","pane_id":"p9"}]'
run_event pane.agent_status_changed \
  '{"pane_id":"p9","agent":"w777-fresh","agent_status":"working"}' "$DROOT"
is "hint: an unledgered agent is NOT discovered by the event" "0" \
  "$(lcount "$DLEDG" '.ev=="discover"')"
is "hint: the scope is marked dirty instead" "1" \
  "$([ -f "$DROOT/acme/demo/dirty" ] && echo 1 || echo 0)"
line_has "hint: and says reconcile owns the identity" "$OUT" "reconcile mints the identity"

# The marker is a LEVEL, not a queue: an event storm leaves one marker, which
# is what keeps it from becoming a snapshot storm.
run_event pane.agent_status_changed \
  '{"pane_id":"p9","agent":"w777-fresh","agent_status":"working"}' "$DROOT"
run_event pane.agent_status_changed \
  '{"pane_id":"p9","agent":"w777-fresh","agent_status":"blocked"}' "$DROOT"
is "hint: repeated events coalesce to ONE marker" "1" \
  "$(ls "$DROOT/acme/demo/" | grep -c '^dirty$' || true)"

# Reconcile does the discovering, then clears the marker.
run_reconcile "$DROOT"
is "hint: reconcile discovers what the event would not" "1" \
  "$(lcount "$DLEDG" '.ev=="discover" and (.agent_ref | startswith("w777-fresh#"))')"
is "hint: and clears the dirty mark afterwards" "0" \
  "$([ -f "$DROOT/acme/demo/dirty" ] && echo 1 || echo 0)"

# ═══ 4. pane.exited: orphan pass, adopt-to-grandparent ═══════════════════════
AROOT="$TMP/aroot"
ALEDGER="$AROOT/acme/demo/ledger.jsonl"
mkdir -p "$AROOT/acme/demo"
cat >"$ALEDGER" <<'EOF'
{"ts":"t0","ev":"spawn","agent_ref":"s0-root#0001","pane_id":"p0","tokens":{"role":"s","issue":"0","slug":"root","depth":"0","state":"spawned","root":"s0-root#0001"}}
{"ts":"t1","ev":"spawn","agent_ref":"o10-orch#0002","pane_id":"p10","tokens":{"role":"o","issue":"10","slug":"orch","depth":"1","state":"spawned","parent":"s0-root#0001","root":"s0-root#0001"}}
{"ts":"t2","ev":"spawn","agent_ref":"w11-child#0003","pane_id":"p11","tokens":{"role":"w","issue":"11","slug":"child","depth":"2","state":"spawned","parent":"o10-orch#0002","root":"s0-root#0001"}}
EOF
herd_fixture '[{"name":"s0-root","agent_status":"working","pane_id":"p0"},{"name":"w11-child","agent_status":"working","pane_id":"p11"}]'

: >"$FAKE_HERDR_LOG"
run_event pane.exited '{"pane_id":"p10"}' "$AROOT"
is "adopt: exits 0" "0" "$RC"
is "adopt: exit recorded for the dead parent" "1" \
  "$(lcount "$ALEDGER" '.ev=="exit" and .agent_ref=="o10-orch#0002" and .reason=="pane_exited"')"
is "adopt: child re-parented to the live grandparent" "1" \
  "$(lcount "$ALEDGER" '.ev=="adopt" and .agent_ref=="w11-child#0003" and .parent=="s0-root#0001" and .prev_parent=="o10-orch#0002"')"
is "adopt: parent token updated on the child pane" "1" \
  "$(log_count '^pane report-metadata p11 --source ralph-herdr --token parent=s0-root#0001$')"
is "adopt: no orphan notification" "0" "$(log_count '^notification show')"
RALPH_HERDR_LEDGER="$ALEDGER"
is "adopt: dead parent closed, gp+child stay open" "s0-root#0001 w11-child#0003" \
  "$(ralph_ledger_open_agents | sort | tr '\n' ' ' | sed 's/ *$//')"

# ═══ 5. pane.exited: orphan pass, no live grandparent ════════════════════════
OROOT="$TMP/oroot"
OLEDGER="$OROOT/acme/demo/ledger.jsonl"
mkdir -p "$OROOT/acme/demo"
cat >"$OLEDGER" <<'EOF'
{"ts":"t0","ev":"spawn","agent_ref":"o20-solo#0004","pane_id":"p20","tokens":{"role":"o","issue":"20","slug":"solo","depth":"0","state":"spawned","root":"o20-solo#0004"}}
{"ts":"t1","ev":"spawn","agent_ref":"w21-kid#0005","pane_id":"p21","tokens":{"role":"w","issue":"21","slug":"kid","depth":"1","state":"spawned","parent":"o20-solo#0004","root":"o20-solo#0004"}}
EOF
herd_fixture '[{"name":"w21-kid","agent_status":"working","pane_id":"p21"}]'

: >"$FAKE_HERDR_LOG"
run_event pane.exited '{"pane_id":"p20"}' "$OROOT"
is "orphan: exits 0" "0" "$RC"
is "orphan: exit recorded for the dead parent" "1" \
  "$(lcount "$OLEDGER" '.ev=="exit" and .agent_ref=="o20-solo#0004" and .reason=="pane_exited"')"
is "orphan: child marked orphaned in the ledger" "1" \
  "$(lcount "$OLEDGER" '.ev=="state" and .agent_ref=="w21-kid#0005" and .state=="orphaned" and .prev_parent=="o20-solo#0004"')"
is "orphan: state token pushed" "1" \
  "$(log_count '^pane report-metadata p21 --source ralph-herdr --token state=orphaned$')"
is "orphan: notified exactly once" "1" "$(log_count '^notification show w21-kid orphaned')"
is "orphan: no other notifications" "1" "$(log_count '^notification show')"

# A later reconcile sees the same orphan edge and must NOT re-notify or
# re-append (the already-orphaned skip in ralph_ledger_orphan_pass).
: >"$FAKE_HERDR_LOG"
lines_before=$(wc -l <"$OLEDGER" | tr -d ' ')
run_reconcile "$OROOT"
is "orphan re-pass: reconcile exits 0" "0" "$RC"
is "orphan re-pass: no duplicate ledger events" "$lines_before" "$(wc -l <"$OLEDGER" | tr -d ' ')"
is "orphan re-pass: no duplicate notification" "0" "$(log_count '^notification show')"

# ═══ 5b. RACING pane.exited + pane.closed — one death, one record set ════════
# The server subscribes both because either can arrive alone, and it runs
# hook commands CONCURRENTLY. The per-ledger mutex makes the loser re-read a
# ledger the winner already amended: exactly one exit, one orphaned state,
# one notification — never the doubled set the unserialized read produced.
CROOT="$TMP/croot"
CLEDGER="$CROOT/acme/demo/ledger.jsonl"
mkdir -p "$CROOT/acme/demo"
cat >"$CLEDGER" <<'EOF'
{"ts":"t0","ev":"spawn","agent_ref":"o30-dual#0006","pane_id":"p30","tokens":{"role":"o","issue":"30","slug":"dual","depth":"0","state":"spawned","root":"o30-dual#0006"}}
{"ts":"t1","ev":"spawn","agent_ref":"w31-baby#0007","pane_id":"p31","tokens":{"role":"w","issue":"31","slug":"baby","depth":"1","state":"spawned","parent":"o30-dual#0006","root":"o30-dual#0006"}}
EOF
herd_fixture '[{"name":"w31-baby","agent_status":"working","pane_id":"p31"}]'
: >"$FAKE_HERDR_LOG"
HERDR_PLUGIN_EVENT=pane.exited HERDR_PLUGIN_EVENT_JSON='{"pane_id":"p30"}' \
  RALPH_HERDR_LEDGER_ROOT="$CROOT" bash "$SCRIPTS/watch-event.sh" >/dev/null 2>&1 &
race_pid1=$!
HERDR_PLUGIN_EVENT=pane.closed HERDR_PLUGIN_EVENT_JSON='{"pane_id":"p30"}' \
  RALPH_HERDR_LEDGER_ROOT="$CROOT" bash "$SCRIPTS/watch-event.sh" >/dev/null 2>&1 &
race_pid2=$!
rc1=0; wait "$race_pid1" || rc1=$?
rc2=0; wait "$race_pid2" || rc2=$?
is "race: both hooks exit 0" "0:0" "$rc1:$rc2"
is "race: exactly ONE exit event for the dead parent" "1" \
  "$(lcount "$CLEDGER" '.ev=="exit" and .agent_ref=="o30-dual#0006"')"
is "race: exactly ONE orphaned state event for the child" "1" \
  "$(lcount "$CLEDGER" '.ev=="state" and .agent_ref=="w31-baby#0007" and .state=="orphaned"')"
is "race: exactly ONE orphan notification" "1" "$(log_count '^notification show')"
is "race: the mutex is released afterwards" "0" \
  "$([ -d "$CROOT/acme/demo/.ledger.lock" ] && echo 1 || echo 0)"

# ═══ 6. reconcile: discover / lost / token re-push ═══════════════════════════
RROOT="$TMP/rroot"
RLEDGER="$RROOT/acme/demo/ledger.jsonl"
mkdir -p "$RROOT/acme/demo" "$TMP/repo"
printf '{"owner":"acme","repo":"demo"}\n' >"$TMP/repo/.ralph.json"
cat >"$RLEDGER" <<'EOF'
{"ts":"t0","ev":"spawn","agent_ref":"w123-fix#aaaa","pane_id":"p1","tokens":{"role":"w","issue":"123","slug":"fix","root":"w123-fix#aaaa","depth":"0","state":"spawned","branch":"feature/GH-123","harness":"claude","spawn_epoch":"aaaa"}}
{"ts":"t1","ev":"spawn","agent_ref":"w9-gone#ffff","pane_id":"p9","tokens":{"role":"w","issue":"9","slug":"gone","depth":"0","state":"spawned"}}
EOF
herd_fixture '[{"name":"w123-fix","agent_status":"working","pane_id":"p1"},{"name":"w5-alpha","agent_status":"idle","pane_id":"p5"},{"name":"ralph-deliver","agent_status":"working","pane_id":"p7"},{"name":"random-agent","agent_status":"working","pane_id":"p8"}]'
printf '{"result":{"pane":{"pane_id":"p5","foreground_cwd":"%s"}}}\n' "$TMP/repo" \
  >"$FAKE_HERDR_FIXTURES/pane-get.p5.json"

: >"$FAKE_HERDR_LOG"
run_reconcile "$RROOT"
is "reconcile: exits 0" "0" "$RC"
case "$OUT" in
  *"reconcile complete"*) ok "reconcile: single pass, then exit" ;;
  *) not_ok "reconcile: single pass, then exit — no completion line in '$OUT'" ;;
esac
is "reconcile: open agent with no live counterpart marked lost" "1" \
  "$(lcount "$RLEDGER" '.ev=="exit" and .agent_ref=="w9-gone#ffff" and .reason=="lost" and .via=="reconcile"')"
is "reconcile: unledgered live agent discovered (fresh ref + tokens)" "1" \
  "$(lcount "$RLEDGER" '.ev=="discover" and (.agent_ref | test("^w5-alpha#[0-9a-f]{4}$")) and .pane_id=="p5" and .via=="reconcile" and .tokens.role=="w" and .tokens.issue=="5" and .tokens.slug=="alpha"')"
is "reconcile: legacy singleton never ledgered" "0" \
  "$(grep -c 'ralph-deliver' "$RLEDGER" || true)"
is "reconcile: non-ralph agent never ledgered" "0" \
  "$(grep -c 'random-agent' "$RLEDGER" || true)"

p1line=$(grep '^pane report-metadata p1 ' "$FAKE_HERDR_LOG" || true)
is "re-push: exactly one push for the live pane p1" "1" "$(log_count '^pane report-metadata p1 ')"
line_has  "re-push: spawn tokens replayed (role)"   "$p1line" "--token role=w"
line_has  "re-push: spawn tokens replayed (issue)"  "$p1line" "--token issue=123"
line_has  "re-push: spawn tokens replayed (branch)" "$p1line" "--token branch=feature/GH-123"
line_has  "re-push: live status supersedes the recorded state" "$p1line" "--token state=working"
line_lacks "re-push: stale recorded state dropped"  "$p1line" "--token state=spawned"
p5line=$(grep '^pane report-metadata p5 ' "$FAKE_HERDR_LOG" || true)
line_has  "re-push: discovered agent gets its tokens" "$p5line" "--token slug=alpha"
line_lacks "re-push: idle maps to no state claim"     "$p5line" "--token state="
RALPH_HERDR_LEDGER="$RLEDGER"
is "reconcile: open set is live-and-ledgered only (epochs stripped)" "w123-fix w5-alpha" \
  "$(ralph_ledger_open_agents | sed 's/#[0-9a-f]*$//' | sort | tr '\n' ' ' | sed 's/ *$//')"

# A sick server must never mark the herd lost: agent list fails → no-op pass.
lines_before=$(wc -l <"$RLEDGER" | tr -d ' ')
RC=0
OUT=$(RALPH_HERDR_LEDGER_ROOT="$RROOT" HERDR_BIN_PATH=/usr/bin/false \
  bash "$SCRIPTS/reconcile.sh" 2>&1) || RC=$?
is "sick server: reconcile still exits 0" "0" "$RC"
case "$OUT" in
  *"not reconciling"*) ok "sick server: declines the pass loudly" ;;
  *) not_ok "sick server: declines the pass loudly — got '$OUT'" ;;
esac
is "sick server: ledger untouched" "$lines_before" "$(wc -l <"$RLEDGER" | tr -d ' ')"

# ═══ 7. depth guard: refusal at depth 2 ══════════════════════════════════════
DLEDGER="$TMP/depth/ledger.jsonl"
mkdir -p "$TMP/depth"
cat >"$DLEDGER" <<'EOF'
{"ts":"t0","ev":"spawn","agent_ref":"w11-child#bbbb","tokens":{"role":"w","issue":"11","slug":"child","depth":"1","state":"spawned"}}
{"ts":"t1","ev":"spawn","agent_ref":"w12-grand#cccc","tokens":{"role":"w","issue":"12","slug":"grand","depth":"2","state":"spawned"}}
EOF
# lib.sh needs a board CLI at source time — the repo's own checkout provides it.
depth_probe() {
  env RALPH_HERDR_REPO="$ROOT" RALPH_HERDR_LEDGER="$DLEDGER" \
    bash -c ". '$SCRIPTS/lib.sh'; ralph_depth_guard \"\$1\"" depth-probe "$1"
}
is "depth: child of a depth-1 parent is depth 2 (allowed)" "2" "$(depth_probe 'w11-child#bbbb' 2>/dev/null)"
fails "depth: a depth-2 parent is refused (cap: 3 levels, depths 0-2)" depth_probe 'w12-grand#cccc'
RC=0
MSG=$(depth_probe 'w12-grand#cccc' 2>&1) || RC=$?
is "depth: refusal rc is 1" "1" "$RC"
case "$MSG" in
  *"refusing a herdr-plane child"*) ok "depth: refusal names the cap" ;;
  *) not_ok "depth: refusal names the cap — got '$MSG'" ;;
esac

# ═══ 8. reconcile: claim recovery for a worker its pane outlived (GH-1809) ═══
# One pass over five open records that differ ONLY in what their pane says, so
# each assertion isolates one verdict. The board CLI is fake-board.sh, and its
# invocation log is the assertion surface: what matters is not just which
# claims were released but that the others were never even asked about.
CROOT="$TMP/croot"
CLEDGER="$CROOT/acme/demo/ledger.jsonl"
mkdir -p "$CROOT/acme/demo"
export FAKE_BOARD_FIXTURES="$TMP/board-fixtures"
export FAKE_BOARD_LOG="$TMP/board.log"
mkdir -p "$FAKE_BOARD_FIXTURES"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-board.sh" >"$BIN/board"
chmod +x "$BIN/board"

# The checkout every record points at — a real git repo, because the scope
# guard resolves it through `git rev-parse --show-toplevel` before writing.
CREPO="$TMP/crepo"
mkdir -p "$CREPO"
printf '{"owner":"acme","repo":"demo","projectNumber":1}\n' >"$CREPO/.ralph.json"
git -C "$CREPO" init -q 2>/dev/null
git -C "$CREPO" config user.email t@t 2>/dev/null
git -C "$CREPO" config user.name t 2>/dev/null
# …and one pointing at a DIFFERENT board, for the cross-repo refusal.
CFOREIGN="$TMP/cforeign"
mkdir -p "$CFOREIGN"
printf '{"owner":"other","repo":"elsewhere","projectNumber":9}\n' >"$CFOREIGN/.ralph.json"
git -C "$CFOREIGN" init -q 2>/dev/null

cat >"$CLEDGER" <<EOF
{"ts":"t0","ev":"spawn","agent_ref":"w201-restart#a1","pane_id":"pR","shell_pid":"5001","checkout":"$CREPO","tokens":{"role":"w","issue":"201","harness":"claude","state":"spawned"}}
{"ts":"t0","ev":"spawn","agent_ref":"w202-crash#a2","pane_id":"pC","shell_pid":"5002","checkout":"$CREPO","tokens":{"role":"w","issue":"202","harness":"claude","state":"spawned"}}
{"ts":"t0","ev":"spawn","agent_ref":"w203-alive#a3","pane_id":"pA","shell_pid":"5003","checkout":"$CREPO","tokens":{"role":"w","issue":"203","harness":"claude","state":"spawned"}}
{"ts":"t0","ev":"spawn","agent_ref":"w204-unknown#a4","pane_id":"pU","shell_pid":"5004","checkout":"$CREPO","tokens":{"role":"w","issue":"204","harness":"claude","state":"spawned"}}
{"ts":"t0","ev":"spawn","agent_ref":"w205-foreign#a5","pane_id":"pF","shell_pid":"5005","checkout":"$CFOREIGN","tokens":{"role":"w","issue":"205","harness":"claude","state":"spawned"}}
EOF
# Every record's agent is LIVE in the herd — the point of the phase: after a
# restart the names are all still there, and only the pane tells the truth.
herd_fixture '[{"name":"w201-restart","agent_status":"idle","pane_id":"pR"},{"name":"w202-crash","agent_status":"idle","pane_id":"pC"},{"name":"w203-alive","agent_status":"working","pane_id":"pA"},{"name":"w204-unknown","agent_status":"idle","pane_id":"pU"},{"name":"w205-foreign","agent_status":"idle","pane_id":"pF"}]' "$CREPO"

# pR: the pane was REBUILT — a different shell, and a `claude --resume` already
# relaunched into it. The live process is exactly the trap: a presence check
# would call this alive.
printf '{"process_info":{"pane_id":"pR","shell_pid":7001,"foreground_processes":[{"argv0":"claude","name":"2.1.229","pid":7100}]}}\n' \
  >"$FAKE_HERDR_FIXTURES/pane-process-info.pR.json"
# pC: same shell, nothing running — it died in place.
printf '{"process_info":{"pane_id":"pC","shell_pid":5002,"foreground_processes":[]}}\n' \
  >"$FAKE_HERDR_FIXTURES/pane-process-info.pC.json"
# pA: same shell, claude still working.
printf '{"process_info":{"pane_id":"pA","shell_pid":5003,"foreground_processes":[{"argv0":"claude","name":"2.1.229","pid":5300}]}}\n' \
  >"$FAKE_HERDR_FIXTURES/pane-process-info.pA.json"
# pU: the server cannot answer — a transport failure, not an answer.
printf 'not json at all\n' >"$FAKE_HERDR_FIXTURES/pane-process-info.pU.raw"
# pF: dead pane, but its checkout belongs to another board.
printf '{"process_info":{"pane_id":"pF","shell_pid":9999,"foreground_processes":[]}}\n' \
  >"$FAKE_HERDR_FIXTURES/pane-process-info.pF.json"

for _i in 201 202 205; do
  printf '{"number":%s,"state":"In Progress","claim":{"holders":["t@h"],"since":"2026-08-13T00:00:00Z"}}\n' "$_i" \
    >"$FAKE_BOARD_FIXTURES/get.$_i.json"
done

: >"$FAKE_BOARD_LOG"
RC=0
OUT=$(RALPH_HERDR_LEDGER_ROOT="$CROOT" RALPH_HERDR_BOARD="$BIN/board" \
  bash "$SCRIPTS/reconcile.sh" 2>&1) || RC=$?
is "claim recovery: pass exits 0" "0" "$RC"

is "restart-killed: record closed with the specific reason" "1" \
  "$(lcount "$CLEDGER" '.ev=="exit" and .agent_ref=="w201-restart#a1" and .reason=="restart_killed"')"
is "restart-killed: claim released" "1" \
  "$(grep -c '^release 201 ' "$FAKE_BOARD_LOG" || true)"
is "crashed-in-place: recorded as crashed, not restart_killed" "1" \
  "$(lcount "$CLEDGER" '.ev=="exit" and .agent_ref=="w202-crash#a2" and .reason=="crashed"')"
is "crashed-in-place: claim released" "1" \
  "$(grep -c '^release 202 ' "$FAKE_BOARD_LOG" || true)"
is "live worker: record left open" "0" \
  "$(lcount "$CLEDGER" '.ev=="exit" and .agent_ref=="w203-alive#a3"')"
is "live worker: board never touched" "0" \
  "$(grep -c ' 203 ' "$FAKE_BOARD_LOG" || true)"
is "unreadable pane: record left open (unknown releases nothing)" "0" \
  "$(lcount "$CLEDGER" '.ev=="exit" and .agent_ref=="w204-unknown#a4"')"
is "unreadable pane: board never touched" "0" \
  "$(grep -c ' 204 ' "$FAKE_BOARD_LOG" || true)"
is "cross-repo: dead worker's record still closed" "1" \
  "$(lcount "$CLEDGER" '.ev=="exit" and .agent_ref=="w205-foreign#a5"')"
is "cross-repo: another board is never written" "0" \
  "$(grep -c ' 205 ' "$FAKE_BOARD_LOG" || true)"
case "$OUT" in
  *"refusing to write another board"*) ok "cross-repo: the refusal says why" ;;
  *) not_ok "cross-repo: the refusal says why — got '$OUT'" ;;
esac

# The state gate: a worker that got its PR up before dying is In Review, and
# `release` is neither legal nor wanted there.
CROOT2="$TMP/croot2"
mkdir -p "$CROOT2/acme/demo"
cat >"$CROOT2/acme/demo/ledger.jsonl" <<EOF
{"ts":"t0","ev":"spawn","agent_ref":"w206-inreview#a6","pane_id":"pC","shell_pid":"5002","checkout":"$CREPO","tokens":{"role":"w","issue":"206","harness":"claude","state":"spawned"}}
EOF
herd_fixture '[{"name":"w206-inreview","agent_status":"idle","pane_id":"pC"}]' "$CREPO"
printf '{"number":206,"state":"In Review","claim":{"holders":["t@h"],"since":"2026-08-13T00:00:00Z"}}\n' \
  >"$FAKE_BOARD_FIXTURES/get.206.json"
: >"$FAKE_BOARD_LOG"
OUT=$(RALPH_HERDR_LEDGER_ROOT="$CROOT2" RALPH_HERDR_BOARD="$BIN/board" \
  bash "$SCRIPTS/reconcile.sh" 2>&1) || true
is "In Review: never released" "0" "$(grep -c '^release 206 ' "$FAKE_BOARD_LOG" || true)"
is "In Review: the board was still consulted" "1" "$(grep -c '^get 206 ' "$FAKE_BOARD_LOG" || true)"

# A refusal from board.ts (guardHolder: not this machine's claim) is reported,
# never worked around — there is no --force anywhere in this system.
CROOT3="$TMP/croot3"
mkdir -p "$CROOT3/acme/demo"
cat >"$CROOT3/acme/demo/ledger.jsonl" <<EOF
{"ts":"t0","ev":"spawn","agent_ref":"w207-refused#a7","pane_id":"pC","shell_pid":"5002","checkout":"$CREPO","tokens":{"role":"w","issue":"207","harness":"claude","state":"spawned"}}
EOF
herd_fixture '[{"name":"w207-refused","agent_status":"idle","pane_id":"pC"}]' "$CREPO"
printf '{"number":207,"state":"In Progress","claim":{"holders":["someone@else"],"since":"2026-08-13T00:00:00Z"}}\n' \
  >"$FAKE_BOARD_FIXTURES/get.207.json"
echo 1 >"$FAKE_BOARD_FIXTURES/release.207.rc"
printf '#207 is claimed by someone@else — wait for TTL expiry or have the holder release it.\n' \
  >"$FAKE_BOARD_FIXTURES/release.207.json"
: >"$FAKE_BOARD_LOG"
RC=0
OUT=$(RALPH_HERDR_LEDGER_ROOT="$CROOT3" RALPH_HERDR_BOARD="$BIN/board" \
  bash "$SCRIPTS/reconcile.sh" 2>&1) || RC=$?
is "board refusal: the pass still exits 0" "0" "$RC"
is "board refusal: attempted exactly once, never retried" "1" \
  "$(grep -c '^release 207 ' "$FAKE_BOARD_LOG" || true)"
case "$OUT" in
  *"claim NOT released for GH-207"*) ok "board refusal: reported in the log" ;;
  *) not_ok "board refusal: reported in the log — got '$OUT'" ;;
esac

# The wrong-server case, end to end — the one that would have been a disaster.
# herdr fires [[startup]] for EVERY server, so an isolated session's scratch
# server runs this pass against the real ledgers while knowing none of these
# panes. Phase A then marks every live worker `lost` (observed live on
# 2026-08-13, five workers in one sweep). The requirement is absolute: not one
# board call, from either phase.
CROOT4="$TMP/croot4"
mkdir -p "$CROOT4/acme/demo"
cat >"$CROOT4/acme/demo/ledger.jsonl" <<EOF
{"ts":"t0","ev":"spawn","agent_ref":"w208-live#a8","pane_id":"pGONE","shell_pid":"5008","checkout":"$CREPO","tokens":{"role":"w","issue":"208","harness":"claude","state":"spawned"}}
{"ts":"t0","ev":"spawn","agent_ref":"w209-legacy#a9","pane_id":"pC","checkout":"$CREPO","tokens":{"role":"w","issue":"209","harness":"claude","state":"spawned"}}
EOF
# An empty herd is exactly what a foreign server reports about our agents.
herd_fixture '[]' "$CREPO"
printf '{"error":{"code":"pane_not_found","message":"pane not found"}}\n' \
  >"$FAKE_HERDR_FIXTURES/pane-process-info.pGONE.json"
: >"$FAKE_BOARD_LOG"
RC=0
OUT=$(RALPH_HERDR_LEDGER_ROOT="$CROOT4" RALPH_HERDR_BOARD="$BIN/board" \
  bash "$SCRIPTS/reconcile.sh" 2>&1) || RC=$?
is "wrong server: pass exits 0" "0" "$RC"
is "wrong server: phase A still closes the records (ledger is recoverable)" "2" \
  "$(lcount "$CROOT4/acme/demo/ledger.jsonl" '.ev=="exit" and .reason=="lost"')"
is "wrong server: NOT ONE board call, from either phase" "0" \
  "$(wc -l <"$FAKE_BOARD_LOG" | tr -d ' ')"
is "legacy record (no recorded shell pid): empty pane releases nothing" "0" \
  "$(grep -c ' 209 ' "$FAKE_BOARD_LOG" || true)"

# ═══ 9. worker verdict — the unit table ══════════════════════════════════════
# shellcheck source=../scripts/sanitize.sh
. "$SCRIPTS/sanitize.sh"
# shellcheck source=../scripts/transport.sh
. "$SCRIPTS/transport.sh"
# shellcheck source=../scripts/claim-recover.sh
. "$SCRIPTS/claim-recover.sh"
is "verdict: rebuilt pane outranks a live process"  "restart_killed" "$(ralph_worker_verdict pR 5001 claude)"
is "verdict: same shell, no harness → crashed"      "crashed"        "$(ralph_worker_verdict pC 5002 claude)"
is "verdict: same shell, harness running → alive"   "alive"          "$(ralph_worker_verdict pA 5003 claude)"
is "verdict: unreadable answer → unknown"           "unknown"        "$(ralph_worker_verdict pU 5004 claude)"
# No recorded pid = no way to tell this pane from a stranger's, whatever it
# looks like. The pid is the ticket to a board write; an empty pane without one
# proves nothing.
is "verdict: no recorded shell pid → unknown, even for an empty pane" "unknown" \
  "$(ralph_worker_verdict pC '' claude)"
is "verdict: no pane at all → unknown"              "unknown"        "$(ralph_worker_verdict '' 5001 claude)"
# The wrong-server trap, and the reason this is not special-cased as a death:
# `pane_not_found` is also what a perfectly healthy server says about a pane
# belonging to a DIFFERENT server — which is the situation a [[startup]] hook
# fired by an isolated session's server actually creates (observed 2026-08-13).
printf '{"error":{"code":"pane_not_found","message":"pane not found"}}\n' \
  >"$FAKE_HERDR_FIXTURES/pane-process-info.pX.json"
is "verdict: pane_not_found is an absence, not a death" "unknown" \
  "$(ralph_worker_verdict pX 5001 claude)"
# The version-string trap: herdr reports a claude process's `name` as its
# version, so a verdict matching on `.name` would call every live worker dead.
printf '{"process_info":{"pane_id":"pV","shell_pid":5006,"foreground_processes":[{"argv0":"claude","name":"2.1.229","pid":5600}]}}\n' \
  >"$FAKE_HERDR_FIXTURES/pane-process-info.pV.json"
is "verdict: matches argv0, not the version-string name" "alive" \
  "$(ralph_worker_verdict pV 5006 claude)"

# ═══ notify-watch.sh: an unreadable poll is not a state (GH-1855) ═══════════
# Both poll sites parsed `agent get` themselves and ended in `// "unknown"`,
# which handed the branch table a state string for a response nobody could
# parse. Routed through the adapter, the three outcomes are distinct: a status,
# a gone verdict herdr actually gave, and "could not find out".
#
# The watcher never exits while a target is unreadable — that is the property
# under test — so the runs below are bounded by the harness, not by a timeout
# binary the runner may not ship.
rm -f "$FAKE_HERDR_FIXTURES"/agent-get.* "$FAKE_HERDR_FIXTURES"/agent-wait.*

# watch_until SUBSTR TARGET… — run notify-watch.sh until it prints SUBSTR or
# exits; then stop it. Sets WATCH_OUT, WATCH_EXITED (1 if it exited on its own
# before we stopped it) and WATCH_RC (its exit code — only meaningful then).
# $WATCH_POLL_ENV overrides the poll knob, including with junk.
watch_until() {
  local want="$1" i=0 pid
  shift
  : >"$TMP/notify-watch.out"
  RALPH_HERDR_WATCH_POLL="${WATCH_POLL_ENV:-1}" RALPH_HERDR_REPO="$REPO_DIR" RALPH_HERDR_BOARD="$BIN/board" \
    bash "$SCRIPTS/notify-watch.sh" "$@" >"$TMP/notify-watch.out" 2>&1 &
  pid=$!
  WATCH_EXITED=0
  while [ "$i" -lt 50 ]; do
    grep -qF -- "$want" "$TMP/notify-watch.out" 2>/dev/null && break
    if ! kill -0 "$pid" 2>/dev/null; then WATCH_EXITED=1; break; fi
    sleep 0.2
    i=$((i + 1))
  done
  # The line can land a beat before the process does: gone() notifies and THEN
  # exits. Give it a poll interval to finish before calling it still-watching.
  i=0
  while [ "$WATCH_EXITED" -eq 0 ] && [ "$i" -lt 6 ]; do
    kill -0 "$pid" 2>/dev/null || { WATCH_EXITED=1; break; }
    sleep 0.2
    i=$((i + 1))
  done
  kill "$pid" 2>/dev/null || true
  WATCH_RC=0
  wait "$pid" 2>/dev/null || WATCH_RC=$?
  WATCH_OUT=$(cat "$TMP/notify-watch.out")
}

printf '{"agent":{"name":"w-done","agent_status":"done","pane_id":"p1","workspace_id":"w1","tab_id":"w1:t1","terminal_id":"t","focused":false,"revision":1}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-get.w-done.json"
# A refusal: the envelope on stderr, stdout empty, nonzero exit — what 0.8.x
# does. `agent_not_found` is the code the live binary answers (probed).
printf '{"error":{"code":"agent_not_found","message":"agent target w-gone not found"}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-get.w-gone.json"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-get.w-gone.rc"
# A well-formed agent_info success carrying no agent_status: the response that
# used to become the state "unknown".
printf '{"agent":{"name":"w-mute","pane_id":"p1"}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-get.w-mute.json"

watch_until "read failed for w-mute" w-done w-gone w-mute
line_has  "watch: a done agent notifies and drops" "$WATCH_OUT" "notify [w-done] ralph: w-done done"
line_has  "watch: herdr's agent_not_found is reported as gone" "$WATCH_OUT" "notify [w-gone] ralph: w-gone gone"
line_has  "watch: a statusless success is a failed read" "$WATCH_OUT" "read failed for w-mute"
line_lacks "watch: an unreadable poll never becomes the state 'unknown'" "$WATCH_OUT" "w-mute unknown"
line_lacks "watch: an unreadable target is never announced gone" "$WATCH_OUT" "w-mute gone"
is "watch: an unreadable target keeps the watcher alive" "0" "$WATCH_EXITED"
line_lacks "watch: …so the watcher does not claim the herd finished" "$WATCH_OUT" "all watched agents finished"

# Single target: same three outcomes, through the same helper.
watch_until "read failed for w-mute" w-mute
line_has  "watch (single): an unreadable read backs off instead of ending the watch" \
  "$WATCH_OUT" "read failed for w-mute — retrying"
line_lacks "watch (single): an unreadable read is not a gone verdict" "$WATCH_OUT" "w-mute gone"
is "watch (single): the watcher is still watching" "0" "$WATCH_EXITED"

watch_until "notify [w-gone]" w-gone
line_has "watch (single): a refused get IS a gone verdict" "$WATCH_OUT" "notify [w-gone] ralph: w-gone gone"
is "watch (single): and the watch ends there" "1" "$WATCH_EXITED"

# ── `agent wait` is adapted too, or the get branch is unreachable (GH-1870) ──
# GH-1855 routed the two `agent get` polls through the adapter and left
# `wait_for` reading a bare exit status three lines above the new backoff, so
# `wait_for || gone` still read ANY nonzero — a herdr outage, a dropped socket,
# a missing binary — as "the agent departed". Reproduced with a herdr that
# fails every call: the watcher announced gone and exited 0, and the adapted
# `agent get` branch below it was never reached.
#
# An empty body at a nonzero exit is that server: nothing on either pipe.
: >"$FAKE_HERDR_FIXTURES/agent-wait.w-blip.raw"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-wait.w-blip.rc"
watch_until "wait failed for w-blip" w-blip
line_has  "wait: an unanswered wait backs off" "$WATCH_OUT" "wait failed for w-blip — retrying"
line_lacks "wait: an unreachable server is NOT a departure" "$WATCH_OUT" "w-blip gone"
is "wait: the watcher keeps watching a live agent through the blip" "0" "$WATCH_EXITED"

# …and the verdict that DOES end a watch still does. herdr answers
# agent_not_found for a departed session on `agent wait` too (probed on 0.8.x),
# so this is the one nonzero that means gone.
printf '{"error":{"code":"agent_not_found","message":"agent target w-left not found"}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-wait.w-left.json"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-wait.w-left.rc"
watch_until "notify [w-left]" w-left
line_has "wait: herdr's agent_not_found still ends the watch" "$WATCH_OUT" "notify [w-left] ralph: w-left gone"
is "wait: and the process exits cleanly" "1" "$WATCH_EXITED"

# ── a malformed poll knob may not kill the watch (GH-1870) ──────────────────
# validate_pos_int had been hoisted above the mode branch, making a junk value
# FATAL for single-target watches that previously ignored it. Every spawn path
# `exec`s into this watcher AFTER its agent is live, and exec discards
# hold_pane's EXIT trap — so the pane closed instantly, took the error line
# with it, and left the just-spawned agent unwatched. RALPH_* vars are exported
# from shell profiles and inherited by every pane, so the junk value is a live
# route, not a hypothetical.
WATCH_POLL_ENV=15s
watch_until "notify [w-done]" w-done
line_has "poll knob: a malformed value warns" "$WATCH_OUT" \
  "ignoring RALPH_HERDR_WATCH_POLL='15s'"
line_has "poll knob: …and the watch still happens" "$WATCH_OUT" "notify [w-done] ralph: w-done done"
is "poll knob: the watcher is not killed by it (single target)" "0" "$WATCH_RC"

# Both modes read the knob through the same resolver, so neither dies on it.
watch_until "all watched agents finished" w-done w-gone
line_has "poll knob: the multi-target loop degrades the same way" "$WATCH_OUT" \
  "ignoring RALPH_HERDR_WATCH_POLL='15s'"
is "poll knob: the watcher is not killed by it (multi target)" "0" "$WATCH_RC"
WATCH_POLL_ENV=

rm -f "$FAKE_HERDR_FIXTURES"/agent-get.* "$FAKE_HERDR_FIXTURES"/agent-wait.*

echo "1..$n"
echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
