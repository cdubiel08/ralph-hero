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
# dep-refs.sh (GH-2109) reaches for `gh` on PATH to read a candidate's BODY.
# Stubbing it HERE rather than per-test is deliberate: $BIN is already ahead of
# the real gh for every test in this file, so no test can hit the live API by
# forgetting to opt in — the hermetic direction is the default one.
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-gh.sh" >"$BIN/gh"
chmod +x "$BIN/herdr" "$BIN/board" "$BIN/gh"
export PATH="$BIN:$PATH"
export HERDR_BIN_PATH="$BIN/herdr"
export FAKE_HERDR_FIXTURES="$TMP/fixtures"
export FAKE_HERDR_LOG="$TMP/herdr.log"
export FAKE_BOARD_FIXTURES="$TMP/board-fixtures"
export FAKE_BOARD_LOG="$TMP/board.log"
export FAKE_GH_FIXTURES="$TMP/gh-fixtures"
export FAKE_GH_LOG="$TMP/gh.log"
mkdir -p "$FAKE_HERDR_FIXTURES" "$FAKE_BOARD_FIXTURES" "$FAKE_GH_FIXTURES"
# The healthy post-prompt world (GH-1926): the spawned agent left idle and a
# turn is running. The fake's bare default is `idle`, which the spawn path now
# refuses to count as a spawn — so a fleet test that wants a successful spawn
# must say so, exactly as the real server would have.
printf '{"agent":{"name":"w","agent_status":"working","pane_id":"p1","workspace_id":"w1","tab_id":"w1:t1","terminal_id":"term_fake","focused":false,"revision":9}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-wait-until.json"
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
# Herd fixtures: a scoped read resolves agent -> workspace -> worktree
# provenance, so the snapshot must carry the join (see herd-fixture.sh).
# shellcheck source=herd-fixture.sh
. "$SCRIPT_DIR/herd-fixture.sh"

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
# lcount FILE JQ_BOOL_EXPR — number of ledger records matching the expression.
# Reads through _ralph_ledger_events: since phase D (GH-2311) appends land in
# the sqlite tape, and the raw jsonl no longer carries them.
# shellcheck source=../scripts/ledger.sh
. "$SCRIPTS/ledger.sh"
lcount() { _ralph_ledger_events "$1" 2>/dev/null | jq -rs "[.[] | select($2)] | length"; }
# levents FILE — the ledger's event stream (either tape form)
levents() { _ralph_ledger_events "$1" 2>/dev/null; }
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

# ═══ 2b. arming scope — GH-2461's epic field ═════════════════════════════════
# A team lead's staffing run (work-fleet.sh --epic EPIC --refill) sets
# RALPH_HERDR_FLEET_EPIC before arming; refill_one reads `.epic` back to
# scope every later pick to that epic's frontier. An env var, not a new
# positional — every `ralph_fleet_arm K REFILL ISSUE...` call above (and in
# the wild) stays byte-compatible.
RID3=$(ralph_run_id)
RALPH_HERDR_RUN_ID="$RID3"
FF3=$(ralph_fleet_arm 2 1 900)
is "arm: no RALPH_HERDR_FLEET_EPIC — epic is null (unscoped, unchanged)" "null" "$(jqf "$FF3" '.epic')"

RID4=$(ralph_run_id)
RALPH_HERDR_RUN_ID="$RID4"
FF4=$(RALPH_HERDR_FLEET_EPIC=700 RALPH_HERDR_TEAM_LEAD=o700-lead RALPH_HERDR_TEAM_LEAD_REF=o700-lead#0000abcd ralph_fleet_arm 2 1 901)
is "arm: RALPH_HERDR_FLEET_EPIC records the scope as a number" "700" "$(jqf "$FF4" '.epic')"

rc=0; RALPH_HERDR_FLEET_EPIC=abc RALPH_HERDR_RUN_ID="$RID4" ralph_fleet_arm 2 1 >/dev/null 2>&1 || rc=$?
is "arm: refuses a non-numeric RALPH_HERDR_FLEET_EPIC" "1" "$rc"

# The lead identity rides beside the scope (review finding on GH-2461): the
# daemon-side refill has no lead env, so a refilled worker would otherwise be
# a depth-0 root with no RALPH_HERDR_LEAD in its pane.
is "arm: a plain run records no lead" "null null" "$(jq -r '"\(.lead) \(.lead_ref)"' "$FF3")"
is "arm: an epic run records the lead name and durable ref" "o700-lead o700-lead#0000abcd" \
  "$(jq -r '"\(.lead) \(.lead_ref)"' "$FF4")"
RID5=$(ralph_run_id)
FF5=$(RALPH_HERDR_RUN_ID="$RID5" RALPH_HERDR_FLEET_EPIC=700 RALPH_HERDR_TEAM_LEAD='$(rm -rf /)' \
  RALPH_HERDR_TEAM_LEAD_REF='not a ref' ralph_fleet_arm 2 1 902 2>/dev/null)
is "arm: an unparseable lead name / ref is recorded as null, never verbatim" "null null" \
  "$(jq -r '"\(.lead) \(.lead_ref)"' "$FF5")"

# A relaunch supersedes the epic's earlier armed run (review finding): two
# armed runs on one epic would race the same frontier with doubled budget.
# Other epics and unscoped runs are never touched.
RID6=$(ralph_run_id)
FF6=$(RALPH_HERDR_RUN_ID="$RID6" RALPH_HERDR_FLEET_EPIC=701 ralph_fleet_arm 2 1 903)
superseded=$(REPO="$REPO_DIR" ralph_fleet_supersede_epic 700 "$RID6" | sort | tr '\n' ' ')
# Both earlier epic-700 armings (FF4 and the parse-gating FF5) are retired.
is "supersede: names EVERY earlier armed run on the epic" "$(printf '%s\n%s\n' "$RID4" "$RID5" | sort | tr '\n' ' ')" "$superseded"
is "supersede: the earlier run is disarmed with the new run named" "false superseded by run $RID6 (GH-700 relaunched)" \
  "$(jq -r '"\(.armed) \(.disarm_reason)"' "$FF4")"
is "supersede: a different epic's run stays armed" "true" "$(jqf "$FF6" '.armed')"
is "supersede: an unscoped run stays armed" "true" "$(jqf "$FF3" '.armed')"
is "supersede: nothing left to supersede prints nothing" "" "$(REPO="$REPO_DIR" ralph_fleet_supersede_epic 700 "$RID6")"
# Under a HELD scope lock (work-fleet.sh's arm-then-supersede section) the
# call must not re-lock (the mutex is not reentrant) — identity-checked like
# consume. A re-lock here would spin to the 15s stale break, not hang.
RID7=$(ralph_run_id)
ralph_ledger_lock "$RALPH_HERDR_LEDGER"
FF7=$(RALPH_HERDR_RUN_ID="$RID7" RALPH_HERDR_FLEET_EPIC=701 ralph_fleet_arm 2 1 904)
held_out=$(REPO="$REPO_DIR" ralph_fleet_supersede_epic 701 "$RID7")
ralph_ledger_unlock "$RALPH_HERDR_LEDGER"
is "supersede: works under the caller's held lock (arm-then-supersede is one section)" "$RID6" "$held_out"
is "supersede: the new run, armed first, is the one left standing" "true false" "$(jqf "$FF7" '.armed') $(jqf "$FF6" '.armed')"

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
is "brief: constraints pin branch/base/no_force" "feat/9-fake-issue origin/main true" \
  "$(jq -r '"\(.constraints.branch) \(.constraints.base) \(.constraints.no_force)"' "$B")"
is "brief: validated through board contract validate" "1" \
  "$(log_count "$FAKE_BOARD_LOG" '^contract validate ralph.fleet_brief ')"

# A brief is an observation: an unnameable issue leaves the legacy shape
# (which still resolves everywhere) rather than failing the write (GH-1858).
printf '1\n' >"$FAKE_BOARD_FIXTURES/name.9.rc"
B=$(ralph_brief_write "w9-fix#dc03" 9 2>/dev/null)
is "brief: an unnameable issue falls back to the legacy branch" "feature/GH-9" \
  "$(jqf "$B" '.constraints.branch')"
rm -f "$FAKE_BOARD_FIXTURES/name.9.rc"

B=$(ralph_brief_write "w9-fix#ef01" 9 "feature/GH-77" 2>/dev/null)
is "brief: an explicit branch overrides the default (shared-claim siblings)" \
  "feature/GH-77" "$(jqf "$B" '.constraints.branch')"
B=$(RALPH_HERDR_REPLY_TO=s0-custom ralph_brief_write "w9-fix#ff02" 9 2>/dev/null)
is "brief: RALPH_HERDR_REPLY_TO overrides the reply target" "s0-custom" \
  "$(jqf "$B" '.reply_to.name')"

# Chain of command (GH-2217): a lead-spawned brief replies to the LEAD; the
# explicit override still wins; an unparseable lead falls back to the watcher.
B=$(RALPH_HERDR_TEAM_LEAD=o900-lead ralph_brief_write "w9-fix#ab05" 9 2>/dev/null)
is "brief: reply-to defaults to the spawning lead (chain of command)" "o900-lead" \
  "$(jqf "$B" '.reply_to.name')"
B=$(RALPH_HERDR_TEAM_LEAD=o900-lead RALPH_HERDR_REPLY_TO=s0-custom ralph_brief_write "w9-fix#ac06" 9 2>/dev/null)
is "brief: explicit reply-to outranks the lead" "s0-custom" "$(jqf "$B" '.reply_to.name')"
B=$(RALPH_HERDR_TEAM_LEAD='not a name' ralph_brief_write "w9-fix#ad07" 9 2>/dev/null)
is "brief: an unparseable lead falls back to the watcher" "s0-watch" \
  "$(jqf "$B" '.reply_to.name')"

# The who-is-who block (GH-2217, D4.2): rides the spawn out-vars; empty vars
# omit their field, all empty omits the block entirely (addresses are chrome).
B=$(RALPH_HERDR_SPAWNED_ADDRESS=fake-repo/t900-teams/w9-fix \
  RALPH_HERDR_SPAWNED_WHO_LEAD=fake-repo/t900-teams/o900-lead \
  RALPH_HERDR_SPAWNED_WHO_DISPATCH=fake-repo/dispatch \
  ralph_brief_write "w9-fix#ae08" 9 2>/dev/null)
is "brief: who block carries own address, lead, dispatch" \
  "fake-repo/t900-teams/w9-fix fake-repo/t900-teams/o900-lead fake-repo/dispatch" \
  "$(jq -r '"\(.who.address) \(.who.lead) \(.who.dispatch)"' "$B")"
B=$(RALPH_HERDR_SPAWNED_ADDRESS= RALPH_HERDR_SPAWNED_WHO_LEAD= \
  RALPH_HERDR_SPAWNED_WHO_DISPATCH=fake-repo/dispatch \
  ralph_brief_write "w9-fix#af09" 9 2>/dev/null)
is "brief: leadless who keeps dispatch, omits the empty fields" "fake-repo/dispatch" \
  "$(jq -r 'if (.who|has("address")) or (.who|has("lead")) then "POLLUTED" else .who.dispatch end' "$B")"
B=$(RALPH_HERDR_SPAWNED_ADDRESS= RALPH_HERDR_SPAWNED_WHO_LEAD= \
  RALPH_HERDR_SPAWNED_WHO_DISPATCH= ralph_brief_write "w9-fix#ba10" 9 2>/dev/null)
is "brief: no derivable addresses omit the who block entirely" "absent" \
  "$(jq -r 'if has("who") then "present" else "absent" end' "$B")"

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
#
# CAPABILITY-GATED. `contract validate` is the one board verb that needs zod,
# lazy-loaded by design so an installed-plugin copy without node_modules keeps
# every other verb working — a zod-less host is SUPPORTED, and CI's test-hooks
# job is one (it installs no deps). Asserting the strict path there fails on a
# working configuration; worse, the rejection assertion below would PASS for
# the wrong reason, since a zod-less refusal is also a nonzero exit. So probe
# once and assert whichever contract actually applies. C3 enforcement itself is
# covered independently by contracts.test.ts in the board-tests job.
REAL_BOARD="$ROOT/ralph/scripts/board"
probe=$( (cd "$ROOT" && "$REAL_BOARD" contract validate ralph.fleet_brief \
  "$ROOT/ralph/contracts/examples/good/ralph.fleet_brief.json") 2>&1 >/dev/null ) || true
case $probe in
  *"needs the zod package"*) real_validator=absent ;;
  *) real_validator=present ;;
