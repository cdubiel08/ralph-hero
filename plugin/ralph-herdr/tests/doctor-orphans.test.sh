#!/usr/bin/env bash
# doctor-orphans.test.sh — tests for scripts/doctor-orphans.sh (TAP-ish).
#
#   bash plugin/ralph-herdr/tests/doctor-orphans.test.sh
#
# The herd comes from the shared fake herdr + herd_fixture; the PROCESS TABLE
# comes from $RALPH_HERDR_PS, a command the script evals instead of running
# `ps`. That injection is what makes this suite platform-independent: the real
# `ps` differs between BSD and procps in both of the flags the check depends
# on, and a suite that shelled out to the live one would assert about the CI
# runner's process list rather than about the check.
#
# Read-only by construction: no server, no ledger, no signal is ever sent.
# bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCTOR="$SCRIPT_DIR/../scripts/doctor-orphans.sh"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-orphans-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

export HERDR_BIN_PATH="$SCRIPT_DIR/fake-herdr.sh"
export FAKE_HERDR_FIXTURES="$TMP/fixtures"
mkdir -p "$FAKE_HERDR_FIXTURES"

REPO_DIR="$TMP/repo"
mkdir -p "$REPO_DIR"
printf '{"owner":"acme","repo":"demo","projectNumber":1}\n' >"$REPO_DIR/.ralph.json"
# shellcheck source=herd-fixture.sh
. "$SCRIPT_DIR/herd-fixture.sh"

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}
has_line() {
  if printf '%s\n' "$OUT" | grep -q "$2"; then ok "$1"; else not_ok "$1 — no line matching '$2' in: $OUT"; fi
}
no_line() {
  if printf '%s\n' "$OUT" | grep -q "$2"; then not_ok "$1 — unexpected line matching '$2' in: $OUT"; else ok "$1"; fi
}

# ps_fixture TEXT — the process table the check will read.
ps_fixture() { printf '%s\n' "$1" >"$TMP/ps.txt"; }
# run AGENTS_JSON — build the herd, run the check; sets OUT and RC.
run() {
  herd_fixture "$1"
  printf 'warning: chatty but harmless\n' >"$FAKE_HERDR_FIXTURES/api-snapshot.err"
  RC=0
  OUT=$(RALPH_HERDR_PS="cat $TMP/ps.txt" bash "$DOCTOR" 2>&1) || RC=$?
}

# herd_fixture numbers panes p0, p1, ... in agent order.
LIVE='  101 claude --resume PATH=/usr/bin HERDR_PANE_ID=p0 HERDR_ENV=1'
ORPHAN=' 202 node cockpit.js --poll PATH=/usr/bin HERDR_PANE_ID=pGONE HERDR_ENV=1'
NONHERDR='303 /usr/bin/ssh somewhere PATH=/usr/bin'

# ── every herdr process sits in a live pane → clean, exit 0 ──────────────────
ps_fixture "$LIVE
$NONHERDR"
run '[{"name":"w1-a","agent_status":"working","pane_id":"p0"}]'
is "all panes live exits 0" "0" "$RC"
has_line "clean run reports the counts it checked" '^  ok   orphan-procs — no orphans (1 herdr process'

# ── a process whose pane is gone → GAP, exit 1 ──────────────────────────────
ps_fixture "$LIVE
$ORPHAN
$NONHERDR"
run '[{"name":"w1-a","agent_status":"working","pane_id":"p0"}]'
is "orphaned process exits 1" "1" "$RC"
has_line "orphan is a GAP naming pid and pane" '^  GAP  orphan-proc-202 — pane pGONE is gone'
has_line "orphan GAP carries the command line" 'node cockpit.js --poll'
has_line "finding count is reported" '^  1 orphaned process'
no_line "the live process is not reported" 'orphan-proc-101'

# ── a process with no HERDR_PANE_ID is none of this check's business ─────────
no_line "a non-herdr process is never a finding" 'orphan-proc-303'

# ── the orphan is reported even though its pane resolves to no repository ────
# This is the fail-OPEN property (GH-1888). scope.sh fails closed because it
# decides "may I write here"; this check writes nothing, and an orphan's pane —
# the join every scope read runs through — is gone by construction. A scoped
# version of this check could never fire on the case it exists to catch, so the
# assertion is that a completely unresolvable pane id still produces a finding.
ps_fixture "$ORPHAN"
run '[]'
is "orphan in an empty herd still exits 1" "1" "$RC"
has_line "unscopeable orphan is still reported" '^  GAP  orphan-proc-202 '

# ── the check never kills: it hands over the pid and says so ────────────────
has_line "the GAP hands the human a kill line, it does not run one" 'nothing here kills it, decide and run: kill 202'

# ── a process table with no environments is NOT EVALUABLE, never clean ──────
# procps reads `-E` as "every process" and prints a table with no environments
# in it. Read as an answer, that is a silent all-clear on a machine that was
# never actually inspected.
ps_fixture ' 101 claude --resume
 202 node cockpit.js --poll'
run '[{"name":"w1-a","agent_status":"working","pane_id":"p0"}]'
is "an environment-less process table exits 2" "2" "$RC"
has_line "and says why" '^  note orphan-procs — not evaluable — .*no process environments'
no_line "not-evaluable never reports findings" '^  GAP '

# ── an empty process table is not evaluable either ──────────────────────────
ps_fixture ''
run '[{"name":"w1-a","agent_status":"working","pane_id":"p0"}]'
is "an empty process table exits 2" "2" "$RC"

# ── an unreadable snapshot is NOT EVALUABLE, never "everything is orphaned" ──
ps_fixture "$LIVE
$ORPHAN"
herd_fixture '[{"name":"w1-a","agent_status":"working","pane_id":"p0"}]'
printf 'not json at all\n' >"$FAKE_HERDR_FIXTURES/api-snapshot.raw"
RC=0
OUT=$(RALPH_HERDR_PS="cat $TMP/ps.txt" bash "$DOCTOR" 2>&1) || RC=$?
is "an unreadable snapshot exits 2" "2" "$RC"
has_line "and says the snapshot was the problem" '^  note orphan-procs — not evaluable — herdr snapshot unavailable'
no_line "a sick server condemns nothing" '^  GAP '
rm -f "$FAKE_HERDR_FIXTURES/api-snapshot.raw"

# ── no herdr at all → not evaluable ─────────────────────────────────────────
RC=0
OUT=$(HERDR_BIN_PATH="$TMP/nope" RALPH_HERDR_PS="cat $TMP/ps.txt" bash "$DOCTOR" 2>&1) || RC=$?
is "no herdr binary exits 2" "2" "$RC"
has_line "and says herdr is missing" 'herdr is not installed'

# ── bad invocation ──────────────────────────────────────────────────────────
RC=0
OUT=$(bash "$DOCTOR" --fix 2>&1) || RC=$?
is "arguments are refused with 64" "64" "$RC"

echo "1..$n"
[ "$fail" -eq 0 ] || exit 1
