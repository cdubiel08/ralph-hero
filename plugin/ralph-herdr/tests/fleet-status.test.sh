#!/usr/bin/env bash
# fleet-status.test.sh — executable tests for scripts/fleet-status.sh's
# HEALTH derivation (TAP-ish, matching the suite's structure).
#
#   bash plugin/ralph-herdr/tests/fleet-status.test.sh
#
# GH-2274: dead-before-start used to be derived from the self-report token
# alone, so a driver that finished its unit (merged feature, or a
# zero-commit-by-construction apply unit) without a LATER self-report read as
# dead and earned a runnable "respawn" footer line. The fix asks the board
# (closed vs open, one batched `board list --json`) before the branch
# (commits ahead of its merge-base) — this suite pins all three acceptance
# directions plus the two "third answer" failure modes and the
# one-call/zero-call cost bound. All herdr and board traffic goes through
# tests/fake-herdr.sh and tests/fake-board.sh — no server, no GitHub, real
# git repos on disk for the branch-commit half. bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../scripts"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-fleet-status-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}

# ── herdr PATH shim (fake-herdr.sh) ─────────────────────────────────────────
BIN="$TMP/bin"
mkdir -p "$BIN"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-herdr.sh" >"$BIN/herdr"
chmod +x "$BIN/herdr"
export PATH="$BIN:$PATH"
export HERDR_BIN_PATH="$BIN/herdr"
export FAKE_HERDR_FIXTURES="$TMP/herdr-fixtures"
mkdir -p "$FAKE_HERDR_FIXTURES"
export FAKE_HERDR_LOG="$TMP/herdr.log"
: >"$FAKE_HERDR_LOG"

# ── board CLI shim (fake-board.sh) ──────────────────────────────────────────
export RALPH_HERDR_BOARD="$SCRIPT_DIR/fake-board.sh"
export FAKE_BOARD_FIXTURES="$TMP/board-fixtures"
mkdir -p "$FAKE_BOARD_FIXTURES"
export FAKE_BOARD_LOG="$TMP/board.log"
: >"$FAKE_BOARD_LOG"

# The scoped-agent join keys on the repository root; the per-agent worktree
# checkout can point anywhere (that is exactly what this suite needs — a
# distinct real git repo per row) as long as repo_root also matches, since
# ralph_scoped_agents accepts either half.
REPO_DIR="$TMP/checkout"
mkdir -p "$REPO_DIR"
printf '{"owner":"acme","repo":"demo","projectNumber":1}\n' >"$REPO_DIR/.ralph.json"
export RALPH_HERDR_REPO="$REPO_DIR"
export RALPH_HERDR_LEDGER="$TMP/ledger/ledger.jsonl"
mkdir -p "$TMP/ledger"

# ── real git fixtures for the branch-commit half of the predicate ──────────
git config --global user.email >/dev/null 2>&1 || git config --global user.email "t@t.example"
git config --global user.name >/dev/null 2>&1 || git config --global user.name "test"
git config --global init.defaultBranch main >/dev/null 2>&1 || true

ORIGIN="$TMP/origin.git"
git init -q --bare "$ORIGIN"
SEED="$TMP/seed"
git init -q -b main "$SEED"
echo hi >"$SEED/f"
git -C "$SEED" add f
git -C "$SEED" commit -q -m init
git -C "$SEED" remote add origin "$ORIGIN"
git -C "$SEED" push -q origin main

# WT_ZERO: a branch with NO commits of its own — origin/main's tip exactly.
# Models both "genuinely never started" and an apply unit's zero-commit close.
WT_ZERO="$TMP/wt-zero"
git clone -q "$ORIGIN" "$WT_ZERO"
git -C "$WT_ZERO" checkout -q -b feat/branch-zero

# WT_COMMITS: one commit ahead of its merge-base with origin/main.
WT_COMMITS="$TMP/wt-commits"
git clone -q "$ORIGIN" "$WT_COMMITS"
git -C "$WT_COMMITS" checkout -q -b feat/branch-commits
echo work >"$WT_COMMITS/g"
git -C "$WT_COMMITS" add g
git -C "$WT_COMMITS" commit -q -m "did work"

