#!/usr/bin/env bash
# fleet.test.sh — executable tests for the Phase-3 fleet controller (TAP-ish,
# matching watcher.test.sh's structure).
#
#   bash plugin/ralph-herdr/tests/fleet.test.sh    # exits 0 on pass, 1 on fail
#
# Covers: the per-run arming file lifecycle (arm → state → TTL expiry at read
# time → disarm), budget-consumption atomicity under the ledger mutex
# (concurrent consumers, held-lock reentrancy, the per-run spawned set),
# FleetBrief writes validated against the REAL board CLI (contract validate
# runs offline), the watcher's refill decision table (armed+capacity → spawn;
# blocked → never; expired → disarm; frontier-empty / budget-exhausted →
# disarm + ONE toast; unreadable agent list → fail closed; in-flight picks
# count toward capacity), and spawn_issue_fleet (sibling naming, peer ledger
# records rooted at the first sibling, the In Progress-gated deferred claim
# join per sibling). All herdr
# traffic goes through tests/fake-herdr.sh and all board traffic through
# tests/fake-board.sh on PATH — no server, no GitHub, no writes outside $TMP
# (the one exception: the REAL board CLI validates a brief, read-only, from
# the repo checkout). bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../scripts"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-fleet-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

# ── the herdr + board PATH shims ─────────────────────────────────────────────
# Wrappers (not symlinks) so the repo files' exec bits are never load-bearing.
BIN="$TMP/bin"
mkdir -p "$BIN"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-herdr.sh" >"$BIN/herdr"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-board.sh" >"$BIN/board"
chmod +x "$BIN/herdr" "$BIN/board"
export PATH="$BIN:$PATH"
export HERDR_BIN_PATH="$BIN/herdr"
export FAKE_HERDR_FIXTURES="$TMP/fixtures"
export FAKE_HERDR_LOG="$TMP/herdr.log"
export FAKE_BOARD_FIXTURES="$TMP/board-fixtures"
export FAKE_BOARD_LOG="$TMP/board.log"
mkdir -p "$FAKE_HERDR_FIXTURES" "$FAKE_BOARD_FIXTURES"
: >"$FAKE_HERDR_LOG"
: >"$FAKE_BOARD_LOG"
# Guard: no subprocess may ever fall back to the real ~/.ralph.
export RALPH_HERDR_LEDGER_ROOT="$TMP/guard-root"

# A real repo with a real (local) origin: the live spawn path fetches
# origin/main before branching, so the fixture repo must answer a fetch.
ORIGIN="$TMP/origin"
REPO_DIR="$TMP/repo"
git init -q -b main "$ORIGIN" 2>/dev/null || {
  git init -q "$ORIGIN" && git -C "$ORIGIN" checkout -q -b main
}
git -C "$ORIGIN" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git clone -q "$ORIGIN" "$REPO_DIR"
WT="$TMP/wt"
mkdir -p "$WT"

# lib.sh (fleet.sh included) sourced against the fixture repo + fake board;
# it sets -euo pipefail at source time — observe failures, don't die on them.
export RALPH_HERDR_REPO="$REPO_DIR"
export RALPH_HERDR_BOARD="$BIN/board"
unset ANTHROPIC_API_KEY 2>/dev/null || true
# shellcheck source=../scripts/lib.sh
. "$SCRIPTS/lib.sh"
set +e
set +o pipefail

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
# jqf FILE EXPR — raw jq read of a JSON file
jqf() { jq -r "$2" "$1"; }
# log_count LOG REGEX — matching lines in an invocation log
log_count() { grep -c -- "$2" "$1" || true; }
# line_has DESC HAYSTACK SUBSTR / line_lacks DESC HAYSTACK SUBSTR
line_has() {
  case "$2" in *"$3"*) ok "$1" ;; *) not_ok "$1 — no '$3' in '$2'" ;; esac
}
line_lacks() {
  case "$2" in *"$3"*) not_ok "$1 — unexpected '$3' in '$2'" ;; *) ok "$1" ;; esac
}
# run_event EVENT PAYLOAD LEDGER_ROOT — run watch-event.sh as the herdr server
# would (no workspace cwd, fake board threaded for the refill branch); sets
# OUT and RC.
run_event() {
  RC=0
  OUT=$(HERDR_PLUGIN_EVENT="$1" HERDR_PLUGIN_EVENT_JSON="$2" \
    RALPH_HERDR_LEDGER_ROOT="$3" RALPH_HERDR_BOARD="$BIN/board" \
    ANTHROPIC_API_KEY= bash "$SCRIPTS/watch-event.sh" 2>&1) || RC=$?
}

# ═══ 1. run id + run dir ═════════════════════════════════════════════════════
RID=$(ralph_run_id)
case "$RID" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z-[0-9a-f][0-9a-f][0-9a-f][0-9a-f])
    ok "run id: UTC compact timestamp + 4 hex" ;;
  *) not_ok "run id: UTC compact timestamp + 4 hex — got '$RID'" ;;
esac

RALPH_HERDR_LEDGER="$TMP/u1/ledger.jsonl"
RALPH_HERDR_RUN_ID="$RID"
dir=$(ralph_run_dir "$RID")
is "run dir: nests under the scope ledger's runs/" "$TMP/u1/runs/$RID" "$dir"
is "run dir: briefs/ created" "1" "$([ -d "$dir/briefs" ] && echo 1 || echo 0)"
is "run dir: reports/ reserved for C2 from day one" "1" "$([ -d "$dir/reports" ] && echo 1 || echo 0)"
fails "run dir: refuses a missing run id" ralph_run_dir ''

