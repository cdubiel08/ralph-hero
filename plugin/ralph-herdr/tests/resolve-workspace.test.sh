#!/usr/bin/env bash
# resolve-workspace.test.sh — GH-2269: every workspace-context action resolves
# its target through scripts/resolve-workspace.sh before doing anything, so a
# wrong target is VISIBLE (printed) rather than silently spawning to
# completion — and a resolved workspace with no board config REFUSES instead
# of opening a pane against it.
#
#   bash plugin/ralph-herdr/tests/resolve-workspace.test.sh   # exits 0 pass, 1 fail
#
# No herdr server, no board mutation, no writes outside $TMP.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../scripts"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-resolve-workspace-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

set +e
set +o pipefail

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}

run_resolve() {
  # $1 = HERDR_PLUGIN_CONTEXT_JSON. Captures stdout/stderr/rc separately.
  out_file="$TMP/out" err_file="$TMP/err"
  HERDR_PLUGIN_CONTEXT_JSON="$1" bash "$SCRIPTS/resolve-workspace.sh" >"$out_file" 2>"$err_file"
  rc=$?
  stdout=$(cat "$out_file")
  stderr=$(cat "$err_file")
}

# ── 1. a board-configured workspace resolves, prints the scope, refuses nothing
CONFIGURED="$TMP/configured-repo"
mkdir -p "$CONFIGURED"
printf '{"owner":"acme","repo":"widgets","projectNumber":1}\n' >"$CONFIGURED/.ralph.json"

run_resolve "{\"workspace_cwd\":\"$CONFIGURED\"}"
is "configured workspace: exits 0" "0" "$rc"
is "configured workspace: prints the resolved cwd on stdout" "$CONFIGURED" "$stdout"
case "$stderr" in
  *"acme/widgets"*) ok "configured workspace: names the resolved board scope on stderr" ;;
  *) not_ok "configured workspace: stderr did not name the scope — got '$stderr'" ;;
esac

# ── 2. workspace_cwd wins over focused_pane_cwd when both are present
OTHER="$TMP/other-focused-pane"
mkdir -p "$OTHER"
run_resolve "{\"workspace_cwd\":\"$CONFIGURED\",\"focused_pane_cwd\":\"$OTHER\"}"
is "workspace_cwd takes precedence over focused_pane_cwd" "$CONFIGURED" "$stdout"

# falls back to focused_pane_cwd when workspace_cwd is absent
run_resolve "{\"focused_pane_cwd\":\"$CONFIGURED\"}"
is "falls back to focused_pane_cwd when workspace_cwd is absent" "$CONFIGURED" "$stdout"

# ── 3. an unconfigured workspace REFUSES, naming the resolved path — never
#      falls back to opening a pane there (acceptance #2)
UNCONFIGURED="$TMP/unconfigured-repo"
mkdir -p "$UNCONFIGURED"
run_resolve "{\"workspace_cwd\":\"$UNCONFIGURED\"}"
is "unconfigured workspace: refuses (rc 1)" "1" "$rc"
is "unconfigured workspace: prints NOTHING to stdout on refusal" "" "$stdout"
case "$stderr" in
  *"$UNCONFIGURED"*) ok "unconfigured workspace: refusal names the resolved path" ;;
  *) not_ok "unconfigured workspace: refusal did not name '$UNCONFIGURED' — got '$stderr'" ;;
esac
case "$stderr" in
  *"FOCUSED workspace"*) ok "unconfigured workspace: refusal explains focus vs invoking shell" ;;
  *) not_ok "unconfigured workspace: refusal missing the focus explanation" ;;
esac

# ── 4. .claude/settings.json's env block is honoured too, mirroring board.ts
SETTINGS_CFG="$TMP/settings-repo"
mkdir -p "$SETTINGS_CFG/.claude"
printf '{"env":{"RALPH_GH_OWNER":"acme","RALPH_GH_REPO":"gadgets"}}\n' >"$SETTINGS_CFG/.claude/settings.json"
run_resolve "{\"workspace_cwd\":\"$SETTINGS_CFG\"}"
is "settings.json env block: resolves same as .ralph.json" "0" "$rc"
case "$stderr" in
  *"acme/gadgets"*) ok "settings.json env block: names the resolved scope" ;;
  *) not_ok "settings.json env block: stderr did not name the scope — got '$stderr'" ;;
esac

# ── 5. no context at all refuses rather than guessing $PWD
run_resolve ""
is "empty context: refuses (rc 1)" "1" "$rc"
is "empty context: prints nothing to stdout" "" "$stdout"

# ── 6. the blast-radius case named on GH-2269: two DIFFERENT local checkouts
#      of the SAME board (owner/repo) — e.g. this repo and a second worktree
#      of it. Every board-level guard passes identically for both, which is
#      exactly why this fix does not try to distinguish them by scope — the
#      issue's own "Honest limit" says so. What it must still do is name the
#      ACTUAL resolved path (never just the repo name) for each, so a human
#      reading the printed line can tell the two apart even though the board
#      scope string alone cannot.
CHECKOUT_A="$TMP/ralph-hero-checkout-a"
CHECKOUT_B="$TMP/ralph-hero-checkout-b"
mkdir -p "$CHECKOUT_A" "$CHECKOUT_B"
printf '{"owner":"cdubiel08","repo":"ralph-hero","projectNumber":3}\n' >"$CHECKOUT_A/.ralph.json"
printf '{"owner":"cdubiel08","repo":"ralph-hero","projectNumber":3}\n' >"$CHECKOUT_B/.ralph.json"

run_resolve "{\"workspace_cwd\":\"$CHECKOUT_A\"}"
is "same-board checkout A: resolves (rc 0)" "0" "$rc"
is "same-board checkout A: stdout names checkout A's own path" "$CHECKOUT_A" "$stdout"
case "$stderr" in
  *"$CHECKOUT_A"*) ok "same-board checkout A: stderr names checkout A's own path, not just the scope" ;;
  *) not_ok "same-board checkout A: stderr did not name '$CHECKOUT_A' — got '$stderr'" ;;
esac

run_resolve "{\"workspace_cwd\":\"$CHECKOUT_B\"}"
is "same-board checkout B: resolves (rc 0)" "0" "$rc"
is "same-board checkout B: stdout names checkout B's own path, not A's" "$CHECKOUT_B" "$stdout"
case "$stderr" in
  *"$CHECKOUT_B"*) ok "same-board checkout B: stderr names checkout B's own path, not just the scope" ;;
  *) not_ok "same-board checkout B: stderr did not name '$CHECKOUT_B' — got '$stderr'" ;;
esac

echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
