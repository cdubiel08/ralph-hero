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
printf '{"env":{"RALPH_GH_OWNER":"acme","RALPH_GH_REPO":"gadgets","RALPH_GH_PROJECT_NUMBER":"2"}}\n' >"$SETTINGS_CFG/.claude/settings.json"
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

# ── 7. three distinct causes of "no usable board config", never collapsed
#      into one message with a WRONG remedy (QA finding on GH-2269/#2286):
#      no config file at all (remedy: focus the intended workspace) vs a
#      config file that IS the focused repo's own but is broken (remedy:
#      fix the file, not re-focus) — malformed JSON, and valid JSON missing
#      owner/repo. board.ts:1005/1031 distinguish the first from the rest;
#      collapsing all three here would make the printed remedy wrong for a
#      correctly-focused-but-broken-config workspace.
BADJSON="$TMP/badjson-repo"
mkdir -p "$BADJSON"
printf '{ this is not json' >"$BADJSON/.ralph.json"
run_resolve "{\"workspace_cwd\":\"$BADJSON\"}"
is "malformed .ralph.json: refuses (rc 1)" "1" "$rc"
is "malformed .ralph.json: prints nothing to stdout" "" "$stdout"
case "$stderr" in
  *MALFORMED*"$BADJSON/.ralph.json"*) ok "malformed .ralph.json: names the broken file" ;;
  *) not_ok "malformed .ralph.json: did not name the broken file — got '$stderr'" ;;
esac
case "$stderr" in
  *"NOT a focus problem"*) ok "malformed .ralph.json: remedy says fix the file, not re-focus" ;;
  *) not_ok "malformed .ralph.json: remedy still tells the operator to re-focus — got '$stderr'" ;;
esac
case "$stderr" in
  *"focus the intended repo's workspace and retry"*) not_ok "malformed .ralph.json: must NOT reuse the no-config remedy" ;;
  *) ok "malformed .ralph.json: does not reuse the no-config remedy" ;;
esac

ARRAYCFG="$TMP/array-repo"
mkdir -p "$ARRAYCFG"
printf '[]' >"$ARRAYCFG/.ralph.json"
run_resolve "{\"workspace_cwd\":\"$ARRAYCFG\"}"
is "non-object JSON (array): refuses (rc 1)" "1" "$rc"
case "$stderr" in
  *MALFORMED*) ok "non-object JSON (array): treated as malformed, like board.ts:1009" ;;
  *) not_ok "non-object JSON (array): not flagged as malformed — got '$stderr'" ;;
esac

MISSING_OWNER="$TMP/missing-owner-repo"
mkdir -p "$MISSING_OWNER"
printf '{"projectNumber":1}\n' >"$MISSING_OWNER/.ralph.json"
run_resolve "{\"workspace_cwd\":\"$MISSING_OWNER\"}"
is "valid JSON missing owner/repo: refuses (rc 1)" "1" "$rc"
is "valid JSON missing owner/repo: prints nothing to stdout" "" "$stdout"
case "$stderr" in
  *"missing owner/repo"*) ok "valid JSON missing owner/repo: distinct message naming what's missing" ;;
  *) not_ok "valid JSON missing owner/repo: message did not name what's missing — got '$stderr'" ;;
esac
case "$stderr" in
  *"NOT a focus problem"*) ok "valid JSON missing owner/repo: remedy says fix the config, not re-focus" ;;
  *) not_ok "valid JSON missing owner/repo: remedy still tells the operator to re-focus — got '$stderr'" ;;
esac
case "$stderr" in
  *MALFORMED*) not_ok "valid JSON missing owner/repo: must NOT be reported as malformed" ;;
  *) ok "valid JSON missing owner/repo: not conflated with malformed JSON" ;;
esac

# ── 8. owner/repo present but no projectNumber (GH-2336): the scope read
#      passes (owner/repo IS its key) but board.ts:1032 refuses in init, so
#      the pane would open and die anonymously — a fourth distinct refusal,
#      one per config-file shape, and the coercion mirrors board.ts's
#      Number(x ?? 0): 0 and a non-numeric string refuse, a numeric string
#      passes.
NO_PROJECT="$TMP/no-project-repo"
mkdir -p "$NO_PROJECT"
printf '{"owner":"acme","repo":"widgets"}\n' >"$NO_PROJECT/.ralph.json"
run_resolve "{\"workspace_cwd\":\"$NO_PROJECT\"}"
is ".ralph.json missing projectNumber: refuses (rc 1)" "1" "$rc"
is ".ralph.json missing projectNumber: prints nothing to stdout" "" "$stdout"
case "$stderr" in
  *"missing projectNumber"*"'projectNumber'"*) ok ".ralph.json missing projectNumber: names the missing key for this file shape" ;;
  *) not_ok ".ralph.json missing projectNumber: message did not name projectNumber — got '$stderr'" ;;