# ═══ 2. arming file lifecycle — arm → state → expiry at read → disarm ════════
rc=0; RALPH_HERDR_RUN_ID= ralph_fleet_arm 2 1 >/dev/null 2>&1 || rc=$?
is "arm: refuses without RALPH_HERDR_RUN_ID" "1" "$rc"
fails "arm: refuses k=0" ralph_fleet_arm 0 1
fails "arm: refuses a non-integer k" ralph_fleet_arm x 1
fails "arm: refuses refill outside 0|1" ralph_fleet_arm 2 5
fails "arm: refuses a bad issue number" ralph_fleet_arm 2 1 12a
rc=0; RALPH_HERDR_REFILL_TTL_MIN=0 ralph_fleet_arm 2 1 >/dev/null 2>&1 || rc=$?
is "arm: refuses RALPH_HERDR_REFILL_TTL_MIN=0" "1" "$rc"
rc=0; RALPH_HERDR_REFILL_BUDGET=abc ralph_fleet_arm 2 1 >/dev/null 2>&1 || rc=$?
is "arm: refuses a non-integer RALPH_HERDR_REFILL_BUDGET" "1" "$rc"
# Leading zeros would be octal-read by bash arithmetic (0123 → 83 minutes).
rc=0; RALPH_HERDR_REFILL_TTL_MIN=0123 ralph_fleet_arm 2 1 >/dev/null 2>&1 || rc=$?
is "arm: refuses a leading-zero TTL (octal hazard)" "1" "$rc"
rc=0; RALPH_HERDR_REFILL_BUDGET=09 ralph_fleet_arm 2 1 >/dev/null 2>&1 || rc=$?
is "arm: refuses a leading-zero budget" "1" "$rc"

# refill=0 records the run for the audit trail DISARMED: every refill
# consumer gates on .armed, so a one-shot arm can never be refilled.
F0=$(ralph_fleet_arm 2 0 100)
is "arm: refill=0 writes the audit record disarmed" "false false" \
  "$(jq -r '"\(.armed) \(.refill)"' "$F0")"
S=$(ralph_fleet_state "$F0")
is "state: a one-shot (refill=0) arm reads disarmed" "false" "$(jq -r '.armed' <<<"$S")"
fails "consume: refuses a one-shot (refill=0) run" ralph_fleet_consume_budget "$F0" 555

FF=$(ralph_fleet_arm 2 1 101 102)
is "arm: writes the current run's fleet.json" "$TMP/u1/runs/$RID/fleet.json" "$FF"
is "arm: run_id recorded" "$RID" "$(jqf "$FF" '.run_id')"
is "arm: armed true" "true" "$(jqf "$FF" '.armed')"
is "arm: k recorded as a number" "2" "$(jqf "$FF" '.k')"
is "arm: refill true" "true" "$(jqf "$FF" '.refill')"
is "arm: initial spawns pre-charged against the budget (8-2)" "6" "$(jqf "$FF" '.budget_left')"
is "arm: spawned seeds the per-run set (numbers)" "[101,102]" "$(jq -c '.spawned' "$FF")"
is "arm: repo recorded for the cwd-less refill hook" "$REPO_DIR" "$(jqf "$FF" '.repo')"
is "arm: expiry is in the future (lexicographic ISO compare)" "yes" \
  "$(jq -r 'if .expires_at > .created_at then "yes" else "no" end' "$FF")"

S=$(ralph_fleet_state "$FF")
is "state: unexpired arming reads armed" "true false" \
  "$(jq -r '"\(.armed) \(.expired)"' <<<"$S")"
S=$(ralph_fleet_state)
is "state: defaults to the current run's fleet.json" "$RID" "$(jq -r '.run_id' <<<"$S")"

# TTL expiry is enforced AT READ TIME: the file still says armed=true, but
# every reader sees a lapsed arming as disarmed — no timers anywhere.
jq -c '.expires_at = "2000-01-01T00:00:00Z"' "$FF" >"$FF.t" && mv "$FF.t" "$FF"
S=$(ralph_fleet_state "$FF")
is "expiry: read-time enforcement forces armed=false" "false true" \
  "$(jq -r '"\(.armed) \(.expired)"' <<<"$S")"
is "expiry: the FILE still says armed=true (no timer rewrote it)" "true" "$(jqf "$FF" '.armed')"

rc=0; ralph_fleet_disarm "$FF" "test reason" || rc=$?
is "disarm: rc 0" "0" "$rc"
is "disarm: armed=false + reason written" "false test reason" \
  "$(jq -r '"\(.armed) \(.disarm_reason)"' "$FF")"
is "disarm: disarmed_at stamped" "1" \
  "$(jq -r 'if (.disarmed_at // "") != "" then 1 else 0 end' "$FF")"
rc=0; ralph_fleet_disarm "$TMP/nowhere/fleet.json" || rc=$?
is "disarm: a missing file is rc 0 (nothing was armed)" "0" "$rc"

fails "state: missing file is rc 1" ralph_fleet_state "$TMP/nowhere/fleet.json"
printf 'not json\n' >"$TMP/u1/garbage.json"
fails "state: garbage file is rc 1" ralph_fleet_state "$TMP/u1/garbage.json"
printf '{"run_id":"x","budget_left":3,"expires_at":"2999-01-01T00:00:00Z"}\n' >"$TMP/u1/shape.json"
fails "state: shape-invalid file (no k) is rc 1" ralph_fleet_state "$TMP/u1/shape.json"

rc=0; RALPH_HERDR_REFILL_BUDGET=2 ralph_fleet_arm 2 1 11 12 13 >/dev/null 2>&1 || rc=$?
is "arm: budget_left clamps at 0 when initial spawns exceed it" \
  "0 0" "$rc $(jqf "$TMP/u1/runs/$RID/fleet.json" '.budget_left')"

# ═══ 3. budget consumption — atomic under the scope's ledger mutex ═══════════
RID2=$(ralph_run_id)
RALPH_HERDR_LEDGER="$TMP/u2/ledger.jsonl"
RALPH_HERDR_RUN_ID="$RID2"
FF2=$(ralph_fleet_arm 3 1 201)

fails "consume: refuses a bad issue" ralph_fleet_consume_budget "$FF2" 20x
fails "consume: refuses a missing fleet file" ralph_fleet_consume_budget "$TMP/nowhere/fleet.json" 5
fails "consume: refuses an issue already spawned this run" ralph_fleet_consume_budget "$FF2" 201
left=$(ralph_fleet_consume_budget "$FF2" 202)
is "consume: decrements and prints the new budget" "6" "$left"
is "consume: records the pick in spawned" "[201,202]" "$(jq -c '.spawned' "$FF2")"
is "consume: records the pick in-flight (with a ts) for the capacity count" "1" \
  "$(jq -r '[.inflight[]? | select(.issue == 202 and (.ts // "") != "")] | length' "$FF2")"

