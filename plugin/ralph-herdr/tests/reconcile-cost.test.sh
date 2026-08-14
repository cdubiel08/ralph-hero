#!/usr/bin/env bash
# reconcile-cost.test.sh — the reconciliation cost contract (GH-1775).
#
#   bash plugin/ralph-herdr/tests/reconcile-cost.test.sh   # 0 on pass, 1 on fail
#
# The design record (docs/superpowers/specs/2026-08-11-herdr-transport-
# hardening-design.md, §Performance Design) states the contract as CALL COUNTS
# rather than elapsed time: "Timing tests use generous regression budgets and
# report measurements; deterministic call-count assertions are the hard gate."
# This file is that gate. It asserts what a reconcile pass may ask a herdr
# server, and — the part a timing test cannot express — what must NOT grow when
# the herd or the number of boards grows.
#
# The contract, in four lines:
#
#   1. ONE session.snapshot per pass, plus AT MOST one fresh re-probe, no
#      matter how many ledgers are under the ledger root. The re-probe used to
#      sit inside the per-ledger loop, so a machine with N boards paid N+1.
#   2. ZERO per-agent `agent list` / `agent get` reads. The snapshot already
#      carries the join; asking again per agent is the regression.
#   3. `pane process-info` is O(open workers) and DELIBERATELY so — see below.
#   4. `pane report-metadata` is O(live workers) and deliberately so: it is a
#      WRITE addressed to one pane, and protocol 19 has no bulk form.
#
# WHY 3 IS ALLOWED TO BE PER-WORKER. Phase E's verdict needs the pane's shell
# pid and foreground processes. Probed against the live herdr 0.8.x server, a
# `session.snapshot` pane carries cwd, foreground_cwd, agent_status, terminal
# title and ids — and NO shell_pid, NO foreground_processes. So this read has no
# snapshot equivalent and cannot be hoisted. The design's rule is "zero
# per-agent Herdr list/get calls"; process-info is neither, it is the
# pane-liveness primitive GH-1809 rests on. It is pinned here at its exact
# expected count rather than left unasserted, so it stays a decision and does
# not quietly become an oversight.
#
# All herdr traffic goes through tests/fake-herdr.sh on PATH — no server, no
# panes, no writes outside $TMP. bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../scripts"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-cost-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

# ── the herdr PATH shim ──────────────────────────────────────────────────────
BIN="$TMP/bin"
mkdir -p "$BIN"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-herdr.sh" >"$BIN/herdr"
chmod +x "$BIN/herdr"
export PATH="$BIN:$PATH"
export HERDR_BIN_PATH="$BIN/herdr"
export FAKE_HERDR_FIXTURES="$TMP/fixtures"
export FAKE_HERDR_LOG="$TMP/herdr.log"
mkdir -p "$FAKE_HERDR_FIXTURES"
: >"$FAKE_HERDR_LOG"

# The in-scope checkout: herd_fixture binds its agents' worktree provenance
# here, and a scoped read resolves this root's BOARD identity — so it must
# carry board config naming the owner/repo the test ledgers nest under.
REPO_DIR="$TMP/checkout"
mkdir -p "$REPO_DIR"
printf '{"owner":"acme","repo":"demo","projectNumber":1}\n' >"$REPO_DIR/.ralph.json"

# shellcheck source=herd-fixture.sh
. "$SCRIPT_DIR/herd-fixture.sh"
# shellcheck source=../scripts/sanitize.sh
. "$SCRIPTS/sanitize.sh"
# shellcheck source=../scripts/ledger.sh
. "$SCRIPTS/ledger.sh"

# Guard: no subprocess may fall back to the real ~/.ralph — every run below
# passes its own root explicitly, and this catches a miss.
export RALPH_HERDR_LEDGER_ROOT="$TMP/guard-root"

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}
# log_count REGEX — matching lines in the herdr invocation log
log_count() { grep -c -- "$1" "$FAKE_HERDR_LOG" || true; }

# run_reconcile LEDGER_ROOT — truncate the call log, run one pass, set OUT/RC.
# The log is cleared per run so every count below is for ONE pass.
run_reconcile() {
  RC=0
  : >"$FAKE_HERDR_LOG"
  OUT=$(RALPH_HERDR_LEDGER_ROOT="$1" bash "$SCRIPTS/reconcile.sh" 2>&1) || RC=$?
}

# mk_ledger ROOT OWNER REPO N [PANE_PREFIX] [WITH_PID] — a ledger holding N open
# spawn records. WITH_PID=yes records a shell pid, which is what makes phase E
# ask the pane about the worker; without it the verdict is `unknown` before any
# call is made.
mk_ledger() {
  local root="$1" owner="$2" repo="$3" count="$4" prefix="${5:-p}" withpid="${6:-no}"
  local dir="$root/$owner/$repo" i pid=""
  mkdir -p "$dir"
  : >"$dir/ledger.jsonl"
  i=1
  while [ "$i" -le "$count" ]; do
    [ "$withpid" = yes ] && pid=", \"shell_pid\": 9000"
    printf '{"ts":"2026-08-14T00:00:00Z","ev":"spawn","agent_ref":"w%s-job#%04x","pane_id":"%s%s"%s,"checkout":"%s","tokens":{"issue":"%s","role":"w","slug":"job"}}\n' \
      "$i" "$i" "$prefix" "$i" "$pid" "$REPO_DIR" "$i" >>"$dir/ledger.jsonl"
    i=$((i + 1))
  done
  printf '%s\n' "$dir/ledger.jsonl"
}