esac

if [ "$real_validator" = present ]; then
  rc=0
  err=$( (cd "$ROOT" && BOARD="$REAL_BOARD" ralph_brief_write "w42-real#beef" 42 >/dev/null) 2>&1 ) || rc=$?
  is "brief: the REAL board CLI validates a written brief (rc 0)" "0" "$rc"
  is "brief: the real validator raised no warning" "" "$err"
  jq -c '.skill_invocation = "/ralph:work 999"' "$RDIR/briefs/w42-real#beef.json" >"$TMP/bad-brief.json"
  rc=0
  (cd "$ROOT" && "$REAL_BOARD" contract validate ralph.fleet_brief "$TMP/bad-brief.json" >/dev/null 2>&1) || rc=$?
  is "brief: the REAL validator REJECTS a skill/issue mismatch (C3 is enforced)" "1" "$rc"
else
  rc=0
  err=$( (cd "$ROOT" && BOARD="$REAL_BOARD" ralph_brief_write "w42-real#beef" 42 >/dev/null) 2>&1 ) || rc=$?
  is "brief: a zod-less host still writes the brief (rc 0)" "0" "$rc"
  line_has "brief: a zod-less host warns and keeps it" "$err" "kept anyway"
  is "brief: the brief survived the unavailable validator" "1" \
    "$([ -f "$RDIR/briefs/w42-real#beef.json" ] && echo 1 || echo 0)"
