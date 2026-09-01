#!/usr/bin/env bash
# dispatch-up.test.sh — executable tests for DISPATCH UP (GH-2213, unit E of
# #2208, D3.1; placement amended by GH-2246): the seat lives in the repo's
# MAIN workspace (cwd match on the source checkout), its idempotence (a
# standing space and a live sitting are never doubled), the heal paths (dead
# hero reopened, missing main workspace created — labeled by the checkout,
# never by the dispatch address), the legacy `<repo>/dispatch` migration
# (live sitting left alone + noted; dead legacy space noted, never closed),
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

# The dispatch address the board mints for every case below. The SOURCE
# checkout the fake's `worktree list` reports is /tmp/fake-herdr-parent, so
# the main workspace's cwd key is that path and its label fallback is
# `fake-herdr-parent`.
printf '{"repo":"fake","address":"fake/dispatch"}\n' >"$FAKE_BOARD_FIXTURES/name.dispatch.json"
SRC=/tmp/fake-herdr-parent

# A standing main workspace for the repo — worktree-bound to the source
# checkout, the way herdr reports a workspace it opened on the checkout.
MAIN_WS='{"workspace_id":"wM","label":"fake-herdr-parent","number":2,"pane_count":1,"tab_count":1,"active_tab_id":"wM:t1","agent_status":"idle","focused":false,"worktree":{"checkout_path":"/tmp/fake-herdr-parent","is_linked_worktree":false,"repo_key":"/tmp/fake-herdr-parent/.git","repo_name":"fake","repo_root":"/tmp/fake-herdr-parent"}}'
# A legacy `<repo>/dispatch` sibling (pre-GH-2246): address-labeled, no
# worktree binding — exactly what `workspace create --cwd --label` produced.
LEGACY_WS='{"workspace_id":"wL","label":"fake/dispatch","number":9,"pane_count":2,"tab_count":2,"active_tab_id":"wL:t1","agent_status":"idle","focused":false}'

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
    "$FAKE_HERDR_FIXTURES"/plugin-pane.json \
    "$FAKE_BOARD_FIXTURES"/name.dispatch.rc "$FAKE_BOARD_FIXTURES"/roster.rc \
    "$RALPH_HERDR_LEDGER_ROOT/fake/fake/hero.pane.json" \
    "$RALPH_HERDR_LEDGER_ROOT/fake/fake/dispatch-heartbeat" 2>/dev/null || true
}

# live_hero PANE — a live hero record for PANE: this test's own pid is
# alive, and the snapshot carries the pane.
live_hero() {
  mkdir -p "$RALPH_HERDR_LEDGER_ROOT/fake/fake"
  printf '{"pane":"%s","pid":%s,"at":"2026-08-28T00:00:00Z","repo":"%s"}\n' "$1" $$ "$REPO_DIR" \
    >"$RALPH_HERDR_LEDGER_ROOT/fake/fake/hero.pane.json"
  printf '{"snapshot":{"version":1,"protocol":19,"workspaces":[],"tabs":[],"panes":[{"pane_id":"%s"}],"layouts":[],"agents":[]}}\n' "$1" \
    >"$FAKE_HERDR_FIXTURES/api-snapshot.json"
}