# herd_of N PREFIX — a herd fixture of N live ralph agents, panes matching
# mk_ledger's, all in the in-scope workspace.
herd_of() {
  local count="$1" prefix="${2:-p}" i agents="[]"
  i=1
  while [ "$i" -le "$count" ]; do
    agents=$(printf '%s' "$agents" | jq -c \
      --arg nm "w$i-job" --arg pane "$prefix$i" \
      '. + [{name: $nm, agent_status: "working", pane_id: $pane}]')
    i=$((i + 1))
  done
  herd_fixture "$agents"
}

echo "# ═══ 1. the open-rows read: parity with the per-ref helpers ═══"
# ralph_ledger_open_rows is the batched read every phase now uses. It must mean
# EXACTLY what the _ralph_ledger_latest_* helpers it replaced meant — the same
# open set, and per field the same "last non-empty value for this exact ref".
# Parity is asserted rather than assumed, because a silent divergence here
# would change reconcile's behavior while every existing test still passed.
PLEDGER="$TMP/parity/ledger.jsonl"
mkdir -p "$TMP/parity"
cat >"$PLEDGER" <<'EOF'
{"ts":"1","ev":"spawn","agent_ref":"w1-a#aaaa","pane_id":"p1","shell_pid":123,"checkout":"/co/a","tokens":{"issue":"1","harness":"claude","role":"w","state":"spawned"}}
{"ts":"2","ev":"state","agent_ref":"w1-a#aaaa","state":"working"}
{"ts":"3","ev":"spawn","agent_ref":"w2-b#bbbb","lineage":{"herdr":{"pane_id":"p2"}},"tokens":{"issue":"2","parent":"w1-a#aaaa"}}
{"ts":"4","ev":"exit","agent_ref":"w2-b#bbbb","reason":"lost"}
{"ts":"5","ev":"spawn","agent_ref":"w3-c#cccc","pane_id":"p3","tokens":{"issue":"3"}}
{"ts":"6","ev":"adopt","agent_ref":"w3-c#cccc","parent":"w1-a#aaaa"}
EOF
RALPH_HERDR_LEDGER="$PLEDGER"

is "open-rows: same open set as open_agents" \
  "$(ralph_ledger_open_agents)" \
  "$(ralph_ledger_open_rows | cut -d"$(printf '\037')" -f1)"

while IFS=$'\037' read -r ref pane pid harness parent state issue checkout toks; do
  is "open-rows $ref: pane"      "$(_ralph_ledger_latest_pane "$ref" 2>/dev/null || true)"      "$pane"
  is "open-rows $ref: shell_pid" "$(_ralph_ledger_latest_shell_pid "$ref" 2>/dev/null || true)" "$pid"
  is "open-rows $ref: parent"    "$(_ralph_ledger_latest_parent "$ref" 2>/dev/null || true)"    "$parent"
  is "open-rows $ref: state"     "$(_ralph_ledger_latest_state "$ref" 2>/dev/null || true)"     "$state"
  is "open-rows $ref: issue"     "$(_ralph_ledger_latest_issue "$ref" 2>/dev/null || true)"     "$issue"
  is "open-rows $ref: checkout"  "$(_ralph_ledger_latest_checkout "$ref" 2>/dev/null || true)"  "$checkout"
  is "open-rows $ref: tokens"    "$(_ralph_ledger_latest_tokens "$ref" 2>/dev/null || true)"    "$toks"
  is "open-rows $ref: harness" \
    "$(_ralph_ledger_latest '((try .tokens.harness catch null) // "")' "$ref" 2>/dev/null || true)" "$harness"
  is "open-rows $ref: the tokens column is still parseable JSON" "0" \
    "$(printf '%s' "$toks" | jq -e . >/dev/null 2>&1; echo $?)"
done < <(ralph_ledger_open_rows)

# An empty column must stay a column. This is why the separator is US and not a
# tab: bash treats tab as IFS whitespace and would collapse two adjacent empty
# fields into one, silently shifting every field after them.
EMPTYCOLS="$TMP/parity/empty.jsonl"
printf '{"ts":"1","ev":"spawn","agent_ref":"w9-z#9999","tokens":{"issue":"9"}}\n' >"$EMPTYCOLS"
RALPH_HERDR_LEDGER="$EMPTYCOLS"
is "open-rows: a record with no pane/pid/harness still yields 9 columns" "9" \
  "$(ralph_ledger_open_rows | awk -F'\037' '{print NF}')"
is "open-rows: and the issue lands in column 7, not shifted left" "9" \
  "$(ralph_ledger_open_rows | cut -d"$(printf '\037')" -f7)"

