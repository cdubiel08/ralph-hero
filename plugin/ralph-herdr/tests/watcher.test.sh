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
# lcount FILE JQ_BOOL_EXPR — number of ledger records matching the expression.
# Reads through _ralph_ledger_events: since phase D (GH-2311) appends land in
# the sqlite tape, and the raw jsonl no longer carries them.
lcount() { _ralph_ledger_events "$1" 2>/dev/null | jq -rs "[.[] | select($2)] | length"; }
# levents FILE — the ledger's event stream (either tape form)
levents() { _ralph_ledger_events "$1" 2>/dev/null; }
# ecount FILE — total events on the tape (0 when no ledger exists yet)
ecount() { _ralph_ledger_events "$1" 2>/dev/null | grep -c . | tr -d " "; }
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
is "append: stored compact, one event" \
  "{\"ts\":\"2026-08-11T00:00:00Z\",\"ev\":\"spawn\",\"agent_ref\":\"w1-a#0001\",\"session\":\"$(ralph_session_key)\"}" \
  "$(levents "$RALPH_HERDR_LEDGER")"
[ -f "$RALPH_HERDR_LEDGER" ] && not_ok "append: no jsonl is written (the tape is sqlite, phase D)" || ok "append: no jsonl is written (the tape is sqlite, phase D)"

fails "append: refuses non-JSON" ralph_ledger_append 'not json'
fails "append: refuses two documents on one line" ralph_ledger_append '{"a":1} {"b":2}'
fails "append: refuses two documents split by a newline" ralph_ledger_append '{"a":1}
{"b":2}'
big=$(printf '%4200s' '' | tr ' ' 'x')
rc=0; ralph_ledger_append "{\"pad\":\"$big\"}" 2>/dev/null || rc=$?
is "append: the 4096-byte ceiling is LIFTED (phase D — it protected JSONL O_APPEND atomicity)" "0" "$rc"

rc=0; ralph_ledger_append '{"ev":"state","agent_ref":"w1-a#0001","note":"line1\nline2"}' || rc=$?
is "append: an ESCAPED newline in a value is fine (rc 0)" "0" "$rc"
is "append: refused writes never touched the tape (3 events)" "3" \
  "$(ecount "$RALPH_HERDR_LEDGER")"

# GH-1933: the writer's session key rides on EVERY record, stamped by append so
# no call site can forget it. It is what proves a ledger ours once its last
# pane is gone.
ralph_ledger_append '{"ts":"t","ev":"spawn","agent_ref":"w2-b#0002","session":"theirs"}'
is "append: a caller-supplied session is preserved, not overwritten" "theirs" \
  "$(levents "$RALPH_HERDR_LEDGER" | jq -r 'select(.agent_ref=="w2-b#0002") | .session')"
is "append: open sessions are the OPENING records' writers" "$(ralph_session_key) theirs" \
  "$(ralph_ledger_open_sessions | sort | tr '\n' ' ' | sed 's/ *$//')"
# An exit written by a DIFFERENT server must not hand that server ownership of
# a record it never opened.
ralph_ledger_append '{"ts":"t","ev":"exit","agent_ref":"w2-b#0002","reason":"lost","session":"stranger"}'
is "append: a foreign exit closes the record without claiming it" "$(ralph_session_key)" \
  "$(ralph_ledger_open_sessions | sort | tr '\n' ' ' | sed 's/ *$//')"

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
is "open: name resolves to its open ref" "w1-a#0001" "$(ralph_ledger_open_ref w1-a)"
is "open: a name the ledger never met resolves to nothing" "" \
  "$(ralph_ledger_open_ref w9-nope)"

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

mkdir -p "$TMP/unit2b"
_saved_ledger="$RALPH_HERDR_LEDGER"
RALPH_HERDR_LEDGER="$TMP/unit2b/ledger.jsonl"
# GH-1776 — the join is on the EXACT ref, never the name part. A recycled name
# (respawn after a crash: names are deterministic) would otherwise give the
# LIVE generation the dead one's children, and the consequences are writes —
# orphan_pass re-parents or orphan-marks whatever this returns.
ralph_ledger_append '{"ts":"t3b","ev":"spawn","agent_ref":"w8-ghost#0088","pane_id":"pG"}'
ralph_ledger_append '{"ts":"t3c","ev":"spawn","agent_ref":"w9-kid#0099","pane_id":"pK","tokens":{"parent":"w8-ghost#0088"}}'
ralph_ledger_append '{"ts":"t3d","ev":"exit","agent_ref":"w8-ghost#0088","reason":"pane_closed"}'
ralph_ledger_append '{"ts":"t3e","ev":"spawn","agent_ref":"w8-ghost#0188","pane_id":"pG2"}'
is "open: a recycled name does not inherit the dead epoch's children" "" \
  "$(ralph_ledger_children w8-ghost#0188)"
is "open: the dead epoch still owns them (the ref is the key)" "w9-kid#0099" \
  "$(ralph_ledger_children w8-ghost#0088)"
is "open: the name resolves to the LIVE generation" "w8-ghost#0188" \
  "$(ralph_ledger_open_ref w8-ghost)"
is "open: a name the ledger never met resolves to nothing" "" \
  "$(ralph_ledger_open_ref w7-nope)"
RALPH_HERDR_LEDGER="$_saved_ledger"

# ═══ 3. watch-event: pane.agent_status_changed ═══════════════════════════════
WROOT="$TMP/wroot"
WLEDGER="$WROOT/acme/demo/ledger.jsonl"
mkdir -p "$WROOT/acme/demo"
rm -f "${WLEDGER%.jsonl}.sqlite" "${WLEDGER%.jsonl}.sqlite-wal" "${WLEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
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

# ═══ 3a. GH-2396: .agent is the harness kind, name recovered from .title ═════
# herdr 0.8.2's real payload is the enveloped shape below with .data.agent set
# to the HARNESS ("claude"), never the pane name — the name only survives in
# .data.title's composed address ("<repo>/<name> <glyph>", GH-2210/D6.2).
# Captured shape (herdr plugin log entries 150-200, 2026-09-02/03), pinned so
# a future payload change is caught here instead of silently exiting 0.
herd_fixture '[{"name":"w123-fix","agent_status":"working","pane_id":"p1"}]'
: >"$FAKE_HERDR_LOG"
before_titled=$(lcount "$WLEDGER" '.ev=="state" and .agent_ref=="w123-fix#aaaa" and .agent_status=="working" and .via=="event"')
run_event pane.agent_status_changed \
  '{"event":"pane_agent_status_changed","data":{"type":"pane_agent_status_changed","pane_id":"p1","workspace_id":"w1","agent_status":"working","agent":"claude","title":"acme/demo/w123-fix *"}}' "$WROOT"
is "GH-2396 envelope: exits 0" "0" "$RC"
is "GH-2396 envelope: state recorded against the title-derived name" "$((before_titled + 1))" \
  "$(lcount "$WLEDGER" '.ev=="state" and .agent_ref=="w123-fix#aaaa" and .agent_status=="working" and .via=="event"')"
is "GH-2396 envelope: state token pushed to the right pane" "1" \
  "$(log_count '^pane report-metadata p1 --source ralph-herdr --token state=working$')"

# .agent stays the first choice: a payload that DOES carry a parseable name
# is unaffected by the title fallback, even alongside a title.
herd_fixture '[{"name":"w123-fix","agent_status":"working","pane_id":"p1"}]'
: >"$FAKE_HERDR_LOG"
run_event pane.agent_status_changed \
  '{"pane_id":"p1","agent":"w123-fix","agent_status":"working","title":"acme/demo/w999-other *"}' "$WROOT"
is "GH-2396 envelope: a parseable .agent is never overridden by .title" "1" \
  "$(log_count '^pane report-metadata p1 --source ralph-herdr --token state=working$')"

# The fallback must not turn a genuinely non-ralph pane into a false match: no
# "/" in the title (nothing to recover) and a "/" whose tail still fails
# grammar B both stay the pre-fix no-op.
: >"$FAKE_HERDR_LOG"
lines_before=$(wc -l <"$WLEDGER" | tr -d ' ')
run_event pane.agent_status_changed \
  '{"data":{"pane_id":"p9","agent_status":"working","agent":"claude","title":"some other window"}}' "$WROOT"
is "GH-2396 envelope: a title with no '/' is still ignored" "0" "$RC"
run_event pane.agent_status_changed \
  '{"data":{"pane_id":"p9","agent_status":"working","agent":"claude","title":"acme/demo/Not A Slug *"}}' "$WROOT"
is "GH-2396 envelope: a title tail that fails grammar B is still ignored" "0" "$RC"
is "GH-2396 envelope: neither non-match wrote to the ledger" "$lines_before" \
  "$(wc -l <"$WLEDGER" | tr -d ' ')"
is "GH-2396 envelope: neither non-match made an herdr call" "0" "$(wc -l <"$FAKE_HERDR_LOG" | tr -d ' ')"

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
rm -f "${ALEDGER%.jsonl}.sqlite" "${ALEDGER%.jsonl}.sqlite-wal" "${ALEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
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
is "adopt: no orphan notification" "0" "$(log_fcount 'orphaned --body')"
# o10-orch is an o-lane LEAD with no recorded checkout, so the healing pass
# (GH-2212) reports it unrespawnable — that notification is the healer's, not
# the orphan pass's.
is "adopt: the dead lead's unrespawnable notification stands alone" "1" \
  "$(log_fcount 'died — not respawned')"
RALPH_HERDR_LEDGER="$ALEDGER"
is "adopt: dead parent closed, gp+child stay open" "s0-root#0001 w11-child#0003" \
  "$(ralph_ledger_open_agents | sort | tr '\n' ' ' | sed 's/ *$//')"

# GH-2396 remedy: pane.closed correlates by pane id, never by name, so the
# enveloped {event,data} shape already worked — pinned here with a fixture so
# a future payload change is caught the same way section 3a catches it for
# pane.agent_status_changed.
: >"$FAKE_HERDR_LOG"
run_event pane.closed '{"event":"pane_closed","data":{"pane_id":"p11"}}' "$AROOT"
is "envelope pane.closed: exits 0" "0" "$RC"
is "envelope pane.closed: exit recorded via .data.pane_id" "1" \
  "$(lcount "$ALEDGER" '.ev=="exit" and .agent_ref=="w11-child#0003" and .reason=="pane_closed"')"