fi

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
# mk_row NAME [EPIC] — a fresh scope root with TWO open w-lane agents
# (w100-first on p1, w110-second on p2 — two panes so a row can fire two
# refill triggers) and a fresh armed run; sets ROW, RLEDGER, RRID, RFF. EPIC
# (GH-2461), when given, arms the run scoped to that epic — the team lead's
# staffing path (RALPH_HERDR_FLEET_EPIC, threaded by work-fleet.sh --epic
# --refill); omitted, arming is unscoped exactly as before.
mk_row() {
  ROW="$TMP/row-$1"
  RLEDGER="$ROW/acme/demo/ledger.jsonl"
  mkdir -p "$ROW/acme/demo"
  cat >"$RLEDGER" <<'EOF'
{"ts":"t0","ev":"spawn","agent_ref":"w100-first#aaaa","pane_id":"p1","tokens":{"role":"w","issue":"100","slug":"first","root":"w100-first#aaaa","depth":"0","state":"spawned","branch":"feature/GH-100","harness":"claude","spawn_epoch":"aaaa"}}
{"ts":"t1","ev":"spawn","agent_ref":"w110-second#bbbb","pane_id":"p2","tokens":{"role":"w","issue":"110","slug":"second","root":"w110-second#bbbb","depth":"0","state":"spawned","branch":"feature/GH-110","harness":"claude","spawn_epoch":"bbbb"}}
EOF
  RRID=$(ralph_run_id)
  RFF=$(RALPH_HERDR_LEDGER="$RLEDGER" RALPH_HERDR_RUN_ID="$RRID" RALPH_HERDR_FLEET_EPIC="${2:-}" ralph_fleet_arm 2 1 100)
}
# Default fixtures for the refill rows: the dead fleet's pane freed capacity,
# the frontier offers GH-301, worktrees open on p31 in the fixture checkout.
refill_fixtures() {
  herd_fixture '[]'
  # Payload only — the fake composes the protocol envelope (id + result.type).
  # Wrapping this in its own "result" would nest one inside the other, drop the
  # required `workspace` field, and get the whole response REJECTED — after
  # which the spawn silently falls through to the `worktree open` default and
  # these assertions pass without ever exercising p31/$WT.
  printf '{"workspace":{"workspace_id":"wR"},"tab":{"tab_id":"wR:t1"},"root_pane":{"pane_id":"p31"},"worktree":{"path":"%s"}}\n' "$WT" \
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
# Pins the worktree-create fixture as load-bearing: if it ever stops validating,
# the spawn falls through to the `worktree open` default and every assertion
# below still passes while testing nothing. Asserting the CREATE path's pane
# makes that failure visible instead of silent.
is "refill A: the spawn used the created worktree's pane (create path, not the open fallback)" "1" \
  "$(log_count "$FAKE_HERDR_LOG" '^agent start w301-[a-z-]* --kind claude --pane p31$')"
is "refill A: the dead w-lane exit is ledgered" "1" \
  "$(lcount "$RLEDGER" '.ev=="exit" and .agent_ref=="w100-first#aaaa"')"
is "refill A: one frontier spawn ledgered (grammar-B name from the title)" "1" \
  "$(lcount "$RLEDGER" '.ev=="spawn" and (.agent_ref | startswith("w301-add-refill-support#"))')"
is "refill A: the spawn is honestly machine-initiated" "scheduler" \
  "$(levents "$RLEDGER" | jq -rs '[.[] | select(.ev=="spawn")] | last | .lineage.spawner.invoked_by')"
# GH-1809: the live path records what reconcile later needs to tell a herdr
# restart from a crash — the pane's shell pid, and a checkout to resolve the
# board scope from. Asserted on the LIVE path specifically: the dry-run plan
# has no pane to read either from, so only this covers it.
is "refill A: spawn record carries the pane's shell pid" "9000" \
  "$(levents "$RLEDGER" | jq -rs '[.[] | select(.ev=="spawn")] | last | .shell_pid')"
is "refill A: spawn record carries the worktree checkout" "$WT" \
  "$(levents "$RLEDGER" | jq -rs '[.[] | select(.ev=="spawn")] | last | .checkout')"
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
herd_fixture '[{"name":"w100-first","agent_status":"blocked","pane_id":"p1"}]'
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
# The status now comes from the SNAPSHOT, not the payload (GH-1774) — a done
# event about an agent the herd still reports blocked is a stale hint, and
# refill must not act on it. So the herd has to actually reach done.
herd_fixture '[{"name":"w100-first","agent_status":"done","pane_id":"p1"}]'
run_event pane.agent_status_changed \
  '{"pane_id":"p1","agent":"w100-first","agent_status":"done"}' "$ROW"
is "refill B: done exits 0" "0" "$RC"
is "refill B: done frees capacity — frontier spawn ledgered" "1" \
  "$(lcount "$RLEDGER" '.ev=="spawn" and (.agent_ref | startswith("w301-"))')"
is "refill B: budget consumed by the done-triggered refill" "6" "$(jqf "$RFF" '.budget_left')"

# ── row C: at capacity → stays armed, no spawn ───────────────────────────────
mk_row c
refill_fixtures
herd_fixture '[{"name":"w100-first","agent_status":"working","pane_id":"p1"},{"name":"w200-other","agent_status":"working","pane_id":"p2"}]'
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
# The herd read is the session snapshot now, so that is what has to fail.
printf '1\n' >"$FAKE_HERDR_FIXTURES/api-snapshot.rc"
: >"$FAKE_HERDR_LOG"
: >"$FAKE_BOARD_LOG"
run_event pane.exited '{"pane_id":"p1"}' "$ROW"
is "refill H: hook exits 0" "0" "$RC"
is "refill H: a failed herd read spawns NOTHING" "0" \
  "$(log_count "$FAKE_HERDR_LOG" '^worktree create ')"
is "refill H: the frontier is never even read" "0" \
  "$(log_count "$FAKE_BOARD_LOG" '^frontier --json$')"
is "refill H: stays armed, budget untouched" "true 7" \
  "$(jq -r '"\(.armed) \(.budget_left)"' "$RFF")"
line_has "refill H: the skip is logged honestly" "$OUT" "herd read failed — leaving armed"
# Clear the injection: it is failure for ONE case, not the rest of the file.
# (Before GH-1774 leaving it set was harmless, because the herd read was a
# pipeline whose rc came from jq — the failure was swallowed and every later
# case ran against a "healthy" server. It is detected now, so it must be
# cleaned up explicitly.)
rm -f "$FAKE_HERDR_FIXTURES/api-snapshot.rc"
rm -f "$FAKE_HERDR_FIXTURES/agent-list.rc"

# ── row I: in-flight picks count toward capacity; stale ones never block ─────
mk_row i
refill_fixtures
# One live w-agent + one unexpired in-flight pick = k(2) — at capacity: a
# racer's consume is visible in fleet.json long before its agent starts.
herd_fixture '[{"name":"w110-second","agent_status":"working","pane_id":"p2"}]'
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

# ── row J: unwired body reference → refuse, ADVANCE to the next (GH-2120) ────
# GH-301's body names OPEN #777 with no `board dep` edge; GH-302 is clean.
# Refill's failure semantics deliberately differ from work-fleet's
# SKIP-and-leave-the-slot-empty (journaled on GH-2120): the seat is filled
# from the next candidate, the refusal spends NO budget unit, and the refused
# pick is never written to the spawned set — re-derived per event, so wiring
# the edge self-heals with no state to expire.
mk_row j
refill_fixtures
printf '{"frontier":[{"number":301,"title":"Add refill support"},{"number":302,"title":"Second choice"}],"blocked":[]}\n' \
  >"$FAKE_BOARD_FIXTURES/frontier.json"
jq -nc '{data:{repository:{issue:{body:"Needs the parser from #777 before this can start."}}}}' \
  >"$FAKE_GH_FIXTURES/gh-body.301.json"
printf '{"data":{"repository":{"r777":{"number":777,"state":"OPEN"}}}}\n' \
  >"$FAKE_GH_FIXTURES/gh-state.json"
: >"$FAKE_HERDR_LOG"
run_event pane.exited '{"pane_id":"p1"}' "$ROW"
is "refill J: hook exits 0" "0" "$RC"
is "refill J: the refused candidate is not spawned" "0" \
  "$(lcount "$RLEDGER" '.ev=="spawn" and (.agent_ref | startswith("w301-"))')"
is "refill J: the seat is filled from the NEXT candidate" "1" \
  "$(lcount "$RLEDGER" '.ev=="spawn" and (.agent_ref | startswith("w302-"))')"
line_has "refill J: the refusal is logged with the reference and the remedy" \
  "$OUT" "GH-301 refused — body names OPEN #777 with no dependency edge (wire it: board dep 301 --on N; no budget spent)"
is "refill J: one budget unit spent — the spawn, never the refusal" "6" "$(jqf "$RFF" '.budget_left')"
is "refill J: the refusal is not durable — spawned records only the real pick" "[100,302]" \
  "$(jq -c '.spawned' "$RFF")"
is "refill J: still armed" "true" "$(jqf "$RFF" '.armed')"

# The same run again with only the refused candidate left: refusals explaining
# an empty pick may NOT disarm — "frontier empty" would kill the run
# permanently on a prose heuristic, while a wired edge re-qualifies GH-301 at
# the very next trigger.
: >"$FAKE_HERDR_LOG"
run_event pane.exited '{"pane_id":"p2"}' "$ROW"
is "refill J2: every remaining candidate refused — nothing new spawned" "0" \
  "$(lcount "$RLEDGER" '.ev=="spawn" and (.agent_ref | startswith("w301-"))')"
line_has "refill J2: the hold is logged, not silent" \
  "$OUT" "every remaining candidate refused on unwired body refs — staying armed"
is "refill J2: stays ARMED — a refused frontier is not an empty one" "true" \
  "$(jqf "$RFF" '.armed')"
is "refill J2: no completion toast" "0" \
  "$(log_count "$FAKE_HERDR_LOG" "^notification show fleet run $RRID complete ")"
is "refill J2: budget untouched by refusals" "6" "$(jqf "$RFF" '.budget_left')"
rm -f "$FAKE_GH_FIXTURES"/gh-*.json "$FAKE_GH_FIXTURES"/gh-*.rc

# ── row K: an unreadable body fails OPEN, loudly — never grounds the fleet ───
mk_row k
refill_fixtures
echo 1 >"$FAKE_GH_FIXTURES/gh-body.rc"
: >"$FAKE_HERDR_LOG"
run_event pane.exited '{"pane_id":"p1"}' "$ROW"
is "refill K: an unreadable body never grounds the refill — the spawn proceeds" "1" \
  "$(lcount "$RLEDGER" '.ev=="spawn" and (.agent_ref | startswith("w301-"))')"
line_has "refill K: and the failed read is said out loud" "$OUT" "body refs NOT CHECKED"
line_lacks "refill K: a failed read never renders as a refusal" "$OUT" "refused — body names"
rm -f "$FAKE_GH_FIXTURES"/gh-*.json "$FAKE_GH_FIXTURES"/gh-*.rc

# ── row L: past the refusal cap the next candidate spawns UNVETTED ───────────
# The guard over-reports by construction and has no operator to override it
# here; a fleet that stops refilling because the frontier's top carries prose
# refs is the grounded-fleet failure dep-refs.sh's own header warns about.
# Unvetted is the pre-guard norm — strictly no worse, and loudly logged.
mk_row l
refill_fixtures
printf '{"frontier":[{"number":301,"title":"One"},{"number":303,"title":"Three"},{"number":302,"title":"Two"}],"blocked":[]}\n' \
  >"$FAKE_BOARD_FIXTURES/frontier.json"
jq -nc '{data:{repository:{issue:{body:"Needs #777 first."}}}}' \
  >"$FAKE_GH_FIXTURES/gh-body.301.json"
jq -nc '{data:{repository:{issue:{body:"Also needs #777 first."}}}}' \
  >"$FAKE_GH_FIXTURES/gh-body.303.json"
printf '{"data":{"repository":{"r777":{"number":777,"state":"OPEN"}}}}\n' \
  >"$FAKE_GH_FIXTURES/gh-state.json"
export RALPH_HERDR_REFILL_DEP_MAX=1
: >"$FAKE_HERDR_LOG"
run_event pane.exited '{"pane_id":"p1"}' "$ROW"
unset RALPH_HERDR_REFILL_DEP_MAX
is "refill L: the refused candidate is skipped" "0" \
  "$(lcount "$RLEDGER" '.ev=="spawn" and (.agent_ref | startswith("w301-"))')"
is "refill L: past the cap the NEXT candidate spawns unvetted — never a stall" "1" \
  "$(lcount "$RLEDGER" '.ev=="spawn" and (.agent_ref | startswith("w303-"))')"
line_has "refill L: the cap is logged, so the unvetted spawn is honest" \
  "$OUT" "unwired-ref refusal cap (1) reached — the next candidate spawns unvetted"
rm -f "$FAKE_GH_FIXTURES"/gh-*.json "$FAKE_GH_FIXTURES"/gh-*.rc

# ── row M: an epic-scoped arming refills ONLY from that epic's frontier ──────
# GH-2461: `work-fleet.sh --epic EPIC --refill` threads RALPH_HERDR_FLEET_EPIC
# into ralph_fleet_arm at arm time; refill_one reads `.epic` back off
# fleet.json and passes it to ralph_fleet_frontier_json — the SAME scoped
# read `work-fleet --epic` uses (`board frontier --json --epic EPIC`). The
# unscoped frontier's top pick (GH-999, a stranger to this team) must NEVER
# spawn; only the epic-scoped one (GH-701) may.
RALPH_HERDR_TEAM_LEAD=o700-lead RALPH_HERDR_TEAM_LEAD_REF=o700-lead#0000abcd mk_row m 700
herd_fixture '[]'
printf '{"workspace":{"workspace_id":"wM"},"tab":{"tab_id":"wM:t1"},"root_pane":{"pane_id":"p41"},"worktree":{"path":"%s"}}\n' "$WT" \
  >"$FAKE_HERDR_FIXTURES/worktree-create.json"
printf '{"frontier":[{"number":999,"title":"Not this team, a stranger"}],"blocked":[]}\n' \
  >"$FAKE_BOARD_FIXTURES/frontier.json"
printf '{"epic":700,"epicOnTopology":true,"frontier":[{"number":701,"title":"In the team scope","parentNumber":700}],"blocked":[]}\n' \
  >"$FAKE_BOARD_FIXTURES/frontier.epic.700.json"
: >"$FAKE_HERDR_LOG"
: >"$FAKE_BOARD_LOG"
run_event pane.exited '{"pane_id":"p1"}' "$ROW"
is "refill M: hook exits 0" "0" "$RC"
is "refill M: the epic-scoped candidate spawns" "1" \
  "$(lcount "$RLEDGER" '.ev=="spawn" and (.agent_ref | startswith("w701-"))')"
is "refill M: the unscoped candidate never spawns" "0" \
  "$(lcount "$RLEDGER" '.ev=="spawn" and (.agent_ref | startswith("w999-"))')"
is "refill M: the frontier read carried the --epic scope" "1" \
  "$(log_count "$FAKE_BOARD_LOG" '^frontier --json --epic 700$')"
# The lead identity restored from fleet.json (review finding): the worker is
# the lead's child in the ledger and carries the lead's address in its pane.
is "refill M: the refilled worker's lineage parent is the lead's ref" "o700-lead#0000abcd" \
  "$(levents "$RLEDGER" | jq -rs '[.[] | select(.ev=="spawn" and (.agent_ref | startswith("w701-")))] | last | .tokens.parent // empty')"
is "refill M: depth 1 — a team worker, not a root" "1" \
  "$(levents "$RLEDGER" | jq -rs '[.[] | select(.ev=="spawn" and (.agent_ref | startswith("w701-")))] | last | .tokens.depth // empty')"
is "refill M: RALPH_HERDR_LEAD is injected into the worker pane" "1" \
  "$(log_count "$FAKE_HERDR_LOG" 'RALPH_HERDR_LEAD=o700-lead ')"
rm -f "$FAKE_BOARD_FIXTURES/frontier.epic.700.json"

# ═══ 7. spawn_issue_fleet — REMOVED (GH-1774) ════════════════════════════════
# Shared-CHECKOUT fleets put K agents in one git worktree, racing on the index,
# the branch, and each other's uncommitted files. The function is kept as a
# hard refusal rather than deleted outright so a stale caller (a pinned plugin
# copy, a user's own script) gets a migration message instead of
# "command not found" — and so these tests can prove it never spawns again.
: >"$FAKE_HERDR_LOG"
: >"$FAKE_BOARD_LOG"
rc=0
out=$(spawn_issue_fleet 77 2 '{"next":null,"queue":[{"number":77,"title":"Shared claim fleet"}]}' 2>&1) || rc=$?
is "issue fleet: refuses (rc 1)" "1" "$rc"
line_has "issue fleet: the refusal names the worktree race, not the claim" "$out" "ONE git worktree"
line_has "issue fleet: the refusal points at decomposition" "$out" "decompose GH-77"
line_has "issue fleet: the refusal names the replacement verb" "$out" "work-fleet"

# The whole point of the removal: no topology is created, no claim is joined.
# Asserted against the transport logs rather than the return code, because a
# refusal that still mutated would be the exact failure this closes.
is "issue fleet: reaches herdr not at all" "0" \
  "$(wc -l <"$FAKE_HERDR_LOG" | tr -d ' ')"
is "issue fleet: never joins a shared claim" "0" \
  "$(log_count "$FAKE_BOARD_LOG" '^claim join ')"

# A refusal must not depend on the arguments being well-formed — a stale caller
# passing anything at all gets the migration message, never a spawn.
rc=0; spawn_issue_fleet >/dev/null 2>&1 || rc=$?
is "issue fleet: refuses with no arguments at all" "1" "$rc"
line_has "issue fleet: the refusal names the SAFE replacement (GH-1808)" \
  "$out" "spawn_investigator_fleet"

# ═══ 7b. spawn_investigator_fleet — one driver, N read-only children ═════════
# GH-1808 narrows GH-1774's finding without weakening it: what was unfixable is
# K sibling WRITERS. One driver plus N investigators is not concurrent writing,
# so it is allowed — and every part of that sentence is enforced rather than
# promised. Dry run only: the shape is what is under test, not herdr.
# The agent definition resolves from $BOARD in production; here $BOARD is the
# fake shim, so point the override at the real file — the binding's whole point
# is that the tool list comes from THAT file and nowhere else.
export RALPH_INVESTIGATOR_AGENT="$ROOT/ralph/agents/investigator.md"
rc=0
out=$(RALPH_HERDR_DRY_RUN=true spawn_investigator "700" "w700-alpha#aaaaaaaa" "$TMP/tree-x" \
  "Where is the retry loop?" 2>&1) || rc=$?
is "investigator: a driver's investigator is planned (rc 0)" "0" "$rc"
line_has "investigator: named in the investigation lane"  "$out" "agent: i700-"
line_has "investigator: opens a TAB in the driver's tree, never a new worktree" \
  "$out" "tab create --cwd $TMP/tree-x"
line_has "investigator: the harness carries the tool allowlist" "$out" "--tools"
# GH-2266: no Bash in the allowlist → process containment is INAPPLICABLE,
# recorded as such rather than claimed as applied.
line_has "investigator: process containment is inapplicable for a Bash-less harness" \
  "$out" "process containment: inapplicable"
# GH-2267: tool binding is read off the argv (an allowlist with no writer),
# reported as its own line beside process containment — two mechanisms, two
# renderings.
line_has "investigator: tool binding is observed off the argv as accepted (GH-2267)" \
  "$out" "tool binding: accepted"
# GH-2363: with no Bash in the harness and an argv ceiling of `accepted`, the
# dry-run plan names the Write-only probe that will run in-pane after start —
# the mechanism the argv observation alone cannot supply.
line_has "investigator: the dry-run plan names the write-only probe (GH-2363)" \
  "$out" "Write-only probe after start (no Bash in this harness to forge the marker with — GH-2363)"
# A definition that grants a writing tool is refused by observing the argv it
# would produce — never by trusting the file's role.
cat >"$TMP/inv-write.md" <<'DEF'
---
name: investigator
description: a definition that grants Write
tools: [Read, Grep, Write]
---
Body.
DEF
rc=0
out=$(RALPH_INVESTIGATOR_AGENT="$TMP/inv-write.md" RALPH_HERDR_DRY_RUN=true \
  spawn_investigator "700" "w700-alpha#aaaaaaaa" "$TMP/tree-x" "q" 2>&1) || rc=$?
is "investigator: a definition granting Write is refused (rc 1)" "1" "$rc"
line_has "investigator: the refusal names tool binding not_applied" "$out" "tool binding not_applied"
case "$out" in
  *"DRY RUN — would spawn investigator"*) not_ok "investigator: no plan for a refused writer" ;;
  *) ok "investigator: no plan printed for a refused writer" ;;
