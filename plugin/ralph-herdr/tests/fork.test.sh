#!/usr/bin/env bash
# fork.test.sh — tests for scripts/fork.sh, the session-context fork (GH-1892).
#
#   bash plugin/ralph-herdr/tests/fork.test.sh    # exits 0 on pass, 1 on fail
#
# fork.sh is a SCRIPT, not a sourced lib, so every case runs it as a
# subprocess against the shared fake herdr and asserts on two surfaces: its
# stdout, and FAKE_HERDR_LOG — the exact argv it sent. The argv assertions are
# the load-bearing ones. `--fork-session` is the difference between two panes
# holding one transcript and two panes holding one CONTEXT, and it is
# invisible in any output that only says "forked". bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORK="$SCRIPT_DIR/../scripts/fork.sh"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-fork-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

REPO_DIR="$TMP/repo"
mkdir -p "$REPO_DIR"

export HERDR_BIN_PATH="$SCRIPT_DIR/fake-herdr.sh"
export FAKE_HERDR_FIXTURES="$TMP/fixtures"
mkdir -p "$FAKE_HERDR_FIXTURES"
export RALPH_HERDR_REPO="$REPO_DIR"
export RALPH_HERDR_LEDGER="$TMP/ledger/ledger.jsonl"
mkdir -p "$TMP/ledger"
# fork.sh never reads the board — but lib.sh resolves a board CLI at source
# time and refuses without one, so the shim stands in for a machine that has
# ralph installed. Pointing at the real CLI would put a GitHub round trip in a
# unit test.
export RALPH_HERDR_BOARD="$SCRIPT_DIR/fake-board.sh"
export FAKE_BOARD_FIXTURES="$TMP/board-fixtures"
mkdir -p "$FAKE_BOARD_FIXTURES"

# shellcheck source=herd-fixture.sh
. "$SCRIPT_DIR/herd-fixture.sh"

n=0 pass=0 fail=0 rc=0 out="" log="" LOG=""
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}
has() {
  case "$3" in
    *"$2"*) ok "$1" ;;
    *) not_ok "$1 — '$2' not found in: $3" ;;
  esac
}
hasnt() {
  case "$3" in
    *"$2"*) not_ok "$1 — '$2' unexpectedly found in: $3" ;;
    *) ok "$1" ;;
  esac
}

SESS="11111111-2222-3333-4444-555555555555"

# pane_fixture JSON — the `pane get` answer for the source pane p1. Callers
# pass the partial pane; the required PaneInfo fields are filled in here.
pane_fixture() {
  jq -nc --argjson p "$1" --arg cwd "$REPO_DIR" '
    {pane: ({pane_id: "p1", terminal_id: "termS", workspace_id: "wR",
             tab_id: "wR:t1", focused: true, agent_status: "working",
             revision: 3, cwd: $cwd, tokens: {}} + $p)}' \
    >"$FAKE_HERDR_FIXTURES/pane-get.json"
}

# A live claude worker, ralph-spawned (slug + depth tokens), is the baseline
# source pane; the herd holds it so the collision check has something to see.
baseline() {
  pane_fixture "$(jq -nc --arg s "$SESS" '{
    agent: "claude",
    agent_session: {agent: "claude", kind: "id", source: "herdr:claude", value: $s},
    tokens: {role: "w", issue: "42", slug: "fix-the-thing", depth: "0",
             root: "w42-fix-the-thing#abcd1234"}}')"
  herd_fixture '[{"name":"w42-fix-the-thing","agent_status":"working","pane_id":"p1"}]'
}

# run PLACEMENT [ENV...] — run fork.sh on pane p1. Sets three globals: $out
# (stdout+stderr), $rc, and $log (the argv the fake herdr was sent).
#
# Deliberately not `out=$(run …)`: a command substitution runs this in a
# subshell, where every assignment below dies with it — the whole suite would
# then assert against a stale rc and an empty log, which is how it read green
# for cases it never exercised.
run() {
  local placement="$1" logfile="$TMP/argv.log"
  shift
  : >"$logfile"
  rc=0
  out=$(env FAKE_HERDR_LOG="$logfile" RALPH_FORK_PANE=p1 RALPH_FORK_PLACEMENT="$placement" \
    "$@" bash "$FORK" 2>&1) || rc=$?
  log=$(cat "$logfile")
}

# ── the dry-run plan ─────────────────────────────────────────────────────────
baseline
run right RALPH_HERDR_DRY_RUN=true
is "dry-run: exits 0" "0" "$rc"
has "dry-run: plans the split beside the source pane" "pane split p1 --direction right" "$out"
has "dry-run: names the source session" "--resume $SESS" "$out"
has "dry-run: forks rather than sharing the transcript" "--fork-session" "$out"
has "dry-run: names the fork in lane d on issue 0" "agent: d0-fork-fix-the-thing" "$out"
hasnt "dry-run: mutates nothing" "$(printf 'agent_started')" "$log"
# Two READS and nothing else: the pane, and the herd the planned name was
# checked against. A plan that named a fork without proving the name is free
# would be a plan whose first live step can fail.
is "dry-run: sends only reads" "pane get p1
api snapshot" "$log"

run tab RALPH_HERDR_DRY_RUN=true
has "dry-run: tab placement plans a tab in the source's workspace" "tab create --workspace wR" "$out"

# ── the live path ────────────────────────────────────────────────────────────
baseline
run right
is "live: exits 0" "0" "$rc"
has "live: splits the source pane right, in its own cwd" \
  "pane split p1 --direction right --cwd $REPO_DIR --focus" "$log"