# ═══ 5. pane.exited: orphan pass, no live grandparent ════════════════════════
OROOT="$TMP/oroot"
OLEDGER="$OROOT/acme/demo/ledger.jsonl"
mkdir -p "$OROOT/acme/demo"
rm -f "${OLEDGER%.jsonl}.sqlite" "${OLEDGER%.jsonl}.sqlite-wal" "${OLEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
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
# Two notifications total: the orphaned child's, and the healer's for the
# dead checkout-less lead (GH-2212) — nothing else.
is "orphan: no other notifications" "2" "$(log_count '^notification show')"

# A later reconcile sees the same orphan edge and must NOT re-notify or
# re-append (the already-orphaned skip in ralph_ledger_orphan_pass).
: >"$FAKE_HERDR_LOG"
lines_before=$(wc -l <"$OLEDGER" | tr -d ' ')
run_reconcile "$OROOT"
is "orphan re-pass: reconcile exits 0" "0" "$RC"
is "orphan re-pass: no duplicate ledger events" "$lines_before" "$(wc -l <"$OLEDGER" | tr -d ' ')"
is "orphan re-pass: no duplicate notification" "0" "$(log_count '^notification show')"

# ═══ 5a. GH-1776: a recycled parent NAME does not suppress the orphan pass ═══
# The dead parent o30-solo#0006 is closed and a NEW generation of the same
# name (#0106) is open. Reconcile's "is this parent still open?" test used to
# compare name parts, so the live generation answered for the dead one and the
# child stayed silently parented to a worker that no longer exists — the ghost
# this phase exists to clear. The test is on the full ref, so the pass runs.
GROOT="$TMP/groot"
GLEDGER="$GROOT/acme/demo/ledger.jsonl"
mkdir -p "$GROOT/acme/demo"
rm -f "${GLEDGER%.jsonl}.sqlite" "${GLEDGER%.jsonl}.sqlite-wal" "${GLEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
cat >"$GLEDGER" <<'EOF'
{"ts":"t0","ev":"spawn","agent_ref":"o30-solo#0006","pane_id":"p30","tokens":{"role":"o","issue":"30","slug":"solo","depth":"0","state":"spawned","root":"o30-solo#0006"}}
{"ts":"t1","ev":"spawn","agent_ref":"w31-kid#0007","pane_id":"p31","tokens":{"role":"w","issue":"31","slug":"kid","depth":"1","state":"spawned","parent":"o30-solo#0006","root":"o30-solo#0006"}}
{"ts":"t2","ev":"exit","agent_ref":"o30-solo#0006","reason":"pane_exited"}
{"ts":"t3","ev":"spawn","agent_ref":"o30-solo#0106","pane_id":"p32","tokens":{"role":"o","issue":"30","slug":"solo","depth":"0","state":"spawned","root":"o30-solo#0106"}}
EOF
herd_fixture '[{"name":"w31-kid","agent_status":"working","pane_id":"p31"},{"name":"o30-solo","agent_status":"working","pane_id":"p32"}]'

: >"$FAKE_HERDR_LOG"
run_reconcile "$GROOT"
is "recycled parent: reconcile exits 0" "0" "$RC"
is "recycled parent: the child is orphaned, not left on the ghost" "1" \
  "$(lcount "$GLEDGER" '.ev=="state" and .agent_ref=="w31-kid#0007" and .state=="orphaned" and .prev_parent=="o30-solo#0006"')"
is "recycled parent: the live generation did not adopt it" "0" \
  "$(lcount "$GLEDGER" '.ev=="adopt" and .agent_ref=="w31-kid#0007"')"

# ═══ 5b. RACING pane.exited + pane.closed — one death, one record set ════════
# The server subscribes both because either can arrive alone, and it runs
# hook commands CONCURRENTLY. The per-ledger mutex makes the loser re-read a
# ledger the winner already amended: exactly one exit, one orphaned state,
# one notification — never the doubled set the unserialized read produced.
CROOT="$TMP/croot"
CLEDGER="$CROOT/acme/demo/ledger.jsonl"
mkdir -p "$CROOT/acme/demo"
rm -f "${CLEDGER%.jsonl}.sqlite" "${CLEDGER%.jsonl}.sqlite-wal" "${CLEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
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
is "race: exactly ONE orphan notification" "1" "$(log_fcount 'orphaned --body')"
# The dead parent is an o-lane LEAD with no recorded checkout, so the winner's
# healing pass (GH-2212) reports it unrespawnable — exactly once: the mutex
# loser found no open refs and healed nothing.
is "race: exactly ONE lead-death notification" "1" "$(log_fcount 'died — not respawned')"
is "race: the mutex is released afterwards" "0" \
  "$([ -d "$CROOT/acme/demo/.ledger.lock" ] && echo 1 || echo 0)"

# ═══ 5c. GH-2212: event-driven healing — dead lead respawn + heartbeat ═══════
# A dead o-lane LEAD is respawned by re-running work-team.sh EPIC --lead-only
# from the checkout its own spawn record names; the team workspace is flagged
# (ev orphan_space) for the sweep backstop; the dispatch heartbeat is stamped
# for the scope the event acted on. The respawn is stubbed: work-team.sh has
# its own test file, and what THIS hook owes is the correct delegation.
HEAL_STUB="$TMP/fake-work-team.sh"
cat >"$HEAL_STUB" <<'EOF'
#!/bin/bash
printf 'argv=%s cwd=%s repo=%s by=%s\n' "$*" "$PWD" "${RALPH_HERDR_REPO:-}" "${RALPH_HERDR_INVOKED_BY:-}" >>"${HEAL_STUB_LOG:?}"
exit "${HEAL_STUB_RC:-0}"
EOF
chmod +x "$HEAL_STUB"
export RALPH_HERDR_WORK_TEAM="$HEAL_STUB"
export HEAL_STUB_LOG="$TMP/heal-stub.log"

HROOT="$TMP/hroot"
HLEDGER="$HROOT/acme/demo/ledger.jsonl"
mkdir -p "$HROOT/acme/demo"
rm -f "${HLEDGER%.jsonl}.sqlite" "${HLEDGER%.jsonl}.sqlite-wal" "${HLEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
cat >"$HLEDGER" <<EOF
{"ts":"t0","ev":"spawn","agent_ref":"o40-heal#0001","pane_id":"p40","checkout":"$REPO_DIR","tokens":{"role":"orchestrator","issue":"40","slug":"heal","depth":"0","state":"spawned","root":"o40-heal#0001"}}
EOF
herd_fixture '[]'
: >"$FAKE_HERDR_LOG"
: >"$HEAL_STUB_LOG"
run_event pane.exited '{"pane_id":"p40","workspace_id":"ws40"}' "$HROOT"
is "heal: hook exits 0" "0" "$RC"
is "heal: exit appended for the lead" "1" \
  "$(lcount "$HLEDGER" '.ev=="exit" and .agent_ref=="o40-heal#0001"')"
is "heal: team space flagged orphan_space with the event's workspace id" "1" \
  "$(lcount "$HLEDGER" '.ev=="orphan_space" and .agent_ref=="o40-heal#0001" and .workspace_id=="ws40" and .via=="event"')"
stub_line=$(cat "$HEAL_STUB_LOG")
is "heal: exactly one respawn delegation" "1" "$(wc -l <"$HEAL_STUB_LOG" | tr -d ' ')"
line_has "heal: respawn is work-team EPIC --lead-only" "$stub_line" "argv=40 --lead-only"
line_has "heal: respawn runs from the lead's recorded checkout" "$stub_line" "cwd=$(cd "$REPO_DIR" && pwd)"
line_has "heal: respawn scopes lib.sh at the same checkout" "$stub_line" "repo=$REPO_DIR"
line_has "heal: the spawn is machine-initiated (invoked_by)" "$stub_line" "by=scheduler"
is "heal: a successful respawn raises no notification" "0" "$(log_count '^notification show')"
is "heal: dispatch heartbeat stamped for the scope" "1" \
  "$([ -f "$HROOT/acme/demo/dispatch-heartbeat" ] && echo 1 || echo 0)"
is "heal: heartbeat names its writer" "watch-event" \
  "$(jq -r '.writer' <"$HROOT/acme/demo/dispatch-heartbeat" 2>/dev/null)"

# Exit 4 from work-team.sh is the CLEAN refusal — the epic is complete, the
# self-dissolve backstop is working: log only, never a notification.
rm -f "${HLEDGER%.jsonl}.sqlite" "${HLEDGER%.jsonl}.sqlite-wal" "${HLEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
cat >"$HLEDGER" <<EOF
{"ts":"t0","ev":"spawn","agent_ref":"o41-done#0001","pane_id":"p41","checkout":"$REPO_DIR","tokens":{"role":"orchestrator","issue":"41","slug":"done","depth":"0","state":"spawned","root":"o41-done#0001"}}
EOF
: >"$FAKE_HERDR_LOG"
: >"$HEAL_STUB_LOG"
HEAL_STUB_RC=4 run_event pane.exited '{"pane_id":"p41","workspace_id":"ws41"}' "$HROOT"
is "heal complete-epic: hook exits 0" "0" "$RC"
is "heal complete-epic: respawn was attempted (and cleanly refused)" "1" "$(wc -l <"$HEAL_STUB_LOG" | tr -d ' ')"
is "heal complete-epic: no notification — the backstop working is not attention" "0" "$(log_count '^notification show')"
case "$OUT" in
  *"self-dissolve backstop"*) ok "heal complete-epic: the log names the backstop" ;;
  *) not_ok "heal complete-epic: the log names the backstop — no mention in '$OUT'" ;;
esac

# Any other nonzero rc is a FAILED respawn: the lead is dead and the healer
# could not stand a new one up — that is attention, so it notifies.
rm -f "${HLEDGER%.jsonl}.sqlite" "${HLEDGER%.jsonl}.sqlite-wal" "${HLEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
cat >"$HLEDGER" <<EOF
{"ts":"t0","ev":"spawn","agent_ref":"o42-sick#0001","pane_id":"p42","checkout":"$REPO_DIR","tokens":{"role":"orchestrator","issue":"42","slug":"sick","depth":"0","state":"spawned","root":"o42-sick#0001"}}
EOF
: >"$FAKE_HERDR_LOG"
: >"$HEAL_STUB_LOG"
HEAL_STUB_RC=1 run_event pane.exited '{"pane_id":"p42","workspace_id":"ws42"}' "$HROOT"
is "heal failed-respawn: hook exits 0" "0" "$RC"
is "heal failed-respawn: notification raised" "1" "$(log_fcount 'died — respawn failed')"