# ── snapshot builder: one workspace+pane+agent per row, each with its own
# worktree.checkout_path (unlike herd-fixture.sh's single shared root) ──────
# ROWS_JSON: [{name, status, checkout, token_state}]
build_snapshot() {
  local rows_json="$1"
  jq -n --argjson rows "$rows_json" --arg root "$REPO_DIR" '
    ($rows | to_entries) as $ix
    | {snapshot: {
        version: 1, protocol: 19,
        workspaces: [$ix[] | .key as $i | .value as $r |
          {workspace_id: ("w" + ($i | tostring)), number: $i, label: $r.name,
           focused: false, pane_count: 1, tab_count: 1,
           active_tab_id: ("w" + ($i | tostring) + ":t1"), agent_status: "unknown",
           worktree: {repo_key: ("test/" + $r.name), repo_name: $r.name,
                      repo_root: $root, checkout_path: $r.checkout,
                      is_linked_worktree: true}}],
        tabs: [$ix[] | .key as $i | {tab_id: ("w" + ($i | tostring) + ":t1")}],
        panes: [$ix[] | .key as $i | .value as $r |
          {pane_id: ("p" + ($i | tostring)), terminal_id: ("term" + ($i | tostring)),
           workspace_id: ("w" + ($i | tostring)), tab_id: ("w" + ($i | tostring) + ":t1"),
           focused: false, agent_status: $r.status, revision: 1,
           tokens: (if $r.token_state == null then {} else {state: $r.token_state} end)}],
        layouts: [],
        agents: [$ix[] | .key as $i | .value as $r |
          {name: $r.name, agent_status: $r.status,
           workspace_id: ("w" + ($i | tostring)), pane_id: ("p" + ($i | tostring)),
           tab_id: ("w" + ($i | tostring) + ":t1"), terminal_id: ("term" + ($i | tostring)),
           focused: false, revision: 1}]
      }}' >"$FAKE_HERDR_FIXTURES/api-snapshot.json"
}

run_status() {
  ( cd "$REPO_DIR" && bash "$SCRIPTS/fleet-status.sh" --json ) 2>"$TMP/last.stderr"
}

# ═══ Scenario A: one run, five candidates covering the corrected shape ═════
ROWS='[
  {"name":"w2101-merged",         "status":"idle", "checkout":"'"$TMP"'/does-not-exist-2101", "token_state":"spawned"},
  {"name":"w2102-deadopen",       "status":"idle", "checkout":"'"$WT_ZERO"'",                  "token_state":"spawned"},
  {"name":"w2103-workedopen",     "status":"done", "checkout":"'"$WT_COMMITS"'",               "token_state":"briefed"},
  {"name":"w2104-closedcommits",  "status":"idle", "checkout":"'"$WT_COMMITS"'",               "token_state":"spawned"},
  {"name":"w2105-unreadablewt",   "status":"idle", "checkout":"'"$TMP"'/does-not-exist-2105",  "token_state":"briefed"},
  {"name":"w2106-working",        "status":"working", "checkout":"'"$REPO_DIR"'",              "token_state":"working"},
  {"name":"w2107-blocked",        "status":"blocked", "checkout":"'"$REPO_DIR"'",              "token_state":null},
  {"name":"w2108-tokenrotforward","status":"idle", "checkout":"'"$REPO_DIR"'",                 "token_state":"working"},
  {"name":"w2109-idlenotoken",    "status":"idle", "checkout":"'"$REPO_DIR"'",                 "token_state":null},
  {"name":"w2110-unknown",        "status":"weird","checkout":"'"$REPO_DIR"'",                 "token_state":null}
]'
build_snapshot "$ROWS"

# Board: 2102, 2103 and 2105 are OPEN; 2101 and 2104 are absent (closed).
cat >"$FAKE_BOARD_FIXTURES/list.json" <<'EOF'
{"items":[{"number":2102,"state":"In Progress"},{"number":2103,"state":"In Review"},{"number":2105,"state":"In Progress"}],"foreign":[]}
EOF

