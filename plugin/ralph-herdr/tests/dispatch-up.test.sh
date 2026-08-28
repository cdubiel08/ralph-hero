#!/usr/bin/env bash
# dispatch-up.test.sh — executable tests for DISPATCH UP (GH-2213, unit E of
# #2208, D3.1): the named-space + hero-pane bring-up, its idempotence (a
# standing space and a live sitting are never doubled), the heal paths (dead
# hero reopened, deleted space recreated, hero-in-the-wrong-space corrected),
# the fail-closed reads (address, workspace list) vs the fail-open ones
# (hero liveness, roster), and the heartbeat stamp.
#
#   bash plugin/ralph-herdr/tests/dispatch-up.test.sh   # exits 0 pass, 1 fail
#
# All herdr traffic goes through tests/fake-herdr.sh, all board traffic
# through tests/fake-board.sh — no server, no GitHub, no writes outside $TMP.
# bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../scripts"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-dispatch-up-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

BIN="$TMP/bin"
mkdir -p "$BIN"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-herdr.sh" >"$BIN/herdr"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-board.sh" >"$BIN/board"
chmod +x "$BIN/herdr" "$BIN/board"
export PATH="$BIN:$PATH"
export HERDR_BIN_PATH="$BIN/herdr"
export RALPH_HERDR_BOARD="$BIN/board"
export FAKE_HERDR_FIXTURES="$TMP/fixtures"
export FAKE_HERDR_LOG="$TMP/herdr.log"
export FAKE_BOARD_FIXTURES="$TMP/board-fixtures"
export FAKE_BOARD_LOG="$TMP/board.log"
mkdir -p "$FAKE_HERDR_FIXTURES" "$FAKE_BOARD_FIXTURES"
export RALPH_HERDR_LEDGER_ROOT="$TMP/ledger-root"

# A repo dir with a board scope, so the heartbeat path and the hero record
# resolve naturally (~/.ralph/<owner>/<repo> under the test ledger root).
REPO_DIR="$TMP/repo"
mkdir -p "$REPO_DIR"
printf '{"owner":"fake","repo":"fake","projectNumber":1}\n' >"$REPO_DIR/.ralph.json"
export RALPH_HERDR_REPO="$REPO_DIR"

# The dispatch address the board mints for every case below.
printf '{"repo":"fake","address":"fake/dispatch"}\n' >"$FAKE_BOARD_FIXTURES/name.dispatch.json"

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
has() {
  if printf '%s' "$2" | grep -q "$3"; then ok "$1"; else not_ok "$1 — no '$3' in: $(printf '%s' "$2" | head -5)"; fi
}
hasnt() {
  if printf '%s' "$2" | grep -q "$3"; then not_ok "$1 — found '$3'"; else ok "$1"; fi
}

run_up() { (cd "$REPO_DIR" && bash "$SCRIPTS/dispatch-up.sh" "$@" </dev/null 2>&1); }

reset() {
  : >"$FAKE_HERDR_LOG"
  : >"$FAKE_BOARD_LOG"
  rm -f "$FAKE_HERDR_FIXTURES"/workspace-list.json "$FAKE_HERDR_FIXTURES"/workspace-list.rc \
    "$FAKE_HERDR_FIXTURES"/pane-list.json "$FAKE_HERDR_FIXTURES"/api-snapshot.json \
    "$FAKE_BOARD_FIXTURES"/name.dispatch.rc "$FAKE_BOARD_FIXTURES"/roster.rc \
    "$RALPH_HERDR_LEDGER_ROOT/fake/fake/hero.pane.json" \
    "$RALPH_HERDR_LEDGER_ROOT/fake/fake/dispatch-heartbeat" 2>/dev/null || true
}

# ── 1. fresh bring-up: no space, no hero — create both, print roster ────────
reset
out=$(run_up)
rc=$?
[ "$rc" = 0 ] && ok "fresh bring-up exits 0" || not_ok "fresh bring-up exits 0 — rc $rc: $out"
has "creates the workspace with the canonical label" "$(cat "$FAKE_HERDR_LOG")" "workspace create --cwd .* --label fake/dispatch --no-focus"
has "opens the hero pane into the created space" "$(cat "$FAKE_HERDR_LOG")" "plugin pane open --plugin ralph-herdr --entrypoint hero --workspace wT --placement tab"
has "summary names created + opened" "$out" "workspace wT (created), hero pane pP1 (opened)"
has "prints the roster" "$out" "ROSTER (fake)"
has "roster was asked of the board" "$(cat "$FAKE_BOARD_LOG")" "^roster"
hb="$RALPH_HERDR_LEDGER_ROOT/fake/fake/dispatch-heartbeat"
if [ -f "$hb" ]; then ok "heartbeat stamped"; else not_ok "heartbeat stamped — $hb missing"; fi
has "heartbeat names this writer" "$(cat "$hb" 2>/dev/null)" '"writer":"dispatch-up"'

# ── 2. heal: space stands, hero dead (no record) — reopen the pane only ─────
reset
printf '{"workspaces":[{"workspace_id":"wD","label":"fake/dispatch","number":9,"pane_count":1,"tab_count":1,"active_tab_id":"wD:t1","agent_status":"idle","focused":false}]}\n' \
  >"$FAKE_HERDR_FIXTURES/workspace-list.json"
out=$(run_up)
rc=$?
[ "$rc" = 0 ] && ok "heal-pane run exits 0" || not_ok "heal-pane run exits 0 — rc $rc: $out"
hasnt "standing space is not recreated" "$(cat "$FAKE_HERDR_LOG")" "workspace create"
has "hero pane opened into the standing space" "$(cat "$FAKE_HERDR_LOG")" "plugin pane open .* --workspace wD"
has "summary names standing + opened" "$out" "workspace wD (standing), hero pane pP1 (opened)"