# A record with no usable checkout cannot ground a respawn — inventing a cwd
# is the cross-scope write the pane proof forbids. No delegation; attention.
rm -f "${HLEDGER%.jsonl}.sqlite" "${HLEDGER%.jsonl}.sqlite-wal" "${HLEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
cat >"$HLEDGER" <<'EOF'
{"ts":"t0","ev":"spawn","agent_ref":"o43-bare#0001","pane_id":"p43","tokens":{"role":"orchestrator","issue":"43","slug":"bare","depth":"0","state":"spawned","root":"o43-bare#0001"}}
EOF
: >"$FAKE_HERDR_LOG"
: >"$HEAL_STUB_LOG"
run_event pane.exited '{"pane_id":"p43","workspace_id":"ws43"}' "$HROOT"
is "heal no-checkout: hook exits 0" "0" "$RC"
is "heal no-checkout: respawn never delegated" "0" "$(wc -l <"$HEAL_STUB_LOG" | tr -d ' ')"
is "heal no-checkout: notification raised" "1" "$(log_fcount 'died — not respawned')"
is "heal no-checkout: team space still flagged" "1" \
  "$(lcount "$HLEDGER" '.ev=="orphan_space" and .agent_ref=="o43-bare#0001" and .workspace_id=="ws43"')"

# ═══ 5d. GH-2357: heal.sh refuses a respawn once a ref is stood down ════════
# Unreachable through run_event's own open-for-pane filter — a stood-down ref
# is closed (in the ledger) before any death event for its pane can even
# fire, so watch-event's handle_gone never hands it here at all (see heal.sh's
# header and work-team.sh's --stand-down). This calls ralph_heal_lead_death
# DIRECTLY instead, to prove heal.sh's OWN second guard: even handed a ref
# whose latest ledger fact is already exit/stood-down, it refuses to respawn
# and refuses to flag the space orphaned.
# shellcheck source=../scripts/heal.sh
. "$SCRIPTS/heal.sh"
HEAL_DIRECT_LOG="$TMP/heal-direct.log"
log() { printf '%s\n' "$*" >>"$HEAL_DIRECT_LOG"; }
: >"$HEAL_DIRECT_LOG"
rm -f "${HLEDGER%.jsonl}.sqlite" "${HLEDGER%.jsonl}.sqlite-wal" "${HLEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
cat >"$HLEDGER" <<EOF
{"ts":"t0","ev":"spawn","agent_ref":"o44-parked#0001","pane_id":"p44","checkout":"$REPO_DIR","tokens":{"role":"orchestrator","issue":"44","slug":"parked","depth":"0","state":"spawned","root":"o44-parked#0001"}}
{"ts":"t1","ev":"exit","agent_ref":"o44-parked#0001","reason":"stood-down","via":"operator"}
EOF
: >"$FAKE_HERDR_LOG"
: >"$HEAL_STUB_LOG"
RALPH_HERDR_LEDGER="$HLEDGER" ralph_heal_lead_death "$HLEDGER" "o44-parked#0001" "ws44" "pane_exited"
is "heal stood-down: no respawn delegated" "0" "$(wc -l <"$HEAL_STUB_LOG" | tr -d ' ')"
is "heal stood-down: no orphan_space flag" "0" \
  "$(lcount "$HLEDGER" '.ev=="orphan_space" and .agent_ref=="o44-parked#0001"')"
is "heal stood-down: no notification raised" "0" "$(log_count '^notification show')"
line_has "heal stood-down: the log names the operator's stand-down" "$(cat "$HEAL_DIRECT_LOG")" "stood down by operator"

# The REACHABLE case (Greptile P1 on #2397): between the stand-down append and
# the workspace close, a reconcile discover pass sees a live pane with no open
# record and mints a fresh ref (new epoch, same name). The death event finds
# THAT ref open, appends its exit, and hands it here — through run_event, the
# real path. The guard is keyed on the NAME, so the discover epoch is parked
# too: no respawn, no orphan flag.
rm -f "${HLEDGER%.jsonl}.sqlite" "${HLEDGER%.jsonl}.sqlite-wal" "${HLEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
cat >"$HLEDGER" <<EOF
{"ts":"t0","ev":"spawn","agent_ref":"o45-parked#0001","pane_id":"p45","checkout":"$REPO_DIR","tokens":{"role":"orchestrator","issue":"45","slug":"parked","depth":"0","state":"spawned","root":"o45-parked#0001"}}
{"ts":"t1","ev":"exit","agent_ref":"o45-parked#0001","reason":"stood-down","pane_id":"p45","via":"operator"}
{"ts":"t2","ev":"discover","agent_ref":"o45-parked#0002","pane_id":"p45","via":"reconcile","checkout":"$REPO_DIR","tokens":{"role":"orchestrator","issue":"45","slug":"parked"}}
EOF
herd_fixture '[]'
: >"$FAKE_HERDR_LOG"
: >"$HEAL_STUB_LOG"
run_event pane.exited '{"pane_id":"p45","workspace_id":"ws45"}' "$HROOT"
is "heal stood-down (rediscovered epoch): hook exits 0" "0" "$RC"
is "heal stood-down (rediscovered epoch): the discover ref's exit is recorded" "1" \
  "$(lcount "$HLEDGER" '.ev=="exit" and .agent_ref=="o45-parked#0002"')"
is "heal stood-down (rediscovered epoch): no respawn delegated" "0" "$(wc -l <"$HEAL_STUB_LOG" | tr -d ' ')"
is "heal stood-down (rediscovered epoch): no orphan_space flag" "0" \
  "$(lcount "$HLEDGER" '.ev=="orphan_space" and .agent_ref=="o45-parked#0002"')"
is "heal stood-down (rediscovered epoch): no notification" "0" "$(log_count '^notification show')"
# A later SPAWN (a human re-arm) clears the park: the next death heals again.
rm -f "${HLEDGER%.jsonl}.sqlite" "${HLEDGER%.jsonl}.sqlite-wal" "${HLEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
cat >"$HLEDGER" <<EOF
{"ts":"t0","ev":"spawn","agent_ref":"o46-rearmed#0001","pane_id":"p46a","checkout":"$REPO_DIR","tokens":{"role":"orchestrator","issue":"46","slug":"rearmed","depth":"0","state":"spawned","root":"o46-rearmed#0001"}}
{"ts":"t1","ev":"exit","agent_ref":"o46-rearmed#0001","reason":"stood-down","via":"operator"}
{"ts":"t2","ev":"spawn","agent_ref":"o46-rearmed#0002","pane_id":"p46","checkout":"$REPO_DIR","tokens":{"role":"orchestrator","issue":"46","slug":"rearmed","depth":"0","state":"spawned","root":"o46-rearmed#0002"}}
EOF
: >"$FAKE_HERDR_LOG"
: >"$HEAL_STUB_LOG"
run_event pane.exited '{"pane_id":"p46","workspace_id":"ws46"}' "$HROOT"
is "heal re-armed: a spawn after the stand-down re-arms the name — respawn delegated" "1" "$(wc -l <"$HEAL_STUB_LOG" | tr -d ' ')"
# An UNLEDGERED re-arm (its spawn append failed; reconcile discovered it) is
# a discover on a DIFFERENT pane from the one the stand-down parked — that is
# a lead that genuinely exists, and its later death heals again (Greptile P1
# on #2397, second round).
rm -f "${HLEDGER%.jsonl}.sqlite" "${HLEDGER%.jsonl}.sqlite-wal" "${HLEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
cat >"$HLEDGER" <<EOF
{"ts":"t0","ev":"spawn","agent_ref":"o47-unledgered#0001","pane_id":"p47a","checkout":"$REPO_DIR","tokens":{"role":"orchestrator","issue":"47","slug":"unledgered","depth":"0","state":"spawned","root":"o47-unledgered#0001"}}
{"ts":"t1","ev":"exit","agent_ref":"o47-unledgered#0001","reason":"stood-down","pane_id":"p47a","via":"operator"}
{"ts":"t2","ev":"discover","agent_ref":"o47-unledgered#0002","pane_id":"p47b","via":"reconcile","checkout":"$REPO_DIR","tokens":{"role":"orchestrator","issue":"47","slug":"unledgered"}}
EOF
: >"$FAKE_HERDR_LOG"
: >"$HEAL_STUB_LOG"
run_event pane.exited '{"pane_id":"p47b","workspace_id":"ws47"}' "$HROOT"
is "heal unledgered re-arm: a discover on ANOTHER pane re-arms the name — respawn delegated" "1" "$(wc -l <"$HEAL_STUB_LOG" | tr -d ' ')"
unset -f log

unset RALPH_HERDR_WORK_TEAM HEAL_STUB_LOG

# ═══ 6. reconcile: discover / lost / token re-push ═══════════════════════════
RROOT="$TMP/rroot"
RLEDGER="$RROOT/acme/demo/ledger.jsonl"
mkdir -p "$RROOT/acme/demo" "$TMP/repo"
printf '{"owner":"acme","repo":"demo"}\n' >"$TMP/repo/.ralph.json"
# Both records carry THIS server's session key, which is what a ledger written
# by a current ralph looks like — and since GH-1944 that stamp is what makes
# w9-gone sweepable. It used to inherit the verdict from its live sibling; a
# record now answers for itself.
rm -f "${RLEDGER%.jsonl}.sqlite" "${RLEDGER%.jsonl}.sqlite-wal" "${RLEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
cat >"$RLEDGER" <<EOF
{"ts":"t0","ev":"spawn","agent_ref":"w123-fix#aaaa","pane_id":"p1","session":"$(ralph_session_key)","tokens":{"role":"w","issue":"123","slug":"fix","root":"w123-fix#aaaa","depth":"0","state":"spawned","branch":"feature/GH-123","harness":"claude","spawn_epoch":"aaaa"}}
{"ts":"t1","ev":"spawn","agent_ref":"w9-gone#ffff","pane_id":"p9","session":"$(ralph_session_key)","tokens":{"role":"w","issue":"9","slug":"gone","depth":"0","state":"spawned"}}
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
  "$(lcount "$RLEDGER" '.ev=="exit" and .agent_ref=="w9-gone#ffff" and .reason=="swept-unknown" and .via=="reconcile"')"
is "reconcile: unledgered live agent discovered (fresh ref + tokens)" "1" \
  "$(lcount "$RLEDGER" '.ev=="discover" and (.agent_ref | test("^w5-alpha#[0-9a-f]{8}$")) and .pane_id=="p5" and .via=="reconcile" and .tokens.role=="driver" and .tokens.issue=="5" and .tokens.slug=="alpha"')"