rc=0; ralph_fleet_spawn_done "$FF2" 202 || rc=$?
is "spawn_done: rc 0, the in-flight entry is cleared" "0 0" \
  "$rc $(jq -r '[.inflight[]? | select(.issue == 202)] | length' "$FF2")"
is "spawn_done: spawned membership and budget stay spent (no re-pick, no refund)" "1 6" \
  "$(jq -r '"\([.spawned[] | select(. == 202)] | length) \(.budget_left)"' "$FF2")"
rc=0; ralph_fleet_spawn_done "$TMP/nowhere/fleet.json" 5 || rc=$?
is "spawn_done: a missing file is a quiet rc-0 no-op" "0" "$rc"

# Two concurrent consumers, DIFFERENT issues: the mutex serializes the
# read-decide-rewrite, so the budget drops exactly once per consumer — never
# the lost-update a plain read-modify-write pair would produce.
( ralph_fleet_consume_budget "$FF2" 211 >/dev/null 2>&1 ) &
p1=$!
( ralph_fleet_consume_budget "$FF2" 212 >/dev/null 2>&1 ) &
p2=$!
rc1=0; wait "$p1" || rc1=$?
rc2=0; wait "$p2" || rc2=$?
is "consume race (distinct issues): both succeed" "0:0" "$rc1:$rc2"
is "consume race: budget decremented exactly once each (6-2)" "4" "$(jqf "$FF2" '.budget_left')"
is "consume race: both picks recorded" "[201,202,211,212]" "$(jq -c '.spawned | sort' "$FF2")"
is "consume race: the mutex is released afterwards" "0" \
  "$([ -d "$TMP/u2/.ledger.lock" ] && echo 1 || echo 0)"

# Two concurrent consumers, the SAME issue: exactly one wins — the loser
# re-reads a spawned set the winner already amended (the double-pick closer).
( ralph_fleet_consume_budget "$FF2" 220 >/dev/null 2>&1 ) &
p1=$!
( ralph_fleet_consume_budget "$FF2" 220 >/dev/null 2>&1 ) &
p2=$!
rc1=0; wait "$p1" || rc1=$?
rc2=0; wait "$p2" || rc2=$?
case "$rc1:$rc2" in
  0:1 | 1:0) ok "consume race (same issue): exactly one winner" ;;
  *) not_ok "consume race (same issue): exactly one winner — got rc $rc1:$rc2" ;;
esac
is "consume race (same issue): one budget unit spent" "3" "$(jqf "$FF2" '.budget_left')"
is "consume race (same issue): the pick recorded once" "1" \
  "$(jq -r '[.spawned[] | select(. == 220)] | length' "$FF2")"

# Held-lock reentrancy: a caller already inside the scope's mutex section
# (identity-checked — the SAME lock, not any lock) must consume without
# deadlocking and without releasing the caller's lock on the way out.
ralph_ledger_lock "$TMP/u2/ledger.jsonl"
left=$(ralph_fleet_consume_budget "$FF2" 230)
rc=$?
is "consume under the held mutex: no deadlock, decrements (rc 0)" "0" "$rc"
is "consume under the held mutex: budget now 2" "2" "$left"
is "consume under the held mutex: the caller's lock is NOT released" "1" \
  "$([ -d "$TMP/u2/.ledger.lock" ] && echo 1 || echo 0)"
ralph_fleet_spawn_done "$FF2" 230
is "spawn_done under the held mutex: no deadlock, entry cleared, lock kept" "0 1" \
  "$(jq -r '[.inflight[]? | select(.issue == 230)] | length' "$FF2") $([ -d "$TMP/u2/.ledger.lock" ] && echo 1 || echo 0)"
ralph_ledger_unlock "$TMP/u2/ledger.jsonl"

jq -c '.budget_left = 0' "$FF2" >"$FF2.t" && mv "$FF2.t" "$FF2"
fails "consume: refuses when the budget is exhausted" ralph_fleet_consume_budget "$FF2" 240
jq -c '.budget_left = 5 | .expires_at = "2000-01-01T00:00:00Z"' "$FF2" >"$FF2.t" && mv "$FF2.t" "$FF2"
fails "consume: refuses an expired arming (read-time TTL)" ralph_fleet_consume_budget "$FF2" 241
jq -c '.expires_at = "2999-01-01T00:00:00Z" | .armed = false' "$FF2" >"$FF2.t" && mv "$FF2.t" "$FF2"
fails "consume: refuses a disarmed run" ralph_fleet_consume_budget "$FF2" 242

# ═══ 4. FleetBriefs — written at spawn, validated by the REAL board CLI ══════
RID3=$(ralph_run_id)
RALPH_HERDR_LEDGER="$TMP/u3/ledger.jsonl"
RALPH_HERDR_RUN_ID="$RID3"
RDIR="$TMP/u3/runs/$RID3"

fails "brief: refuses a bad issue" ralph_brief_write "w9-fix#abcd" 9x
fails "brief: refuses an unparseable ref" ralph_brief_write "not a ref" 9
fails "brief: refuses a non-w lane (no skill mapping yet)" ralph_brief_write "r9-rev#abcd" 9
rc=0; RALPH_HERDR_RUN_ID= ralph_brief_write "w9-fix#abcd" 9 >/dev/null 2>&1 || rc=$?
is "brief: refuses without a run id" "1" "$rc"

: >"$FAKE_BOARD_LOG"
B=$(ralph_brief_write "w9-fix#abcd" 9 2>/dev/null)
is "brief: lands in the run's briefs/ keyed by ref" "$RDIR/briefs/w9-fix#abcd.json" "$B"
is "brief: C3 contract header" "ralph.fleet_brief 1" \
  "$(jq -r '"\(.contract) \(.contract_version)"' "$B")"
is "brief: issue is a number, role is the ref's lane" "9 w" \
  "$(jq -r '"\(.issue) \(.role)"' "$B")"