esac
case "$out" in
  *"--settings"*) not_ok "investigator: no sandbox profile for a harness with nothing to contain" ;;
  *) ok "investigator: no sandbox profile for a harness with nothing to contain" ;;
esac
case "$out" in
  *"worktree create"*) not_ok "investigator: must not cut a second worktree" ;;
  *) ok "investigator: cuts no second worktree" ;;
esac

# The edge rule, at the spawn path rather than in prose: the parent's role is
# READ from the ledger, so a non-driver parent is refused even when the caller
# asks nicely.
printf '%s\n' '{"ts":"2026-08-15T00:00:00Z","ev":"spawn","agent_ref":"i900-leaf#cccccccc","tokens":{"role":"investigator","issue":"900","depth":"1"}}' \
  >>"$RALPH_HERDR_LEDGER"
rc=0
out=$(RALPH_HERDR_DRY_RUN=true spawn_investigator "900" "i900-leaf#cccccccc" "$TMP/tree-x" "q" 2>&1) || rc=$?
is "investigator: an investigator may not spawn one (leaf rule)" "1" "$rc"
line_has "investigator: the refusal names the edge it refused" "$out" "may not spawn"

rc=0
out=$(spawn_investigator_fleet 700 0 2>&1) || rc=$?
is "investigator fleet: K must be positive" "1" "$rc"

# ═══ 7c. spawn_investigator (GH-2427): the probe's stdout survives $() ═══════
# GH-2382 replaced a here-string (`<<<`, which always appends a trailing
# newline) with `read ... < <(printf '%s' "$probe_out")`. `probe_out` comes
# from a command substitution, which always strips trailing newlines, so the
# printf never restores one either — `read` hits EOF with no newline and
# returns 1 (POSIX), though it still populates the variables. Every real
# caller sources fleet.sh under `set -euo pipefail` (work-fleet.sh,
# work-team.sh, lib.sh), so a real containment probe on a Bash-capable
# investigator died right after "process containment: applied" with no
# visible error. Reproduced here against the fake herd exactly as
# roles.test.sh proves spawn_containment_probe in isolation, under an
# explicit `set -e` subshell — the same posture the production sourcing chain
# imposes, which the outer `set +e` in this file's own preamble does not.
cat >"$TMP/inv-bash.md" <<'DEF'
---
name: investigator
description: a Bash-capable investigator (containment engages)
tools: [Read, Grep, Bash]
---
Body.
DEF
mkdir -p "$TMP/tree-x"
cat >"$TMP/probe-hook.sh" <<'HOOK'
#!/usr/bin/env bash
# Plays an obedient, fully-sandboxed pane: touches only the OUTSIDE and
# control markers a bound Bash + Write step would leave (FAKE_PROBE_MODE
# "applied", per roles.test.sh's own probe-hook.sh).
paths=$(printf '%s' "$2" | grep -o "touch '[^']*' '[^']*'" | head -1)
outside=$(printf '%s' "$paths" | sed -n "s/^touch '[^']*' '\([^']*\)'\$/\1/p")
control=$(printf '%s' "$2" | sed -n "s/^touch '\([^']*\)'; echo CONTROL_RC.*\$/\1/p" | head -1)
[ -n "$outside" ] && touch "$outside"
[ -n "$control" ] && touch "$control"
HOOK
chmod +x "$TMP/probe-hook.sh"
rc=0
out=$(
  (
    set -e
    RALPH_INVESTIGATOR_AGENT="$TMP/inv-bash.md" RALPH_HERDR_UNAME=Darwin \
      RALPH_HOME="$TMP/home-inv" FAKE_HERDR_PROMPT_HOOK="$TMP/probe-hook.sh" \
      spawn_investigator "700" "w700-alpha#aaaaaaaa" "$TMP/tree-x" "Where is the retry loop?"
  ) 2>&1
) || rc=$?
is "investigator probe (GH-2427): a Bash-capable investigator's containment probe does not die under set -e" "0" "$rc"
line_has "investigator probe (GH-2427): process containment reads applied" "$out" "process containment: applied"
line_has "investigator probe (GH-2427): tool binding reads accepted (no writer in the harness)" "$out" "tool binding: accepted"
line_has "investigator probe (GH-2427): the spawn completes past the probe" "$out" "spawned investigator"
unset FAKE_HERDR_PROMPT_HOOK

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

# ═══ 9. work-fleet.sh — an EXPLICIT issue list (GH-1780) ═════════════════════
# "Run a fleet on THESE issues" is an argument, not a second code path: same
# cap, same guards, same spawn primitive. The frontier read stops being the
# candidate source and becomes the eligibility oracle — and an issue it does
# not admit is SKIPPED with a named reason, never fatal, because a fleet caller
# must keep going.
cat >"$FAKE_BOARD_FIXTURES/frontier.json" <<'EOF'
{"frontier":[{"number":501,"title":"One"},{"number":502,"title":"Two"},{"number":503,"title":"Three"}],
 "blocked":[{"number":601,"blockers_open":[7,8]},{"number":602,"blockers_open":[],"truncated":true}]}
EOF
run_wf 503 501
is "work-fleet list: exits 0" "0" "$RC"
is "work-fleet list: spawns exactly the named issues, in the order given" "503 501" \
  "$(printf '%s\n' "$OUT" | sed -n 's/^DRY RUN — would spawn GH-\([0-9]*\):.*/\1/p' | tr '\n' ' ' | sed 's/ *$//')"
line_lacks "work-fleet list: a frontier head nobody named is left alone" "$OUT" "GH-502"

: >"$FAKE_HERDR_LOG"
: >"$FAKE_BOARD_LOG"
run_wf 601
is "work-fleet list: a blocked issue is a skip, not a failure" "0" "$RC"
line_has "work-fleet list: the skip names the open blockers" "$OUT" "SKIP blocked by #7 #8"
# The whole point of skipping BEFORE the spawn: the herd is never touched and
# the board is never written — validation is a read.
is "work-fleet list: a skipped issue reaches herdr not at all" "0" \
  "$(wc -l <"$FAKE_HERDR_LOG" | tr -d ' ')"
