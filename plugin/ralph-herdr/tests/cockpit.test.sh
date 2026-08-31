#!/usr/bin/env bash
# cockpit.test.sh — executable tests for the cockpit's cross-cutting shell
# surface (TAP-ish, matching watcher.test.sh / fleet.test.sh structure).
#
#   bash plugin/ralph-herdr/tests/cockpit.test.sh   # exits 0 on pass, 1 on fail
#
# Covers: cockpit-launch.sh's degradation ladder in a hermetic temp tree with
# a CONTROLLED PATH (binary present → rung 1 exec'd, argv recorded by a fake
# executable; binary absent + fzf present → the rung-3 line + cockpit-fzf
# chosen; both absent → dashboard.sh, rung 4 — fzf "removal" is pure PATH
# control, the real fzf is never consulted), and cockpit-fzf.sh's pure
# functions SOURCED directly (the fleet.test.sh pattern — the real fzf UI is
# never driven): read_board's fail-closed WHOLE-BOARD read (one process for
# all three columns, GH-1786 — rc-nonzero AND 0-exit-with-garbage-stdout both
# refuse to render an empty board),
# cockpit_cards' three-column flatten in the locked order with the agent
# glyph join by name parse (grammar-B w<N>-* and legacy gh-N, exact-issue
# boundaries — w421 never decorates #42), run_verb's reply
# (delivered-checkmark ONLY on herdr rc 0; failure preserves the typed text),
# answer (COMMENT-FIRST: `board answer N -m` lands before any agent prompt on
# one combined invocation log; a failed answer never nudges), observe, and
# diff (open-PR preference from `board get --json`), plus the __preview
# subshell's two sources. All herdr traffic goes through tests/fake-herdr.sh,
# all board traffic through tests/fake-board.sh, gh is a PATH shim — no
# server, no GitHub, no real fzf, no writes outside $TMP. bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../scripts"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-cockpit-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

# ── PATH shims: herdr, board, gh ─────────────────────────────────────────────
# Wrappers (not symlinks) so the repo files' exec bits are never load-bearing.
BIN="$TMP/bin"
mkdir -p "$BIN"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-herdr.sh" >"$BIN/herdr"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-board.sh" >"$BIN/board"
# gh: logs into the board log (prefixed, to stay distinguishable from board
# verbs) and answers the two surfaces run_verb/diff and __preview read.
cat >"$BIN/gh" <<'EOF'
#!/bin/bash
if [ -n "${FAKE_BOARD_LOG:-}" ]; then printf 'gh %s\n' "$*" >>"$FAKE_BOARD_LOG"; fi
case "${1-} ${2-}" in
  "pr diff") printf 'DIFF BODY for PR %s\n' "${3-}" ;;
  "issue view") printf 'comment line one\ncomment line two\n' ;;