is "reconcile: discovery retains its proven checkout" "$REPO_DIR" \
  "$(levents "$RLEDGER" | jq -r 'select(.ev=="discover" and (.agent_ref | startswith("w5-alpha#"))) | .checkout // empty')"
is "reconcile: legacy singleton never ledgered" "0" \
  "$(levents "$RLEDGER" | grep -c 'ralph-deliver' || true)"
is "reconcile: non-ralph agent never ledgered" "0" \
  "$(levents "$RLEDGER" | grep -c 'random-agent' || true)"

p1line=$(grep '^pane report-metadata p1 ' "$FAKE_HERDR_LOG" || true)
is "re-push: exactly one push for the live pane p1" "1" "$(log_count '^pane report-metadata p1 ')"
# The fixture record predates GH-1808 and carries the old lane-letter role.
# Left as-is deliberately: re-push replays what the LEDGER holds, and records
# written before the vocabulary changed are exactly what a real ledger has.
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

# ═══ 6b. reconcile: a herd belonging to ANOTHER server sweeps nothing (GH-1863)
# herdr runs [[startup]] for EVERY server that starts, so an isolated named
# session ran this pass against the operator's real ledgers while answering
# about a herd it never had. Observed live 2026-08-13: five running workers
# marked lost in one sweep. The pass now needs POSITIVE evidence that a ledger
# is its own — one of the ledger's open records naming a pane this server
# holds — and an empty or foreign herd supplies none.
FROOT="$TMP/froot"
FLEDGER="$FROOT/acme/demo/ledger.jsonl"
mkdir -p "$FROOT/acme/demo"
foreign_ledger() {
  rm -f "${FLEDGER%.jsonl}.sqlite" "${FLEDGER%.jsonl}.sqlite-wal" "${FLEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
  cat >"$FLEDGER" <<'EOF'
{"ts":"t0","ev":"spawn","agent_ref":"w123-fix#aaaa","pane_id":"p1","tokens":{"role":"w","issue":"123","slug":"fix","depth":"0","state":"spawned"}}
{"ts":"t1","ev":"spawn","agent_ref":"w9-gone#ffff","pane_id":"p9","tokens":{"role":"w","issue":"9","slug":"gone","depth":"0","state":"spawned"}}
EOF
}

# (a) the observed case: a scratch server with no agents and no panes at all.
foreign_ledger
herd_fixture '[]'
: >"$FAKE_HERDR_LOG"
run_reconcile "$FROOT"
is "foreign server: reconcile still exits 0" "0" "$RC"
is "foreign server: nothing marked lost" "0" \
  "$(lcount "$FLEDGER" '.ev=="exit"')"
case "$OUT" in
  *"not this server's ledger"*) ok "foreign server: declines the sweep loudly" ;;
  *) not_ok "foreign server: declines the sweep loudly — got '$OUT'" ;;
esac
RALPH_HERDR_LEDGER="$FLEDGER"
is "foreign server: both records still open" "w123-fix w9-gone" \
  "$(ralph_ledger_open_agents | sed 's/#[0-9a-f]*$//' | sort | tr '\n' ' ' | sed 's/ *$//')"

# (b) a NON-empty foreign herd is no better: ownership is proven by the panes
# this ledger recorded, never by the herd merely being non-empty.
foreign_ledger
herd_fixture '[{"name":"w77-other","agent_status":"working","pane_id":"pz1"}]'
: >"$FAKE_HERDR_LOG"
run_reconcile "$FROOT"
is "foreign herd: nothing marked lost" "0" "$(lcount "$FLEDGER" '.ev=="exit"')"
is "foreign herd: no token pushed onto our panes" "0" "$(log_count '^pane report-metadata p[19] ')"

# (c) the control: a record whose pane IS in this snapshot is ours, and the
# ordinary sweep resumes for it — the guard is scoped, not a mute. Its
# unproven sibling is NOT swept along with it (GH-1944): the verdict belongs
# to the record, and w9-gone's writer is unknowable from this legacy ledger.
foreign_ledger
herd_fixture '[{"name":"w123-fix","agent_status":"working","pane_id":"p1"}]'
: >"$FAKE_HERDR_LOG"
run_reconcile "$FROOT"
is "owned record: the live worker is left open" "0" \
  "$(lcount "$FLEDGER" '.ev=="exit" and .agent_ref=="w123-fix#aaaa"')"
is "mixed ledger: the unproven sibling is NOT swept on the live one's proof" "0" \
  "$(lcount "$FLEDGER" '.ev=="exit" and .agent_ref=="w9-gone#ffff"')"
case "$OUT" in
  *"are not this server's"*) ok "mixed ledger: says how many records it declined" ;;
  *) not_ok "mixed ledger: says how many records it declined — got '$OUT'" ;;
esac

# (c2) THE REGRESSION (GH-1944). Two servers share one repository's ledger.
# Ours has a live pane; theirs has a live worker we cannot see, because it is
# absent from OUR snapshot. Under a whole-ledger verdict our single matching
# record handed us the right to sweep theirs, and a live worker exited `lost`
# cannot be re-discovered. It must survive.
MROOT="$TMP/mroot"
MLEDGER="$MROOT/acme/demo/ledger.jsonl"
mkdir -p "$MROOT/acme/demo"
rm -f "${MLEDGER%.jsonl}.sqlite" "${MLEDGER%.jsonl}.sqlite-wal" "${MLEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
cat >"$MLEDGER" <<EOF
{"ts":"t0","ev":"spawn","agent_ref":"w1-ours#aaaa","pane_id":"p1","session":"$(ralph_session_key)","tokens":{"role":"w","issue":"1","slug":"ours","depth":"0","state":"spawned"}}
{"ts":"t1","ev":"spawn","agent_ref":"w2-theirs#bbbb","pane_id":"pX","session":"another-server","tokens":{"role":"w","issue":"2","slug":"theirs","depth":"0","state":"spawned"}}
EOF
herd_fixture '[{"name":"w1-ours","agent_status":"working","pane_id":"p1"}]'
: >"$FAKE_HERDR_LOG"
run_reconcile "$MROOT"
is "shared ledger: exits 0" "0" "$RC"
is "shared ledger: the foreign server's live worker is NOT marked lost" "0" \
  "$(lcount "$MLEDGER" '.ev=="exit" and .agent_ref=="w2-theirs#bbbb"')"
is "shared ledger: no token pushed onto the foreign server's pane" "0" \
  "$(log_count '^pane report-metadata pX ')"
is "shared ledger: our own live worker is untouched too" "0" \
  "$(lcount "$MLEDGER" '.ev=="exit" and .agent_ref=="w1-ours#aaaa"')"

# and the other half of the same verdict: OUR retired record in that shared
# ledger is still swept. Per-record ownership must not cost us our own sweep.
rm -f "${MLEDGER%.jsonl}.sqlite" "${MLEDGER%.jsonl}.sqlite-wal" "${MLEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
cat >"$MLEDGER" <<EOF
{"ts":"t0","ev":"spawn","agent_ref":"w1-ours#aaaa","pane_id":"p1","session":"$(ralph_session_key)","tokens":{"role":"w","issue":"1","slug":"ours","depth":"0","state":"spawned"}}
{"ts":"t1","ev":"spawn","agent_ref":"w2-theirs#bbbb","pane_id":"pX","session":"another-server","tokens":{"role":"w","issue":"2","slug":"theirs","depth":"0","state":"spawned"}}
EOF
herd_fixture '[]'
: >"$FAKE_HERDR_LOG"
run_reconcile "$MROOT"
is "shared ledger: our own absent record is still swept" "1" \
  "$(lcount "$MLEDGER" '.ev=="exit" and .agent_ref=="w1-ours#aaaa" and .reason=="swept-unknown"')"
is "shared ledger: theirs still is not, even with no herd at all" "0" \
  "$(lcount "$MLEDGER" '.ev=="exit" and .agent_ref=="w2-theirs#bbbb"')"

# ═══ 6c. reconcile: a QUIESCED ledger of ours is sweepable (GH-1933) ═════════
# The catch-22 6b's guard created: sweeping is safe only when no worker is
# live, and was possible only when at least one was. A record written by this
# server proves the ledger ours after its last pane is gone.
QROOT="$TMP/qroot"
QLEDGER="$QROOT/acme/quiet/ledger.jsonl"
mkdir -p "$QROOT/acme/quiet"
quiesced_ledger() {
  local sess="${1:?}"
  rm -f "${QLEDGER%.jsonl}.sqlite" "${QLEDGER%.jsonl}.sqlite-wal" "${QLEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
  cat >"$QLEDGER" <<EOF
{"ts":"t0","ev":"spawn","agent_ref":"w9-gone#ffff","pane_id":"p9","session":"$sess","tokens":{"role":"w","issue":"9","slug":"gone","depth":"0","state":"spawned"}}
EOF
}

# (a) ours, fully retired: no live pane anywhere, and the sweep runs.
quiesced_ledger "$(ralph_session_key)"
herd_fixture '[]'
: >"$FAKE_HERDR_LOG"
run_reconcile "$QROOT"
is "quiesced ledger: reconcile exits 0" "0" "$RC"
is "quiesced ledger: the stale record is finally swept" "1" \
  "$(lcount "$QLEDGER" '.ev=="exit" and .agent_ref=="w9-gone#ffff" and .reason=="swept-unknown"')"

# (b) the guard is not weakened: another server's key is no proof at all.
quiesced_ledger "someone-else"
: >"$FAKE_HERDR_LOG"
run_reconcile "$QROOT"
is "foreign session key: nothing swept" "0" "$(lcount "$QLEDGER" '.ev=="exit"')"
case "$OUT" in
  *"not this server's ledger"*) ok "foreign session key: declines the sweep loudly" ;;
  *) not_ok "foreign session key: declines the sweep loudly — got '$OUT'" ;;
esac

# (c) a record from before the stamp existed has no discoverable writer, so it
# stays unknown — and --adopt is the operator asserting what evidence cannot.
foreign_ledger # legacy shape: no session field on either record
herd_fixture '[]'
: >"$FAKE_HERDR_LOG"
RC=0
OUT=$(RALPH_HERDR_LEDGER_ROOT="$FROOT" bash "$SCRIPTS/reconcile.sh" --adopt "$FLEDGER" 2>&1) || RC=$?
is "--adopt: exits 0" "0" "$RC"
case "$OUT" in
  *"on the operator's assertion"*) ok "--adopt: says out loud that it overrode the verdict" ;;
  *) not_ok "--adopt: says out loud that it overrode the verdict — got '$OUT'" ;;
esac
is "--adopt: the legacy stale record is swept" "1" \
  "$(lcount "$FLEDGER" '.ev=="exit" and .agent_ref=="w9-gone#ffff" and .reason=="swept-unknown"')"