is "work-fleet list: validation never mutates the board" "0" \
  "$(log_count "$FAKE_BOARD_LOG" '^\(move\|claim\|answer\) ')"

run_wf 602
line_has "work-fleet list: a truncated dependency read fails closed, and says so" \
  "$OUT" "blocked (dependency read truncated"

: >"$FAKE_BOARD_LOG"
run_wf 999
is "work-fleet list: an issue the frontier does not carry is a skip" "0" "$RC"
line_has "work-fleet list: the reason is the board's own view, not a guess" \
  "$OUT" "not on the frontier — board says: #999 [Backlog]"
is "work-fleet list: naming it costs exactly one targeted board get" "1" \
  "$(log_count "$FAKE_BOARD_LOG" '^get 999')"

run_wf 601 501
is "work-fleet list: one bad issue does not strand the rest (rc 0)" "0" "$RC"
line_has "work-fleet list: the blocked one is skipped" "$OUT" "SKIP blocked by"
line_has "work-fleet list: the eligible one still spawns" "$OUT" "would spawn GH-501"
line_has "work-fleet list: the summary reports the skip" "$OUT" "skipped: GH-601"

run_wf 1 2 3 4 5
is "work-fleet list: more than the hard cap dies" "1" "$RC"
line_has "work-fleet list: the refusal names the cap" "$OUT" "hard cap is 4"

run_wf --refill 501
is "work-fleet list: --refill with an explicit list dies" "1" "$RC"
line_has "work-fleet list: the refusal explains why refill and a list conflict" \
  "$OUT" "closed set"

run_wf --help
is "work-fleet: --help exits 0" "0" "$RC"
line_has "work-fleet: the capability is discoverable from --help" \
  "$OUT" "work-fleet.sh [--refill] [--no-watch] [ISSUE...]"

# ═══ 9a. work-fleet.sh --no-watch — spawn, confirm, exit (GH-2228) ═══════════
# For an orchestrating session that backgrounds the run and reads the board
# anyway, the watcher is decorative and its only fate is to be killed at the
# terminal. --no-watch prints the spawn summary and EXITS: no notify-watch,
# and no hold_pane Enter-hold either — there is no pane, and the hold would be
# the very hang the flag removes. Non-dry runs, because the watch/hold delta
# is invisible under DRY_RUN (which exits before either).
run_wf_live() {
  RC=0
  OUT=$(RALPH_HERDR_REPO="$REPO_DIR" RALPH_HERDR_BOARD="$BIN/board" \
    RALPH_HERDR_LEDGER="$WFL" ANTHROPIC_API_KEY= \
    bash "$SCRIPTS/work-fleet.sh" "$@" </dev/null 2>&1) || RC=$?
}
run_wf_live --no-watch 601
is "no-watch: a live run with nothing spawned exits 0" "0" "$RC"
line_has "no-watch: the honest limit prints with the summary" \
  "$OUT" "watch: OFF (--no-watch) — nobody narrates completions"
line_lacks "no-watch: no pane hold — an orchestrator is never asked to press Enter" \
  "$OUT" "press Enter"

run_wf_live 601
line_has "no-watch default unchanged: the attended pane still holds for Enter" \
  "$OUT" "press Enter"
line_lacks "no-watch default unchanged: no watch-OFF line without the flag" \
  "$OUT" "watch: OFF"

RC=0
OUT=$(RALPH_HERDR_REPO="$REPO_DIR" RALPH_HERDR_BOARD="$BIN/board" \
  RALPH_HERDR_LEDGER="$WFL" ANTHROPIC_API_KEY= RALPH_HERDR_NO_WATCH=1 \
  bash "$SCRIPTS/work-fleet.sh" 601 </dev/null 2>&1) || RC=$?
is "no-watch: RALPH_HERDR_NO_WATCH=1 is the env spelling" "0" "$RC"
line_has "no-watch: the env form prints the same line" "$OUT" "watch: OFF (--no-watch)"

run_wf --no-watch
is "no-watch: composes with a dry run (rc 0)" "0" "$RC"

# ═══ 9b. work-fleet.sh --epic — the team's staffing path (GH-2214, GH-2461) ══
# --epic is the ranked frontier filtered to the epic's DIRECT children,
# capped at FLEET. A ranked path — nobody named the issues — so the
# unwired-reference guard applies; refused beside an explicit list.
# Beside --refill it is now ACCEPTED (GH-2461): work-team.sh runs it
# uncontained at team launch, since the lead's own pane cannot fetch.
cat >"$FAKE_BOARD_FIXTURES/frontier.json" <<'EOF'
{"frontier":[{"number":501,"title":"Unit A","parentNumber":700},
             {"number":502,"title":"Stranger","parentNumber":null},
             {"number":503,"title":"Unit B","parentNumber":700}],
 "blocked":[]}
EOF
run_wf --epic 700
is "work-fleet --epic: exits 0" "0" "$RC"
line_has "work-fleet --epic: names the team scope" "$OUT" "team GH-700 staffing"
line_has "work-fleet --epic: first ready child planned, ranked order" "$OUT" "would spawn GH-501"
line_has "work-fleet --epic: second ready child planned" "$OUT" "would spawn GH-503"
line_lacks "work-fleet --epic: a ready non-child is never team work" "$OUT" "GH-502"

RC=0
OUT=$(RALPH_HERDR_REPO="$REPO_DIR" RALPH_HERDR_BOARD="$BIN/board" \
  RALPH_HERDR_LEDGER="$WFL" RALPH_HERDR_DRY_RUN=true ANTHROPIC_API_KEY= \
  RALPH_HERDR_FLEET=1 bash "$SCRIPTS/work-fleet.sh" --epic 700 </dev/null 2>&1) || RC=$?
line_has "work-fleet --epic: RALPH_HERDR_FLEET caps the pick" "$OUT" "would spawn GH-501"
line_lacks "work-fleet --epic: past the cap is not picked" "$OUT" "would spawn GH-503"

run_wf --epic 750
is "work-fleet --epic: no ready children exits 0" "0" "$RC"
line_has "work-fleet --epic: empty slice NAMES the epic (≠ frontier empty)" \
  "$OUT" "no ready children of GH-750 on the frontier"

run_wf --epic 700 501
is "work-fleet --epic + list: dies" "1" "$RC"
line_has "work-fleet --epic + list: the override lane is named" "$OUT" "explicit override"

# --epic + --refill is now the STAFFING path itself (GH-2461, revising
# D3.2): the lead cannot arm or spawn from its own contained pane, so
# work-team.sh runs exactly this combination uncontained at team launch. The
# arming records the epic scope (RALPH_HERDR_FLEET_EPIC -> fleet.json's
# `epic` field), which refill_one later reads back to keep every pick inside
# EPIC's frontier.
run_wf --epic 700 --refill
is "work-fleet --epic + refill: no longer refused (GH-2461)" "0" "$RC"
line_has "work-fleet --epic + refill: still spawns the initial fleet" "$OUT" "would spawn GH-501"
line_has "work-fleet --epic + refill: the arming plan names the epic scope" \
  "$OUT" "would arm run"
line_has "work-fleet --epic + refill: and says WHICH scope" "$OUT" "scoped to GH-700 frontier only"

run_wf --epic
is "work-fleet --epic with no value: dies" "1" "$RC"
line_has "work-fleet --epic with no value: says what it takes" "$OUT" "--epic takes an issue number"

run_wf --epic abc
is "work-fleet --epic non-numeric: dies" "1" "$RC"

# ═══ 9b'. work-fleet.sh --epic staffs the whole SUBTREE (GH-2417) ═══════════
# The bug: a mid-level phase (an open Backlog child that itself has
# children) gets demoted by rankNext to ITS best leaf, so that leaf carries
# parentNumber == <phase>, never == the epic — invisible to a DIRECT-children
# filter. The fix routes the read itself through `board frontier --epic`
# (epicDescendantPredicate, GH-2398), so a board CLI that understands the
# flag hands back the leaf already scoped under the epic. Modeled here via
# frontier.epic.<N>.json — fake-board.sh only serves it when it sees
# `--epic N` past the two-word match key.
cat >"$FAKE_BOARD_FIXTURES/frontier.epic.800.json" <<'EOF'
{"epic":800,"epicOnTopology":true,
 "frontier":[{"number":811,"title":"direct child","parentNumber":800,"blockers":[],"eligible":true},
             {"number":822,"title":"grandchild under a mid-level phase","parentNumber":850,"via":850,"blockers":[],"eligible":true}],
 "blocked":[]}
EOF
run_wf --epic 800
is "work-fleet --epic subtree: exits 0" "0" "$RC"
line_has "work-fleet --epic subtree: the direct child is staffed" "$OUT" "would spawn GH-811"
line_has "work-fleet --epic subtree: the demoted GRANDCHILD is staffed too (GH-2417)" \
  "$OUT" "would spawn GH-822"
line_has "work-fleet --epic subtree: names the whole-subtree scope" "$OUT" "team GH-800 staffing"
rm -f "$FAKE_BOARD_FIXTURES/frontier.epic.800.json"

# A CLI that echoes epicOnTopology: false — the epic itself has left the
# board (closed with nothing live beneath it, transferred, off-board).
cat >"$FAKE_BOARD_FIXTURES/frontier.epic.801.json" <<'EOF'
{"epic":801,"epicOnTopology":false,"frontier":[],"blocked":[]}
EOF
run_wf --epic 801
is "work-fleet --epic off-topology: exits 0" "0" "$RC"
line_has "work-fleet --epic off-topology: names the cause, not just empty" \
  "$OUT" "is not on this board's open topology"
rm -f "$FAKE_BOARD_FIXTURES/frontier.epic.801.json"

# No frontier.epic.<N>.json fixture at all (only the plain frontier.json from
# 9b, still holding #501/#502/#503) — models a board CLI predating
# `--epic` (GH-2398): it silently ignores the flag, so the fleet must
# degrade to DIRECT children only rather than staffing the wrong epic.
run_wf --epic 700
line_has "work-fleet --epic degrade: still finds the direct children" "$OUT" "would spawn GH-501"
line_has "work-fleet --epic degrade: says the CLI predates --epic" "$OUT" "predates \`frontier --epic\`"