# ── 1. fresh bring-up: no space, no hero — create main workspace, print ─────
reset
out=$(run_up)
rc=$?
[ "$rc" = 0 ] && ok "fresh bring-up exits 0" || not_ok "fresh bring-up exits 0 — rc $rc: $out"
has "creates the main workspace on the source checkout, labeled by it" "$(cat "$FAKE_HERDR_LOG")" "workspace create --cwd $SRC --label fake-herdr-parent --no-focus"
hasnt "never creates an address-labeled sibling (GH-2246)" "$(cat "$FAKE_HERDR_LOG")" "workspace create .*--label fake/dispatch"
has "opens the hero pane into the created space" "$(cat "$FAKE_HERDR_LOG")" "plugin pane open --plugin ralph-herdr --entrypoint hero --workspace wT --placement tab"
has "ensure-only leaves the new hero unfocused" "$(cat "$FAKE_HERDR_LOG")" "plugin pane open .* --no-focus"
has "summary names created + opened" "$out" "workspace wT (created), hero pane pP1 (opened)"
has "absorbs the fresh space's default root tab (GH-2316)" "$(cat "$FAKE_HERDR_LOG")" "tab close wT:t1"
has "summary still carries the dispatch address" "$out" "dispatch up: fake/dispatch"
has "prints the roster" "$out" "ROSTER (fake)"
has "roster was asked of the board" "$(cat "$FAKE_BOARD_LOG")" "^roster"
hb="$RALPH_HERDR_LEDGER_ROOT/fake/fake/dispatch-heartbeat"
if [ -f "$hb" ]; then ok "heartbeat stamped"; else not_ok "heartbeat stamped — $hb missing"; fi
has "heartbeat names this writer" "$(cat "$hb" 2>/dev/null)" '"writer":"dispatch-up"'

# ── 2. heal: main workspace stands, hero dead — reopen the pane only ────────
reset
printf '{"workspaces":[%s]}\n' "$MAIN_WS" >"$FAKE_HERDR_FIXTURES/workspace-list.json"
out=$(run_up)
rc=$?
[ "$rc" = 0 ] && ok "heal-pane run exits 0" || not_ok "heal-pane run exits 0 — rc $rc: $out"
hasnt "standing main workspace is not recreated" "$(cat "$FAKE_HERDR_LOG")" "workspace create"
has "hero pane opened into the standing main workspace" "$(cat "$FAKE_HERDR_LOG")" "plugin pane open .* --workspace wM"
has "summary names standing + opened" "$out" "workspace wM (standing), hero pane pP1 (opened)"
hasnt "a standing space's tabs are never closed (GH-2316 is created-only)" "$(cat "$FAKE_HERDR_LOG")" "tab close"

# ── 2b. GH-2316 guard: hero lands in the SAME tab as the default — no close ─
# The absorb is destructive, so its guard fails toward leaving the tab: a
# plugin-pane response placing the hero in the create response's own tab
# (wT:t1) must suppress the close, whatever the reason it happened.
reset
printf '{"plugin_pane":{"entrypoint":"hero","plugin_id":"ralph-herdr","pane":{"pane_id":"pP1","workspace_id":"wT","tab_id":"wT:t1","terminal_id":"term_fake","focused":true,"agent_status":"unknown","revision":0}}}\n' \
  >"$FAKE_HERDR_FIXTURES/plugin-pane.json"
out=$(run_up)
rc=$?
[ "$rc" = 0 ] && ok "same-tab hero run exits 0" || not_ok "same-tab hero run exits 0 — rc $rc: $out"
hasnt "hero in the default tab suppresses the close" "$(cat "$FAKE_HERDR_LOG")" "tab close"

# ── 3. idempotent: main stands, hero LIVE in it — touch nothing ─────────────
reset
printf '{"workspaces":[%s]}\n' "$MAIN_WS" >"$FAKE_HERDR_FIXTURES/workspace-list.json"
live_hero pH
printf '{"panes":[{"pane_id":"pH","workspace_id":"wM","tab_id":"wM:t2","terminal_id":"t","focused":false,"agent_status":"working","revision":1}]}\n' \
  >"$FAKE_HERDR_FIXTURES/pane-list.json"
out=$(run_up)
rc=$?
[ "$rc" = 0 ] && ok "idempotent run exits 0" || not_ok "idempotent run exits 0 — rc $rc: $out"
hasnt "no workspace created" "$(cat "$FAKE_HERDR_LOG")" "workspace create"
hasnt "no hero pane opened" "$(cat "$FAKE_HERDR_LOG")" "plugin pane open"
has "summary names standing + live" "$out" "workspace wM (standing), hero pane pH (live)"
has "roster still prints" "$out" "ROSTER (fake)"