# (c2) --adopt is scoped to the ledger NAMED (GH-1944). It used to sit inside
# the ledger walk, so one assertion about one inspected ledger silently
# adopted every unproven ledger the walk found — writing lost-exits into
# unrelated, possibly foreign, ledgers.
AROOT="$TMP/aroot"
A1="$AROOT/acme/one/ledger.jsonl"
A2="$AROOT/acme/two/ledger.jsonl"
mkdir -p "$AROOT/acme/one" "$AROOT/acme/two"
adopt_ledgers() {
  rm -f "${A1%.jsonl}.sqlite" "${A1%.jsonl}.sqlite-wal" "${A1%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape (phase D)
  cat >"$A1" <<'EOF'
{"ts":"t0","ev":"spawn","agent_ref":"w1-one#aaaa","pane_id":"p1","tokens":{"role":"w","issue":"1","slug":"one","depth":"0","state":"spawned"}}
EOF
  rm -f "${A2%.jsonl}.sqlite" "${A2%.jsonl}.sqlite-wal" "${A2%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape (phase D)
  cat >"$A2" <<'EOF'
{"ts":"t0","ev":"spawn","agent_ref":"w2-two#bbbb","pane_id":"p2","tokens":{"role":"w","issue":"2","slug":"two","depth":"0","state":"spawned"}}
EOF
}
adopt_ledgers
herd_fixture '[]'
: >"$FAKE_HERDR_LOG"
RC=0
OUT=$(RALPH_HERDR_LEDGER_ROOT="$AROOT" bash "$SCRIPTS/reconcile.sh" --adopt "$A1" 2>&1) || RC=$?
is "--adopt PATH: exits 0" "0" "$RC"
is "--adopt PATH: the named ledger is swept" "1" \
  "$(lcount "$A1" '.ev=="exit" and .agent_ref=="w1-one#aaaa" and .reason=="swept-unknown"')"
is "--adopt PATH: the OTHER unproven ledger is untouched" "0" \
  "$(lcount "$A2" '.ev=="exit"')"

# and the flag refuses to mean more than was typed: a bare --adopt is an
# error, not a global assertion.
adopt_ledgers
RC=0
OUT=$(RALPH_HERDR_LEDGER_ROOT="$AROOT" bash "$SCRIPTS/reconcile.sh" --adopt 2>&1) || RC=$?
is "bare --adopt: refused" "2" "$RC"
is "bare --adopt: swept nothing" "0" "$(lcount "$A1" '.ev=="exit"')"
RC=0
OUT=$(RALPH_HERDR_LEDGER_ROOT="$AROOT" bash "$SCRIPTS/reconcile.sh" --adopt "$AROOT/nope.jsonl" 2>&1) || RC=$?
is "--adopt of a non-ledger: refused" "2" "$RC"

# a path that resolves to no walked ledger is REFUSED, not ignored: adopting
# nothing while sweeping on regardless reads exactly like a successful
# adoption, so a typo or a stale root would silently do nothing.
adopt_ledgers
OTHER="$TMP/elsewhere"
mkdir -p "$OTHER/acme/one"
: >"$OTHER/acme/one/ledger.jsonl"
RC=0
OUT=$(RALPH_HERDR_LEDGER_ROOT="$AROOT" bash "$SCRIPTS/reconcile.sh" --adopt "$OTHER/acme/one/ledger.jsonl" 2>&1) || RC=$?
is "--adopt outside the walked root: refused" "2" "$RC"
case "$OUT" in
  *"nothing to adopt"*) ok "--adopt outside the root: says the assertion matched nothing" ;;
  *) not_ok "--adopt outside the root: says the assertion matched nothing — got '$OUT'" ;;
esac

# and a symlink IS the same ledger by any honest reading — matched with -ef,
# so neither the directory nor the final component has to be spelled
# canonically (Greptile, PR #1947).
adopt_ledgers
herd_fixture '[]'
ln -sf "$A1" "$TMP/link-to-one.jsonl"
RC=0
OUT=$(RALPH_HERDR_LEDGER_ROOT="$AROOT" bash "$SCRIPTS/reconcile.sh" --adopt "$TMP/link-to-one.jsonl" 2>&1) || RC=$?
is "--adopt via a symlinked basename: exits 0" "0" "$RC"
is "--adopt via a symlinked basename: the named ledger is swept" "1" \
  "$(lcount "$A1" '.ev=="exit" and .agent_ref=="w1-one#aaaa" and .reason=="swept-unknown"')"
is "--adopt via a symlinked basename: the other ledger is still untouched" "0" \
  "$(lcount "$A2" '.ev=="exit"')"

# (d) --dry-run computes the same verdict and writes nothing.
quiesced_ledger "$(ralph_session_key)"
before=$(wc -l <"$QLEDGER" | tr -d ' ')
: >"$FAKE_HERDR_LOG"
RC=0
OUT=$(RALPH_HERDR_LEDGER_ROOT="$QROOT" bash "$SCRIPTS/reconcile.sh" --dry-run 2>&1) || RC=$?
is "--dry-run: exits 0" "0" "$RC"
is "--dry-run: the ledger is untouched" "$before" "$(wc -l <"$QLEDGER" | tr -d ' ')"
case "$OUT" in
  *'would append:'*'"reason":"swept-unknown"'*) ok "--dry-run: reports the exact sweep it withheld" ;;
  *) not_ok "--dry-run: reports the exact sweep it withheld — got '$OUT'" ;;
esac
is "--dry-run: no token pushed" "0" "$(log_count '^pane report-metadata ')"

RC=0
OUT=$(RALPH_HERDR_LEDGER_ROOT="$QROOT" bash "$SCRIPTS/reconcile.sh" --nonsense 2>&1) || RC=$?
is "unknown flag: refused, not silently ignored" "2" "$RC"

# ═══ 7. depth guard: refusal at depth 2 ══════════════════════════════════════
DLEDGER="$TMP/depth/ledger.jsonl"
mkdir -p "$TMP/depth"
rm -f "${DLEDGER%.jsonl}.sqlite" "${DLEDGER%.jsonl}.sqlite-wal" "${DLEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
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

rm -f "${CLEDGER%.jsonl}.sqlite" "${CLEDGER%.jsonl}.sqlite-wal" "${CLEDGER%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape or it shadows the new jsonl (phase D)
cat >"$CLEDGER" <<EOF
{"ts":"t0","ev":"spawn","agent_ref":"w201-restart#a1","pane_id":"pR","shell_pid":"5001","checkout":"$CREPO","tokens":{"role":"w","issue":"201","harness":"claude","state":"spawned"}}
{"ts":"t0","ev":"spawn","agent_ref":"w202-crash#a2","pane_id":"pC","shell_pid":"5002","checkout":"$CREPO","tokens":{"role":"w","issue":"202","harness":"claude","state":"spawned"}}
{"ts":"t0","ev":"spawn","agent_ref":"w203-alive#a3","pane_id":"pA","shell_pid":"5003","checkout":"$CREPO","tokens":{"role":"w","issue":"203","harness":"claude","state":"spawned"}}
{"ts":"t0","ev":"spawn","agent_ref":"w204-unknown#a4","pane_id":"pU","shell_pid":"5004","checkout":"$CREPO","tokens":{"role":"w","issue":"204","harness":"claude","state":"spawned"}}
{"ts":"t0","ev":"spawn","agent_ref":"w205-foreign#a5","pane_id":"pF","shell_pid":"5005","checkout":"$CFOREIGN","tokens":{"role":"w","issue":"205","harness":"claude","state":"spawned"}}
{"ts":"t0","ev":"spawn","agent_ref":"t0-tend#a6","pane_id":"pT","shell_pid":"5006","checkout":"$CREPO","tokens":{"role":"tender","issue":"0","harness":"claude","state":"spawned"}}
EOF
# Every record's agent is LIVE in the herd — the point of the phase: after a
# restart the names are all still there, and only the pane tells the truth.
herd_fixture '[{"name":"w201-restart","agent_status":"idle","pane_id":"pR"},{"name":"w202-crash","agent_status":"idle","pane_id":"pC"},{"name":"w203-alive","agent_status":"working","pane_id":"pA"},{"name":"w204-unknown","agent_status":"idle","pane_id":"pU"},{"name":"w205-foreign","agent_status":"idle","pane_id":"pF"},{"name":"t0-tend","agent_status":"idle","pane_id":"pT"}]' "$CREPO"

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
# pT: a dead lane pass (GH-2342) — same shell, nothing running. Issue 0 is a
# digit string, so the no-issue check used to admit it and aim `board get 0`
# at the row; a pass holds no claim, so the board must never be asked.
printf '{"process_info":{"pane_id":"pT","shell_pid":5006,"foreground_processes":[]}}\n' \
  >"$FAKE_HERDR_FIXTURES/pane-process-info.pT.json"

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
is "lane pass (issue 0): dead pass's record still closed as crashed" "1" \
  "$(lcount "$CLEDGER" '.ev=="exit" and .agent_ref=="t0-tend#a6" and .reason=="crashed"')"
is "lane pass (issue 0): the board is never asked about GH-0" "0" \
  "$(grep -c '^\(get\|release\) 0 ' "$FAKE_BOARD_LOG" || true)"
case "$OUT" in
  *"issue 0 binds it to no unit"*) ok "lane pass (issue 0): the skip names why" ;;
  *) not_ok "lane pass (issue 0): the skip names why — got '$OUT'" ;;
esac

# The state gate: a worker that got its PR up before dying is In Review, and
# `release` is neither legal nor wanted there.
CROOT2="$TMP/croot2"
mkdir -p "$CROOT2/acme/demo"
rm -f "$CROOT2/acme/demo/ledger.sqlite" "$CROOT2/acme/demo/ledger.sqlite-wal" "$CROOT2/acme/demo/ledger.sqlite-shm" # fixture rewrite: drop the tape (phase D)
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
rm -f "$CROOT3/acme/demo/ledger.sqlite" "$CROOT3/acme/demo/ledger.sqlite-wal" "$CROOT3/acme/demo/ledger.sqlite-shm" # fixture rewrite: drop the tape (phase D)
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
rm -f "$CROOT4/acme/demo/ledger.sqlite" "$CROOT4/acme/demo/ledger.sqlite-wal" "$CROOT4/acme/demo/ledger.sqlite-shm" # fixture rewrite: drop the tape (phase D)
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
# GH-1809 accepted the ledger half of this as recoverable damage and asserted
# the two exit-lost records here. GH-1863 closed it: neither pane is in this
# server's snapshot, so the ledger is not this server's to sweep.
is "wrong server: phase A closes nothing either (GH-1863)" "0" \
  "$(lcount "$CROOT4/acme/demo/ledger.jsonl" '.ev=="exit" and (.reason=="lost" or .reason=="swept-unknown")')"
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
  RALPH_HERDR_WATCH_POLL="${WATCH_POLL_ENV:-1}" RALPH_HERDR_WATCH_ARM_SEC="${WATCH_ARM_ENV:-1}" \
    RALPH_HERDR_REPO="$REPO_DIR" RALPH_HERDR_BOARD="$BIN/board" \
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