# ═══ 9c. the spawn-edge guard at the fleet path (GH-2214) ════════════════════
# Every session this script opens is a DRIVER; the spawner's stated role must
# be allowed to create one. orchestrator→driver is the lead's staffing edge
# (the whole point of D3.2); a leaf role is refused before any read.
RC=0
OUT=$(RALPH_HERDR_REPO="$REPO_DIR" RALPH_HERDR_BOARD="$BIN/board" \
  RALPH_HERDR_LEDGER="$WFL" RALPH_HERDR_DRY_RUN=true ANTHROPIC_API_KEY= \
  RALPH_HERDR_SPAWNER_ROLE=orchestrator bash "$SCRIPTS/work-fleet.sh" --epic 700 </dev/null 2>&1) || RC=$?
is "spawn edge: orchestrator→driver passes (the lead's staffing edge)" "0" "$RC"
line_has "spawn edge: the lead's pick still plans" "$OUT" "would spawn GH-501"

RC=0
OUT=$(RALPH_HERDR_REPO="$REPO_DIR" RALPH_HERDR_BOARD="$BIN/board" \
  RALPH_HERDR_LEDGER="$WFL" RALPH_HERDR_DRY_RUN=true ANTHROPIC_API_KEY= \
  RALPH_HERDR_SPAWNER_ROLE=investigator bash "$SCRIPTS/work-fleet.sh" </dev/null 2>&1) || RC=$?
is "spawn edge: a leaf role is refused" "1" "$RC"
line_has "spawn edge: the refusal names the edge" "$OUT" "may not spawn"

rm -f "$FAKE_BOARD_FIXTURES/frontier.json"
rm -f "$FAKE_GH_FIXTURES"/gh-*.json "$FAKE_GH_FIXTURES"/gh-*.rc

# ═══ 10. work-fleet.sh — the in-flight file surface at spawn (GH-2139) ═══════
# Fact, never prediction: the surface is what open fleet PRs already hold, one
# `surface:` line per PR labelled by unit. Advisory like the deps: line — it
# never refuses a spawn — and the three empty-ish renderings are pinned
# DISTINCT: "none in flight" (a real clean answer), "NOT CHECKED for #N" (one
# unreadable file list), "NOT CHECKED — could not list" (the list read failed).
printf '{"frontier":[{"number":501,"title":"One"}],"blocked":[]}\n' \
  >"$FAKE_BOARD_FIXTURES/frontier.json"

run_wf
is "surface: exits 0 with no open PRs" "0" "$RC"
line_has "surface: no open PRs is the honest empty" "$OUT" "surface: none in flight"
line_lacks "surface: a clean empty is never NOT CHECKED" "$OUT" "surface: NOT CHECKED"

cat >"$FAKE_GH_FIXTURES/gh-prs.json" <<'EOF'
[{"number":901,"headRefName":"feat/601-alpha-thing"},
 {"number":902,"headRefName":"dependabot/npm_and_yarn/foo-1.2.3"},
 {"number":903,"headRefName":"feature/GH-77"}]
EOF
printf '{"files":[{"path":"a/one.sh"},{"path":"b/two.ts"}]}\n' \
  >"$FAKE_GH_FIXTURES/gh-pr-files.901.json"
printf '{"files":[{"path":"c/three.md"}]}\n' \
  >"$FAKE_GH_FIXTURES/gh-pr-files.903.json"
run_wf
line_has "surface: a fleet PR prints its unit and files" \
  "$OUT" "surface: GH-601 (#901): a/one.sh b/two.ts"
line_has "surface: the legacy feature/GH-N grammar still resolves" \
  "$OUT" "surface: GH-77 (#903): c/three.md"
line_lacks "surface: a non-fleet branch is not part of the surface" "$OUT" "#902"
line_lacks "surface: with PRs in flight, none-in-flight does not print" \
  "$OUT" "none in flight"
line_has "surface: the spawn still happens beside the surface" "$OUT" "would spawn GH-501"

printf '1\n' >"$FAKE_GH_FIXTURES/gh-pr-files.901.rc"
run_wf
is "surface: one unreadable file list never blocks the spawn" "0" "$RC"
line_has "surface: the unreadable PR is named NOT CHECKED, per PR" \
  "$OUT" "surface: NOT CHECKED for #901"
line_has "surface: the readable sibling still prints" "$OUT" "surface: GH-77 (#903)"
rm -f "$FAKE_GH_FIXTURES/gh-pr-files.901.rc"

printf '1\n' >"$FAKE_GH_FIXTURES/gh-prs.rc"
run_wf
is "surface: an unreadable PR list never blocks the spawn" "0" "$RC"
line_has "surface: a failed list read says NOT CHECKED, loudly" \
  "$OUT" "surface: NOT CHECKED — could not list open PRs"
line_lacks "surface: could-not-read never renders as none-in-flight" \
  "$OUT" "surface: none in flight"
line_has "surface: the spawn proceeds through the failed read" "$OUT" "would spawn GH-501"

rm -f "$FAKE_BOARD_FIXTURES/frontier.json"
rm -f "$FAKE_GH_FIXTURES"/gh-*.json "$FAKE_GH_FIXTURES"/gh-*.rc

# ═══ 10. work-fleet.sh — the guard is observable, and sees past the graph ════
# GH-2109, two halves.
#
# (a) The guard was INVISIBLE. The ranked path printed `── GH-N ──` and spawned;
#     nothing said a dependency check had run, so "guarded and clean" and
#     "unguarded" rendered identically to whoever read the output. The frontier
#     read already carries every edge with its state, so the evidence is free.
#
# (b) The guard was exactly as complete as the `board dep` graph, and that graph
#     is sparser than the real dependency structure — dependencies get written
#     in prose and only sometimes get wired.
gh_body() { # gh_body N TEXT — the body dep-refs.sh will read for issue N
  jq -nc --arg b "$2" '{data:{repository:{issue:{body:$b}}}}' >"$FAKE_GH_FIXTURES/gh-body.$1.json"
}
gh_state() { # gh_state JSON — the batched alias answer, keyed r<N>
  printf '{"data":{"repository":%s}}\n' "$1" >"$FAKE_GH_FIXTURES/gh-state.json"
}
clear_gh() { rm -f "$FAKE_GH_FIXTURES"/gh-*.json "$FAKE_GH_FIXTURES"/gh-*.rc; }

# ── (a) the evidence line ────────────────────────────────────────────────────
clear_gh
printf '{"frontier":[{"number":501,"title":"One","blockers":[{"number":77,"state":"CLOSED"}]}],"blocked":[]}\n' \
  >"$FAKE_BOARD_FIXTURES/frontier.json"
run_wf
is "dep evidence: a guarded spawn still exits 0" "0" "$RC"
line_has "dep evidence: the frontier's own edge is printed with its state" "$OUT" "deps: #77 CLOSED"
line_has "dep evidence: and the spawn still happens" "$OUT" "would spawn GH-501"

printf '{"frontier":[{"number":501,"title":"One","blockers":[]}],"blocked":[]}\n' \
  >"$FAKE_BOARD_FIXTURES/frontier.json"
run_wf
line_has "dep evidence: an empty edge list reads as none, and says the frontier said so" \
  "$OUT" "deps: none (frontier reports no dependency edges)"

# A board CLI whose frontier carries no blocker list at all cannot be reported
# as having none — that collapse is this issue's own subject.
printf '{"frontier":[{"number":501,"title":"One"}],"blocked":[]}\n' \
  >"$FAKE_BOARD_FIXTURES/frontier.json"
run_wf
line_has "dep evidence: an unreported edge list is NOT reported as none" \
  "$OUT" "deps: not reported by this board CLI"
line_lacks "dep evidence: and never borrows none's wording" "$OUT" "deps: none"

# The `next` fallback spells the same fact under two other keys.
rm -f "$FAKE_BOARD_FIXTURES/frontier.json"
printf '{"next":{"number":501,"title":"One","openBlockers":[],"closedBlockers":[88]},"queue":[{"number":501,"title":"One","openBlockers":[],"closedBlockers":[88]}],"blocked":[]}\n' \
  >"$FAKE_BOARD_FIXTURES/next.json"
run_wf
line_has "dep evidence: the next-shaped fallback reports the same edge" "$OUT" "deps: #88 CLOSED"
rm -f "$FAKE_BOARD_FIXTURES/next.json"

# Evidence is owed on BOTH paths — the operator reads the same output either way.
printf '{"frontier":[{"number":501,"title":"One","blockers":[{"number":77,"state":"CLOSED"}]}],"blocked":[]}\n' \
  >"$FAKE_BOARD_FIXTURES/frontier.json"
run_wf 501
line_has "dep evidence: an explicitly named issue reports its edges too" "$OUT" "deps: #77 CLOSED"

# ── (b) the unwired body reference ───────────────────────────────────────────
clear_gh
printf '{"frontier":[{"number":501,"title":"One","blockers":[]},{"number":502,"title":"Two","blockers":[]}],"blocked":[]}\n' \
  >"$FAKE_BOARD_FIXTURES/frontier.json"
gh_body 501 'Needs the parser from #777 before this can start.'
gh_state '{"r777":{"number":777,"state":"OPEN"}}'
: >"$FAKE_HERDR_LOG"
: >"$FAKE_BOARD_LOG"
# One slot, two ranked candidates: the only way #502 could appear is if the
# refusal promoted it, which is the question this section is asking.
RC=0
OUT=$(RALPH_HERDR_REPO="$REPO_DIR" RALPH_HERDR_BOARD="$BIN/board" \
  RALPH_HERDR_LEDGER="$WFL" RALPH_HERDR_DRY_RUN=true ANTHROPIC_API_KEY= \
  RALPH_HERDR_FLEET=1 bash "$SCRIPTS/work-fleet.sh" </dev/null 2>&1) || RC=$?
is "unwired ref: a refused spawn is a skip, not a failure" "0" "$RC"
line_has "unwired ref: the refusal names the reference" "$OUT" "SKIP body names OPEN #777"
line_has "unwired ref: and names the two remedies" "$OUT" "wire it (board dep 501 --on N) or name this issue explicitly (work-fleet 501)"
line_lacks "unwired ref: the refused issue is not spawned" "$OUT" "would spawn GH-501"
line_has "unwired ref: the summary carries the skip" "$OUT" "skipped: GH-501"
# SKIP, never backfill: refusing a spawn is not licence to choose replacement
# work off a prose heuristic. #502 was never in the top-1 slice and stays out.
is "unwired ref: nothing is backfilled into the freed slot" "0" \
  "$(printf '%s\n' "$OUT" | grep -c 'would spawn GH-502' || true)"