RALPH_HERDR_LEDGER="$TMP/parity/none.jsonl"
: >"$TMP/parity/none.jsonl"
is "open-rows: an empty ledger is no rows, not an error" "0" \
  "$(ralph_ledger_open_rows >/dev/null 2>&1; echo $?)"
unset RALPH_HERDR_LEDGER

echo "# ═══ 2. a live herd: one snapshot, and no per-agent reads ═══"
# Every worker is live and ledgered, so nothing looks lost and the re-probe is
# never needed. This is the steady-state pass.
for W in 1 10 100; do
  ROOT="$TMP/live$W"
  mk_ledger "$ROOT" acme demo "$W" p >/dev/null
  herd_of "$W" p
  run_reconcile "$ROOT"
  is "live/$W workers: pass exits 0"                "0" "$RC"
  is "live/$W workers: exactly ONE session.snapshot" "1" "$(log_count '^api snapshot')"
  is "live/$W workers: zero \`agent list\`"           "0" "$(log_count '^agent list')"
  is "live/$W workers: zero \`agent get\`"            "0" "$(log_count '^agent get')"
  # No recorded shell pid in these records, so phase E asks the pane nothing.
  is "live/$W workers: zero \`pane process-info\`"    "0" "$(log_count '^pane process-info')"
  # The one deliberate per-worker call: a metadata WRITE, one pane at a time.
  is "live/$W workers: one \`pane report-metadata\` per worker" "$W" \
    "$(log_count '^pane report-metadata')"
done

echo "# ═══ 3. THE REGRESSION: the fresh re-probe is per PASS, not per ledger ═══"
# Nothing in the herd, every ledger holding open records — so every ledger has
# lost-looking candidates and each one used to trigger its own re-probe. The
# pass-start snapshot plus ONE re-probe is the whole budget, at any number of
# boards. Before GH-1775 this was N+1.
herd_fixture '[]'
for L in 1 2 5; do
  ROOT="$TMP/multi$L"
  i=1
  while [ "$i" -le "$L" ]; do
    mk_ledger "$ROOT" "owner$i" "repo$i" 3 p >/dev/null
    i=$((i + 1))
  done
  run_reconcile "$ROOT"
  is "$L ledger(s), all candidates: pass exits 0" "0" "$RC"
  is "$L ledger(s), all candidates: snapshot calls stay at 2 (pass-start + one re-probe)" \
    "2" "$(log_count '^api snapshot')"
done

echo "# ═══ 4. the re-probe is LAZY, and its failure is not retried per ledger ═══"
# A pass where nothing looks lost must not pay for a re-probe at all — asserted
# in §2 by the count of 1. Here the opposite: the probe is attempted once and,
# when it fails, is not re-attempted for each remaining ledger.
ROOT="$TMP/lazy"
for i in 1 2 3; do mk_ledger "$ROOT" "own$i" "rep$i" 2 p >/dev/null; done
herd_fixture '[]'
run_reconcile "$ROOT"
is "lazy: three ledgers of candidates still cost one re-probe" "2" "$(log_count '^api snapshot')"
case "$OUT" in
  *"exit "*"reason lost"*) ok "lazy: the candidates were actually swept (the probe ran)" ;;
  *) not_ok "lazy: expected exit-lost records, got '$OUT'" ;;
esac

echo "# ═══ 5. \`pane process-info\` is per-worker BY DESIGN, and pinned ═══"
# Records carrying a recorded shell pid are the ones phase E can form a verdict
# about, so each one earns exactly one pane read — no more, and not one per
# (worker x phase). Pinned so the deliberate O(workers) read cannot drift into
# an accidental O(workers x something).
ROOT="$TMP/pid"
mk_ledger "$ROOT" acme demo 4 p yes >/dev/null
herd_of 4 p
run_reconcile "$ROOT"
is "recorded pids: one \`pane process-info\` per open worker, not more" "4" \
  "$(log_count '^pane process-info')"
is "recorded pids: still exactly one snapshot" "1" "$(log_count '^api snapshot')"
is "recorded pids: still zero \`agent list\`" "0" "$(log_count '^agent list')"

echo "# ═══ 6. a sick server still costs one call and changes nothing ═══"
# The fail-closed posture the cost work must not weaken: a snapshot that cannot
# be read aborts the pass BEFORE any ledger is touched.
ROOT="$TMP/sick"
LEDGER=$(mk_ledger "$ROOT" acme demo 3 p)
before=$(wc -l <"$LEDGER" | tr -d ' ')
RC=0
: >"$FAKE_HERDR_LOG"
OUT=$(RALPH_HERDR_LEDGER_ROOT="$ROOT" HERDR_BIN_PATH=/usr/bin/false \
  bash "$SCRIPTS/reconcile.sh" 2>&1) || RC=$?
is "sick server: pass still exits 0" "0" "$RC"
is "sick server: ledger untouched" "$before" "$(wc -l <"$LEDGER" | tr -d ' ')"
case "$OUT" in
  *"not reconciling"*) ok "sick server: declines the pass loudly" ;;
  *) not_ok "sick server: declines the pass loudly — got '$OUT'" ;;
esac

echo "1..$n"
echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