is "brief: skill invocation is exactly the pane prompt" "/ralph:work 9" \
  "$(jqf "$B" '.skill_invocation')"
is "brief: replies route to the durable watcher agent" "herdr_agent s0-watch" \
  "$(jq -r '"\(.reply_to.kind) \(.reply_to.name)"' "$B")"
is "brief: report_path reserves the C2 slot in reports/" \
  "$RDIR/reports/w9-fix#abcd.json" "$(jqf "$B" '.report_path')"
is "brief: constraints pin branch/base/no_force" "feature/GH-9 origin/main true" \
  "$(jq -r '"\(.constraints.branch) \(.constraints.base) \(.constraints.no_force)"' "$B")"
is "brief: validated through board contract validate" "1" \
  "$(log_count "$FAKE_BOARD_LOG" '^contract validate ralph.fleet_brief ')"

B=$(ralph_brief_write "w9-fix#ef01" 9 "feature/GH-77" 2>/dev/null)
is "brief: an explicit branch overrides the default (shared-claim siblings)" \
  "feature/GH-77" "$(jqf "$B" '.constraints.branch')"
B=$(RALPH_HERDR_REPLY_TO=s0-custom ralph_brief_write "w9-fix#ff02" 9 2>/dev/null)
is "brief: RALPH_HERDR_REPLY_TO overrides the reply target" "s0-custom" \
  "$(jqf "$B" '.reply_to.name')"

# warn-not-die: a failed validation (or no CLI at all) costs a warning, never
# the brief — briefs are observations, the board stays authoritative.
printf '1\n' >"$FAKE_BOARD_FIXTURES/contract-validate.rc"
rc=0
err=$(ralph_brief_write "w9-fix#aa03" 9 2>&1 >/dev/null) || rc=$?
is "brief: failed validation keeps the brief (rc 0)" "0" "$rc"
line_has "brief: failed validation warns (kept anyway)" "$err" "kept anyway"
is "brief: the file survived the failed validation" "1" \
  "$([ -f "$RDIR/briefs/w9-fix#aa03.json" ] && echo 1 || echo 0)"
rm -f "$FAKE_BOARD_FIXTURES/contract-validate.rc"
rc=0
err=$(BOARD= ralph_brief_write "w9-fix#bb04" 9 2>&1 >/dev/null) || rc=$?
is "brief: no board CLI still writes (rc 0)" "0" "$rc"
line_has "brief: no board CLI warns (unvalidated)" "$err" "brief written unvalidated"

# The REAL validator, offline: contract validate is pure schema work — run it
# from the repo checkout (board.ts resolves scope from the tree, no network).
REAL_BOARD="$ROOT/ralph/scripts/board"
rc=0
err=$( (cd "$ROOT" && BOARD="$REAL_BOARD" ralph_brief_write "w42-real#beef" 42 >/dev/null) 2>&1 ) || rc=$?
is "brief: the REAL board CLI validates a written brief (rc 0)" "0" "$rc"
is "brief: the real validator raised no warning" "" "$err"
jq -c '.skill_invocation = "/ralph:work 999"' "$RDIR/briefs/w42-real#beef.json" >"$TMP/bad-brief.json"
rc=0
(cd "$ROOT" && "$REAL_BOARD" contract validate ralph.fleet_brief "$TMP/bad-brief.json" >/dev/null 2>&1) || rc=$?
is "brief: the REAL validator REJECTS a skill/issue mismatch (C3 is enforced)" "1" "$rc"

# ═══ 5. frontier probe — one normalized {next, queue} envelope ═══════════════
cat >"$FAKE_BOARD_FIXTURES/frontier.json" <<'EOF'
{"frontier":[{"number":11,"title":"First"},{"number":12,"title":"Second"}],"blocked":[]}
EOF
out=$(ralph_fleet_frontier_json)
is "frontier: frontierView shape normalizes to {next, queue}" "11 2" \
  "$(jq -r '"\(.next.number) \(.queue | length)"' <<<"$out")"
printf '[{"number":21,"title":"Bare"}]\n' >"$FAKE_BOARD_FIXTURES/frontier.json"
out=$(ralph_fleet_frontier_json)
is "frontier: a bare array normalizes too" "21 1" \
  "$(jq -r '"\(.next.number) \(.queue | length)"' <<<"$out")"
rm -f "$FAKE_BOARD_FIXTURES/frontier.json"
printf '{"next":{"number":31,"title":"Ranked"},"queue":[{"number":31,"title":"Ranked"}]}\n' \
  >"$FAKE_BOARD_FIXTURES/next.json"
: >"$FAKE_BOARD_LOG"
out=$(ralph_fleet_frontier_json)
is "frontier: verb absent falls back to the ranked next queue" "31" \
  "$(jq -r '.next.number' <<<"$out")"
is "frontier: the probe tried the frontier verb first" "1" \
  "$(log_count "$FAKE_BOARD_LOG" '^frontier --json$')"
is "frontier: then read next --json once" "1" "$(log_count "$FAKE_BOARD_LOG" '^next --json$')"
rm -f "$FAKE_BOARD_FIXTURES/next.json"

# ═══ 6. refill decision table (watch-event integration) ══════════════════════
# mk_row NAME — a fresh scope root with TWO open w-lane agents (w100-first on
# p1, w110-second on p2 — two panes so a row can fire two refill triggers) and
# a fresh armed run; sets ROW, RLEDGER, RRID, RFF.
mk_row() {
  ROW="$TMP/row-$1"
  RLEDGER="$ROW/acme/demo/ledger.jsonl"
  mkdir -p "$ROW/acme/demo"
  cat >"$RLEDGER" <<'EOF'
{"ts":"t0","ev":"spawn","agent_ref":"w100-first#aaaa","pane_id":"p1","tokens":{"role":"w","issue":"100","slug":"first","root":"w100-first#aaaa","depth":"0","state":"spawned","branch":"feature/GH-100","harness":"claude","spawn_epoch":"aaaa"}}
{"ts":"t1","ev":"spawn","agent_ref":"w110-second#bbbb","pane_id":"p2","tokens":{"role":"w","issue":"110","slug":"second","root":"w110-second#bbbb","depth":"0","state":"spawned","branch":"feature/GH-110","harness":"claude","spawn_epoch":"bbbb"}}
EOF
  RRID=$(ralph_run_id)
  RFF=$(RALPH_HERDR_LEDGER="$RLEDGER" RALPH_HERDR_RUN_ID="$RRID" ralph_fleet_arm 2 1 100)
}
# Default fixtures for the refill rows: the dead fleet's pane freed capacity,
# the frontier offers GH-301, worktrees open on p31 in the fixture checkout.
refill_fixtures() {
  printf '{"result":{"agents":[]}}\n' >"$FAKE_HERDR_FIXTURES/agent-list.json"
  printf '{"result":{"root_pane":{"pane_id":"p31"},"worktree":{"path":"%s"}}}\n' "$WT" \
    >"$FAKE_HERDR_FIXTURES/worktree-create.json"
  printf '{"frontier":[{"number":301,"title":"Add refill support"}],"blocked":[]}\n' \
    >"$FAKE_BOARD_FIXTURES/frontier.json"
}

