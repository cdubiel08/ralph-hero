#!/usr/bin/env bash
# invoke.test.sh — tests for scripts/invoke.sh, deterministic repo-path
# targeting for herdr plugin panes (GH-2291).
#
#   bash plugin/ralph-herdr/tests/invoke.test.sh    # exits 0 on pass, 1 on fail
#
# invoke.sh is a SCRIPT, not a sourced lib, and it NEVER reads
# HERDR_PLUGIN_CONTEXT_JSON — every case here runs it as a subprocess against
# the shared fake herdr and asserts on its stdout/stderr and on
# FAKE_HERDR_LOG, the exact argv it sent. No RALPH_HERDR_BOARD / board CLI is
# configured anywhere in this file — invoke.sh must never need one (the
# cockpit-open.sh precedent: it targets a repo that may not be $PWD, so it
# cannot depend on $PWD having a board). bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INVOKE="$SCRIPT_DIR/../scripts/invoke.sh"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-invoke-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

export HERDR_BIN_PATH="$SCRIPT_DIR/fake-herdr.sh"
export FAKE_HERDR_FIXTURES="$TMP/fixtures"
mkdir -p "$FAKE_HERDR_FIXTURES"

n=0 pass=0 fail=0 rc=0 out="" log=""
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

# Real directories, so invoke.sh's own `cd DIR && pwd -P` resolution is
# exercised for real (a fake path here would just make every match fail on a
# spelling mismatch nobody intended to test).
REPO_MAIN_RAW="$TMP/repo/ralph-hero"
WT_A_RAW="$TMP/wt/ralph-hero-a"
WT_B_RAW="$TMP/wt/ralph-hero-b"
OTHER_REPO_RAW="$TMP/repo/other-repo"
mkdir -p "$REPO_MAIN_RAW" "$WT_A_RAW" "$WT_B_RAW" "$OTHER_REPO_RAW"
REPO_MAIN=$(cd "$REPO_MAIN_RAW" && pwd -P)
WT_A=$(cd "$WT_A_RAW" && pwd -P)
WT_B=$(cd "$WT_B_RAW" && pwd -P)
OTHER_REPO=$(cd "$OTHER_REPO_RAW" && pwd -P)

# ws_fixture JSON_ARRAY — the `workspace list` payload.
ws_fixture() {
  printf '{"workspaces": %s}\n' "$1" >"$FAKE_HERDR_FIXTURES/workspace-list.json"
}
# panes_fixture JSON_ARRAY — the `pane list` payload (fake-herdr answers the
# same body regardless of --workspace, so one fixture covers one test case).
panes_fixture() {
  printf '{"panes": %s}\n' "$1" >"$FAKE_HERDR_FIXTURES/pane-list.json"
}

# run ARG... — run invoke.sh. Sets $out (stdout+stderr), $rc, $log (the argv
# the fake herdr received). Deliberately not `out=$(run …)` — see fork.test.sh
# for why a subshell capture would lose $rc/$log to the substitution.
run() {
  local logfile="$TMP/argv.log"
  : >"$logfile"
  rc=0
  out=$(env FAKE_HERDR_LOG="$logfile" bash "$INVOKE" "$@" 2>&1) || rc=$?
  log=$(cat "$logfile")
}

# A realistic multi-repo herdr snapshot: ralph-hero's main checkout, two of
# its linked worktrees (sharing its repo_root), an unrelated repo, and one
# workspace herdr reports with NO worktree object at all (the "projects"
# placeholder / a workspace opened over a bare directory — observed live).
BASE_WS=$(jq -nc --arg main "$REPO_MAIN" --arg a "$WT_A" --arg b "$WT_B" --arg other "$OTHER_REPO" '[
  {workspace_id: "w1", label: "ralph-hero",
   worktree: {checkout_path: $main, repo_root: $main, is_linked_worktree: false}},
  {workspace_id: "wAD", label: "feat-a",
   worktree: {checkout_path: $a, repo_root: $main, is_linked_worktree: true}},
  {workspace_id: "wAH", label: "feat-b",
   worktree: {checkout_path: $b, repo_root: $main, is_linked_worktree: true}},
  {workspace_id: "w7", label: "other-repo",
   worktree: {checkout_path: $other, repo_root: $other, is_linked_worktree: false}},
  {workspace_id: "w4Q", label: "projects"}
]')

# ── exact checkout_path match — the common case ─────────────────────────────
ws_fixture "$BASE_WS"
run "$REPO_MAIN" dashboard --placement tab --no-focus
is "main checkout, tab: exits 0" "0" "$rc"
has "main checkout, tab: opens in w1" "plugin pane open --plugin ralph-herdr --entrypoint dashboard --placement tab --workspace w1 --cwd $REPO_MAIN --no-focus" "$log"
hasnt "main checkout, tab: never lists panes (no target-pane needed)" "pane list" "$log"

run "$WT_A" dashboard --placement tab
is "linked worktree, exact match: exits 0" "0" "$rc"
has "linked worktree, exact match: opens in wAD, not w1" "--workspace wAD" "$log"
has "linked worktree, exact match: cwd is the worktree's own path" "--cwd $WT_A" "$log"

# ── split/zoomed resolve a target-pane; tab/overlay do not ──────────────────
panes_fixture '[{"pane_id":"w1:p1","workspace_id":"w1"},{"pane_id":"w1:p2","workspace_id":"w1"}]'
run "$REPO_MAIN" dashboard
is "default placement (split): exits 0" "0" "$rc"
has "default placement (split): lists panes in the matched workspace" "pane list --workspace w1" "$log"
has "default placement (split): targets the first pane, not --workspace" "--target-pane w1:p1" "$log"
hasnt "default placement (split): does not also pass --workspace" "--workspace w1 " "$log"
has "default placement (split): direction defaults to right" "--direction right" "$log"
has "default placement (split): focus defaults on" "--focus" "$log"