# ── a blocked episode notifies ONCE, transient failure or not (GH-1870) ─────
# Codex P2 on #1871: routing the off-blocked re-arm through the backoff made a
# transient failure `continue` to the loop top, and the BARE wait's default
# until-set includes blocked — so while the agent was still blocked it returned
# at once, the status read said blocked again, and a second notification fired
# for an episode that never re-transitioned. Under a persistent outage that is
# a notification every poll interval: the spin this file already fixed once,
# through a different door.
#
# The fixture pair is the point: the bare wait answers, the --until re-arm does
# not.
printf '{"agent":{"name":"w-stuck","agent_status":"blocked","pane_id":"p1","workspace_id":"w1","tab_id":"w1:t1","terminal_id":"t","focused":false,"revision":1}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-get.w-stuck.json"
: >"$FAKE_HERDR_FIXTURES/agent-wait-until.w-stuck.raw"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-wait-until.w-stuck.rc"
watch_until "wait failed for w-stuck" w-stuck
is "blocked: notified exactly once despite the failing re-arm" "1" \
  "$(printf '%s\n' "$WATCH_OUT" | grep -c 'ralph: w-stuck blocked' || true)"
line_has  "blocked: the failing re-arm is reported" "$WATCH_OUT" "wait failed for w-stuck"
line_lacks "blocked: and it is not read as a departure" "$WATCH_OUT" "w-stuck gone"
rm -f "$FAKE_HERDR_FIXTURES"/agent-wait-until.w-stuck.*

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

# ═══ idle inside the spawn window is not a finished session (GH-1878) ═══════
# Observed 2026-08-14: a fleet agent was declared finished and dropped from the
# watch list 30s after spawn, then worked for another 36 minutes unwatched. It
# had simply not yet transitioned into `working` when the first poll landed.
# `idle` is the one ambiguous read; `done` and `gone` are not.
printf '{"agent":{"name":"w-fresh","agent_status":"idle","pane_id":"p1","workspace_id":"w1","tab_id":"w1:t1","terminal_id":"t","focused":false,"revision":1}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-get.w-fresh.json"
printf '{"agent":{"name":"w-done","agent_status":"done","pane_id":"p1","workspace_id":"w1","tab_id":"w1:t1","terminal_id":"t","focused":false,"revision":1}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-get.w-done.json"

WATCH_ARM_ENV=3600 watch_until "reads idle inside" w-fresh w-done
line_has  "spawn window: an unarmed idle target is held, not dropped" "$WATCH_OUT" \
  "w-fresh reads idle inside the 3600s spawn window"
line_lacks "spawn window: …and is never announced finished" "$WATCH_OUT" "ralph: w-fresh idle"
is "spawn window: the hold is announced once, not every poll" "1" \
  "$(printf '%s\n' "$WATCH_OUT" | grep -c 'w-fresh reads idle inside' || true)"
line_has  "spawn window: a genuinely done sibling still drops immediately" "$WATCH_OUT" \
  "notify [w-done] ralph: w-done done"
is "spawn window: the watcher keeps watching the held target" "0" "$WATCH_EXITED"

# The window is bounded: an agent that never arms is not watched forever.
WATCH_ARM_ENV=1 watch_until "notify [w-fresh]" w-fresh w-done
line_has "spawn window: once the window closes, idle is terminal again" "$WATCH_OUT" \
  "notify [w-fresh] ralph: w-fresh idle"
is "spawn window: …and the watcher then exits" "1" "$WATCH_EXITED"

# Single target: the bare `agent wait` default until-set includes idle, so this
# is the path that fired at 30s in the observed run.
printf '{"agent":{"name":"w-fresh","agent_status":"idle"}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-wait.w-fresh.json"
WATCH_ARM_ENV=3600 watch_until "reads idle inside" w-fresh
line_has  "spawn window (single): the wait's idle match does not end the watch" "$WATCH_OUT" \
  "w-fresh reads idle inside the 3600s spawn window"
line_lacks "spawn window (single): no finished notification fires" "$WATCH_OUT" "ralph: w-fresh idle"
is "spawn window (single): the watcher is still watching" "0" "$WATCH_EXITED"

WATCH_ARM_ENV=1 watch_until "notify [w-fresh]" w-fresh
line_has "spawn window (single): the window closes and idle is terminal" "$WATCH_OUT" \
  "notify [w-fresh] ralph: w-fresh idle"
is "spawn window (single): and the watch ends there" "1" "$WATCH_EXITED"

# A malformed window value warns and defaults, like every other knob here.
WATCH_ARM_ENV=2m watch_until "notify [w-done]" w-done
line_has "spawn window: a malformed value warns" "$WATCH_OUT" \
  "ignoring RALPH_HERDR_WATCH_ARM_SEC='2m'"
is "spawn window: …and does not kill the watcher" "0" "$WATCH_RC"
WATCH_ARM_ENV=

# ── the latch, not just the clock: a target seen working is terminal on idle ──
# The window bounds the ambiguity; being observed live resolves it outright. A
# session that worked and then went idle really has finished, and must drop
# immediately rather than waiting out the window.
printf '{"agent":{"name":"w-arm","agent_status":"working","pane_id":"p1","workspace_id":"w1","tab_id":"w1:t1","terminal_id":"t","focused":false,"revision":1}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-get.w-arm.json"
printf '{"agent":{"name":"w-arm","agent_status":"working"}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-wait.w-arm.json"
(
  sleep 2
  printf '{"agent":{"name":"w-arm","agent_status":"idle","pane_id":"p1","workspace_id":"w1","tab_id":"w1:t1","terminal_id":"t","focused":false,"revision":1}}\n' \
    >"$FAKE_HERDR_FIXTURES/agent-get.w-arm.json"
) &
flip=$!
WATCH_ARM_ENV=3600 watch_until "notify [w-arm]" w-arm w-fresh
wait "$flip" 2>/dev/null || true
line_has  "latch: a target observed working drops on idle inside the window" "$WATCH_OUT" \
  "notify [w-arm] ralph: w-arm idle"
line_lacks "latch: it is never held as a spawn-window read" "$WATCH_OUT" "w-arm reads idle inside"
line_has  "latch: the never-armed sibling is still held" "$WATCH_OUT" "w-fresh reads idle inside"
WATCH_ARM_ENV=

rm -f "$FAKE_HERDR_FIXTURES"/agent-get.* "$FAKE_HERDR_FIXTURES"/agent-wait.*

# ═══ 8. an outage-killed session is not a finished one (GH-1907) ══════════════
# The repro: an API outage killed two fleet sessions mid-turn and both read
#
#   w1863-reconcile-sweeps-every  done  1863  spawned
#
# identically to a session that had delivered and exited, over worktrees full of
# uncommitted work. `done` is a TURN boundary; an error ends a turn exactly as a
# completion does, and the state token a dead session never wrote stayed at its
# spawn value. Retiring a workspace on that reading discards finished work.
# shellcheck source=../scripts/outcome.sh
. "$SCRIPTS/outcome.sh"

mkgit() {  # mkgit DIR [dirty] — a git checkout, optionally with unstaged work
  mkdir -p "$1"
  git -C "$1" init -q 2>/dev/null
  git -C "$1" -c user.email=t@t -c user.name=t commit -q --allow-empty -m base
  [ "${2-}" = dirty ] && printf 'half a fix\n' >"$1/wip.txt"
  return 0
}
WT_DIRTY="$TMP/wt-dirty"; mkgit "$WT_DIRTY" dirty
WT_CLEAN="$TMP/wt-clean"; mkgit "$WT_CLEAN"

rc=0; ralph_worktree_dirty "$WT_DIRTY" || rc=$?
is "dirty: uncommitted work is rc 0" "0" "$rc"
rc=0; ralph_worktree_dirty "$WT_CLEAN" || rc=$?
is "dirty: a clean checkout is rc 1" "1" "$rc"
# rc 2 is a THIRD outcome, not a synonym for clean: folding an unreadable
# checkout into "no unfinished work here" is the fail-open this file removes.
rc=0; ralph_worktree_dirty "$TMP" || rc=$?
is "dirty: a non-git directory is unreadable (rc 2), not clean" "2" "$rc"
rc=0; ralph_worktree_dirty "$TMP/nowhere-at-all" || rc=$?
is "dirty: a missing path is unreadable (rc 2)" "2" "$rc"
rc=0; ralph_worktree_dirty "" || rc=$?
is "dirty: no path at all is unreadable (rc 2)" "2" "$rc"

is "outcome: the session word wins — reporting is finished even over a dirty tree" \
  "finished" "$(ralph_session_outcome reporting "$WT_DIRTY")"
is "outcome: the observed repro — token stuck at spawned + dirty tree is interrupted" \
  "interrupted" "$(ralph_session_outcome spawned "$WT_DIRTY")"
is "outcome: no token + dirty tree is interrupted" \
  "interrupted" "$(ralph_session_outcome "" "$WT_DIRTY")"
# The honest refusal. A clean tree does NOT earn a completion claim: only the
# session can make one, and this one never did.
is "outcome: no token + clean tree withholds the verdict" \
  "indeterminate" "$(ralph_session_outcome "" "$WT_CLEAN")"
is "outcome: an unresolvable checkout never yields a terminal claim" \
  "indeterminate" "$(ralph_session_outcome "" "")"
line_has "outcome: the withheld verdict names WHICH two it cannot separate" \
  "$(ralph_outcome_note indeterminate w1863)" 'killed before it could report'
line_has "outcome: and says the workspace may not be retired on it" \
  "$(ralph_outcome_note indeterminate w1863)" 'do NOT retire'