# ── row A: armed + capacity → spawn from the frontier ────────────────────────
mk_row a
refill_fixtures
: >"$FAKE_HERDR_LOG"
: >"$FAKE_BOARD_LOG"
run_event pane.exited '{"pane_id":"p1"}' "$ROW"
is "refill A: hook exits 0" "0" "$RC"
is "refill A: the dead w-lane exit is ledgered" "1" \
  "$(lcount "$RLEDGER" '.ev=="exit" and .agent_ref=="w100-first#aaaa"')"
is "refill A: one frontier spawn ledgered (grammar-B name from the title)" "1" \
  "$(lcount "$RLEDGER" '.ev=="spawn" and (.agent_ref | startswith("w301-add-refill-support#"))')"
is "refill A: the spawn is honestly machine-initiated" "scheduler" \
  "$(jq -rs '[.[] | select(.ev=="spawn")] | last | .lineage.spawner.invoked_by' <"$RLEDGER")"
is "refill A: the refill_spawn annotation binds run + issue + budget" "1" \
  "$(lcount "$RLEDGER" ".ev==\"refill_spawn\" and .run_id==\"$RRID\" and .issue==301 and .budget_left==6")"
is "refill A: budget consumed + pick recorded atomically" "6 [100,301]" \
  "$(jq -r '"\(.budget_left) \(.spawned | tojson)"' "$RFF")"
is "refill A: the in-flight marker is cleared once the spawn finished" "0" \
  "$(jq -r '[.inflight[]? | select(.issue == 301)] | length' "$RFF")"
is "refill A: still armed (budget remains)" "true" "$(jqf "$RFF" '.armed')"
is "refill A: worktree created once" "1" "$(log_count "$FAKE_HERDR_LOG" '^worktree create ')"
is "refill A: agent started" "1" "$(log_count "$FAKE_HERDR_LOG" '^agent start w301-add-refill-support ')"
is "refill A: prompted with the work skill" "1" \
  "$(log_count "$FAKE_HERDR_LOG" '^agent prompt w301-add-refill-support /ralph:work 301$')"
is "refill A: candidates came from the frontier verb" "1" \
  "$(log_count "$FAKE_BOARD_LOG" '^frontier --json$')"
is "refill A: a FleetBrief was written for the refill spawn" "1" \
  "$(ls "$ROW/acme/demo/runs/$RRID/briefs/"w301-*.json 2>/dev/null | wc -l | tr -d ' ')"

# A second exit (the other seeded w-pane) with the same frontier: 301 is
# already in the per-run spawned set — never re-picked (a crashed sibling is
# attention, not capacity); the frontier is thereby empty for this run →
# disarm + ONE completion toast.
run_event pane.exited '{"pane_id":"p2"}' "$ROW"
is "refill A2: no second spawn for an already-picked issue" "1" \
  "$(lcount "$RLEDGER" '.ev=="spawn" and (.agent_ref | startswith("w301-"))')"
is "refill A2: frontier-empty disarms" "false frontier empty" \
  "$(jq -r '"\(.armed) \(.disarm_reason)"' "$RFF")"
is "refill A2: exactly one completion toast" "1" \
  "$(log_count "$FAKE_HERDR_LOG" "^notification show fleet run $RRID complete ")"

# ── row B: blocked routes attention, NEVER capacity; done refills ────────────
mk_row b
refill_fixtures
printf '{"result":{"agents":[{"name":"w100-first","agent_status":"blocked","pane_id":"p1"}]}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-list.json"
: >"$FAKE_HERDR_LOG"
: >"$FAKE_BOARD_LOG"
run_event pane.agent_status_changed \
  '{"pane_id":"p1","agent":"w100-first","agent_status":"blocked","title":"stuck"}' "$ROW"
is "refill B: blocked exits 0" "0" "$RC"
is "refill B: blocked notified (attention routing)" "1" \
  "$(log_count "$FAKE_HERDR_LOG" '^notification show w100-first blocked ')"
is "refill B: blocked NEVER spawns" "0" "$(log_count "$FAKE_HERDR_LOG" '^worktree create ')"
is "refill B: blocked never even reads the frontier" "0" \
  "$(log_count "$FAKE_BOARD_LOG" '^frontier --json$')"
is "refill B: budget untouched" "7" "$(jqf "$RFF" '.budget_left')"
run_event pane.agent_status_changed \
  '{"pane_id":"p1","agent":"w100-first","agent_status":"done"}' "$ROW"
is "refill B: done exits 0" "0" "$RC"
is "refill B: done frees capacity — frontier spawn ledgered" "1" \
  "$(lcount "$RLEDGER" '.ev=="spawn" and (.agent_ref | startswith("w301-"))')"
is "refill B: budget consumed by the done-triggered refill" "6" "$(jqf "$RFF" '.budget_left')"

# ── row C: at capacity → stays armed, no spawn ───────────────────────────────
mk_row c
refill_fixtures
printf '{"result":{"agents":[{"name":"w100-first","agent_status":"working","pane_id":"p1"},{"name":"w200-other","agent_status":"working","pane_id":"p2"}]}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-list.json"
: >"$FAKE_HERDR_LOG"
run_event pane.agent_status_changed \
  '{"pane_id":"p1","agent":"w100-first","agent_status":"done"}' "$ROW"