# ── 3. idempotent: space stands, hero LIVE in it — touch nothing ────────────
reset
printf '{"workspaces":[{"workspace_id":"wD","label":"fake/dispatch","number":9,"pane_count":2,"tab_count":2,"active_tab_id":"wD:t1","agent_status":"idle","focused":false}]}\n' \
  >"$FAKE_HERDR_FIXTURES/workspace-list.json"
# A live hero record: this test's own pid is alive, and the snapshot + the
# dispatch workspace's pane list both carry its pane.
mkdir -p "$RALPH_HERDR_LEDGER_ROOT/fake/fake"
printf '{"pane":"pH","pid":%s,"at":"2026-08-28T00:00:00Z","repo":"%s"}\n' $$ "$REPO_DIR" \
  >"$RALPH_HERDR_LEDGER_ROOT/fake/fake/hero.pane.json"
printf '{"snapshot":{"version":1,"protocol":19,"workspaces":[],"tabs":[],"panes":[{"pane_id":"pH"}],"layouts":[],"agents":[]}}\n' \
  >"$FAKE_HERDR_FIXTURES/api-snapshot.json"
printf '{"panes":[{"pane_id":"pH","workspace_id":"wD","tab_id":"wD:t2","terminal_id":"t","focused":false,"agent_status":"working","revision":1}]}\n' \
  >"$FAKE_HERDR_FIXTURES/pane-list.json"
out=$(run_up)
rc=$?
[ "$rc" = 0 ] && ok "idempotent run exits 0" || not_ok "idempotent run exits 0 — rc $rc: $out"
hasnt "no workspace created" "$(cat "$FAKE_HERDR_LOG")" "workspace create"
hasnt "no hero pane opened" "$(cat "$FAKE_HERDR_LOG")" "plugin pane open"
has "summary names standing + live" "$out" "workspace wD (standing), hero pane pH (live)"
has "roster still prints" "$out" "ROSTER (fake)"

# ── 4. hero live but in ANOTHER space — open one where it belongs ───────────
reset
printf '{"workspaces":[{"workspace_id":"wD","label":"fake/dispatch","number":9,"pane_count":1,"tab_count":1,"active_tab_id":"wD:t1","agent_status":"idle","focused":false}]}\n' \
  >"$FAKE_HERDR_FIXTURES/workspace-list.json"
mkdir -p "$RALPH_HERDR_LEDGER_ROOT/fake/fake"
printf '{"pane":"pElsewhere","pid":%s,"at":"2026-08-28T00:00:00Z","repo":"%s"}\n' $$ "$REPO_DIR" \
  >"$RALPH_HERDR_LEDGER_ROOT/fake/fake/hero.pane.json"
printf '{"snapshot":{"version":1,"protocol":19,"workspaces":[],"tabs":[],"panes":[{"pane_id":"pElsewhere"}],"layouts":[],"agents":[]}}\n' \
  >"$FAKE_HERDR_FIXTURES/api-snapshot.json"
printf '{"panes":[{"pane_id":"pShell","workspace_id":"wD","tab_id":"wD:t1","terminal_id":"t","focused":false,"agent_status":"idle","revision":1}]}\n' \
  >"$FAKE_HERDR_FIXTURES/pane-list.json"
out=$(run_up)
has "hero elsewhere does not satisfy the dispatch space" "$(cat "$FAKE_HERDR_LOG")" "plugin pane open .* --workspace wD"
has "summary says opened" "$out" "hero pane pP1 (opened)"

# ── 5. fail-closed: the address read ────────────────────────────────────────
reset
printf '1\n' >"$FAKE_BOARD_FIXTURES/name.dispatch.rc"
out=$(run_up)
rc=$?
[ "$rc" != 0 ] && ok "unmintable address refuses" || not_ok "unmintable address refuses — rc 0: $out"
has "refusal names the board as the minter" "$out" "the space's name is the board's to mint"
hasnt "nothing was created" "$(cat "$FAKE_HERDR_LOG")" "workspace create"

# ── 6. fail-closed: the workspace list ──────────────────────────────────────
reset
printf '1\n' >"$FAKE_HERDR_FIXTURES/workspace-list.rc"
out=$(run_up)
rc=$?
[ "$rc" != 0 ] && ok "unreadable workspace list refuses" || not_ok "unreadable workspace list refuses — rc 0: $out"
has "refusal says why" "$out" "refusing to guess whether fake/dispatch already exists"
hasnt "no blind create" "$(cat "$FAKE_HERDR_LOG")" "workspace create"

# ── 7. fail-open: the roster ────────────────────────────────────────────────
reset
printf '1\n' >"$FAKE_BOARD_FIXTURES/roster.rc"
out=$(run_up)
rc=$?
[ "$rc" = 0 ] && ok "failed roster does not fail the up" || not_ok "failed roster does not fail the up — rc $rc: $out"
has "degradation is named" "$out" "roster read failed"
has "the space still came up" "$out" "workspace wT (created)"

# ── 8. arguments: none taken ────────────────────────────────────────────────
reset
out=$(run_up --rota)
rc=$?
[ "$rc" != 0 ] && ok "unknown argument refuses" || not_ok "unknown argument refuses — rc 0"
out=$(run_up --help)
rc=$?
[ "$rc" = 0 ] && ok "--help exits 0" || not_ok "--help exits 0 — rc $rc"
has "--help states idempotence" "$out" "re-run heals"
has "--help states no scheduling" "$out" "Arms nothing scheduled"

echo
echo "$pass passed, $fail failed (of $n)"
[ "$fail" = 0 ]