# ── through the event hook: `done` now resolves to a verdict ─────────────────
OROOT="$TMP/oroot"
OLEDG="$OROOT/acme/demo/ledger.jsonl"
mkdir -p "$(dirname "$OLEDG")"
rm -f "${OLEDG%.jsonl}.sqlite" "${OLEDG%.jsonl}.sqlite-wal" "${OLEDG%.jsonl}.sqlite-shm" # fixture rewrite: drop the tape (phase D)
cat >"$OLEDG" <<'EOF'
{"ts":"2026-08-14T00:00:00Z","ev":"spawn","agent_ref":"w1863-sweep#bbbb","pane_id":"p0","tokens":{"role":"w","issue":"1863","slug":"sweep","root":"w1863-sweep#bbbb","depth":"0","state":"spawned","branch":"feature/GH-1863","harness":"claude","spawn_epoch":"bbbb"}}
EOF

# The killed session: herdr says done, the pane token is still `spawned`, and
# the worktree holds the work it never got to commit.
herd_fixture '[{"name":"w1863-sweep","agent_status":"done","pane_id":"p0","tokens":{"state":"spawned"}}]' "$WT_DIRTY"
: >"$FAKE_HERDR_LOG"
run_event pane.agent_status_changed \
  '{"pane_id":"p0","agent":"w1863-sweep","agent_status":"done"}' "$OROOT"
is "done: exits 0" "0" "$RC"
is "done: a killed session is tokened interrupted, not left at spawned" "1" \
  "$(log_count '^pane report-metadata p0 --source ralph-herdr --token state=interrupted$')"
line_has "done: and the reason is logged, not left to a pane read" "$OUT" \
  "worktree holds uncommitted work"

# The finished session: it closed out, so its own word stands and the token is
# NOT overwritten with a restatement of it.
herd_fixture '[{"name":"w1863-sweep","agent_status":"done","pane_id":"p0","tokens":{"state":"reporting"}}]' "$WT_DIRTY"
: >"$FAKE_HERDR_LOG"
run_event pane.agent_status_changed \
  '{"pane_id":"p0","agent":"w1863-sweep","agent_status":"done"}' "$OROOT"
is "done: a session that closed out keeps its own reporting token" "0" \
  "$(log_count '^pane report-metadata p0 .*--token state=')"
line_has "done: and is recorded as a real completion claim" "$OUT" "closed out"

# Neither signal available: the verdict is withheld rather than defaulting to
# the quiet reading.
herd_fixture '[{"name":"w1863-sweep","agent_status":"done","pane_id":"p0","tokens":{"state":"spawned"}}]' "$WT_CLEAN"
: >"$FAKE_HERDR_LOG"
run_event pane.agent_status_changed \
  '{"pane_id":"p0","agent":"w1863-sweep","agent_status":"done"}' "$OROOT"
is "done: nothing to tell them apart pushes indeterminate" "1" \
  "$(log_count '^pane report-metadata p0 --source ralph-herdr --token state=indeterminate$')"

# THE defect, stated as one assertion: the two readings must differ.
herd_fixture '[{"name":"w1863-sweep","agent_status":"done","pane_id":"p0","tokens":{"state":"reporting"}}]' "$WT_CLEAN"
: >"$FAKE_HERDR_LOG"
run_event pane.agent_status_changed \
  '{"pane_id":"p0","agent":"w1863-sweep","agent_status":"done"}' "$OROOT"
is "done: a finished session and a killed one no longer read alike" "0" \
  "$(log_count 'token state=interrupted\|token state=indeterminate')"

# A verdict is a durable claim about a session fate, so it obeys the same rule
# refill does: an unverified payload may not cause one.
herd_fixture '[]'
: >"$FAKE_HERDR_LOG"
run_event pane.agent_status_changed \
  '{"pane_id":"p0","agent":"w1863-sweep","agent_status":"done"}' "$OROOT"
is "done: an unconfirmed agent gets no verdict at all" "0" \
  "$(log_count '^pane report-metadata')"

# The verdict rides in the LEDGER too, not just on the pane. Tokens are chrome:
# a server restart drops them and reconcile re-pushes from the ledger's reduced
# `state`. Left out of the record, a verdict would be silently replaced by the
# spawn record's `spawned` on the next restart — the exact reading this fixes.
herd_fixture '[{"name":"w1863-sweep","agent_status":"done","pane_id":"p0","tokens":{"state":"spawned"}}]' "$WT_DIRTY"
before_verdicts=$(lcount "$OLEDG" '.ev=="state" and .state=="interrupted"')
run_event pane.agent_status_changed \
  '{"pane_id":"p0","agent":"w1863-sweep","agent_status":"done"}' "$OROOT"
is "done: the verdict is recorded in the ledger, so it survives a token drop" "$((before_verdicts + 1))" \
  "$(lcount "$OLEDG" '.ev=="state" and .agent_status=="done" and .state=="interrupted"')"
is "done: a finished session records no verdict — reporting is already the claim" "0" \
  "$(lcount "$OLEDG" '.state=="finished"')"

# GH-1878 is not re-litigated here: `idle` is the read that cannot tell
# not-started from finished, and it still carries no lifecycle claim.
herd_fixture '[{"name":"w1863-sweep","agent_status":"idle","pane_id":"p0","tokens":{"state":"spawned"}}]' "$WT_DIRTY"
: >"$FAKE_HERDR_LOG"
run_event pane.agent_status_changed \
  '{"pane_id":"p0","agent":"w1863-sweep","agent_status":"idle"}' "$OROOT"
is "idle: still no token push — the spawn-window latch owns that read" "0" \
  "$(log_count '^pane report-metadata')"