is "refill C: at capacity (live w-agents >= k) spawns nothing" "0" \
  "$(log_count "$FAKE_HERDR_LOG" '^worktree create ')"
is "refill C: stays armed for the next exit" "true" "$(jqf "$RFF" '.armed')"
is "refill C: budget untouched" "7" "$(jqf "$RFF" '.budget_left')"

# ── row D: expired arming → disarmed in the FILE, no spawn, no toast ─────────
mk_row d
refill_fixtures
jq -c '.expires_at = "2000-01-01T00:00:00Z"' "$RFF" >"$RFF.t" && mv "$RFF.t" "$RFF"
: >"$FAKE_HERDR_LOG"
run_event pane.exited '{"pane_id":"p1"}' "$ROW"
is "refill D: expired run spawns nothing" "0" "$(log_count "$FAKE_HERDR_LOG" '^worktree create ')"
is "refill D: the lapsed arming is written down as disarmed" "false ttl expired" \
  "$(jq -r '"\(.armed) \(.disarm_reason)"' "$RFF")"
is "refill D: a TTL lapse is the planned bound — no toast" "0" \
  "$(log_count "$FAKE_HERDR_LOG" '^notification show fleet run ')"

# ── row E: frontier empty → disarm + ONE toast ───────────────────────────────
mk_row e
refill_fixtures
printf '{"frontier":[],"blocked":[]}\n' >"$FAKE_BOARD_FIXTURES/frontier.json"
: >"$FAKE_HERDR_LOG"
run_event pane.exited '{"pane_id":"p1"}' "$ROW"
is "refill E: empty frontier disarms" "false frontier empty" \
  "$(jq -r '"\(.armed) \(.disarm_reason)"' "$RFF")"
is "refill E: one completion toast" "1" \
  "$(log_count "$FAKE_HERDR_LOG" "^notification show fleet run $RRID complete ")"
run_event pane.exited '{"pane_id":"p2"}' "$ROW"
is "refill E: a later exit never re-toasts a disarmed run" "1" \
  "$(log_count "$FAKE_HERDR_LOG" "^notification show fleet run $RRID complete ")"

# ── row F: budget exhausted → disarm + ONE toast; racer's leftover silent ────
mk_row f
refill_fixtures
jq -c '.budget_left = 1' "$RFF" >"$RFF.t" && mv "$RFF.t" "$RFF"
: >"$FAKE_HERDR_LOG"
run_event pane.exited '{"pane_id":"p1"}' "$ROW"
is "refill F: the last budget unit still spawns" "1" \
  "$(lcount "$RLEDGER" '.ev=="spawn" and (.agent_ref | startswith("w301-"))')"
is "refill F: exhausted budget disarms after the spawn" "false budget exhausted" \
  "$(jq -r '"\(.armed) \(.disarm_reason)"' "$RFF")"
is "refill F: one completion toast" "1" \
  "$(log_count "$FAKE_HERDR_LOG" "^notification show fleet run $RRID complete ")"
# A racer's leftover (armed=true, budget 0) disarms silently — the consumer
# of the last unit already toasted; never double-toast.
jq -c '.armed = true | del(.disarm_reason)' "$RFF" >"$RFF.t" && mv "$RFF.t" "$RFF"
run_event pane.exited '{"pane_id":"p2"}' "$ROW"
is "refill F2: the leftover is disarmed" "false" "$(jqf "$RFF" '.armed')"
is "refill F2: silently — the toast count is unchanged" "1" \
  "$(log_count "$FAKE_HERDR_LOG" "^notification show fleet run $RRID complete ")"

# ── row G: recorded repo gone → disarm, never spawn ──────────────────────────
mk_row g
refill_fixtures
jq -c '.repo = "/nonexistent/checkout"' "$RFF" >"$RFF.t" && mv "$RFF.t" "$RFF"
: >"$FAKE_HERDR_LOG"
run_event pane.exited '{"pane_id":"p1"}' "$ROW"
is "refill G: a vanished repo disarms" "false repo missing" \
  "$(jq -r '"\(.armed) \(.disarm_reason)"' "$RFF")"
is "refill G: nothing spawned" "0" "$(log_count "$FAKE_HERDR_LOG" '^worktree create ')"

# ── row H: unreadable agent list → fail CLOSED (skip, stay armed) ────────────
# An unknown herd must never be spawned into: the conservative direction for
# refill is the opposite of the orphan pass's empty-on-failure convention.
mk_row h
refill_fixtures
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-list.rc"
: >"$FAKE_HERDR_LOG"
: >"$FAKE_BOARD_LOG"
run_event pane.exited '{"pane_id":"p1"}' "$ROW"
is "refill H: hook exits 0" "0" "$RC"
is "refill H: a failed agent-list read spawns NOTHING" "0" \
  "$(log_count "$FAKE_HERDR_LOG" '^worktree create ')"
is "refill H: the frontier is never even read" "0" \
  "$(log_count "$FAKE_BOARD_LOG" '^frontier --json$')"
is "refill H: stays armed, budget untouched" "true 7" \
  "$(jq -r '"\(.armed) \(.budget_left)"' "$RFF")"
line_has "refill H: the skip is logged honestly" "$OUT" "agent list read failed — leaving armed"
rm -f "$FAKE_HERDR_FIXTURES/agent-list.rc"

# ── row I: in-flight picks count toward capacity; stale ones never block ─────
mk_row i
refill_fixtures
# One live w-agent + one unexpired in-flight pick = k(2) — at capacity: a
# racer's consume is visible in fleet.json long before its agent starts.
printf '{"result":{"agents":[{"name":"w110-second","agent_status":"working","pane_id":"p2"}]}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-list.json"
jq -c --arg ts "$(date -u +%FT%TZ)" '.inflight = [{issue: 302, ts: $ts}]' \
  "$RFF" >"$RFF.t" && mv "$RFF.t" "$RFF"