esac
exit 0
EOF
chmod +x "$BIN/herdr" "$BIN/board" "$BIN/gh"
export PATH="$BIN:$PATH"
export HERDR_BIN_PATH="$BIN/herdr"
export FAKE_HERDR_FIXTURES="$TMP/fixtures"
export FAKE_HERDR_LOG="$TMP/herdr.log"
export FAKE_BOARD_FIXTURES="$TMP/board-fixtures"
export FAKE_BOARD_LOG="$TMP/board.log"
mkdir -p "$FAKE_HERDR_FIXTURES" "$FAKE_BOARD_FIXTURES"
: >"$FAKE_HERDR_LOG"
: >"$FAKE_BOARD_LOG"
# Guard: no subprocess may ever fall back to the real ~/.ralph.
export RALPH_HERDR_LEDGER_ROOT="$TMP/guard-root"
unset ANTHROPIC_API_KEY 2>/dev/null || true
# This suite may itself be RUN from inside a herdr pane, and the launcher's
# pane stamp reads HERDR_PANE_ID. Leaked in, it makes the ladder rows record
# the RUNNER's pane as the cockpit and makes the no-pane-id row unexpressible.
unset HERDR_PANE_ID 2>/dev/null || true

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}
line_has() {
  case "$2" in *"$3"*) ok "$1" ;; *) not_ok "$1 — no '$3' in '$2'" ;; esac
}
line_lacks() {
  case "$2" in *"$3"*) not_ok "$1 — unexpected '$3' in '$2'" ;; *) ok "$1" ;; esac
}
# log_count LOG FIXED_STRING — matching lines in an invocation log (fixed
# match: asserted lines carry regex metacharacters like [>] and --flags)
log_count() { grep -Fc -- "$2" "$1" || true; }
# ordered DESC FILE FIRST SECOND — FIRST's first match line precedes SECOND's
# (fixed strings; the comment-first assertion lives on this)
ordered() {
  local a b
  a=$(grep -Fn -- "$3" "$2" | head -1 | cut -d: -f1)
  b=$(grep -Fn -- "$4" "$2" | head -1 | cut -d: -f1)
  if [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; then
    ok "$1"
  else
    not_ok "$1 — '$3' at line '${a:-absent}', '$4' at line '${b:-absent}'"
  fi
}
clear_logs() { : >"$FAKE_HERDR_LOG"; : >"$FAKE_BOARD_LOG"; }

# ═══ 1. cockpit-launch.sh — the degradation ladder, hermetic ═════════════════
# A private tree (so the REPO's built binary can never leak into a rung-1
# verdict) + a private PATH (so the HOST's fzf can never leak into rung 3).
TREE="$TMP/tree"
mkdir -p "$TREE/scripts" "$TREE/cockpit"
cp "$SCRIPTS/cockpit-launch.sh" "$TREE/scripts/cockpit-launch.sh"
# The launcher sources these to stamp its pane (GH-2074). Neither has a
# top-level side effect, and with HERDR_PANE_ID unset the stamp returns before
# it touches the filesystem — so the ladder rows below stay hermetic.
cp "$SCRIPTS/ledger.sh" "$SCRIPTS/cockpit-pane.sh" "$TREE/scripts/"
# Rung stubs: record that they ran, never open a UI.
printf '#!/bin/bash\necho "FZF-RUNG ran"\n' >"$TREE/scripts/cockpit-fzf.sh"
printf '#!/bin/bash\necho "DASH-RUNG ran"\n' >"$TREE/scripts/dashboard.sh"
# The fake built TUI: records its argv (the exec contract) and exits.
cat >"$TREE/cockpit/ralph-cockpit" <<EOF
#!/bin/bash
printf 'argv0=%s nargs=%s args=%s\n' "\$0" "\$#" "\$*" >>"$TMP/cockpit-argv.log"
echo "TUI ran"
EOF
chmod +x "$TREE/cockpit/ralph-cockpit"
: >"$TMP/cockpit-argv.log"

# The controlled PATH: exactly what the launcher needs (bash for the exec'd
# rungs, dirname for SCRIPT_DIR) — and NOT fzf. A second dir carries only a
# stub fzf, prepended when a row wants "fzf present".
REAL_BASH=$(command -v bash)
REAL_DIRNAME=$(command -v dirname)
BASEBIN="$TMP/basebin"
FZFBIN="$TMP/fzfbin"
mkdir -p "$BASEBIN" "$FZFBIN"
printf '#!/bin/bash\nexec "%s" "$@"\n' "$REAL_BASH" >"$BASEBIN/bash"
printf '#!/bin/bash\nexec "%s" "$@"\n' "$REAL_DIRNAME" >"$BASEBIN/dirname"
printf '#!/bin/bash\necho "the launcher only probes fzf, never runs it" >&2\nexit 2\n' >"$FZFBIN/fzf"
chmod +x "$BASEBIN/bash" "$BASEBIN/dirname" "$FZFBIN/fzf"

run_launch() { # run_launch PATH_VALUE
  RC=0
  OUT=$(PATH="$1" "$REAL_BASH" "$TREE/scripts/cockpit-launch.sh" 2>&1) || RC=$?
}

# ── rung 1: built binary present → exec'd, argv recorded ─────────────────────
run_launch "$FZFBIN:$BASEBIN"
is "rung 1: exits 0" "0" "$RC"
line_has "rung 1: the rung line names rung 1" "$OUT" "cockpit: rung 1"
line_has "rung 1: the rung line documents rung 2 (same binary, poll-only)" "$OUT" "rung 2"
line_has "rung 1: the built TUI actually ran" "$OUT" "TUI ran"
line_lacks "rung 1: no lower rung ran" "$OUT" "RUNG ran"
# argv0 arrives unnormalized ($SCRIPT_DIR/../cockpit/…) — assert its tail.
line_has "rung 1: exec'd with NO argv (the exec contract)" \
  "$(cat "$TMP/cockpit-argv.log")" "/cockpit/ralph-cockpit nargs=0 args="
is "rung 1: exactly one rung line" "1" \
  "$(printf '%s\n' "$OUT" | grep -c '^cockpit: rung')"

# ── rung 3: binary absent + fzf present → cockpit-fzf chosen ─────────────────
rm -f "$TREE/cockpit/ralph-cockpit"
run_launch "$FZFBIN:$BASEBIN"
is "rung 3: exits 0" "0" "$RC"
line_has "rung 3: the rung line names rung 3" "$OUT" "cockpit: rung 3"
line_has "rung 3: the rung line names the build path back to rung 1" "$OUT" "build-cockpit.sh"
line_has "rung 3: cockpit-fzf.sh ran" "$OUT" "FZF-RUNG ran"
line_lacks "rung 3: the dashboard did not" "$OUT" "DASH-RUNG ran"
is "rung 3: exactly one rung line" "1" \
  "$(printf '%s\n' "$OUT" | grep -c '^cockpit: rung')"

# A present-but-not-executable binary is "not built" — still rung 3.
printf 'not a binary\n' >"$TREE/cockpit/ralph-cockpit"
run_launch "$FZFBIN:$BASEBIN"
line_has "rung 3: a non-executable binary never rungs 1" "$OUT" "cockpit: rung 3"
rm -f "$TREE/cockpit/ralph-cockpit"

# ── rung 4: binary absent + fzf absent (PATH control) → dashboard ────────────
run_launch "$BASEBIN"
is "rung 4: exits 0" "0" "$RC"
line_has "rung 4: the rung line names rung 4" "$OUT" "cockpit: rung 4"
line_has "rung 4: dashboard.sh ran" "$OUT" "DASH-RUNG ran"
line_lacks "rung 4: cockpit-fzf did not" "$OUT" "FZF-RUNG ran"
is "rung 4: exactly one rung line" "1" \
  "$(printf '%s\n' "$OUT" | grep -c '^cockpit: rung')"

# ── build wrapper: a failed REbuild removes the stale binary (ladder honesty) ─
# `go build` leaves a previous output untouched on failure; without the rm the
# launcher would exec a STALE TUI as rung 1 while the build log claims the
# install has no TUI. Hermetic: a fake `go` that fails `build`, controlled PATH.
cp "$SCRIPTS/build-cockpit.sh" "$TREE/scripts/build-cockpit.sh"
printf '#!/bin/bash\necho "stale TUI from the previous install"\n' >"$TREE/cockpit/ralph-cockpit"
chmod +x "$TREE/cockpit/ralph-cockpit"
GOBIN="$TMP/gobin"
mkdir -p "$GOBIN"
printf '#!/bin/bash\nif [ "${1-}" = build ]; then echo "compile error: it broke" >&2; exit 1; fi\necho "go version go0.0-fake fake/fake"\n' >"$GOBIN/go"
REAL_RM=$(command -v rm)
printf '#!/bin/bash\nexec "%s" "$@"\n' "$REAL_RM" >"$BASEBIN/rm"
chmod +x "$GOBIN/go" "$BASEBIN/rm"
RC=0
OUT=$(PATH="$GOBIN:$BASEBIN" "$REAL_BASH" "$TREE/scripts/build-cockpit.sh" 2>&1) || RC=$?
is "build wrapper: a failed build still exits 0 (the install never blocks on the TUI)" "0" "$RC"
line_has "build wrapper: the failure is said, loudly" "$OUT" "go build FAILED"
line_has "build wrapper: the removal is said (no silent rungs)" "$OUT" "removed"
if [ -e "$TREE/cockpit/ralph-cockpit" ]; then
  not_ok "build wrapper: the stale binary must be removed — the launcher would run it as rung 1"
else
  ok "build wrapper: the stale binary is removed — the launcher falls to rung 3/4 honestly"
fi

# And the launcher indeed falls through after the failed rebuild.
run_launch "$FZFBIN:$BASEBIN"
line_has "build wrapper: post-failure launch takes rung 3, not a stale rung 1" "$OUT" "cockpit: rung 3"

# ═══ 2. cockpit-fzf.sh sourced — the pure functions, no fzf UI ═══════════════
# The fleet.test.sh pattern: source for read_column / decorate / cockpit_cards
# / run_verb; the sourced-mode guard must stop BEFORE the fzf requirement and
# the UI loop (this test host may not have fzf at all — CI doesn't).
export RALPH_HERDR_REPO="$TMP"
export RALPH_HERDR_BOARD="$BIN/board"
# shellcheck source=../scripts/cockpit-fzf.sh
. "$SCRIPTS/cockpit-fzf.sh"
set +e
set +o pipefail

is "sourcing defines the pure functions, runs no UI" "4" \
  "$(type read_board decorate cockpit_cards run_verb 2>/dev/null | grep -c 'is a function')"

# ── read_board: ONE whole-board read in, TSV rows out, FAIL-CLOSED ───────────
# GH-1786: one `board list --json` answers all three columns; the partition is
# local. The payload is deliberately NOT grouped by state — the locked column
# order is the reader's, not the board's.
cat >"$FAKE_BOARD_FIXTURES/list.json" <<'EOF'
{"items":[
  {"number":42,"title":"Fix the flux","state":"In Progress"},
  {"number":13,"title":"Which way?","state":"Human Needed"},
  {"number":99,"title":"Not a cockpit column","state":"Backlog"},
  {"number":7,"title":"Review me","state":"In Review"},
  {"number":4,"title":"Small one","state":"In Progress"}
],"foreign":[]}
EOF
clear_logs
out=$(read_board 2>/dev/null)
rc=$?
is "read_board: rc 0 on a parseable read" "0" "$rc"
is "read_board: the three columns in the LOCKED order, board order within each" \
  "In Progress	#42	Fix the flux
In Progress	#4	Small one
In Review	#7	Review me
Human Needed	#13	Which way?" "$out"
is "read_board: exactly ONE board read for all three columns (GH-1786)" "1" \
  "$(grep -c '^list ' "$FAKE_BOARD_LOG")"
is "read_board: the read carries no --state — the whole board, once" "1" \
  "$(log_count "$FAKE_BOARD_LOG" 'list --json')"

printf '{"items":[],"foreign":[]}\n' >"$FAKE_BOARD_FIXTURES/list.json"
out=$(read_board 2>/dev/null)
rc=$?
is "read_board: an EMPTY board is rc 0 + no rows (a real fact)" "0 " "$rc $out"

printf '1\n' >"$FAKE_BOARD_FIXTURES/list.rc"
out=$(read_board 2>/dev/null)
rc=$?
err=$(read_board 2>&1 >/dev/null)
is "read_board: a failed board read is rc 1 — never an empty board" "1 " "$rc $out"
line_has "read_board: the failure is said on stderr" "$err" 'board list --json failed'
rm -f "$FAKE_BOARD_FIXTURES/list.rc"

# Fail-closed on GARBAGE: rc 0 + unparseable stdout is a failed read too
# (the ralph-answer.sh precedent) — an empty board and a failed query are
# different facts.
printf 'npm WARN this is not json\n' >"$FAKE_BOARD_FIXTURES/list.json"
out=$(read_board 2>/dev/null)
rc=$?
err=$(read_board 2>&1 >/dev/null)
is "read_board: 0-exit garbage stdout is rc 1 (no false empty)" "1 " "$rc $out"
line_has "read_board: the refusal names the reason" "$err" "unparseable JSON"

# Fail-closed on SCHEMA-INVALID JSON: parseable, but carrying no items array.
# The Go rung had this hole (CodeRabbit on #1820); this rung fails closed only
# because iterating a null errors in jq. Pinned so a later `.items[]?` — which
# reads like a harmless robustness tweak — cannot silently turn a malformed
# payload back into a calm empty board.
for bad in '{}' 'null' '{"items":null}'; do
  printf '%s\n' "$bad" >"$FAKE_BOARD_FIXTURES/list.json"
  out=$(read_board 2>/dev/null)
  rc=$?
  is "read_board: $bad is a FAILED read, never an empty board" "1 " "$rc $out"
done
rm -f "$FAKE_BOARD_FIXTURES/list.json"

# ── decorate: the glyph join by NAME PARSE, board rows stay authoritative ────
OVERLAY="$(printf 'w42-fix-the-flux\tworking\ngh-7\tblocked\nw9-quiet\tidle\nw13-weird\tmystery\nw421-boundary\tworking')"
CARDS_IN="$(printf 'In Progress\t#42\tFix the flux\nIn Review\t#7\tReview me\nIn Review\t#9\tQuiet one\nHuman Needed\t#13\tWhich way?\nIn Progress\t#4\tSmall one')"
out=$(decorate "$OVERLAY" <<<"$CARDS_IN")
line_has "decorate: working joins as [> agent] (grammar-B w<N>-*)" "$out" \
  "$(printf 'In Progress\t#42\tFix the flux [> w42-fix-the-flux]\tw42-fix-the-flux')"
line_has "decorate: blocked joins as [! agent] (legacy gh-N)" "$out" \
  "$(printf 'In Review\t#7\tReview me [! gh-7]\tgh-7')"
line_has "decorate: idle joins as [. agent]" "$out" \
  "$(printf 'In Review\t#9\tQuiet one [. w9-quiet]\tw9-quiet')"
line_has "decorate: an unknown status joins as [? agent]" "$out" \
  "$(printf 'Human Needed\t#13\tWhich way? [? w13-weird]\tw13-weird')"
line_has "decorate: no agent = bare row, EMPTY hidden 4th field" "$out" \
  "$(printf 'In Progress\t#4\tSmall one\t')"
line_lacks "decorate: w421-* never decorates #4 (issue-number boundary)" "$out" "w421-boundary"
out=$(decorate "" <<<"$CARDS_IN")
is "decorate: an empty overlay (herdr down) costs glyphs, never rows" "5" \
  "$(printf '%s\n' "$out" | grep -c .)"

# ── cockpit_cards: the three-column flatten, locked order, fail-closed ───────
cat >"$FAKE_BOARD_FIXTURES/list.json" <<'EOF'
{"items":[
  {"number":42,"title":"Fix the flux","state":"In Progress"},
  {"number":7,"title":"Review me","state":"In Review"},
  {"number":13,"title":"Which way?","state":"Human Needed"}
],"foreign":[]}
EOF
clear_logs
out=$(cockpit_cards "$OVERLAY" 2>/dev/null)
rc=$?
is "flatten: rc 0, one row per card across the three columns" "0 3" \
  "$rc $(printf '%s\n' "$out" | grep -c .)"
is "flatten: columns land in the locked order (In Progress / In Review / Human Needed)" \
  "In Progress In Review Human Needed" \
  "$(printf '%s\n' "$out" | cut -f1 | tr '\n' ' ' | sed 's/ $//')"
line_has "flatten: the glyph overlay rode along" "$out" "[> w42-fix-the-flux]"
is "flatten: ONE board read for the whole render, not one per column (GH-1786)" "1" \
  "$(grep -c '^list ' "$FAKE_BOARD_LOG")"
is "flatten: no --state ever leaves the cockpit — the board is walked once" "0" \
  "$(grep -c '^list --state ' "$FAKE_BOARD_LOG")"

# An empty middle column thins nothing else.
cat >"$FAKE_BOARD_FIXTURES/list.json" <<'EOF'
{"items":[
  {"number":42,"title":"Fix the flux","state":"In Progress"},
  {"number":13,"title":"Which way?","state":"Human Needed"}
],"foreign":[]}
EOF
out=$(cockpit_cards "" 2>/dev/null)
is "flatten: an empty middle column skips itself, keeps its neighbors" "#42 #13" \
  "$(printf '%s\n' "$out" | cut -f2 | tr '\n' ' ' | sed 's/ $//')"

# Garbage aborts the WHOLE render — never a silently thinner board.
printf 'ExperimentalWarning: not json\n' >"$FAKE_BOARD_FIXTURES/list.json"
out=$(cockpit_cards "" 2>/dev/null)
rc=$?
is "flatten: an unparseable read fails the whole render (rc 1, no rows)" "1 " "$rc $out"
rm -f "$FAKE_BOARD_FIXTURES/list.json"

# ── run_verb reply: delivered-checkmark ONLY on herdr rc 0 ───────────────────
clear_logs
out=$(printf 'take path A\n' | run_verb reply 42 w42-fix-the-flux 2>&1)
line_has "reply: herdr rc 0 → the delivered checkmark" "$out" "✓ delivered to w42-fix-the-flux"
is "reply: the text went through agent prompt verbatim" "1" \
  "$(log_count "$FAKE_HERDR_LOG" 'agent prompt w42-fix-the-flux take path A')"
is "reply: --wait rode along — rc 0 means CONFIRMED, a bare prompt only submits" "1" \
  "$(log_count "$FAKE_HERDR_LOG" 'take path A --wait --timeout 15000')"

printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-prompt.rc"
clear_logs
out=$(printf 'do not lose me\n' | run_verb reply 42 w42-fix-the-flux 2>&1)
line_lacks "reply: herdr rc 1 → NO checkmark, never an optimistic ack" "$out" "✓ delivered"
line_has "reply: the failure is said" "$out" "NOT delivered"
line_has "reply: the typed text is preserved on screen" "$out" "do not lose me"
line_has "reply: the manual retry is printed" "$out" "agent prompt w42-fix-the-flux"

# GH-1868: the two nonzero answers are not the same fact. A refusal means the
# prompt did NOT land; herdr's own wait expiry means it may have, so the
# advice is the pane rather than the retry.
printf '{"error":{"code":"agent_not_found","message":"no such agent"}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-prompt.json"
clear_logs
out=$(printf 'refused text\n' | run_verb reply 42 w42-fix-the-flux 2>&1)
line_has "reply: a refusal names its code" "$out" "herdr refused (agent_not_found)"
line_lacks "reply: a refusal is not reported as unconfirmed" "$out" "not confirmed"

printf '{"error":{"code":"timeout","message":"timed out waiting for agent status"}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-prompt.json"
clear_logs
out=$(printf 'unconfirmed text\n' | run_verb reply 42 w42-fix-the-flux 2>&1)
line_has "reply: a wait expiry says sent-but-unconfirmed" "$out" \
  "sent but not confirmed within 15000ms"
line_lacks "reply: a wait expiry is not reported as a refusal" "$out" "refused"
line_lacks "reply: still no checkmark on an unconfirmed send" "$out" "✓ delivered"
rm -f "$FAKE_HERDR_FIXTURES/agent-prompt.rc" "$FAKE_HERDR_FIXTURES/agent-prompt.json"

clear_logs
out=$(printf '   \n' | run_verb reply 42 w42-fix-the-flux 2>&1)
line_has "reply: whitespace-only input aborts" "$out" "empty — nothing sent"
is "reply: an aborted reply never reaches herdr" "0" \
  "$(log_count "$FAKE_HERDR_LOG" 'agent prompt')"
out=$(run_verb reply 42 "" </dev/null 2>&1)
line_has "reply: no live agent is said, not attempted" "$out" "no live session for #42"

# ── run_verb answer: COMMENT-FIRST on one combined invocation log ────────────
COMBINED="$TMP/combined.log"
export FAKE_BOARD_LOG="$COMBINED" FAKE_HERDR_LOG="$COMBINED"
: >"$COMBINED"
out=$(printf 'ship variant B\n' | run_verb answer 55 w55-agent 2>&1)
is "answer: the durable half went through board answer -m" "1" \
  "$(log_count "$COMBINED" 'answer 55 -m ship variant B')"
ordered "answer: COMMENT-FIRST — board answer lands BEFORE the agent nudge" \
  "$COMBINED" "answer 55 -m ship variant B" "agent prompt w55-agent"
line_has "answer: the nudge names the issue to re-read" "$out" "✓ answered and nudged w55-agent"
is "answer: the nudge waits for confirmation (--wait, ralph-answer.sh parity) and names the claim" "1" \
  "$(log_count "$COMBINED" 'board claim 55 (resumes it under your claim) --wait --timeout 15000')"

# A failed board answer must NEVER nudge — the agent would resume against an
# answer that is not on the record.
printf '1\n' >"$FAKE_BOARD_FIXTURES/answer.rc"
: >"$COMBINED"
out=$(printf 'lost answer\n' | run_verb answer 55 w55-agent 2>&1)
line_has "answer: a failed board answer is said" "$out" "board answer failed"
line_has "answer: the recovery warns against a blind re-answer" "$out" "re-answering would duplicate it"
is "answer: no nudge after a failed answer" "0" "$(log_count "$COMBINED" 'agent prompt')"
line_lacks "answer: no checkmark either" "$out" "✓"
rm -f "$FAKE_BOARD_FIXTURES/answer.rc"

# The nudge is the DECORATIVE half: its failure never un-answers.
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-prompt.rc"
: >"$COMBINED"
out=$(printf 'answered anyway\n' | run_verb answer 55 w55-agent 2>&1)
is "answer: the comment still posted when the nudge fails" "1" \
  "$(log_count "$COMBINED" 'answer 55 -m answered anyway')"
line_has "answer: the failed nudge is honest + prints the manual command" "$out" \
  "nudge was NOT confirmed delivered"
rm -f "$FAKE_HERDR_FIXTURES/agent-prompt.rc"

: >"$COMBINED"
out=$(printf 'no session here\n' | run_verb answer 56 "" 2>&1)
is "answer: no live agent → comment-only, zero herdr traffic" "1 0" \
  "$(log_count "$COMBINED" 'answer 56 -m no session here') $(log_count "$COMBINED" 'agent prompt')"
line_has "answer: the no-session path says the item stays Human Needed pending a claim" "$out" "stays Human Needed"
out=$(printf ' \n' | run_verb answer 56 "" 2>&1)
line_has "answer: whitespace-only input aborts before any board write" "$out" "empty — nothing posted"
export FAKE_BOARD_LOG="$TMP/board.log" FAKE_HERDR_LOG="$TMP/herdr.log"

# ── run_verb observe + diff ──────────────────────────────────────────────────
clear_logs
out=$(run_verb observe 42 w42-fix-the-flux </dev/null 2>&1)
is "observe: focuses the live agent's pane" "1" \
  "$(log_count "$FAKE_HERDR_LOG" 'agent focus w42-fix-the-flux')"
out=$(run_verb observe 42 "" </dev/null 2>&1)
line_has "observe: no live agent points at the spawn verb" "$out" "the spawn verb starts one"

cat >"$FAKE_BOARD_FIXTURES/get.60.json" <<'EOF'
{"number":60,"prs":[{"number":9,"state":"MERGED"},{"number":12,"state":"OPEN"}]}
EOF
clear_logs
out=$(run_verb diff 60 "" </dev/null 2>&1)
is "diff: PR discovery via board get --json, OPEN PR preferred" "1" \
  "$(log_count "$FAKE_BOARD_LOG" 'gh pr diff 12 --color always')"
line_has "diff: the diff body reached the screen" "$out" "DIFF BODY for PR 12"
printf '{"number":61,"prs":[]}\n' >"$FAKE_BOARD_FIXTURES/get.61.json"
out=$(run_verb diff 61 "" </dev/null 2>&1)
line_has "diff: no linked PR is said, not invented" "$out" "no PR linked on #61"
rm -f "$FAKE_BOARD_FIXTURES/get.60.json" "$FAKE_BOARD_FIXTURES/get.61.json"

# ── run_verb fork: the ISSUE row has no single fork source (GH-1957) ─────────
# Only the refusal paths are driven here: they are the whole judgment this
# rung adds, and none of them reaches fork.sh (which needs a live server).
_real_agents_json=$(declare -f ralph_agents_json)
ralph_agents_json() { printf '%s\n' "$FAKE_HERD"; }

FAKE_HERD='{"name":"w42-fix-the-flux","status":"working","pane":"pA"}'
out=$(run_verb fork 42 "" </dev/null 2>&1)
line_has "fork: no live session points at the spawn verb" "$out" "nothing to fork"

FAKE_HERD='{"name":"w42-fix-the-flux","status":"working","pane":"pA"}
{"name":"r42-review","status":"working","pane":"pB"}'
out=$(run_verb fork 42 w42-fix-the-flux </dev/null 2>&1)
line_has "fork: two live sessions on one issue is a named refusal" "$out" "no single fork source"
line_has "fork: the refusal names the second session too" "$out" "r42-review"
line_has "fork: the refusal points at the pane actions" "$out" "fork-right"

FAKE_HERD='{"name":"w42-fix-the-flux","status":"working"}'
out=$(run_verb fork 42 w42-fix-the-flux </dev/null 2>&1)
line_has "fork: an agent herdr reports no pane for is refused, not guessed" "$out" "no pane for w42-fix-the-flux"

ralph_agents_json() { return 3; }
out=$(run_verb fork 42 w42-fix-the-flux </dev/null 2>&1)
line_has "fork: an unreadable herd refuses rather than forking blind" "$out" "cannot read the herd"
eval "$_real_agents_json"

# ═══ 3. __preview — executed subshell, agent tail else comment tail ══════════
printf 'pane tail line A\npane tail line B\n' >"$FAKE_HERDR_FIXTURES/agent-read.txt"
clear_logs
out=$(bash "$SCRIPTS/cockpit-fzf.sh" __preview "$(printf 'In Progress\t#42\tFix the flux [> w42-x]\tw42-x')" 2>&1)
rc=$?
is "preview: exits 0" "0" "$rc"
line_has "preview: a live agent previews its pane tail" "$out" "pane tail line B"
is "preview: the tail came from agent read" "1" \
  "$(log_count "$FAKE_HERDR_LOG" 'agent read w42-x --source recent-unwrapped')"
clear_logs
out=$(bash "$SCRIPTS/cockpit-fzf.sh" __preview "$(printf 'In Review\t#7\tReview me\t')" 2>&1)
line_has "preview: no agent falls back to the issue's comment tail" "$out" "comment line two"
is "preview: the fallback read went through gh issue view" "1" \
  "$(log_count "$FAKE_BOARD_LOG" 'gh issue view 7 --comments')"
is "preview: no agent means no herdr traffic" "0" "$(log_count "$FAKE_HERDR_LOG" 'agent read')"

# ═══ 4. focus-or-open — cockpit-open.sh + the launcher's pane stamp ══════════
# GH-2074: invoking the cockpit action twice used to stack two cockpits, because
# the manifest's inline `plugin pane open` was unconditional. The action now
# runs cockpit-open.sh in the action process. Every row here is hermetic: the
# record file is redirected with RALPH_HERDR_COCKPIT_PANE_FILE, the snapshot
# comes from fake-herdr, and the "live" pid is a real sleep this test owns.
PANEREC="$TMP/cockpit.pane.json"
export RALPH_HERDR_COCKPIT_PANE_FILE="$PANEREC"

# A snapshot that contains pane wCK:p9 — the fixture the record will name.
cat >"$FAKE_HERDR_FIXTURES/api-snapshot.json" <<'EOF'
{"snapshot":{"version":1,"protocol":19,"workspaces":[],"tabs":[],
 "panes":[{"pane_id":"wCK:p9","workspace_id":"wCK","tab_id":"wCK:t1",
           "terminal_id":"term_ck","focused":false,"agent_status":"unknown","revision":1}],
 "layouts":[],"agents":[]}}
EOF

# A real live pid this test owns, and a pid that is certainly dead.
sleep 300 & LIVE_PID=$!
DEAD_PID=$!
( sleep 0 ) & DEAD_PID=$!; wait "$DEAD_PID" 2>/dev/null || true

run_open() { RC=0; OUT=$(bash "$SCRIPTS/cockpit-open.sh" "$TMP" 2>&1) || RC=$?; }
run_open_no_focus() { RC=0; OUT=$(bash "$SCRIPTS/cockpit-open.sh" --no-focus "$TMP" 2>&1) || RC=$?; }
run_open_beside_focused() { RC=0; OUT=$(bash "$SCRIPTS/cockpit-open.sh" --no-focus --beside-focused "$TMP" 2>&1) || RC=$?; }

# ── no record at all → open (today's behavior, unchanged) ────────────────────
rm -f "$PANEREC"; clear_logs
run_open
is "open: no record exits 0" "0" "$RC"
line_has "open: says why it opened" "$OUT" "no live cockpit"
is "open: opened a cockpit pane" "1" \
  "$(log_count "$FAKE_HERDR_LOG" 'plugin pane open --plugin ralph-herdr --entrypoint cockpit')"
is "open: kept the split-right placement the action had" "1" \
  "$(log_count "$FAKE_HERDR_LOG" '--placement split --direction right')"
is "open: focused nothing" "0" "$(log_count "$FAKE_HERDR_LOG" 'plugin pane focus')"
is "open: no record means no snapshot was even read" "0" \
  "$(log_count "$FAKE_HERDR_LOG" 'api snapshot')"

# ── live record (pid alive + pane in the snapshot) → FOCUS, never a 2nd pane ─
printf '{"pane":"wCK:p9","pid":%s,"at":"2026-08-22T00:00:00Z","repo":"%s"}\n' \
  "$LIVE_PID" "$TMP" >"$PANEREC"
clear_logs
run_open
is "focus: exits 0" "0" "$RC"
line_has "focus: names the pane it focused" "$OUT" "wCK:p9"
is "focus: focused the recorded pane" "1" \
  "$(log_count "$FAKE_HERDR_LOG" 'plugin pane focus wCK:p9')"
is "focus: opened NOTHING — the whole point" "0" \
  "$(log_count "$FAKE_HERDR_LOG" 'plugin pane open')"

# ── live record + --no-focus → ensure only, never steal the day seat ────────
clear_logs
run_open_no_focus
is "no-focus live: exits 0" "0" "$RC"
line_has "no-focus live: reports the existing pane" "$OUT" "wCK:p9"
is "no-focus live: does not focus it" "0" \
  "$(log_count "$FAKE_HERDR_LOG" 'plugin pane focus')"
is "no-focus live: opens nothing" "0" \
  "$(log_count "$FAKE_HERDR_LOG" 'plugin pane open')"

# ── no record + --no-focus → open beside dispatch without taking focus ─────
rm -f "$PANEREC"; clear_logs
run_open_no_focus
is "no-focus open: exits 0" "0" "$RC"
is "no-focus open: opens one cockpit" "1" \
  "$(log_count "$FAKE_HERDR_LOG" 'plugin pane open --plugin ralph-herdr --entrypoint cockpit')"
is "no-focus open: asks Herdr not to steal focus" "1" \
  "$(log_count "$FAKE_HERDR_LOG" ' --no-focus')"
is "no-focus open: never asks for focus" "0" \
  "$(log_count "$FAKE_HERDR_LOG" ' --focus')"

# Restore the live record for the liveness degradation cases below.
printf '{"pane":"wCK:p9","pid":%s,"at":"2026-08-22T00:00:00Z","repo":"%s"}\n' \
  "$LIVE_PID" "$TMP" >"$PANEREC"

# ── attended day: a cockpit in the hero tab satisfies the surface ───────────
cat >"$FAKE_HERDR_FIXTURES/api-snapshot.json" <<'EOF'
{"snapshot":{"version":1,"protocol":19,"workspaces":[],"tabs":[],
 "panes":[
   {"pane_id":"wCK:p9","workspace_id":"wMain","tab_id":"wMain:t2","terminal_id":"term_ck","focused":false,"agent_status":"unknown","revision":1},
   {"pane_id":"pHero","workspace_id":"wMain","tab_id":"wMain:t2","terminal_id":"term_h","focused":true,"agent_status":"working","revision":1}],
 "layouts":[],"agents":[]}}
EOF
clear_logs
run_open_beside_focused
is "beside same tab: exits 0" "0" "$RC"
is "beside same tab: reuses the live cockpit" "0" \
  "$(log_count "$FAKE_HERDR_LOG" 'plugin pane open')"
is "beside same tab: never steals focus" "0" \
  "$(log_count "$FAKE_HERDR_LOG" 'plugin pane focus')"

# ── attended day: another tab is not visible beside the dispatch hero ───────
cat >"$FAKE_HERDR_FIXTURES/api-snapshot.json" <<'EOF'
{"snapshot":{"version":1,"protocol":19,"workspaces":[],"tabs":[],
 "panes":[
   {"pane_id":"wCK:p9","workspace_id":"wMain","tab_id":"wMain:t1","terminal_id":"term_ck","focused":false,"agent_status":"unknown","revision":1},
   {"pane_id":"pHero","workspace_id":"wMain","tab_id":"wMain:t2","terminal_id":"term_h","focused":true,"agent_status":"working","revision":1}],
 "layouts":[],"agents":[]}}
EOF
clear_logs
run_open_beside_focused
is "beside other tab: exits 0" "0" "$RC"
is "beside other tab: opens a dispatch-adjacent cockpit" "1" \
  "$(log_count "$FAKE_HERDR_LOG" 'plugin pane open --plugin ralph-herdr --entrypoint cockpit')"
is "beside other tab: targets the focused hero" "1" \
  "$(log_count "$FAKE_HERDR_LOG" ' --target-pane pHero')"

# ── attended day: a cockpit elsewhere does not satisfy the dispatch surface ─
cat >"$FAKE_HERDR_FIXTURES/api-snapshot.json" <<'EOF'
{"snapshot":{"version":1,"protocol":19,"workspaces":[],"tabs":[],
 "panes":[
   {"pane_id":"wCK:p9","workspace_id":"wOther","tab_id":"wOther:t1","terminal_id":"term_ck","focused":false,"agent_status":"unknown","revision":1},
   {"pane_id":"pHero","workspace_id":"wMain","tab_id":"wMain:t2","terminal_id":"term_h","focused":true,"agent_status":"working","revision":1}],
 "layouts":[],"agents":[]}}
EOF
clear_logs
run_open_beside_focused
is "beside other workspace: exits 0" "0" "$RC"
is "beside other workspace: opens a dispatch-adjacent cockpit" "1" \
  "$(log_count "$FAKE_HERDR_LOG" 'plugin pane open --plugin ralph-herdr --entrypoint cockpit')"
is "beside other workspace: targets the focused hero" "1" \
  "$(log_count "$FAKE_HERDR_LOG" ' --target-pane pHero')"
is "beside other workspace: never steals focus" "1" \
  "$(log_count "$FAKE_HERDR_LOG" ' --no-focus')"

# ── attended day: no uniquely focused pane is an honest refusal ─────────────
cat >"$FAKE_HERDR_FIXTURES/api-snapshot.json" <<'EOF'
{"snapshot":{"version":1,"protocol":19,"workspaces":[],"tabs":[],
 "panes":[{"pane_id":"wCK:p9","workspace_id":"wOther","tab_id":"wOther:t1","terminal_id":"term_ck","focused":false,"agent_status":"unknown","revision":1}],
 "layouts":[],"agents":[]}}
EOF
clear_logs
run_open_beside_focused
is "beside unknown focus: exits nonzero" "1" "$RC"
line_has "beside unknown focus: says the topology is unproven" "$OUT" "cannot prove one focused dispatch pane"
is "beside unknown focus: opens nothing blindly" "0" \
  "$(log_count "$FAKE_HERDR_LOG" 'plugin pane open')"

# Restore the original liveness fixture for the degradation cases below.
cat >"$FAKE_HERDR_FIXTURES/api-snapshot.json" <<'EOF'
{"snapshot":{"version":1,"protocol":19,"workspaces":[],"tabs":[],
 "panes":[{"pane_id":"wCK:p9","workspace_id":"wCK","tab_id":"wCK:t1",
           "terminal_id":"term_ck","focused":false,"agent_status":"unknown","revision":1}],
 "layouts":[],"agents":[]}}
EOF

# ── dead pid, pane still in the snapshot → open ──────────────────────────────
# A pane outlives the process inside it (herdr fires pane.exited and leaves the
# pane), so pane-liveness alone would focus a dead cockpit forever.
printf '{"pane":"wCK:p9","pid":%s,"at":"2026-08-22T00:00:00Z","repo":"%s"}\n' \
  "$DEAD_PID" "$TMP" >"$PANEREC"
clear_logs
run_open
is "dead pid: opened a fresh cockpit" "1" "$(log_count "$FAKE_HERDR_LOG" 'plugin pane open')"
is "dead pid: focused nothing" "0" "$(log_count "$FAKE_HERDR_LOG" 'plugin pane focus')"
is "dead pid: never asked for a snapshot (the cheap fact is checked first)" "0" \
  "$(log_count "$FAKE_HERDR_LOG" 'api snapshot')"

# ── live pid, pane GONE from the snapshot → open ─────────────────────────────
# The mirror case: a pid can be reused after its pane is closed.
printf '{"pane":"wCK:pGONE","pid":%s,"at":"2026-08-22T00:00:00Z","repo":"%s"}\n' \
  "$LIVE_PID" "$TMP" >"$PANEREC"
clear_logs
run_open
is "pane gone: opened a fresh cockpit" "1" "$(log_count "$FAKE_HERDR_LOG" 'plugin pane open')"
is "pane gone: focused nothing" "0" "$(log_count "$FAKE_HERDR_LOG" 'plugin pane focus')"

# ── unreadable snapshot → open (fail-OPEN, stated in cockpit-pane.sh) ────────
# A refused read must never leave the human with no cockpit; the stated price
# is a duplicate pane while the server is degraded.
printf '{"pane":"wCK:p9","pid":%s,"at":"2026-08-22T00:00:00Z","repo":"%s"}\n' \
  "$LIVE_PID" "$TMP" >"$PANEREC"
printf 'not json at all' >"$FAKE_HERDR_FIXTURES/api-snapshot.raw"
clear_logs
run_open
is "bad snapshot: still exits 0" "0" "$RC"
is "bad snapshot: fails OPEN, never closed" "1" "$(log_count "$FAKE_HERDR_LOG" 'plugin pane open')"
is "bad snapshot: focused nothing" "0" "$(log_count "$FAKE_HERDR_LOG" 'plugin pane focus')"
rm -f "$FAKE_HERDR_FIXTURES/api-snapshot.raw"

# ── a garbage record is not a live cockpit ───────────────────────────────────
printf 'not json\n' >"$PANEREC"
clear_logs
run_open
is "garbage record: opened" "1" "$(log_count "$FAKE_HERDR_LOG" 'plugin pane open')"
is "garbage record: focused nothing" "0" "$(log_count "$FAKE_HERDR_LOG" 'plugin pane focus')"

kill "$LIVE_PID" 2>/dev/null || true
wait "$LIVE_PID" 2>/dev/null || true

# ── the launcher's stamp: what makes any of the above findable ───────────────
# Records the PANE, and the pid it records is the RUNG's (exec preserves $$).
rm -f "$PANEREC"
printf '#!/bin/bash\necho "TUI ran pid=$$"\n' >"$TREE/cockpit/ralph-cockpit"
chmod +x "$TREE/cockpit/ralph-cockpit"
RC=0
OUT=$(cd "$TMP" && PATH="$BASEBIN:$PATH" HERDR_PANE_ID="wCK:p9" \
  "$REAL_BASH" "$TREE/scripts/cockpit-launch.sh" 2>&1) || RC=$?
is "stamp: the launch still exits 0" "0" "$RC"
is "stamp: recorded the pane it runs in" "wCK:p9" \
  "$(jq -r '.pane // empty' "$PANEREC" 2>/dev/null)"
is "stamp: the recorded pid is the rung's own (exec keeps \$\$)" \
  "$(printf '%s\n' "$OUT" | sed -n 's/^TUI ran pid=//p')" \
  "$(jq -r '.pid // empty' "$PANEREC" 2>/dev/null)"

# No pane id → no record, a warning, and a launch that still runs. The honest
# degradation: a later open finds nothing and opens, which is what it did before.
rm -f "$PANEREC"
RC=0
OUT=$(cd "$TMP" && PATH="$BASEBIN:$PATH" "$REAL_BASH" "$TREE/scripts/cockpit-launch.sh" 2>&1) || RC=$?
is "stamp: no HERDR_PANE_ID still launches" "0" "$RC"
line_has "stamp: and the TUI still ran" "$OUT" "TUI ran"
line_has "stamp: says the next open cannot focus this pane" "$OUT" "HERDR_PANE_ID"
is "stamp: wrote no record" "" "$(cat "$PANEREC" 2>/dev/null)"
rm -f "$TREE/cockpit/ralph-cockpit"
unset RALPH_HERDR_COCKPIT_PANE_FILE

echo "1..$n"
echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