# Refusing BEFORE the spawn is the whole point: no herd write, no board write.
is "unwired ref: a refused spawn reaches herdr not at all" "0" \
  "$(wc -l <"$FAKE_HERDR_LOG" | tr -d ' ')"
is "unwired ref: and never mutates the board" "0" \
  "$(log_count "$FAKE_BOARD_LOG" '^\(move\|claim\|answer\) ')"

# The explicit list IS the override — the operator named this issue, and a
# check that over-reports by construction may not be inescapable.
run_wf 501
is "unwired ref: naming the issue explicitly still spawns it" "0" "$RC"
line_has "unwired ref: the explicit path is the sanctioned override" "$OUT" "would spawn GH-501"

# A CLOSED reference is not work anything is waiting on. `repository.issue`
# answering null (a pull request, or a stranger) lands here too.
gh_state '{"r777":{"number":777,"state":"CLOSED"},"r888":null}'
run_wf
line_has "unwired ref: a closed reference is not a dependency" "$OUT" "body refs: no unwired OPEN reference"
line_has "unwired ref: and the spawn proceeds" "$OUT" "would spawn GH-501"

# The subject is the reference the GRAPH does not have. One that is already
# wired is reported by the evidence line and must not be refused twice.
clear_gh
printf '{"frontier":[{"number":501,"title":"One","blockers":[{"number":777,"state":"CLOSED"}]}],"blocked":[]}\n' \
  >"$FAKE_BOARD_FIXTURES/frontier.json"
gh_body 501 'Needs the parser from #777 before this can start.'
gh_state '{"r777":{"number":777,"state":"OPEN"}}'
run_wf
line_has "unwired ref: an already-wired reference is not unwired" "$OUT" "body refs: no unwired OPEN reference"
line_has "unwired ref: the wired edge shows up as evidence instead" "$OUT" "deps: #777 CLOSED"

# Fail OPEN, loudly: an unreadable body is a rate limit, not a clean board —
# but "not checked" may never borrow "checked and clean"'s wording.
clear_gh
printf '{"frontier":[{"number":501,"title":"One","blockers":[]}],"blocked":[]}\n' \
  >"$FAKE_BOARD_FIXTURES/frontier.json"
gh_body 501 'Needs #777.'
echo 1 >"$FAKE_GH_FIXTURES/gh-body.rc"
run_wf
is "unwired ref: an unreadable body never grounds the fleet" "0" "$RC"
line_has "unwired ref: the failed read is spawned over, and said out loud" "$OUT" "body refs: NOT CHECKED"
line_has "unwired ref: fail-open means the spawn still happens" "$OUT" "would spawn GH-501"
line_lacks "unwired ref: a failed read never renders as a clean one" "$OUT" "no unwired OPEN reference"
clear_gh

# ── dep-refs.sh's own bias-toward-silence bounds ─────────────────────────────
DR() { RC=0; OUT=$(bash "$SCRIPTS/dep-refs.sh" "$@" 2>&1) || RC=$?; }

gh_body 501 'Design lives in `#777` and:
```
blocked by #778
```
so neither is a dependency.'
gh_state '{"r777":{"number":777,"state":"OPEN"},"r778":{"number":778,"state":"OPEN"}}'
DR 501
is "dep-refs: code is prose about references, not references" "0" "$(jq -r '.count' <<<"$OUT")"

gh_body 501 'This supersedes #501 itself and otherorg/otherrepo#888.'
gh_state '{"r501":{"number":501,"state":"OPEN"},"r888":{"number":888,"state":"OPEN"}}'
DR 501
is "dep-refs: an issue naming itself is not blocked on itself, and a foreign ref is not an edge here" \
  "0" "$(jq -r '.count' <<<"$OUT")"

gh_body 501 'Follows GH-777 and cdubiel08/ralph-hero#779.'
gh_state '{"r777":{"number":777,"state":"OPEN"},"r779":{"number":779,"state":"OPEN"}}'
DR 501
is "dep-refs: GH-N and an own-repo slug are the same reference as #N" "2" "$(jq -r '.count' <<<"$OUT")"
is "dep-refs: the summary names them" "#777 #779" "$(jq -r '.summary' <<<"$OUT")"

DR 501 "777,779"
is "dep-refs: wired numbers are dropped — the subject is what the graph lacks" \
  "0" "$(jq -r '.count' <<<"$OUT")"

gh_body 501 'Refs #777.'
gh_state '{"r777":{"number":777,"state":"OPEN"}}'
RALPH_HERDR_DEP_REF_CAP=0 DR 501
is "dep-refs: a zero cap resolves nothing and says so" "0" "$(jq -r '.count' <<<"$OUT")"
line_has "dep-refs: past the cap is reported, never dropped in silence" "$OUT" "past the cap of 0"

echo 1 >"$FAKE_GH_FIXTURES/gh-state.rc"
gh_body 501 'Refs #777.'
DR 501
is "dep-refs: an unreadable resolve is not evaluated" "false" "$(jq -r '.ok' <<<"$OUT")"
is "dep-refs: and reports nothing rather than nothing-found" "0" "$(jq -r '.count' <<<"$OUT")"
clear_gh

DR 501x
is "dep-refs: a non-numeric issue is a usage error" "2" "$RC"

rm -f "$FAKE_BOARD_FIXTURES/frontier.json"
clear_gh

# ═══ 11. work-next.sh — the ranked pick gets the same guard (GH-2120) ════════
# The third caller with the same blind spot: a single ranked spawn off
# `board next --json`. Nobody chose the issue, so a body naming OPEN own-repo
# work with no edge refuses the spawn — without advancing (an operator is at
# the keyboard, and the remedies are theirs).
run_wn() {
  RC=0
  OUT=$(RALPH_HERDR_REPO="$REPO_DIR" RALPH_HERDR_BOARD="$BIN/board" \
    RALPH_HERDR_LEDGER="$WFL" RALPH_HERDR_DRY_RUN=true ANTHROPIC_API_KEY= \
    bash "$SCRIPTS/work-next.sh" </dev/null 2>&1) || RC=$?
}
printf '{"next":{"number":501,"title":"One"},"queue":[{"number":501,"title":"One"}],"blocked":[]}\n' \
  >"$FAKE_BOARD_FIXTURES/next.json"
gh_body 501 'Needs the parser from #777 before this can start.'
gh_state '{"r777":{"number":777,"state":"OPEN"}}'
run_wn
is "work-next: a refused head is a skip, not a failure" "0" "$RC"
line_has "work-next: the refusal names the reference and both remedies" \
  "$OUT" "SKIP GH-501: body names OPEN #777 with no dependency edge — wire it (board dep 501 --on N) or spawn it explicitly (work-fleet 501)"
line_lacks "work-next: the refused head is not spawned" "$OUT" "would spawn GH-501"

# A CLOSED reference is not work anything is waiting on — clean, and printed.
gh_state '{"r777":{"number":777,"state":"CLOSED"}}'
run_wn
line_has "work-next: a closed reference is not a dependency — the spawn proceeds" \
  "$OUT" "would spawn GH-501"
line_has "work-next: and the clean verdict is printed, not implied" \
  "$OUT" "body refs: no unwired OPEN reference"

# Fail OPEN, loudly — an unreadable body is a rate limit, not a clean board.
echo 1 >"$FAKE_GH_FIXTURES/gh-body.rc"
run_wn
line_has "work-next: an unreadable body spawns over the failed read, loudly" \
  "$OUT" "body refs: NOT CHECKED"
line_has "work-next: fail-open means the spawn still happens" "$OUT" "would spawn GH-501"
line_lacks "work-next: a failed read never renders as a clean one" \
  "$OUT" "no unwired OPEN reference"
rm -f "$FAKE_BOARD_FIXTURES/next.json"
clear_gh

# ═══ 7. restart re-arm — reconcile phase F (GH-1862) ═════════════════════════
# The edge trigger cannot survive the restart, because the restart is what kills
# every session that would have fired it. These rows drive the LEVEL trigger:
# reconcile.sh's single startup pass.
#
# The fixture reproduces the restart's defining illusion, and it is the reason
# this is not a two-line change: herdr REBUILDS panes and their agent
# registrations, so `agent list` still answers "alive" for both workers whose
# processes it just killed. Only `pane process-info` disagrees — the recorded
# shell pid (123) is not the rebuilt pane's (the fake's default, 9000) — which
# is exactly the reading phase E already takes. Anything that trusted the herd
# read here would see k occupied seats and spawn nothing.
run_reconcile() {
  RC=0
  OUT=$(RALPH_HERDR_LEDGER_ROOT="$1" RALPH_HERDR_BOARD="$BIN/board" \
    ANTHROPIC_API_KEY= bash "$SCRIPTS/reconcile.sh" 2>&1) || RC=$?
}
# mk_restart_row NAME — a scope root whose two armed-run workers were killed by
# a restart: recorded shell pids that no longer match, but a herd that still
# reports both names live. Sets ROW/RLEDGER/RRID/RFF.
mk_restart_row() {
  ROW="$TMP/restart-$1"
  RLEDGER="$ROW/acme/demo/ledger.jsonl"
  mkdir -p "$ROW/acme/demo"
  cat >"$RLEDGER" <<'EOF'
{"ts":"t0","ev":"spawn","agent_ref":"w100-first#aaaa","pane_id":"p1","shell_pid":123,"tokens":{"role":"w","issue":"100","slug":"first","root":"w100-first#aaaa","depth":"0","state":"spawned","branch":"feature/GH-100","harness":"claude","spawn_epoch":"aaaa"}}
{"ts":"t1","ev":"spawn","agent_ref":"w110-second#bbbb","pane_id":"p2","shell_pid":124,"tokens":{"role":"w","issue":"110","slug":"second","root":"w110-second#bbbb","depth":"0","state":"spawned","branch":"feature/GH-110","harness":"claude","spawn_epoch":"bbbb"}}
EOF
  RRID=$(ralph_run_id)
  RFF=$(RALPH_HERDR_LEDGER="$RLEDGER" RALPH_HERDR_RUN_ID="$RRID" ralph_fleet_arm 2 1 100)
  # The restart illusion: both dead workers still answer the herd read.
  herd_fixture '[{"name":"w100-first","agent_status":"working","pane_id":"p1"},{"name":"w110-second","agent_status":"working","pane_id":"p2"}]'
  printf '{"workspace":{"workspace_id":"wR"},"tab":{"tab_id":"wR:t1"},"root_pane":{"pane_id":"p31"},"worktree":{"path":"%s"}}\n' "$WT" \
    >"$FAKE_HERDR_FIXTURES/worktree-create.json"
  printf '{"frontier":[{"number":301,"title":"Add refill support"},{"number":302,"title":"Second candidate"}],"blocked":[]}\n' \
    >"$FAKE_BOARD_FIXTURES/frontier.json"
  : >"$FAKE_HERDR_LOG"
  : >"$FAKE_BOARD_LOG"
}