has "live: starts claude in the pane herdr returned, not a predicted one" \
  "agent start d0-fork-fix-the-thing --kind claude --pane pS1" "$log"
has "live: resumes the source session and forks it" \
  "-- --resume $SESS --fork-session" "$log"
has "live: reports the pane it forked into" "forked pane p1 -> pS1 (right)" "$out"

# The tokens are how the cockpit tells a fork from a worker. `role=d` and
# `issue=0` are what keep it out of every `^w[0-9]+-` join (refill's capacity
# count, spawn's ownership skip), so they are asserted by value.
has "live: marks the fork disposable" "role=d" "$log"
has "live: binds the fork to no issue" "issue=0" "$log"
has "live: records the source as the fork's parent" "parent=fix-the-thing" "$log"
has "live: keeps the source's spawn-tree root" "root=w42-fix-the-thing#abcd1234" "$log"
has "live: records the nesting one deeper" "depth=1" "$log"

run down
has "live: down placement splits downward" "--direction down" "$log"

run tab
has "live: tab placement creates a tab beside the source" \
  "tab create --workspace wR --cwd $REPO_DIR" "$log"
has "live: tab placement starts in the new tab's root pane" \
  "agent start d0-fork-fix-the-thing --kind claude --pane pTF" "$log"

# ── name collision ───────────────────────────────────────────────────────────
# Names are unique among LIVE agents only, so a second fork of one source has
# to take a generation suffix — `agent start` refuses a taken name outright.
pane_fixture "$(jq -nc --arg s "$SESS" '{
  agent: "claude",
  agent_session: {agent: "claude", kind: "id", source: "herdr:claude", value: $s},
  tokens: {role: "w", issue: "42", slug: "fix-the-thing"}}')"
herd_fixture '[{"name":"w42-fix-the-thing","agent_status":"working","pane_id":"p1"},
               {"name":"d0-fork-fix-the-thing","agent_status":"idle","pane_id":"p2"}]'
run right
is "collision: exits 0" "0" "$rc"
has "collision: the second fork takes a generation suffix" \
  "agent start d0-fork-fix-the-thing--2 --kind claude" "$log"

# An unreadable herd cannot prove the name is free — fail CLOSED rather than
# start an agent onto a name that may be taken.
herd_fixture '[]'
printf '{"error":{"code":"boom","message":"no"}}\n' >"$FAKE_HERDR_FIXTURES/api-snapshot.json"
printf '1\n' >"$FAKE_HERDR_FIXTURES/api-snapshot.rc"
run right
if [ "$rc" -ne 0 ]; then ok "unreadable herd: refuses to fork"; else not_ok "unreadable herd: refuses to fork — got rc 0"; fi
hasnt "unreadable herd: starts nothing" "agent start" "$log"
rm -f "$FAKE_HERDR_FIXTURES/api-snapshot.rc"

# ── refusals, each naming what it saw ────────────────────────────────────────
baseline

pane_fixture '{}'
run right
is "no agent: refuses" "1" "$rc"
has "no agent: says there is no session to fork" "not running an agent" "$out"

pane_fixture '{"agent":"codex","agent_session":{"agent":"codex","kind":"id","source":"herdr:codex","value":"c1"}}'
run right
is "other harness: refuses" "1" "$rc"
has "other harness: names the harness it found" "runs 'codex'" "$out"

pane_fixture '{"agent":"claude"}'
run right
is "no session: refuses" "1" "$rc"
has "no session: says there is nothing to resume from" "no session" "$out"

pane_fixture '{"agent":"claude","agent_session":{"agent":"claude","kind":"path","source":"herdr:claude","value":"/tmp/t.jsonl"}}'
run right
is "session by path: refuses" "1" "$rc"
has "session by path: refuses to guess an id out of a path" "would be a guess" "$out"

# No focused pane at all: the action was invoked from a surface that has none.
rc=0
out=$(env -u RALPH_FORK_PANE -u HERDR_PLUGIN_CONTEXT_JSON RALPH_FORK_PLACEMENT=right \
  bash "$FORK" 2>&1) || rc=$?
is "no source pane: refuses" "2" "$rc"
has "no source pane: says a focused pane is needed" "needs a focused pane" "$out"

rc=0
out=$(env RALPH_FORK_PANE=p1 RALPH_FORK_PLACEMENT=sideways bash "$FORK" 2>&1) || rc=$?
is "bad placement: refuses" "2" "$rc"
has "bad placement: names the placements it takes" "right, down or tab" "$out"

# ── a fork source with no ralph chrome ───────────────────────────────────────
# A hand-started `claude` in a plain pane has no slug token. It is a perfectly
# good source, and refusing it for lacking plugin metadata would make the verb
# available only to panes the plugin itself opened.
pane_fixture "$(jq -nc --arg s "$SESS" '{
  agent: "claude",
  agent_session: {agent: "claude", kind: "id", source: "herdr:claude", value: $s}}')"
herd_fixture '[]'
run right
is "bare pane: forks a hand-started claude" "0" "$rc"
has "bare pane: falls back to the pane id for the name" "d0-fork-p1" "$log"
has "bare pane: records the pane id as the parent" "parent=p1" "$log"
has "bare pane: treats an untokened source as a root" "depth=1" "$log"

echo "1..$n"
[ "$fail" -eq 0 ] || { echo "# $fail of $n failed"; exit 1; }
echo "# all $n passed"