: >"$FAKE_HERDR_LOG"
run_event pane.exited '{"pane_id":"p1"}' "$ROW"
is "refill I: an unexpired in-flight pick counts toward capacity — no spawn" "0" \
  "$(log_count "$FAKE_HERDR_LOG" '^worktree create ')"
is "refill I: stays armed for the next trigger, budget untouched" "true 7" \
  "$(jq -r '"\(.armed) \(.budget_left)"' "$RFF")"
# The same entry gone stale (>10 min): a dead hook's leftover under-fills at
# most until the cutoff, never forever.
jq -c '.inflight = [{issue: 302, ts: "2000-01-01T00:00:00Z"}]' "$RFF" >"$RFF.t" && mv "$RFF.t" "$RFF"
run_event pane.exited '{"pane_id":"p2"}' "$ROW"
is "refill I2: a stale in-flight leftover is ignored — the spawn proceeds" "1" \
  "$(log_count "$FAKE_HERDR_LOG" '^worktree create ')"
is "refill I2: budget consumed by the unblocked refill" "6" "$(jqf "$RFF" '.budget_left')"

# ═══ 7. spawn_issue_fleet — shared-claim siblings on ONE issue ═══════════════
RID4=$(ralph_run_id)
RALPH_HERDR_LEDGER="$TMP/if/ledger.jsonl"
RALPH_HERDR_RUN_ID="$RID4"
IFDIR="$TMP/if/runs/$RID4"
printf '{"result":{"agents":[]}}\n' >"$FAKE_HERDR_FIXTURES/agent-list.json"
printf '{"result":{"root_pane":{"pane_id":"p41"},"worktree":{"path":"%s"}}}\n' "$WT" \
  >"$FAKE_HERDR_FIXTURES/worktree-create.json"
printf '{"result":{"pane":{"pane_id":"p42"}}}\n' >"$FAKE_HERDR_FIXTURES/pane-split.p41.json"
QUEUE='{"next":{"number":77,"title":"Shared claim fleet"},"queue":[{"number":77,"title":"Shared claim fleet"}]}'

fails "issue fleet: refuses a bad issue" spawn_issue_fleet 7x 2
fails "issue fleet: refuses k=0" spawn_issue_fleet 77 0
fails "issue fleet: refuses k=5 (attended cap is 4)" spawn_issue_fleet 77 5

: >"$FAKE_HERDR_LOG"
: >"$FAKE_BOARD_LOG"
# Run in THIS shell (not a substitution subshell): the exported read-backs
# (RALPH_HERDR_FLEET_AGENTS, RALPH_HERDR_SPAWNED_REF) are part of the contract.
rc=0
spawn_issue_fleet 77 3 "$QUEUE" >"$TMP/if-out" 2>&1 || rc=$?
first_ref="$RALPH_HERDR_SPAWNED_REF"
is "issue fleet: rc 0" "0" "$rc"
is "issue fleet: first sibling normal name, siblings colliding names" \
  "w77-shared-claim-fleet w77-shared-claim-fleet--2 w77-shared-claim-fleet--3" \
  "$RALPH_HERDR_FLEET_AGENTS"
is "issue fleet: ONE worktree for the whole fleet" "1" \
  "$(log_count "$FAKE_HERDR_LOG" '^worktree create ')"
is "issue fleet: siblings split inside it, anchored at the first pane, no focus" "2" \
  "$(log_count "$FAKE_HERDR_LOG" "^pane split p41 --direction down --cwd $WT$")"
is "issue fleet: every sibling started" "3" "$(log_count "$FAKE_HERDR_LOG" '^agent start w77-')"
is "issue fleet: every sibling prompted with the SAME issue" "3" \
  "$(log_count "$FAKE_HERDR_LOG" '^agent prompt w77-shared-claim-fleet.* /ralph:work 77$')"
is "issue fleet: siblings 2..K joined to the claim explicitly" "2" \
  "$(log_count "$FAKE_BOARD_LOG" '^claim join 77 --holder w77-shared-claim-fleet--[23]$')"
is "issue fleet: the join pass gated on In Progress (claim show polled)" "1" \
  "$(log_count "$FAKE_BOARD_LOG" '^claim show 77 --json$')"
is "issue fleet: the first sibling never claim-joins (its session claims)" "0" \
  "$(log_count "$FAKE_BOARD_LOG" '^claim join 77 --holder w77-shared-claim-fleet$')"
is "issue fleet: first sibling's record roots at itself" "1" \
  "$(lcount "$RALPH_HERDR_LEDGER" ".ev==\"spawn\" and .agent_ref==\"$first_ref\" and .tokens.root==\"$first_ref\"")"
is "issue fleet: sibling records are PEERS — root=first sibling, parent empty, depth 0" "2" \
  "$(lcount "$RALPH_HERDR_LEDGER" ".ev==\"spawn\" and (.agent_ref | test(\"^w77-shared-claim-fleet--[23]#\")) and .tokens.root==\"$first_ref\" and ((.tokens | has(\"parent\")) | not) and .tokens.depth==\"0\"")"