out=$(run_status)
rc=$?
is "scenario A: fleet-status exits 0" "0" "$rc"

jqf() { jq -r --arg n "$1" '.[] | select(.agent == $n) | .health' <<<"$out"; }

is "closed feature unit (merged, no board entry) reads finished, not dead" \
  "finished" "$(jqf w2101-merged)"
is "open unit with zero commits and a never-advanced token IS dead-before-start (true positive preserved)" \
  "dead-before-start" "$(jqf w2102-deadopen)"
is "open unit whose branch already has commits does not read dead" \
  "stale-token" "$(jqf w2103-workedopen)"
is "closed unit wins over branch commits too (issue state, not git, is authoritative)" \
  "finished" "$(jqf w2104-closedcommits)"
is "open unit with an unreadable worktree renders the third answer, not dead" \
  "unverified" "$(jqf w2105-unreadablewt)"
is "a working session is unaffected" "working" "$(jqf w2106-working)"
is "a blocked session is unaffected" "blocked" "$(jqf w2107-blocked)"
is "token-rotted-forward (working/reporting) is unaffected" "stale-token" "$(jqf w2108-tokenrotforward)"
is "idle with no token at all is unaffected" "idle" "$(jqf w2109-idlenotoken)"
is "an unrecognized status is unaffected" "unknown" "$(jqf w2110-unknown)"

dead_count=$(jq '[.[] | select(.health == "dead-before-start")] | length' <<<"$out")
is "exactly one true dead-before-start in this batch" "1" "$dead_count"

list_calls=$(grep -c '^list --json$' "$FAKE_BOARD_LOG" || true)
is "one batched \`board list --json\` covers the whole run, never one per row" "1" "$list_calls"

# The non-JSON table renders the footer for the one true positive only.
table=$(cd "$REPO_DIR" && bash "$SCRIPTS/fleet-status.sh" 2>/dev/null)
case "$table" in
  *"1 session(s) died before starting"*) ok "footer: names exactly the one true dead-before-start" ;;
  *) not_ok "footer: expected exactly one death — got: $table" ;;
esac

# ═══ Scenario B: the board itself is unreadable ════════════════════════════
rm -rf "$FAKE_HERDR_FIXTURES" "$FAKE_BOARD_FIXTURES"
mkdir -p "$FAKE_HERDR_FIXTURES" "$FAKE_BOARD_FIXTURES"
: >"$FAKE_BOARD_LOG"
build_snapshot '[{"name":"w2201-boardfails","status":"idle","checkout":"'"$WT_ZERO"'","token_state":"spawned"}]'
printf '1\n' >"$FAKE_BOARD_FIXTURES/list.rc"

out=$(run_status)
is "an unreadable board renders the third answer, never a false dead or a false finished" \
  "unverified" "$(jq -r '.[0].health' <<<"$out")"
dead_count=$(jq '[.[] | select(.health == "dead-before-start")] | length' <<<"$out")
is "an unreadable board never contributes to the dead count (fails toward the respawn footer is the defect)" \
  "0" "$dead_count"

# ═══ Scenario C: no candidate rows — the board must never be read at all ══
rm -rf "$FAKE_HERDR_FIXTURES" "$FAKE_BOARD_FIXTURES"
mkdir -p "$FAKE_HERDR_FIXTURES" "$FAKE_BOARD_FIXTURES"
: >"$FAKE_BOARD_LOG"
build_snapshot '[
  {"name":"w2301-working","status":"working","checkout":"'"$REPO_DIR"'","token_state":"working"},
  {"name":"w2302-blocked","status":"blocked","checkout":"'"$REPO_DIR"'","token_state":null}
]'
out=$(run_status)
is "scenario C: no candidates, still exits 0" "0" "$?"
board_calls=$(wc -l <"$FAKE_BOARD_LOG" | tr -d ' ')
is "zero board calls when no row could possibly read dead-before-start" "0" "$board_calls"

echo "1..$n"
echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