# ── 3b. explicit focus: the day surface enters the live hero seat ────────────
reset
printf '{"workspaces":[%s]}\n' "$MAIN_WS" >"$FAKE_HERDR_FIXTURES/workspace-list.json"
live_hero pH
printf '{"panes":[{"pane_id":"pH","workspace_id":"wM","tab_id":"wM:t2","terminal_id":"t","focused":false,"agent_status":"working","revision":1}]}\n' \
  >"$FAKE_HERDR_FIXTURES/pane-list.json"
out=$(run_up --focus)
rc=$?
[ "$rc" = 0 ] && ok "focus run exits 0" || not_ok "focus run exits 0 — rc $rc: $out"
has "focus targets the proven hero pane" "$(cat "$FAKE_HERDR_LOG")" "plugin pane focus pH"
hasnt "focus does not duplicate the hero" "$(cat "$FAKE_HERDR_LOG")" "plugin pane open"

# ── 3c. explicit focus + missing seat: open quietly, then enter it ───────────
reset
out=$(run_up --focus)
rc=$?
[ "$rc" = 0 ] && ok "focus heal exits 0" || not_ok "focus heal exits 0 — rc $rc: $out"
has "focus heal opens without an intermediate jump" "$(cat "$FAKE_HERDR_LOG")" "plugin pane open .* --no-focus"
has "focus heal enters the newly proven hero" "$(cat "$FAKE_HERDR_LOG")" "plugin pane focus pP1"

# ── 4. hero live but in ANOTHER space (not legacy) — open where it belongs ──
reset
printf '{"workspaces":[%s]}\n' "$MAIN_WS" >"$FAKE_HERDR_FIXTURES/workspace-list.json"
live_hero pElsewhere
printf '{"panes":[{"pane_id":"pShell","workspace_id":"wM","tab_id":"wM:t1","terminal_id":"t","focused":false,"agent_status":"idle","revision":1}]}\n' \
  >"$FAKE_HERDR_FIXTURES/pane-list.json"
out=$(run_up)
has "hero elsewhere does not satisfy the main workspace" "$(cat "$FAKE_HERDR_LOG")" "plugin pane open .* --workspace wM"
has "summary says opened" "$out" "hero pane pP1 (opened)"

# ── 5. legacy migration: live hero still in the <repo>/dispatch sibling ─────
reset
printf '{"workspaces":[%s,%s]}\n' "$MAIN_WS" "$LEGACY_WS" >"$FAKE_HERDR_FIXTURES/workspace-list.json"
live_hero pH
# The single pane-list fixture answers every scope; the script's client-side
# workspace check does the filtering — pH sits in wL, not wM.
printf '{"panes":[{"pane_id":"pH","workspace_id":"wL","tab_id":"wL:t2","terminal_id":"t","focused":false,"agent_status":"working","revision":1}]}\n' \
  >"$FAKE_HERDR_FIXTURES/pane-list.json"
out=$(run_up)
rc=$?
[ "$rc" = 0 ] && ok "legacy live sitting exits 0" || not_ok "legacy live sitting exits 0 — rc $rc: $out"
hasnt "a live legacy sitting is left alone (no new pane)" "$(cat "$FAKE_HERDR_LOG")" "plugin pane open"
has "summary names the legacy placement" "$out" "hero pane pH (live-legacy)"
has "note names the legacy space and the manual close" "$out" "legacy dispatch workspace wL .*herdr workspace close wL"

# ── 6. legacy migration: dead sitting — seat opens in main, legacy noted ────
reset
printf '{"workspaces":[%s,%s]}\n' "$MAIN_WS" "$LEGACY_WS" >"$FAKE_HERDR_FIXTURES/workspace-list.json"
out=$(run_up)
rc=$?
[ "$rc" = 0 ] && ok "legacy-dead run exits 0" || not_ok "legacy-dead run exits 0 — rc $rc: $out"
has "hero opens into the MAIN workspace" "$(cat "$FAKE_HERDR_LOG")" "plugin pane open .* --workspace wM"
hasnt "never opens into the legacy space" "$(cat "$FAKE_HERDR_LOG")" "plugin pane open .* --workspace wL"
hasnt "legacy space never closed by the script" "$(cat "$FAKE_HERDR_LOG")" "workspace close"
has "note names the standing legacy space" "$out" "legacy dispatch workspace(s) wL"