run "$REPO_MAIN" dashboard --placement zoomed --direction down
is "zoomed: exits 0" "0" "$rc"
has "zoomed: also resolves a target-pane" "--target-pane w1:p1" "$log"
hasnt "zoomed: direction is split-only, not passed for zoomed" "--direction" "$log"

run "$REPO_MAIN" dashboard --placement overlay --no-focus
is "overlay: exits 0" "0" "$rc"
has "overlay: uses --workspace like tab (unverified either way, treated as no-target-pane)" "--workspace w1" "$log"
hasnt "overlay: never lists panes" "pane list" "$log"

# split against a workspace with zero panes — nothing to place against
panes_fixture '[]'
run "$REPO_MAIN" dashboard --placement split
is "split, no panes in target workspace: refuses" "1" "$rc"
has "split, no panes: names the workspace" "workspace w1 has no panes" "$out"
has "split, no panes: suggests tab instead" "--placement tab" "$out"

# ── ambiguity: several worktrees of one repo, none matching by exact path ──
panes_fixture '[{"pane_id":"p1","workspace_id":"w1"}]'
ws_fixture "$BASE_WS"
run "$REPO_MAIN_RAW/.." dashboard --placement tab
# (walks the parent, which is not any recorded path — exercises "no match")
is "unrelated path: refuses" "1" "$rc"
has "unrelated path: names the searched path" "no herdr workspace has repo path" "$out"
hasnt "unrelated path: opens nothing" "plugin pane open" "$log"

run "$REPO_MAIN" dashboard --workspace does-not-exist
is "--workspace naming an unknown id: refuses" "1" "$rc"
has "--workspace naming an unknown id: says so" "names no workspace herdr currently has open" "$out"

# repo_root matches TWO worktree workspaces (wAD, wAH) with no checkout_path
# match of its own — the "same repo, several checkouts" case. Simulated by
# asking for a path that only the fallback tier can see: strip the main
# workspace's own checkout_path from the snapshot so the repo_root fallback
# is reached, but the caller still names the repo_root path directly.
AMBIG_WS=$(jq -nc --arg a "$WT_A" --arg b "$WT_B" --arg main "$REPO_MAIN" '[
  {workspace_id: "wAD", label: "feat-a",
   worktree: {checkout_path: $a, repo_root: $main, is_linked_worktree: true}},
  {workspace_id: "wAH", label: "feat-b",
   worktree: {checkout_path: $b, repo_root: $main, is_linked_worktree: true}}
]')
ws_fixture "$AMBIG_WS"
run "$REPO_MAIN" dashboard --placement tab
is "repo-root fallback ambiguous: refuses" "1" "$rc"
has "repo-root fallback ambiguous: names both checkouts" "wAD" "$out"
has "repo-root fallback ambiguous: names both checkouts (b)" "wAH" "$out"
has "repo-root fallback ambiguous: suggests --workspace" "pass --workspace" "$out"
hasnt "repo-root fallback ambiguous: opens nothing" "plugin pane open" "$log"

# --workspace disambiguates the exact same ambiguous snapshot. The repo-path
# argument ($REPO_MAIN) and the named workspace's own checkout ($WT_B) are
# DIFFERENT directories on purpose — --workspace exists precisely for "same
# repo, several worktrees", so --cwd must come from the matched workspace's
# own checkout_path, never from the caller's repo-path argument (the pane
# would otherwise open in the right workspace but the wrong directory).
run "$REPO_MAIN" dashboard --placement tab --workspace wAH
is "--workspace disambiguates: exits 0" "0" "$rc"
has "--workspace disambiguates: opens in the named workspace" "--workspace wAH" "$log"
has "--workspace disambiguates: cwd is the WORKSPACE's own checkout, not the repo-path argument" "--cwd $WT_B" "$log"
hasnt "--workspace disambiguates: never uses the repo-path argument as cwd" "--cwd $REPO_MAIN " "$log"

# ── argument validation, before any herdr call ──────────────────────────────
ws_fixture "$BASE_WS"

run
is "no args: usage exit" "2" "$rc"
has "no args: prints usage" "usage: invoke.sh" "$out"

run "$REPO_MAIN"
is "one arg (no entrypoint): refuses" "1" "$rc"
has "one arg: names what's missing" "repo path AND an entrypoint" "$out"

run --help
is "--help: exits 0" "0" "$rc"
has "--help: prints usage" "usage: invoke.sh" "$out"

run "$REPO_MAIN" dashboard --placement sideways
is "bad placement: refuses" "1" "$rc"
has "bad placement: names the valid set" "overlay, split, tab, zoomed" "$out"
hasnt "bad placement: no herdr call made" "workspace list" "$log"

run "$REPO_MAIN" dashboard --direction sideways
is "bad direction: refuses" "1" "$rc"
has "bad direction: names the valid set" "right or down" "$out"

run /this/path/does/not/exist dashboard
is "nonexistent repo path: refuses" "1" "$rc"
has "nonexistent repo path: names it" "does not exist" "$out"
is "nonexistent repo path: never calls herdr at all" "" "$log"

echo "1..$n"
[ "$fail" -eq 0 ] || { echo "# $fail of $n failed"; exit 1; }
echo "# all $n passed"
