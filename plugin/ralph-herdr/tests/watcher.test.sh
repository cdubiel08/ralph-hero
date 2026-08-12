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

: >"$FAKE_HERDR_LOG"
run_event pane.agent_status_changed \
  '{"pane_id":"p1","agent":"w123-fix","agent_status":"working","title":"Fix the flaky test"}' "$WROOT"
is "status working: exits 0" "0" "$RC"
is "status working: one state event appended" "1" \
  "$(lcount "$WLEDGER" '.ev=="state" and .agent_ref=="w123-fix#aaaa" and .agent_status=="working" and .via=="event"')"
is "status working: state token pushed" "1" \
  "$(log_count '^pane report-metadata p1 --source ralph-herdr --token state=working$')"
is "status working: no notification" "0" "$(log_count '^notification show')"

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
: >"$FAKE_HERDR_LOG"
run_event pane.agent_status_changed \
  '{"pane_id":"p1","agent":"w123-fix","agent_status":"idle"}' "$WROOT"
is "idle: state event still recorded" "1" \
  "$(lcount "$WLEDGER" '.ev=="state" and .agent_status=="idle"')"
is "idle: no token push, no notification" "0" "$(log_count '^pane report-metadata\|^notification show')"

# Event-name fallback: no HERDR_PLUGIN_EVENT, payload .type carries it.
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

echo "1..$n"
echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