# ── 7. fail-closed: the address read ────────────────────────────────────────
reset
printf '1\n' >"$FAKE_BOARD_FIXTURES/name.dispatch.rc"
out=$(run_up)
rc=$?
[ "$rc" != 0 ] && ok "unmintable address refuses" || not_ok "unmintable address refuses — rc 0: $out"
has "refusal names the board as the minter" "$out" "the seat's name is the board's to mint"
hasnt "nothing was created" "$(cat "$FAKE_HERDR_LOG")" "workspace create"

# ── 8. fail-closed: the workspace list ──────────────────────────────────────
reset
printf '1\n' >"$FAKE_HERDR_FIXTURES/workspace-list.rc"
out=$(run_up)
rc=$?
[ "$rc" != 0 ] && ok "unreadable workspace list refuses" || not_ok "unreadable workspace list refuses — rc 0: $out"
has "refusal says why" "$out" "refusing to guess whether the repo's main workspace exists"
hasnt "no blind create" "$(cat "$FAKE_HERDR_LOG")" "workspace create"

# ── 9. fail-open: the roster ────────────────────────────────────────────────
reset
printf '1\n' >"$FAKE_BOARD_FIXTURES/roster.rc"
out=$(run_up)
rc=$?
[ "$rc" = 0 ] && ok "failed roster does not fail the up" || not_ok "failed roster does not fail the up — rc $rc: $out"
has "degradation is named" "$out" "roster read failed"
has "the space still came up" "$out" "workspace wT (created)"

# ── 3d. --focus-only: enter the standing seat, heal and open NOTHING ────────
# The attended day's last act. Everything the ensure phases would do has
# already run earlier in the same `rh day`, so this mode is a bare read.
reset
printf '{"workspaces":[%s]}\n' "$MAIN_WS" >"$FAKE_HERDR_FIXTURES/workspace-list.json"
live_hero pH
out=$(run_up --focus-only)
rc=$?
[ "$rc" = 0 ] && ok "focus-only exits 0" || not_ok "focus-only exits 0 — rc $rc: $out"
has "focus-only focuses the recorded hero" "$(cat "$FAKE_HERDR_LOG")" "plugin pane focus pH"
hasnt "focus-only creates no workspace" "$(cat "$FAKE_HERDR_LOG")" "workspace create"
hasnt "focus-only opens no pane" "$(cat "$FAKE_HERDR_LOG")" "plugin pane open"
hasnt "focus-only prints no roster" "$(cat "$FAKE_BOARD_LOG")" "^roster"
has "focus-only names the pane it entered" "$out" "dispatch focus: hero pane pH"

# ── 3e. --focus-only with no live hero: refuse, never focus a guess ─────────
reset
printf '{"workspaces":[%s]}\n' "$MAIN_WS" >"$FAKE_HERDR_FIXTURES/workspace-list.json"
out=$(run_up --focus-only)
rc=$?
[ "$rc" != 0 ] && ok "focus-only without a live hero refuses" || not_ok "focus-only without a live hero refuses — rc 0: $out"
has "refusal names the remedy" "$out" "no live dispatch hero recorded for this repo"
hasnt "no pane was focused on a guess" "$(cat "$FAKE_HERDR_LOG")" "plugin pane focus"

# ── 10. arguments: only the internal focus modes are accepted ───────────────
reset
out=$(run_up --rota)
rc=$?
[ "$rc" != 0 ] && ok "unknown argument refuses" || not_ok "unknown argument refuses — rc 0"
out=$(run_up --help)
rc=$?
[ "$rc" = 0 ] && ok "--help exits 0" || not_ok "--help exits 0 — rc $rc"
has "--help states idempotence" "$out" "re-run heals"
has "--help states no scheduling" "$out" "Arms nothing scheduled"
has "--help states the main-workspace placement" "$out" "MAIN workspace"

echo
echo "$pass passed, $fail failed (of $n)"
[ "$fail" = 0 ]
