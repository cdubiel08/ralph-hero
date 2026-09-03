#!/usr/bin/env bash
# hero.test.sh — executable tests for the hero pane's derived seat name
# (GH-2315): the seat execs the harness under the agent name `board name
# dispatch` mints (peer plane), and a detached helper renames the
# auto-detected herdr agent to the same name and only THEN stamps the
# `address` C8 token (herd plane) — so a `board who dispatch` live row always
# carries a promptable name. Every failure path degrades to the anonymous
# status quo: a board that cannot answer, a refused rename (name taken), and
# a harness without --name all still seat the human.
#
#   bash plugin/ralph-herdr/tests/hero.test.sh   # exits 0 pass, 1 fail
#
# All herdr traffic goes through tests/fake-herdr.sh, all board traffic
# through tests/fake-board.sh, and the harness is a fake `claude` that
# records its argv — no server, no GitHub, no writes outside $TMP.
# bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../scripts"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-hero-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

BIN="$TMP/bin"
mkdir -p "$BIN"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-herdr.sh" >"$BIN/herdr"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-board.sh" >"$BIN/board"
chmod +x "$BIN/herdr" "$BIN/board"

# The fake harness: --help advertises --name (the probe hero.sh runs); any
# real invocation records its argv and exits, standing in for the exec'd
# session. FAKE_CLAUDE_HELP overrides the help text for the no---name case.
cat >"$BIN/claude" <<'EOF'
#!/bin/bash
if [ "${1-}" = "--help" ]; then
  printf '%s\n' "${FAKE_CLAUDE_HELP:-  -n, --name <name>  Set a display name for this session}"
  exit 0
fi
printf '%s\n' "$*" >>"$FAKE_CLAUDE_LOG"
exit 0
EOF
chmod +x "$BIN/claude"

export PATH="$BIN:$PATH"
export HERDR_BIN_PATH="$BIN/herdr"
export RALPH_HERDR_BOARD="$BIN/board"
export FAKE_HERDR_FIXTURES="$TMP/fixtures"
export FAKE_HERDR_LOG="$TMP/herdr.log"
export FAKE_BOARD_FIXTURES="$TMP/board-fixtures"
export FAKE_BOARD_LOG="$TMP/board.log"
export FAKE_CLAUDE_LOG="$TMP/claude.log"
mkdir -p "$FAKE_HERDR_FIXTURES" "$FAKE_BOARD_FIXTURES"
export RALPH_HERDR_LEDGER_ROOT="$TMP/ledger-root"
export RALPH_HERDR_NO_HOLD=1

REPO_DIR="$TMP/repo"
mkdir -p "$REPO_DIR"
printf '{"owner":"fake","repo":"fake","projectNumber":1}\n' >"$REPO_DIR/.ralph.json"
export RALPH_HERDR_REPO="$REPO_DIR"

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
has() {
  if printf '%s' "$2" | grep -q "$3"; then ok "$1"; else not_ok "$1 — no '$3' in: $(printf '%s' "$2" | head -5)"; fi
}
hasnt() {
  if printf '%s' "$2" | grep -q "$3"; then not_ok "$1 — found '$3'"; else ok "$1"; fi
}

# run_hero — hero.sh in the fake pane. ANTHROPIC_API_KEY is scrubbed so the
# billing guard stays out of these cases; </dev/null so a reached hold_pane
# (it never should be — RALPH_HERDR_NO_HOLD) cannot hang the suite.
run_hero() {
  (cd "$REPO_DIR" && env -u ANTHROPIC_API_KEY HERDR_PANE_ID="${PANE-wH:p1}" \
    bash "$SCRIPTS/hero.sh" </dev/null 2>&1)
}

# settle — the detached helper polls on a 2s beat; one beat plus slack is
# enough for the fake, which answers `agent get` on the first ask.
settle() { sleep 3; }

reset() {
  : >"$FAKE_HERDR_LOG"
  : >"$FAKE_BOARD_LOG"
  : >"$FAKE_CLAUDE_LOG"
  rm -f "$FAKE_BOARD_FIXTURES"/name.dispatch.rc \
    "$FAKE_HERDR_FIXTURES"/agent-rename.rc "$FAKE_HERDR_FIXTURES"/agent-rename.json \
    "$RALPH_HERDR_LEDGER_ROOT/fake/fake/hero.pane.json" \
    "$RALPH_HERDR_LEDGER_ROOT/fake/fake/dispatch-heartbeat" 2>/dev/null || true
  printf '{"repo":"fake","address":"fake/dispatch","agentName":"fake-dispatch"}\n' \
    >"$FAKE_BOARD_FIXTURES/name.dispatch.json"
  unset FAKE_CLAUDE_HELP PANE 2>/dev/null || true
}

# ── 1. happy path: one derived name on both planes ──────────────────────────
reset
out=$(run_hero)
rc=$?
[ "$rc" = 0 ] && ok "hero exits 0" || not_ok "hero exits 0 — rc $rc: $out"
has "the harness starts under the derived peer name" "$(cat "$FAKE_CLAUDE_LOG")" "^--name fake-dispatch /ralph:hero$"
settle
herdr_log=$(cat "$FAKE_HERDR_LOG")
has "the helper renames the detected agent to the same name" "$herdr_log" "agent rename wH:p1 fake-dispatch"
has "the address token lands after the rename" "$herdr_log" "pane report-metadata wH:p1 .*--token address=fake/dispatch"
rename_line=$(grep -n "agent rename" "$FAKE_HERDR_LOG" | head -1 | cut -d: -f1)
token_line=$(grep -n "report-metadata" "$FAKE_HERDR_LOG" | head -1 | cut -d: -f1)
if [ -n "$rename_line" ] && [ -n "$token_line" ] && [ "$rename_line" -lt "$token_line" ]; then
  ok "rename precedes the token — a stamped dispatch row always has a promptable name"