is "issue fleet: sibling lineage has no parent_issue edge either" "2" \
  "$(lcount "$RALPH_HERDR_LEDGER" "(.agent_ref | test(\"^w77-.*--[23]#\")) and ((.lineage | has(\"parent_issue\")) | not)")"
is "issue fleet: siblings ledger the SHARED branch" "3" \
  "$(lcount "$RALPH_HERDR_LEDGER" '.ev=="spawn" and .lineage.herdr.worktree_branch=="feature/GH-77"')"
is "issue fleet: sibling tokens pushed onto the split pane (root)" "2" \
  "$(log_count "$FAKE_HERDR_LOG" "^pane report-metadata p42 .*--token root=$first_ref")"
is "issue fleet: one brief per sibling, all on the shared branch" "3 3" \
  "$(ls "$IFDIR/briefs/"w77-*.json 2>/dev/null | wc -l | tr -d ' ') $(cat "$IFDIR/briefs/"w77-*.json | jq -rs '[.[] | select(.constraints.branch=="feature/GH-77")] | length')"

# rc 2 when a session already owns the issue — fleets start fresh.
printf '{"result":{"agents":[{"name":"w77-x","agent_status":"working","pane_id":"p9"}]}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-list.json"
rc=0
out=$(spawn_issue_fleet 77 2 "$QUEUE" 2>&1) || rc=$?
is "issue fleet: a live session on the issue is rc 2 (join by hand instead)" "2" "$rc"
line_has "issue fleet: the refusal names the hand-join path" "$out" "board claim join"
printf '{"result":{"agents":[]}}\n' >"$FAKE_HERDR_FIXTURES/agent-list.json"

# claim join warn-not-die: a board-side refusal (claim vanished, race lost)
# costs a warning naming the manual join — the sibling still spawns and
# works; it just isn't visible as a holder.
printf '1\n' >"$FAKE_BOARD_FIXTURES/claim-join.rc"
rc=0
spawn_issue_fleet 78 2 '{"next":null,"queue":[{"number":78,"title":"Join later"}]}' >"$TMP/if-out" 2>&1 || rc=$?
out=$(cat "$TMP/if-out")
is "issue fleet: a refused claim join never kills the sibling (rc 0)" "0" "$rc"
line_has "issue fleet: the refusal is warned honestly" "$out" "claim join refused"
line_has "issue fleet: the warning names the manual join" "$out" \
  "board claim join 78 --holder w78-join-later--2"
is "issue fleet: the sibling still counts in the fleet" \
  "w78-join-later w78-join-later--2" "$RALPH_HERDR_FLEET_AGENTS"
rm -f "$FAKE_BOARD_FIXTURES/claim-join.rc"

# Join timing: `board claim join` is for In Progress items only — a fresh
# fleet's issue is Backlog until sibling 1's session claims, so the join
# pass WAITS for In Progress and, on timeout, joins nothing and prints the
# manual commands instead (warn-not-die).
printf '{"number":88,"state":"Backlog","claim":null,"claimRaw":null,"ageMin":null,"ttlMin":120,"stale":null}\n' \
  >"$FAKE_BOARD_FIXTURES/claim-show.json"
: >"$FAKE_BOARD_LOG"
rc=0
RALPH_HERDR_JOIN_WAIT_SEC=0 spawn_issue_fleet 88 2 \
  '{"next":null,"queue":[{"number":88,"title":"Wait out"}]}' >"$TMP/if-out" 2>&1 || rc=$?
out=$(cat "$TMP/if-out")
is "issue fleet: a join-wait timeout is rc 0 (warn-not-die)" "0" "$rc"
is "issue fleet: no join is ever attempted before In Progress" "0" \
  "$(log_count "$FAKE_BOARD_LOG" '^claim join 88 ')"
line_has "issue fleet: the timeout names the gate honestly" "$out" "never reached In Progress"
line_has "issue fleet: the timeout prints the manual join" "$out" \
  "board claim join 88 --holder w88-wait-out--2"
rm -f "$FAKE_BOARD_FIXTURES/claim-show.json"

# Dry run: the plan prints, nothing mutates.
: >"$FAKE_HERDR_LOG"
rc=0
RALPH_HERDR_DRY_RUN=true spawn_issue_fleet 99 3 '{"next":null,"queue":[{"number":99,"title":"Plan only"}]}' >"$TMP/if-out" 2>&1 || rc=$?
out=$(cat "$TMP/if-out")
is "issue fleet dry run: rc 0" "0" "$rc"
line_has "issue fleet dry run: sibling plan names the split" "$out" "would: pane split (no focus)"
line_has "issue fleet dry run: sibling plan names the claim join" "$out" "board claim join 99"
is "issue fleet dry run: planned collide names exported" \
  "w99-plan-only w99-plan-only--2 w99-plan-only--3" "$RALPH_HERDR_FLEET_AGENTS"
is "issue fleet dry run: no mutation reached herdr (reads only)" "0" \
  "$(grep -cv '^agent list' "$FAKE_HERDR_LOG" || true)"

# ═══ 8. work-fleet.sh — refill arming is opt-in plumbing ═════════════════════
printf '{"frontier":[{"number":501,"title":"One"},{"number":502,"title":"Two"}],"blocked":[]}\n' \
  >"$FAKE_BOARD_FIXTURES/frontier.json"
WFL="$TMP/wf/ledger.jsonl"
run_wf() {
  RC=0
  OUT=$(RALPH_HERDR_REPO="$REPO_DIR" RALPH_HERDR_BOARD="$BIN/board" \
    RALPH_HERDR_LEDGER="$WFL" RALPH_HERDR_DRY_RUN=true ANTHROPIC_API_KEY= \
    bash "$SCRIPTS/work-fleet.sh" "$@" </dev/null 2>&1) || RC=$?
}
run_wf
is "work-fleet dry: exits 0" "0" "$RC"
line_has "work-fleet dry: plans the frontier head" "$OUT" "DRY RUN — would spawn GH-501"
line_has "work-fleet dry: plans the second slot" "$OUT" "would spawn GH-502"
line_lacks "work-fleet dry: no --refill, no arming mention" "$OUT" "would arm run"
run_wf --refill
is "work-fleet dry --refill: exits 0" "0" "$RC"
line_has "work-fleet dry --refill: arming is planned, not performed" "$OUT" "would arm run"
line_has "work-fleet dry --refill: the plan names TTL and budget bounds" "$OUT" "ttl 120m, budget 8 total spawns"
is "work-fleet dry: nothing armed on disk" "0" \
  "$(ls "$TMP/wf/runs"/*/fleet.json 2>/dev/null | wc -l | tr -d ' ')"
run_wf --bogus
is "work-fleet: unknown arguments die" "1" "$RC"
line_has "work-fleet: the refusal names the one flag" "$OUT" "unknown argument"
RC=0
OUT=$(RALPH_HERDR_REPO="$REPO_DIR" RALPH_HERDR_BOARD="$BIN/board" \
  ANTHROPIC_API_KEY=sk-test bash "$SCRIPTS/work-fleet.sh" </dev/null 2>&1) || RC=$?
is "work-fleet: billing guard refuses a stray API key (rc 3)" "3" "$RC"
rm -f "$FAKE_BOARD_FIXTURES/frontier.json"

echo "1..$n"
echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