esac
case "$stderr" in
  *"NOT a focus problem"*) ok ".ralph.json missing projectNumber: remedy says fix the config, not re-focus" ;;
  *) not_ok ".ralph.json missing projectNumber: remedy still tells the operator to re-focus — got '$stderr'" ;;
esac
case "$stderr" in
  *"missing owner/repo"*|*MALFORMED*) not_ok ".ralph.json missing projectNumber: must NOT reuse the owner/repo or malformed message" ;;
  *) ok ".ralph.json missing projectNumber: not conflated with the owner/repo or malformed refusals" ;;
esac

NO_PROJECT_SETTINGS="$TMP/no-project-settings-repo"
mkdir -p "$NO_PROJECT_SETTINGS/.claude"
printf '{"env":{"RALPH_GH_OWNER":"acme","RALPH_GH_REPO":"gadgets"}}\n' >"$NO_PROJECT_SETTINGS/.claude/settings.json"
run_resolve "{\"workspace_cwd\":\"$NO_PROJECT_SETTINGS\"}"
is "settings.json missing RALPH_GH_PROJECT_NUMBER: refuses (rc 1)" "1" "$rc"
is "settings.json missing RALPH_GH_PROJECT_NUMBER: prints nothing to stdout" "" "$stdout"
case "$stderr" in
  *"missing projectNumber"*"env.RALPH_GH_PROJECT_NUMBER"*) ok "settings.json missing RALPH_GH_PROJECT_NUMBER: names the env key for this file shape" ;;
  *) not_ok "settings.json missing RALPH_GH_PROJECT_NUMBER: message did not name the env key — got '$stderr'" ;;
esac

# board.ts coerces with Number(): "0" and a non-numeric string are refused
# there too, so they refuse here; a numeric string is accepted there, so it
# is accepted here.
printf '{"owner":"acme","repo":"widgets","projectNumber":0}\n' >"$NO_PROJECT/.ralph.json"
run_resolve "{\"workspace_cwd\":\"$NO_PROJECT\"}"
is "projectNumber 0: refuses like board.ts's falsy test" "1" "$rc"
printf '{"owner":"acme","repo":"widgets","projectNumber":"three"}\n' >"$NO_PROJECT/.ralph.json"
run_resolve "{\"workspace_cwd\":\"$NO_PROJECT\"}"
is "non-numeric projectNumber: refuses like board.ts's Number() NaN" "1" "$rc"
printf '{"env":{"RALPH_GH_OWNER":"acme","RALPH_GH_REPO":"gadgets","RALPH_GH_PROJECT_NUMBER":"7"}}\n' >"$NO_PROJECT_SETTINGS/.claude/settings.json"
run_resolve "{\"workspace_cwd\":\"$NO_PROJECT_SETTINGS\"}"
is "numeric-string RALPH_GH_PROJECT_NUMBER (settings.json's only shape): resolves (rc 0)" "0" "$rc"

# The four refusal messages must all differ from one another — the defect
# being fixed was distinct causes rendering byte-identically.
printf '{"owner":"acme","repo":"widgets"}\n' >"$NO_PROJECT/.ralph.json"
run_resolve "{\"workspace_cwd\":\"$UNCONFIGURED\"}"; no_config_err="$stderr"
run_resolve "{\"workspace_cwd\":\"$BADJSON\"}"; malformed_err="$stderr"
run_resolve "{\"workspace_cwd\":\"$MISSING_OWNER\"}"; missing_err="$stderr"
run_resolve "{\"workspace_cwd\":\"$NO_PROJECT\"}"; no_project_err="$stderr"
if [ "$no_config_err" != "$malformed_err" ] && [ "$no_config_err" != "$missing_err" ] && [ "$malformed_err" != "$missing_err" ] \
   && [ "$no_project_err" != "$no_config_err" ] && [ "$no_project_err" != "$malformed_err" ] && [ "$no_project_err" != "$missing_err" ]; then
  ok "four failure causes produce four distinct messages"
else
  not_ok "two or more failure causes still render identically"
fi

echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