# ═══ 10. GH-2347: claude_session on the tape, usage facts from the transcript ═
# The spawn record cannot know the session (no conversation exists yet); the
# first CONFIRMED state event binds it, and from then on the exit and `done`
# writers can find the transcript and price it. Transcripts are read from
# $CLAUDE_CONFIG_DIR — a TMP one here, never the machine's ~/.claude.
export CLAUDE_CONFIG_DIR="$TMP/claude"
USID="0d0c0b0a-1111-2222-3333-444455556666"
tdir="$CLAUDE_CONFIG_DIR/projects/$(printf '%s' "$REPO_DIR" | LC_ALL=C tr -c 'A-Za-z0-9' '-')"
mkdir -p "$tdir"
# One message streamed as two rows (output grows, input side agrees), a
# second call, a call on a model with no price row, and a torn last line —
# the shape a live transcript has.
cat >"$tdir/$USID.jsonl" <<EOF
{"type":"user","cwd":"$REPO_DIR"}
{"type":"assistant","timestamp":"2026-09-01T10:00:00Z","message":{"id":"msg_1","model":"claude-sonnet-5","usage":{"input_tokens":1000,"cache_creation_input_tokens":2000,"cache_read_input_tokens":3000,"output_tokens":10,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":2000}}}}
{"type":"assistant","timestamp":"2026-09-01T10:00:01Z","message":{"id":"msg_1","model":"claude-sonnet-5","usage":{"input_tokens":1000,"cache_creation_input_tokens":2000,"cache_read_input_tokens":3000,"output_tokens":500,"output_tokens_details":{"thinking_tokens":100},"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":2000}}}}
{"type":"assistant","timestamp":"2026-09-01T10:00:05Z","message":{"id":"msg_2","model":"claude-sonnet-5","usage":{"input_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":5000,"output_tokens":100,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}
{"type":"assistant","timestamp":"2026-09-01T10:00:09Z","message":{"id":"msg_3","model":"claude-unreleased-9","usage":{"input_tokens":1,"output_tokens":1}}}
{"type":"assistant","timest
EOF
u=$(ralph_usage_from_transcript "$tdir/$USID.jsonl") || u=""
uj() { jq -r "$1" <<<"$u" 2>/dev/null; }
is "usage: calls are distinct message ids (streamed rows deduped)" "3" "$(uj '.calls')"
is "usage: output takes the max across a message's rows"          "601" "$(uj '.output')"
is "usage: thinking tokens summed"                                "100" "$(uj '.thinking')"
is "usage: cache write lands in the 1h bucket"                    "2000" "$(uj '.cache_write_1h')"
is "usage: max_context is the largest single prompt"              "6000" "$(uj '.max_context')"
is "usage: list_usd prices sonnet-5 at the 1h-write rate, 4dp"    "0.0176" "$(uj '.list_usd')"
is "usage: an unknown model is counted, never silently priced"    "1" "$(uj '.unpriced_calls')"
is "usage: the dominant model is named"                           "claude-sonnet-5" "$(uj '.model')"
printf '{"type":"user"}\n' >"$tdir/empty.jsonl"
fails "usage: a transcript with no model calls is rc 1, not a zero fact" ralph_usage_from_transcript "$tdir/empty.jsonl"
is "usage: transcript found by the derived cwd slug" "$tdir/$USID.jsonl" "$(_ralph_usage_transcript "$USID" "$REPO_DIR")"
is "usage: transcript found by session id alone when the checkout differs" "$tdir/$USID.jsonl" "$(_ralph_usage_transcript "$USID" "/somewhere/else")"
fails "usage: a session id outside the id charset is refused (it lands on a glob)" _ralph_usage_transcript "../x"

UROOT="$TMP/uroot"
ULEDG="$UROOT/acme/demo/ledger.jsonl"
mkdir -p "$UROOT/acme/demo"
cat >"$ULEDG" <<EOF
{"ts":"t0","ev":"spawn","agent_ref":"w2347-usage#u001","pane_id":"p0","checkout":"$REPO_DIR","session":"$(ralph_session_key)","tokens":{"role":"driver","issue":"2347","slug":"usage","root":"w2347-usage#u001","depth":"0","state":"spawned"}}
{"ts":"t1","ev":"spawn","agent_ref":"w9-nosess#u002","pane_id":"p1","checkout":"$REPO_DIR","session":"$(ralph_session_key)","tokens":{"role":"driver","issue":"9","slug":"nosess","root":"w9-nosess#u002","depth":"0","state":"spawned"}}
EOF
herd_fixture '[{"name":"w2347-usage","agent_status":"working","pane_id":"p0","agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"'"$USID"'"}},{"name":"w9-nosess","agent_status":"working","pane_id":"p1"}]'
run_event pane.agent_status_changed '{"pane_id":"p0","agent":"w2347-usage","agent_status":"working"}' "$UROOT"
is "session: exits 0" "0" "$RC"
is "session: the confirmed state event carries claude_session" "$USID" \
  "$(levents "$ULEDG" | jq -r 'select(.ev=="state" and .agent_ref=="w2347-usage#u001") | .claude_session // empty' | head -1)"
is "session: working is not a turn boundary — no usage fact yet" "0" "$(lcount "$ULEDG" '.ev=="usage"')"
RALPH_HERDR_LEDGER="$ULEDG"
is "session: the latest reader answers from the state record" "$USID" "$(_ralph_ledger_latest_claude_session w2347-usage#u001)"
is "session: open set unchanged — usage/session never open or close a row" "w2347-usage#u001 w9-nosess#u002" \
  "$(ralph_ledger_open_agents | sort | tr '\n' ' ' | sed 's/ *$//')"

herd_fixture '[{"name":"w2347-usage","agent_status":"done","pane_id":"p0","tokens":{"state":"reporting"},"agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"'"$USID"'"}},{"name":"w9-nosess","agent_status":"working","pane_id":"p1"}]'
run_event pane.agent_status_changed '{"pane_id":"p0","agent":"w2347-usage","agent_status":"done"}' "$UROOT"
is "heartbeat: exits 0" "0" "$RC"
is "heartbeat: a done turn boundary appends one usage fact via event" "1" \
  "$(lcount "$ULEDG" '.ev=="usage" and .agent_ref=="w2347-usage#u001" and .via=="event" and .claude_session=="'"$USID"'"')"
is "heartbeat: the fact carries the priced reduction and its price table" "0.0176 6000 $RALPH_USAGE_PRICE_TABLE" \
  "$(levents "$ULEDG" | jq -r 'select(.ev=="usage") | "\(.usage.list_usd) \(.usage.max_context) \(.price_table)"' | head -1)"

run_event pane.exited '{"pane_id":"p0","workspace_id":"wR"}' "$UROOT"
is "exit: exits 0" "0" "$RC"
is "exit: the exit is recorded" "1" "$(lcount "$ULEDG" '.ev=="exit" and .agent_ref=="w2347-usage#u001"')"
is "exit: a final usage fact follows the exit (latest wins, never a delta)" "usage" \
  "$(levents "$ULEDG" | jq -r 'select(.agent_ref=="w2347-usage#u001") | .ev' | tail -1)"
is "exit: two usage facts total for the measured worker" "2" "$(lcount "$ULEDG" '.ev=="usage" and .agent_ref=="w2347-usage#u001"')"
is "exit: GH-2348 backdates ts to the transcript's last call, not the detection instant" "2026-09-01T10:00:09Z" \
  "$(levents "$ULEDG" | jq -r 'select(.ev=="exit" and .agent_ref=="w2347-usage#u001") | .ts')"

run_event pane.exited '{"pane_id":"p1","workspace_id":"wR"}' "$UROOT"
is "unmeasured: a worker with no session on the tape still exits cleanly" "0" "$RC"
is "unmeasured: the exit lands" "1" "$(lcount "$ULEDG" '.ev=="exit" and .agent_ref=="w9-nosess#u002"')"
is "unmeasured: no usage fact — 'could not measure' is a log line, never a zero" "0" \
  "$(lcount "$ULEDG" '.ev=="usage" and .agent_ref=="w9-nosess#u002"')"
line_has "unmeasured: the log says why" "$OUT" "no claude_session recorded for w9-nosess#u002"

# Reconcile's discover record carries the session too — it reads the same
# snapshot column, so a worker the event hook never confirmed still binds.
DROOT="$TMP/droot"
DLEDG="$DROOT/acme/demo/ledger.jsonl"
mkdir -p "$DROOT/acme/demo"
USID2="0d0c0b0a-7777-8888-9999-000011112222"
herd_fixture '[{"name":"w77-disc","agent_status":"working","pane_id":"p0","agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"'"$USID2"'"}}]'
run_reconcile "$DROOT"
is "discover: exits 0" "0" "$RC"
is "discover: the record carries claude_session" "$USID2" \
  "$(levents "$DLEDG" | jq -r 'select(.ev=="discover" and (.agent_ref | startswith("w77-disc#"))) | .claude_session // empty')"

# ═══ 11. GH-2348: the work skill's finish fact + honest exit timestamps ══════
# _ralph_ledger_exit_ts: the fast path (SESSION/CHECKOUT passed directly,
# as reconcile's phase E and the sweep now do — zero extra ledger reads) and
# the derive-from-ref path (as watch-event's handle_gone does, bounded by one
# pane's own open refs). Reuses section 10's $USID transcript (last call
# 2026-09-01T10:00:09Z) and $ULEDG (w2347-usage#u001, already bound to it).
is "_exit_ts: fast path resolves the transcript's last call" "2026-09-01T10:00:09Z" \
  "$(_ralph_ledger_exit_ts anyref fallback-ts "$USID" "$REPO_DIR")"
is "_exit_ts: falls back when no session is known" "fallback-ts" \
  "$(_ralph_ledger_exit_ts anyref fallback-ts "" "")"
is "_exit_ts: falls back when the session has no transcript on disk" "fallback-ts" \
  "$(_ralph_ledger_exit_ts anyref fallback-ts "not-a-real-session-id-000" "$REPO_DIR")"
RALPH_HERDR_LEDGER="$ULEDG"
is "_exit_ts: derives session+checkout from the ledger when the caller passes neither" \
  "2026-09-01T10:00:09Z" "$(_ralph_ledger_exit_ts w2347-usage#u001 fallback-ts)"
is "_exit_ts: an unknown ref falls back, ledger read and all" "fallback-ts" \
  "$(_ralph_ledger_exit_ts w9-nope#zzzz fallback-ts)"

# ralph_ledger_finish_append: the work skill's own self-report (the ONE other
# agent-side ledger writer beside the spawn path's carve-out). Appends
# `ev: "finish"`, NEVER `ev: "exit"` — review caught that an early exit
# closes the open-set row while the pane is still live, and reconcile's
# phase B then mints the still-live pane a fresh, unparented epoch on its
# next pass. The regression test below reproduces exactly that: phase B's
# own predicate is `ralph_ledger_open_agents` still naming the ref.
RALPH_HERDR_LEDGER="$TMP/unit11-finish/ledger.jsonl"
ralph_ledger_append '{"ts":"t1","ev":"spawn","agent_ref":"w2348-fin#a001","pane_id":"pF"}'
frc=0
fout=$(ralph_ledger_finish_append pF review 2>&1) || frc=$?
is "finish: exits 0" "0" "$frc"
is "finish: appends a finish fact, via=VIA" "1" \
  "$(lcount "$RALPH_HERDR_LEDGER" '.ev=="finish" and .agent_ref=="w2348-fin#a001" and .via=="review"')"
is "finish: no exit fact — the pane is still live" "0" \
  "$(lcount "$RALPH_HERDR_LEDGER" '.ev=="exit" and .agent_ref=="w2348-fin#a001"')"
is "finish: REGRESSION (review finding) — the ref stays in the open set, so a still-live pane is never rediscovered as a fresh epoch" \
  "w2348-fin#a001" "$(ralph_ledger_open_agents)"
is "finish: pane correlation still resolves the ref — the real exit writer will find and close it later" \
  "w2348-fin#a001" "$(ralph_ledger_open_for_pane pF)"
is "finish: no claude_session recorded — the usage attempt is silent, not a zero fact" "0" \
  "$(lcount "$RALPH_HERDR_LEDGER" '.ev=="usage" and .agent_ref=="w2348-fin#a001"')"
frc=0
ralph_ledger_finish_append pF >/dev/null 2>&1 || frc=$?
is "finish: a second call on the still-open pane succeeds (duplicate facts are tolerated)" "0" "$frc"
is "finish: two finish facts on the tape now" "2" \
  "$(lcount "$RALPH_HERDR_LEDGER" '.ev=="finish" and .agent_ref=="w2348-fin#a001"')"
frc=0
fout=$(ralph_ledger_finish_append pNope 2>&1) || frc=$?
is "finish: an unbound pane refuses" "1" "$frc"
line_has "finish: and says why" "$fout" "no open agent_ref bound to pane"
frc=0
fout=$(ralph_ledger_finish_append 2>&1) || frc=$?
is "finish: no pane id at all refuses" "1" "$frc"
line_has "finish: and says why" "$fout" "no pane id"
ralph_ledger_append '{"ts":"t1","ev":"spawn","agent_ref":"w2348-def#a001","pane_id":"pG"}'
ralph_ledger_finish_append pG >/dev/null 2>&1
is "finish: VIA defaults to work-skill" "1" \
  "$(lcount "$RALPH_HERDR_LEDGER" '.ev=="finish" and .agent_ref=="w2348-def#a001" and .via=="work-skill"')"

# The full regression, end to end through the real subprocesses: a spawned,
# CONFIRMED worker calls finish, then a status event fires (the one that
# used to mark an unledgered ref dirty for rediscovery), then reconcile
# runs (its startup pass, phase B) — the ref must survive with its ORIGINAL
# epoch, never a second, unparented one.
GROOT="$TMP/groot"
GLEDG="$GROOT/acme/demo/ledger.jsonl"
mkdir -p "$GROOT/acme/demo"
RALPH_HERDR_LEDGER="$GLEDG" ralph_ledger_append \
  '{"ts":"g0","ev":"spawn","agent_ref":"w2348-e2e#g001","pane_id":"pE","checkout":"'"$REPO_DIR"'","tokens":{"role":"driver","issue":"2348","root":"w2348-e2e#g001","depth":"0"}}'
herd_fixture '[{"name":"w2348-e2e","agent_status":"working","pane_id":"pE"}]'
run_event pane.agent_status_changed '{"pane_id":"pE","agent":"w2348-e2e","agent_status":"working"}' "$GROOT"
is "e2e: the spawn is confirmed by a live state event" "1" \
  "$(lcount "$GLEDG" '.ev=="state" and (.agent_ref | test("^w2348-e2e#"))')"
RALPH_HERDR_LEDGER="$GLEDG" ralph_ledger_finish_append pE review >/dev/null 2>&1
run_event pane.agent_status_changed '{"pane_id":"pE","agent":"w2348-e2e","agent_status":"idle"}' "$GROOT"
run_reconcile "$GROOT"
is "e2e: REGRESSION — still live + finished, no rediscovery: the ORIGINAL epoch survives" \
  "w2348-e2e#g001" "$(RALPH_HERDR_LEDGER=$GLEDG ralph_ledger_open_ref w2348-e2e)"
is "e2e: exactly one open ref for this name — the review-caught double-epoch never happens" "1" \
  "$(RALPH_HERDR_LEDGER=$GLEDG ralph_ledger_open_agents | grep -c '^w2348-e2e#')"
is "e2e: no second discover record for this name" "0" \
  "$(lcount "$GLEDG" '.ev=="discover" and (.agent_ref | test("^w2348-e2e#"))')"

unset CLAUDE_CONFIG_DIR

echo "1..$n"
echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