# ── row H: the acceptance criterion — work is being worked again ─────────────
mk_restart_row h
run_reconcile "$ROW"
is "restart H: the pass completes" "0" "$RC"
is "restart H: both dead workers are exited restart_killed" "2" \
  "$(lcount "$RLEDGER" '.ev=="exit" and .reason=="restart_killed"')"
# The heart of it: BOTH freed seats refill, not one. The edge trigger fires
# once per vacated seat; a restart vacates every seat with no event at all, so
# the level trigger has to keep asking until the run is back at k.
is "restart H: both freed seats spawn — the fleet is working again" "2" \
  "$(lcount "$RLEDGER" '.ev=="spawn" and ((.agent_ref | startswith("w301-")) or (.agent_ref | startswith("w302-")))')"
is "restart H: the refills are honestly machine-initiated" "2" \
  "$(lcount "$RLEDGER" '.ev=="refill_spawn"')"
is "restart H: budget spent once per spawn, and no more" "5" "$(jqf "$RFF" '.budget_left')"
is "restart H: still armed for steady-state refill" "true" "$(jqf "$RFF" '.armed')"
# The sweep's own in-flight markers deliberately OUTLIVE it: they are the only
# record that these seats are taken until `agent list` catches up, and the
# alternative is a k=2 fleet spawning until the budget runs out. They are inert
# rather than leaked — capacity subtracts any whose agent has since appeared,
# and ignores all of them after 10 minutes.
is "restart H: the sweep's in-flight markers outlive it, one per seat filled" "2" \
  "$(jqf "$RFF" '.inflight | length')"
is "restart H: and they name the issues actually picked" "301 302" \
  "$(jq -r '[.inflight[].issue] | sort | join(" ")' "$RFF")"
line_has "restart H: the pass says what it re-armed" "$OUT" "spawning GH-301"

# ── row I: nothing armed → phase F is inert, and costs no board access ───────
# The no-new-key claim in one assertion: a scope where no human ever typed
# --refill must come back from a restart exactly as it did before.
ROW="$TMP/restart-i"
RLEDGER="$ROW/acme/demo/ledger.jsonl"
mkdir -p "$ROW/acme/demo"
printf '{"ts":"t0","ev":"spawn","agent_ref":"w100-first#aaaa","pane_id":"p1","shell_pid":123,"tokens":{"role":"w","issue":"100","slug":"first","root":"w100-first#aaaa","depth":"0","state":"spawned","branch":"feature/GH-100","harness":"claude","spawn_epoch":"aaaa"}}\n' \
  >"$RLEDGER"
herd_fixture '[{"name":"w100-first","agent_status":"working","pane_id":"p1"}]'
: >"$FAKE_HERDR_LOG"; : >"$FAKE_BOARD_LOG"
run_reconcile "$ROW"
is "restart I: unarmed scope — the pass still completes" "0" "$RC"
is "restart I: nothing armed, nothing spawned" "0" "$(log_count "$FAKE_HERDR_LOG" '^worktree create ')"
is "restart I: nothing armed, no frontier read at all" "0" \
  "$(log_count "$FAKE_BOARD_LOG" '^frontier --json$')"

# ── row J: a restart STORM cannot exceed the budget ──────────────────────────
# The bound is `budget_left` being durable in fleet.json rather than per-process,
# so repeated restarts drain ONE allowance. Nothing counts restarts.
mk_restart_row j
jq -c '.budget_left = 1' "$RFF" >"$RFF.t" && mv "$RFF.t" "$RFF"
run_reconcile "$ROW"
is "restart J: the last unit spawns, the second seat does not" "1" \
  "$(lcount "$RLEDGER" '.ev=="refill_spawn"')"
is "restart J: exhausted budget disarms" "false budget exhausted" \
  "$(jq -r '"\(.armed) \(.disarm_reason)"' "$RFF")"
# Restart again against the same, now-disarmed run.
: >"$FAKE_HERDR_LOG"
run_reconcile "$ROW"
is "restart J: a second restart spawns nothing — the budget is spent, not reset" "0" \
  "$(log_count "$FAKE_HERDR_LOG" '^worktree create ')"

# ── row K: an expired arming is not resurrected by a restart ─────────────────
mk_restart_row k
jq -c '.expires_at = "2000-01-01T00:00:00Z"' "$RFF" >"$RFF.t" && mv "$RFF.t" "$RFF"
run_reconcile "$ROW"
is "restart K: a lapsed TTL spawns nothing" "0" "$(log_count "$FAKE_HERDR_LOG" '^worktree create ')"
is "restart K: and is written down as lapsed" "false ttl expired" \
  "$(jq -r '"\(.armed) \(.disarm_reason)"' "$RFF")"

# ── row L: a worker the restart did NOT kill keeps its seat ──────────────────
# The exclusion only ever discounts what a POSITIVE pane reading disproved. A
# survivor still occupies capacity, so a k=2 run refills exactly one seat.
mk_restart_row l
# p2's pane still holds the recorded shell pid AND a live harness → `alive`.
printf '{"process_info":{"pane_id":"p2","shell_pid":124,"foreground_process_group_id":9100,"foreground_processes":[{"argv0":"claude","name":"2.1.229","pid":9100,"cmdline":"claude"}]}}\n' \
  >"$FAKE_HERDR_FIXTURES/pane-process-info.p2.json"
run_reconcile "$ROW"
is "restart L: only the dead worker is exited" "1" \
  "$(lcount "$RLEDGER" '.ev=="exit" and .reason=="restart_killed"')"
is "restart L: the survivor holds its seat — exactly one refill" "1" \
  "$(lcount "$RLEDGER" '.ev=="refill_spawn"')"
is "restart L: budget reflects the single spawn" "6" "$(jqf "$RFF" '.budget_left')"
rm -f "$FAKE_HERDR_FIXTURES/pane-process-info.p2.json"

# ── row M: a sick server fails CLOSED — no spawn, nothing disarmed ───────────
# Phase F never gets to fail closed on its own here, and that is the point: the
# pass already aborts on an unreadable herd, so the level trigger inherits the
# refusal rather than restating it. An armed run survives untouched for the
# next reconcile — a restart into a half-up server must cost a delay, never the
# arming.
mk_restart_row m
printf '1\n' >"$FAKE_HERDR_FIXTURES/api-snapshot.rc"
run_reconcile "$ROW"
line_has "restart M: the pass declines rather than sweeping" "$OUT" "not reconciling"
is "restart M: a sick server spawns nothing" "0" "$(log_count "$FAKE_HERDR_LOG" '^worktree create ')"
is "restart M: and never reads the frontier" "0" \
  "$(log_count "$FAKE_BOARD_LOG" '^frontier --json$')"
is "restart M: the arming survives intact for the next pass" "true 7" \
  "$(jq -r '"\(.armed) \(.budget_left)"' "$RFF")"
rm -f "$FAKE_HERDR_FIXTURES/api-snapshot.rc"

# ── row N: a FOREIGN server does not refill someone else's fleet (GH-1905) ───
# The startup hook fires for every server, including a scratch one, and points
# it at the real ledger root. Phase F is the phase that starts processes, so an
# ungated pass here spawns real workers into the scratch server. The run's
# provenance is what settles it: fleet.json records the arming server's session
# key, and this pass's key is a different one.
mk_restart_row n
run_reconcile_as() {
  RC=0
  OUT=$(RALPH_HERDR_LEDGER_ROOT="$1" RALPH_HERDR_BOARD="$BIN/board" \
    RALPH_HERDR_SESSION="$2" ANTHROPIC_API_KEY= bash "$SCRIPTS/reconcile.sh" 2>&1) || RC=$?
}
run_reconcile_as "$ROW" scratch-server
is "restart N: the foreign pass still completes" "0" "$RC"
is "restart N: a foreign server spawns nothing" "0" "$(log_count "$FAKE_HERDR_LOG" '^worktree create ')"
is "restart N: and never reads the frontier for it" "0" \
  "$(log_count "$FAKE_BOARD_LOG" '^frontier --json$')"
is "restart N: the arming survives untouched — the owner still gets its re-arm" "true 7" \
  "$(jq -r '"\(.armed) \(.budget_left)"' "$RFF")"
# Matched on a phrase only phase F's refusal carries — GH-1863's ledger refusal
# uses similar words, and this row must not pass on that one.
line_has "restart N: the refusal names the provenance it read" "$OUT" "not refilling it here"
# Row H is the other half of this claim: the OWNING server, same fixture shape,
# refills both seats.

# ── row O: a legacy arming with no provenance arms nothing ───────────────────
# Unknown is not ours. The cost is one TTL for one pre-GH-1905 run; the
# alternative is the row-N spawn against a server nobody can name.
mk_restart_row o
jq -c 'del(.session)' "$RFF" >"$RFF.t" && mv "$RFF.t" "$RFF"
run_reconcile "$ROW"
is "restart O: an unprovenanced arming spawns nothing" "0" \
  "$(log_count "$FAKE_HERDR_LOG" '^worktree create ')"
is "restart O: and is left armed rather than disarmed — the edge path still owns it" "true" \
  "$(jqf "$RFF" '.armed')"
line_has "restart O: the refusal says no provenance was recorded" "$OUT" "none recorded"

rm -f "$FAKE_BOARD_FIXTURES/frontier.json"

echo "1..$n"
echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