else
  not_ok "rename precedes the token (rename@${rename_line:-none}, token@${token_line:-none})"
fi

# ── 2. board cannot answer: anonymous status quo, no herd-plane writes ──────
reset
printf '1\n' >"$FAKE_BOARD_FIXTURES/name.dispatch.rc"
out=$(run_hero)
rc=$?
[ "$rc" = 0 ] && ok "an unanswerable board still seats the human" || not_ok "an unanswerable board still seats the human — rc $rc: $out"
has "the harness starts bare" "$(cat "$FAKE_CLAUDE_LOG")" "^/ralph:hero$"
settle
hasnt "no rename is attempted without a mint" "$(cat "$FAKE_HERDR_LOG")" "agent rename"
hasnt "no token is stamped without a mint" "$(cat "$FAKE_HERDR_LOG")" "report-metadata"

# ── 3. rename refused (name taken — a second hero): token withheld too ──────
reset
printf '{"error":{"code":"agent_name_taken","message":"taken"}}\n' >"$FAKE_HERDR_FIXTURES/agent-rename.json"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-rename.rc"
out=$(run_hero)
[ "$?" = 0 ] && ok "a refused rename still seats the human" || not_ok "a refused rename still seats the human: $out"
has "the peer name is independent of the herd plane" "$(cat "$FAKE_CLAUDE_LOG")" "^--name fake-dispatch /ralph:hero$"
settle
hasnt "a refused rename withholds the token — no stamped row without a name" "$(cat "$FAKE_HERDR_LOG")" "report-metadata"

# ── 4. harness without --name: herd plane still names the seat ──────────────
reset
export FAKE_CLAUDE_HELP="no such flag here"
out=$(run_hero)
[ "$?" = 0 ] && ok "an older harness still seats the human" || not_ok "an older harness still seats the human: $out"
has "the harness starts bare when --name is absent" "$(cat "$FAKE_CLAUDE_LOG")" "^/ralph:hero$"
hasnt "the unsupported flag is never passed" "$(cat "$FAKE_CLAUDE_LOG")" "name fake-dispatch"
settle
has "the herd-plane rename still runs" "$(cat "$FAKE_HERDR_LOG")" "agent rename wH:p1 fake-dispatch"

# ── 5. no pane id: peer name only, no herd-plane calls ──────────────────────
reset
PANE=""
out=$(run_hero)
[ "$?" = 0 ] && ok "no pane id still seats the human" || not_ok "no pane id still seats the human: $out"
has "the peer name still rides the exec" "$(cat "$FAKE_CLAUDE_LOG")" "^--name fake-dispatch /ralph:hero$"
settle
hasnt "no rename without a pane" "$(cat "$FAKE_HERDR_LOG")" "agent rename"
unset PANE

# ── per-lane model (GH-2350): the seat's knob rides the exec ─────────────────
reset
printf '{"owner":"fake","repo":"fake","projectNumber":1,"models":{"dispatch":"claude-opus-5"}}\n' >"$REPO_DIR/.ralph.json"
out=$(run_hero)
rc=$?
[ "$rc" = 0 ] && ok "dispatch model: hero exits 0" || not_ok "dispatch model: hero exits 0 — rc $rc: $out"
has "dispatch model: --model rides the exec beside --name" "$(cat "$FAKE_CLAUDE_LOG")" "^--name fake-dispatch --model claude-opus-5 /ralph:hero$"
settle
reset
printf '{"owner":"fake","repo":"fake","projectNumber":1,"models":{"dispatch":"claude-opus-5"}}\n' >"$REPO_DIR/.ralph.json"
out=$(FAKE_CLAUDE_HELP="  -h, --help" run_hero)
has "dispatch model: --model survives a harness without --name" "$(cat "$FAKE_CLAUDE_LOG")" "^--model claude-opus-5 /ralph:hero$"
settle
reset
printf '{"owner":"fake","repo":"fake","projectNumber":1,"models":{"dispatch":"claude-opus-5"}}\n' >"$REPO_DIR/.ralph.json"
out=$(RALPH_MODEL_DISPATCH=fable run_hero)
has "dispatch model: RALPH_MODEL_DISPATCH outranks .ralph.json" "$(cat "$FAKE_CLAUDE_LOG")" "^--name fake-dispatch --model fable /ralph:hero$"
settle
reset
printf '{"owner":"fake","repo":"fake","projectNumber":1}\n' >"$REPO_DIR/.ralph.json"
out=$(RALPH_MODEL_DISPATCH='bad value' run_hero)
rc=$?
[ "$rc" != 0 ] && ok "dispatch bad model: an unridable model refuses the seat" || not_ok "dispatch bad model: expected a refusal, got rc 0"
has "dispatch bad model: the refusal names the source" "$out" "RALPH_MODEL_DISPATCH=bad"
hasnt "dispatch bad model: the harness is never exec'd" "$(cat "$FAKE_CLAUDE_LOG")" "ralph:hero"
settle

echo
echo "hero.test.sh: $pass passed, $fail failed ($n total)"
[ "$fail" = 0 ]
