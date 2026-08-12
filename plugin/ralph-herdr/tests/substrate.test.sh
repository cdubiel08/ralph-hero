#!/usr/bin/env bash
# substrate.test.sh — executable tests for the Phase-4 card substrate (TAP-ish,
# matching watcher.test.sh / fleet.test.sh structure).
#
#   bash plugin/ralph-herdr/tests/substrate.test.sh   # exits 0 on pass, 1 on fail
#
# Covers: link-open.sh (live-agent focus under both name grammars, the
# no-agent link-offer popup handoff, out-of-scope / no-scope / unparseable
# URLs handed to the OS browser, deep sub-resource/fragment tails routed to
# the browser even in scope, the empty-click no-op), link-offer.sh (board
# get + the three-key offer: [q] closes without the hold trap, [o] opens the
# browser, refusals hold the pane), attend.sh (w-lane-first ordering,
# ledger-timestamped oldest-blocked-first, the pane tail carried into the
# notification — single line, <= 240 bytes, '#N' in the title, credential
# shapes never ride the toast), the
# ralph-answer pane (COMMENT-FIRST ordering asserted on one combined
# invocation log: the durable `board answer` lands before any agent prompt;
# the live-agent nudge uses --wait and reports refusal/timeout honestly;
# stderr noise / garbage stdout on the list never reads as an empty queue;
# the absent-agent path completes comment-only; the pre-answer-verb fallback
# keeps gh-comment-before-move ordering), and the cockpit-view.sh stub's
# three probe branches. All herdr traffic goes through tests/fake-herdr.sh,
# all board traffic through tests/fake-board.sh, gh and the OS opener are
# PATH shims — no server, no GitHub, no browser, no writes outside $TMP.
# bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../scripts"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/ralph-substrate-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

# ── PATH shims: herdr, board, gh, and the OS opener ──────────────────────────
# Wrappers (not symlinks) so the repo files' exec bits are never load-bearing.
BIN="$TMP/bin"
mkdir -p "$BIN"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-herdr.sh" >"$BIN/herdr"
printf '#!/bin/bash\nexec bash "%s" "$@"\n' "$SCRIPT_DIR/fake-board.sh" >"$BIN/board"
# The OS opener: records the URL, opens nothing. Shimming `open` covers both
# platforms — command -v finds it on PATH before /usr/bin/open (macOS) and
# before the xdg-open probe ever runs (linux).
printf '#!/bin/bash\nprintf "%%s\\n" "$*" >>"%s"\n' "$TMP/open.log" >"$BIN/open"
# gh: logs into the answer tests' combined log (prefixed, to stay
# distinguishable from board verbs) and answers the two surfaces
# ralph-answer.sh reads/writes.
cat >"$BIN/gh" <<'EOF'
#!/bin/bash
if [ -n "${FAKE_BOARD_LOG:-}" ]; then printf 'gh %s\n' "$*" >>"$FAKE_BOARD_LOG"; fi
case "${1-} ${2-}" in
  "issue view") printf 'question: which path should we take?\n' ;;
  "issue comment") printf 'https://github.com/acme/demo/issues/%s#issuecomment-1\n' "${3-}" ;;
esac
exit 0
EOF
chmod +x "$BIN/herdr" "$BIN/board" "$BIN/open" "$BIN/gh"
export PATH="$BIN:$PATH"
export HERDR_BIN_PATH="$BIN/herdr"
export FAKE_HERDR_FIXTURES="$TMP/fixtures"
export FAKE_HERDR_LOG="$TMP/herdr.log"
export FAKE_BOARD_FIXTURES="$TMP/board-fixtures"
export FAKE_BOARD_LOG="$TMP/board.log"
mkdir -p "$FAKE_HERDR_FIXTURES" "$FAKE_BOARD_FIXTURES"
: >"$FAKE_HERDR_LOG"
: >"$FAKE_BOARD_LOG"
: >"$TMP/open.log"
# Guard: no subprocess may ever fall back to the real ~/.ralph.
export RALPH_HERDR_LEDGER_ROOT="$TMP/guard-root"
unset ANTHROPIC_API_KEY 2>/dev/null || true

# A repo with a resolvable board scope (acme/demo) — link-open validates
# clicked URLs against it, attend derives its ledger from it.
REPO_DIR="$TMP/repo"
git init -q "$REPO_DIR"
printf '{"owner":"acme","repo":"demo","projectNumber":1}\n' >"$REPO_DIR/.ralph.json"
mkdir -p "$REPO_DIR/sub"
CTX=$(jq -nc --arg c "$REPO_DIR" '{workspace_cwd: $c}')

n=0 pass=0 fail=0
ok()     { n=$((n + 1)); pass=$((pass + 1)); echo "ok $n - $1"; }
not_ok() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — expected '$2', got '$3'"; fi
}
# fcount FILE FIXED_STRING — matching lines in an invocation log (fixed match:
# the asserted lines carry regex metacharacters like (#42) and --flags)
fcount() { grep -Fc -- "$2" "$1" || true; }
line_has() {
  case "$2" in *"$3"*) ok "$1" ;; *) not_ok "$1 — no '$3' in '$2'" ;; esac
}
line_lacks() {
  case "$2" in *"$3"*) not_ok "$1 — unexpected '$3' in '$2'" ;; *) ok "$1" ;; esac
}
# ordered DESC FILE FIRST SECOND — FIRST's first match line precedes SECOND's
# (fixed strings; the comment-first assertions live on this)
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
clear_logs() { : >"$FAKE_HERDR_LOG"; : >"$FAKE_BOARD_LOG"; : >"$TMP/open.log"; }

# run_linkopen URL CTX_JSON — link-open.sh as the action process runs it.
run_linkopen() {
  RC=0
  OUT=$(HERDR_PLUGIN_CLICKED_URL="$1" HERDR_PLUGIN_CONTEXT_JSON="$2" \
    bash "$SCRIPTS/link-open.sh" 2>&1) || RC=$?
}
# run_offer KEYS ISSUE URL [KIND] — link-offer.sh with keystrokes on stdin.
run_offer() {
  RC=0
  OUT=$(printf '%s' "$1" | RALPH_HERDR_LINK_ISSUE="$2" RALPH_HERDR_LINK_URL="$3" \
    RALPH_HERDR_LINK_KIND="${4:-issues}" RALPH_HERDR_REPO="$REPO_DIR" \
    RALPH_HERDR_BOARD="$BIN/board" bash "$SCRIPTS/link-offer.sh" 2>&1) || RC=$?
}
# run_attend [LEDGER] — attend.sh against the fixture repo.
run_attend() {
  RC=0
  OUT=$(RALPH_HERDR_REPO="$REPO_DIR" RALPH_HERDR_BOARD="$BIN/board" \
    RALPH_HERDR_LEDGER="${1-}" bash "$SCRIPTS/attend.sh" 2>&1) || RC=$?
}
# run_answer STDIN — ralph-answer.sh with board+herdr+gh sharing ONE log, so
# cross-surface ordering (the comment-first contract) is assertable by line.
CLOG="$TMP/combined.log"
run_answer() {
  RC=0
  OUT=$(printf '%s' "$1" | FAKE_BOARD_LOG="$CLOG" FAKE_HERDR_LOG="$CLOG" \
    RALPH_HERDR_REPO="$REPO_DIR" RALPH_HERDR_BOARD="$BIN/board" \
    bash "$SCRIPTS/ralph-answer.sh" 2>&1) || RC=$?
}

# ═══ 1. link-open — clicked URL becomes attention ════════════════════════════
# Live session for the issue (grammar B) → focus, nothing else.
printf '{"result":{"agents":[{"name":"w123-fix","agent_status":"working","pane_id":"p1"}]}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-list.json"
clear_logs
run_linkopen "https://github.com/acme/demo/issues/123" "$CTX"
is "link-open live: exits 0" "0" "$RC"
line_has "link-open live: says it is focusing" "$OUT" "focusing w123-fix for #123"
is "link-open live: the focus reached herdr" "1" \
  "$(fcount "$FAKE_HERDR_LOG" "agent focus w123-fix")"
is "link-open live: no popup opened" "0" "$(fcount "$FAKE_HERDR_LOG" "plugin pane open")"
is "link-open live: no browser handoff" "0" "$(wc -l <"$TMP/open.log" | tr -d ' ')"

# Legacy gh-N sessions stay first-class through the transition.
printf '{"result":{"agents":[{"name":"gh-123","agent_status":"working","pane_id":"p1"}]}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-list.json"
clear_logs
run_linkopen "https://github.com/acme/demo/issues/123" "$CTX"
is "link-open live legacy: gh-N is focused too" "1" \
  "$(fcount "$FAKE_HERDR_LOG" "agent focus gh-123")"

# No live session → the link-offer popup, with number/URL/kind via --env.
printf '{"result":{"agents":[]}}\n' >"$FAKE_HERDR_FIXTURES/agent-list.json"
clear_logs
run_linkopen "https://github.com/acme/demo/issues/123" "$CTX"
is "link-open no-agent: exits 0" "0" "$RC"
line_has "link-open no-agent: says it is offering" "$OUT" "no live session for #123"
is "link-open no-agent: opens the link-offer popup entrypoint" "1" \
  "$(fcount "$FAKE_HERDR_LOG" "plugin pane open --plugin ralph-herdr --entrypoint link-offer --placement popup --cwd $REPO_DIR --focus")"
is "link-open no-agent: the issue number rides --env" "1" \
  "$(fcount "$FAKE_HERDR_LOG" "--env RALPH_HERDR_LINK_ISSUE=123")"
is "link-open no-agent: the URL rides --env" "1" \
  "$(fcount "$FAKE_HERDR_LOG" "--env RALPH_HERDR_LINK_URL=https://github.com/acme/demo/issues/123")"
is "link-open no-agent: no focus, no browser" "0 0" \
  "$(fcount "$FAKE_HERDR_LOG" "agent focus") $(wc -l <"$TMP/open.log" | tr -d ' ')"

# A PR link carries kind=pull; scope compare is case-insensitive (GitHub is).
clear_logs
run_linkopen "https://github.com/Acme/Demo/pull/77" "$CTX"
is "link-open PR: case-insensitive scope match, kind=pull" "1" \
  "$(fcount "$FAKE_HERDR_LOG" "--env RALPH_HERDR_LINK_KIND=pull")"

# A cwd below the repo root still resolves the scope (git-toplevel fallback).
clear_logs
run_linkopen "https://github.com/acme/demo/issues/9" \
  "$(jq -nc --arg c "$REPO_DIR/sub" '{workspace_cwd: $c}')"
is "link-open subdir cwd: scope resolves via the git toplevel" "1" \
  "$(fcount "$FAKE_HERDR_LOG" "--env RALPH_HERDR_LINK_ISSUE=9")"

# Out of scope → the OS browser, never focus/popup. The log names the scope
# once (the ${scope:+}${scope:-} double-print regression).
clear_logs
run_linkopen "https://github.com/other/thing/issues/9" "$CTX"
is "link-open out-of-scope: exits 0" "0" "$RC"
line_has "link-open out-of-scope: refusal names both sides" "$OUT" \
  "other/thing#9 is outside this workspace's board scope (acme/demo)"
line_lacks "link-open out-of-scope: the scope prints once, not doubled" "$OUT" "acme/demoacme"
is "link-open out-of-scope: handed to the browser" "1" \
  "$(fcount "$TMP/open.log" "https://github.com/other/thing/issues/9")"
is "link-open out-of-scope: nothing reached herdr but the agent list" "0 0" \
  "$(fcount "$FAKE_HERDR_LOG" "agent focus") $(fcount "$FAKE_HERDR_LOG" "plugin pane open")"

# No scope resolvable (a cwd outside any ralph repo) → browser too.
mkdir -p "$TMP/noscope"
clear_logs
run_linkopen "https://github.com/acme/demo/issues/5" \
  "$(jq -nc --arg c "$TMP/noscope" '{workspace_cwd: $c}')"
is "link-open no-scope: exits 0" "0" "$RC"
line_has "link-open no-scope: honest about the missing scope" "$OUT" "none resolvable"
is "link-open no-scope: handed to the browser" "1" \
  "$(fcount "$TMP/open.log" "https://github.com/acme/demo/issues/5")"

# Unparseable URL → browser; a click must never dead-end.
clear_logs
run_linkopen "https://example.com/not/an/issue" "$CTX"
is "link-open unparseable: exits 0, browser fallback" "0 1" \
  "$RC $(fcount "$TMP/open.log" "https://example.com/not/an/issue")"

# The plain action menu (nothing clicked): say so, exit 0, touch nothing.
clear_logs
RC=0
OUT=$(HERDR_PLUGIN_CLICKED_URL= HERDR_PLUGIN_CONTEXT_JSON= \
  bash "$SCRIPTS/link-open.sh" 2>&1) || RC=$?
is "link-open no-click: exits 0" "0" "$RC"
line_has "link-open no-click: names the link-handler contract" "$OUT" "no clicked URL"
is "link-open no-click: nothing opened anywhere" "0 0" \
  "$(wc -l <"$FAKE_HERDR_LOG" | tr -d ' ') $(wc -l <"$TMP/open.log" | tr -d ' ')"

# The context JSON's clicked_url is the fallback channel for the URL.
clear_logs
RC=0
OUT=$(HERDR_PLUGIN_CLICKED_URL= \
  HERDR_PLUGIN_CONTEXT_JSON=$(jq -nc --arg c "$REPO_DIR" \
    '{workspace_cwd: $c, clicked_url: "https://github.com/acme/demo/issues/123", link_handler_id: "github-issue-or-pr"}') \
  bash "$SCRIPTS/link-open.sh" 2>&1) || RC=$?
is "link-open context fallback: clicked_url from the context JSON works" "0 1" \
  "$RC $(fcount "$FAKE_HERDR_LOG" "--env RALPH_HERDR_LINK_ISSUE=123")"

# Deep sub-resource / fragment tails are browser intent even in scope with a
# live session — a /files or #issuecomment click named a SPECIFIC view no
# pane can show; hijacking it into focus would swallow it with no escape.
printf '{"result":{"agents":[{"name":"w123-fix","agent_status":"working","pane_id":"p1"}]}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-list.json"
clear_logs
run_linkopen "https://github.com/acme/demo/pull/123/files" "$CTX"
is "link-open deep /files: exits 0, browser handoff" "0 1" \
  "$RC $(fcount "$TMP/open.log" "https://github.com/acme/demo/pull/123/files")"
is "link-open deep /files: no focus hijack, no popup" "0 0" \
  "$(fcount "$FAKE_HERDR_LOG" "agent focus") $(fcount "$FAKE_HERDR_LOG" "plugin pane open")"
clear_logs
run_linkopen "https://github.com/acme/demo/issues/123#issuecomment-99" "$CTX"
is "link-open fragment: #issuecomment goes to the browser" "1" \
  "$(fcount "$TMP/open.log" "#issuecomment-99")"
is "link-open fragment: no focus hijack" "0" "$(fcount "$FAKE_HERDR_LOG" "agent focus")"
# …but a bare ?query (or trailing slash) is link plumbing, not intent — the
# attention path holds.
clear_logs
run_linkopen "https://github.com/acme/demo/issues/123?notification_referrer_id=x" "$CTX"
is "link-open ?query tail: still attention — focus, no browser" "1 0" \
  "$(fcount "$FAKE_HERDR_LOG" "agent focus w123-fix") $(wc -l <"$TMP/open.log" | tr -d ' ')"
clear_logs
run_linkopen "https://github.com/acme/demo/issues/123/" "$CTX"
is "link-open trailing slash: still attention — focus, no browser" "1 0" \
  "$(fcount "$FAKE_HERDR_LOG" "agent focus w123-fix") $(wc -l <"$TMP/open.log" | tr -d ' ')"

# ═══ 2. link-offer — the popup pane behind the handler ═══════════════════════
printf '{"result":{"agents":[]}}\n' >"$FAKE_HERDR_FIXTURES/agent-list.json"
clear_logs
run_offer "q" 123 "https://github.com/acme/demo/issues/123"
is "link-offer [q]: clean close, rc 0" "0" "$RC"
line_has "link-offer: shows the item header" "$OUT" "#123 — https://github.com/acme/demo/issues/123"
line_has "link-offer: board get output shown" "$OUT" "[Backlog]"
is "link-offer: the read went through the board CLI" "1" "$(fcount "$FAKE_BOARD_LOG" "get 123")"
line_lacks "link-offer [q]: the hold trap was dropped (no 'no session spawned' banner)" \
  "$OUT" "no session spawned"
is "link-offer [q]: nothing spawned" "0" "$(fcount "$FAKE_HERDR_LOG" "worktree create")"

# [o] opens the browser and the offer stands until [q].
clear_logs
run_offer "oq" 123 "https://github.com/acme/demo/issues/123"
is "link-offer [o]: URL handed to the browser, then [q] closes clean" "0 1" \
  "$RC $(fcount "$TMP/open.log" "https://github.com/acme/demo/issues/123")"

# A PR-numbered click is honest: the caveat prints, board get may fail, the
# offer still stands.
printf '1\n' >"$FAKE_BOARD_FIXTURES/get.rc"
clear_logs
run_offer "q" 456 "https://github.com/acme/demo/pull/456" pull
is "link-offer PR: a failed board get still offers (rc 0 on q)" "0" "$RC"
line_has "link-offer PR: the number-space caveat prints" "$OUT" "not board items"
line_has "link-offer PR: the failed read is reported" "$OUT" "board get 456 failed"
rm -f "$FAKE_BOARD_FIXTURES/get.rc"

# Opened by hand (no issue env) → refuse loudly; the hold trap keeps the
# refusal readable (EOF stands in for the human's Enter).
clear_logs
RC=0
OUT=$(printf '' | RALPH_HERDR_REPO="$REPO_DIR" RALPH_HERDR_BOARD="$BIN/board" \
  bash "$SCRIPTS/link-offer.sh" 2>&1) || RC=$?
is "link-offer by hand: refused, rc 1" "1" "$RC"
line_has "link-offer by hand: the refusal names the opener contract" "$OUT" \
  "opened by link-open.sh, not by hand"
line_has "link-offer by hand: the hold trap caught it" "$OUT" "no session spawned"

# ═══ 3. attend — carry the blocking question ═════════════════════════════════
# Nothing blocked → herd calm.
printf '{"result":{"agents":[]}}\n' >"$FAKE_HERDR_FIXTURES/agent-list.json"
clear_logs
run_attend
is "attend calm: exits 0" "0" "$RC"
is "attend calm: says so in a toast" "1" \
  "$(fcount "$FAKE_HERDR_LOG" "notification show ralph: herd calm")"
is "attend calm: no focus" "0" "$(fcount "$FAKE_HERDR_LOG" "agent focus")"

# A blocked w-lane beats a blocked non-issue lane regardless of list order;
# the pane tail rides the toast — flattened to ONE line, <= 240 bytes, the
# issue number in the title.
printf '{"result":{"agents":[{"name":"o55-review","agent_status":"blocked","pane_id":"p5"},{"name":"w42-fix-pipeline","agent_status":"blocked","pane_id":"p4"}]}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-list.json"
{
  printf 'setup noise: booting the session\n'
  printf '\n'
  printf 'Should we migrate the queue schema before cutting over, or keep the legacy reader hot for one more release cycle?\n'
  printf 'Option A rewrites history tables in place; option B double-writes and backfills asynchronously over the weekend.\r\n'
  printf 'Blocked: need a human decision on A vs B before touching prod.\n'
  printf '\n\n'
} >"$FAKE_HERDR_FIXTURES/agent-read.w42-fix-pipeline.txt"
clear_logs
run_attend
is "attend blocked: exits 0" "0" "$RC"
is "attend blocked: w-lane focused ahead of the o-lane" "1" \
  "$(fcount "$FAKE_HERDR_LOG" "agent focus w42-fix-pipeline")"
is "attend blocked: the pane tail was read" "1" \
  "$(fcount "$FAKE_HERDR_LOG" "agent read w42-fix-pipeline --source recent-unwrapped --lines 25")"
is "attend blocked: title carries the issue number" "1" \
  "$(fcount "$FAKE_HERDR_LOG" "notification show ralph: attending w42-fix-pipeline (#42) --body")"
# One log line per herdr call (list, focus, read, notification) — a body with
# an embedded newline would add a fifth line.
is "attend blocked: the notification body is a single line" "4" \
  "$(wc -l <"$FAKE_HERDR_LOG" | tr -d ' ')"
body=$(sed -n 's/^notification show .* --body //p' "$FAKE_HERDR_LOG" | head -1)
line_has "attend blocked: the body starts with the question tail" "$body" "Should we migrate"
case "$body" in
  *...) ok "attend blocked: over-budget tail is truncated with an ellipsis" ;;
  *) not_ok "attend blocked: over-budget tail is truncated with an ellipsis — got '$body'" ;;
esac
bytes=$(printf '%s' "$body" | wc -c | tr -d ' ')
if [ "$bytes" -le 240 ]; then
  ok "attend blocked: body fits the 240-byte toast budget ($bytes)"
else
  not_ok "attend blocked: body fits the 240-byte toast budget — got $bytes bytes"
fi
case "$body" in
  *$'\r'*) not_ok "attend blocked: CRs flattened out of the body" ;;
  *) ok "attend blocked: CRs flattened out of the body" ;;
esac

# An empty tail degrades to the fixed body — chrome, never the verb.
rm -f "$FAKE_HERDR_FIXTURES/agent-read.w42-fix-pipeline.txt"
clear_logs
run_attend
is "attend blank tail: degrades to the fixed body" "1" \
  "$(fcount "$FAKE_HERDR_LOG" "--body attending w42-fix-pipeline — pane focused")"

# A tail holding a credential (contracts.ts SECRET_RE shapes) never rides the
# toast — the notification DB and lock screen are no place for a key. The
# body degrades to the fixed line; the focus verb survives.
printf 'export ANTHROPIC_API_KEY=sk-ant-api03-fake123 # oops\nghp_FakeToken1234567890\nBlocked: which env should prod use?\n' \
  >"$FAKE_HERDR_FIXTURES/agent-read.w42-fix-pipeline.txt"
clear_logs
run_attend
is "attend secret tail: exits 0, focus still happened" "0 1" \
  "$RC $(fcount "$FAKE_HERDR_LOG" "agent focus w42-fix-pipeline")"
is "attend secret tail: no credential shape reaches the notification" "0 0" \
  "$(fcount "$FAKE_HERDR_LOG" "sk-ant-") $(fcount "$FAKE_HERDR_LOG" "ghp_")"
is "attend secret tail: degrades to the fixed body" "1" \
  "$(fcount "$FAKE_HERDR_LOG" "--body attending w42-fix-pipeline — pane focused")"
rm -f "$FAKE_HERDR_FIXTURES/agent-read.w42-fix-pipeline.txt"

# Ledger timestamps order the queue: oldest blocked-since first.
mkdir -p "$TMP/att"
cat >"$TMP/att/ledger.jsonl" <<'EOF'
{"ts":"2026-08-11T02:00:00Z","ev":"state","agent_ref":"w42-fix-pipeline#cccc","agent_status":"blocked"}
{"ts":"2026-08-11T01:00:00Z","ev":"state","agent_ref":"w41-older#dddd","agent_status":"blocked"}
EOF
printf '{"result":{"agents":[{"name":"w42-fix-pipeline","agent_status":"blocked","pane_id":"p4"},{"name":"w41-older","agent_status":"blocked","pane_id":"p3"}]}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-list.json"
clear_logs
run_attend "$TMP/att/ledger.jsonl"
is "attend ordering: the longest-blocked w-lane wins" "1" \
  "$(fcount "$FAKE_HERDR_LOG" "agent focus w41-older")"
# Without the ledger the tie falls back to agent-list order.
clear_logs
run_attend
is "attend ordering: no ledger falls back to list order" "1" \
  "$(fcount "$FAKE_HERDR_LOG" "agent focus w42-fix-pipeline")"

# ═══ 4. ralph-answer — comment-first, honestly reported ══════════════════════
printf '{"result":{"agents":[]}}\n' >"$FAKE_HERDR_FIXTURES/agent-list.json"

# Empty queue: herd calm, nothing written.
: >"$CLOG"
run_answer '
'
is "answer empty queue: exits 0" "0" "$RC"
line_has "answer empty queue: says so" "$OUT" "nothing in Human Needed"
is "answer empty queue: no answer verb ran" "0" "$(fcount "$CLOG" "answer ")"

printf '{"items":[{"number":123,"title":"Choose the path"}]}\n' \
  >"$FAKE_BOARD_FIXTURES/list.json"

# stderr noise on a SUCCESSFUL list (npx cold-cache chatter, node
# ExperimentalWarning) must never read as an empty queue — stdout is the
# only JSON channel (the false-"herd calm" regression).
printf '#!/bin/bash\necho "(node:1) ExperimentalWarning: stripping types" >&2\nexec "%s" "$@"\n' \
  "$BIN/board" >"$TMP/noisy-board"
chmod +x "$TMP/noisy-board"
: >"$CLOG"
RC=0
OUT=$(printf 'q\n' | FAKE_BOARD_LOG="$CLOG" FAKE_HERDR_LOG="$CLOG" \
  RALPH_HERDR_REPO="$REPO_DIR" RALPH_HERDR_BOARD="$TMP/noisy-board" \
  bash "$SCRIPTS/ralph-answer.sh" 2>&1) || RC=$?
is "answer noisy stderr: exits 0 on q" "0" "$RC"
line_lacks "answer noisy stderr: never a false herd calm" "$OUT" "nothing in Human Needed"
line_has "answer noisy stderr: the queue listed through the noise" "$OUT" "[1] #123"

# A 0-exit with garbage stdout is a failed read, never calm — an empty queue
# and a failed query are different facts.
printf 'not json at all\n' >"$FAKE_BOARD_FIXTURES/list.json"
: >"$CLOG"
run_answer '
'
is "answer garbled list: refused, rc 1" "1" "$RC"
line_has "answer garbled list: named as unparseable" "$OUT" "unparseable JSON"
line_lacks "answer garbled list: never a false herd calm" "$OUT" "nothing in Human Needed"
printf '{"items":[{"number":123,"title":"Choose the path"}]}\n' \
  >"$FAKE_BOARD_FIXTURES/list.json"

# Live session: the durable half (board answer) lands BEFORE the decorative
# half (agent prompt) — asserted by line order in the one combined log.
printf '{"result":{"agents":[{"name":"w123-fix","agent_status":"blocked","pane_id":"p1"}]}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-list.json"
: >"$CLOG"
run_answer '1
Use the blue path.
.

'
is "answer live: exits 0" "0" "$RC"
is "answer live: the queue was listed" "1" "$(fcount "$CLOG" "list --state Human Needed --json")"
is "answer live: the answer verb carried the message" "1" \
  "$(fcount "$CLOG" "answer 123 -m Use the blue path.")"
ordered "answer live: COMMENT-FIRST — board answer precedes the agent nudge" \
  "$CLOG" "answer 123 -m" "agent prompt w123-fix"
ordered "answer live: the durable half even precedes the agent-list read" \
  "$CLOG" "answer 123 -m" "agent list"
is "answer live: the nudge waits for delivery (--wait, bounded)" "1" \
  "$(fcount "$CLOG" "agent prompt w123-fix answered on issue — re-read #123 and resume --wait --timeout 15000")"
line_has "answer live: delivery reported honestly" "$OUT" "nudged w123-fix"

# Absent session: the answer is complete comment-only — no prompt anywhere.
printf '{"result":{"agents":[]}}\n' >"$FAKE_HERDR_FIXTURES/agent-list.json"
: >"$CLOG"
run_answer '1
Go with option B.
.

'
is "answer absent: exits 0" "0" "$RC"
is "answer absent: the answer verb ran" "1" "$(fcount "$CLOG" "answer 123 -m Go with option B.")"
is "answer absent: no prompt was ever attempted" "0" "$(fcount "$CLOG" "agent prompt")"
line_has "answer absent: the wait is named" "$OUT" "no live session for #123"

# Nudge refused (agent vanished between list and prompt): the answer stands,
# the refusal names the manual command.
printf '{"result":{"agents":[{"name":"w123-fix","agent_status":"blocked","pane_id":"p1"}]}}\n' \
  >"$FAKE_HERDR_FIXTURES/agent-list.json"
printf '{"error":{"code":"agent_not_found"}}\n' >"$FAKE_HERDR_FIXTURES/agent-prompt.json"
printf '1\n' >"$FAKE_HERDR_FIXTURES/agent-prompt.rc"
: >"$CLOG"
run_answer '1
Refused nudge case.
.

'
is "answer nudge-refused: still rc 0 (the answer IS durable)" "0" "$RC"
line_has "answer nudge-refused: the code is surfaced" "$OUT" "nudge to w123-fix refused (agent_not_found)"
line_has "answer nudge-refused: the manual prompt is printed" "$OUT" \
  "herdr agent prompt w123-fix"
rm -f "$FAKE_HERDR_FIXTURES/agent-prompt.json"

# Nudge unconfirmed (--wait timed out, no error envelope): reported as sent-
# but-unconfirmed, never as delivered.
: >"$CLOG"
run_answer '1
Timeout case.
.

'
is "answer nudge-timeout: rc 0" "0" "$RC"
line_has "answer nudge-timeout: honesty about non-confirmation" "$OUT" "sent but not confirmed"
rm -f "$FAKE_HERDR_FIXTURES/agent-prompt.rc"

# board answer refused: rc 1, and the retry guidance names the MOVE (never
# re-answering — the comment may already be on the record).
printf '1\n' >"$FAKE_BOARD_FIXTURES/answer.rc"
: >"$CLOG"
run_answer '1
Refused answer.
.

'
is "answer verb-refused: rc 1" "1" "$RC"
line_has "answer verb-refused: retry the move, not the answer" "$OUT" "retry the MOVE"
rm -f "$FAKE_BOARD_FIXTURES/answer.rc"

# A board CLI predating the answer verb: gh comment (durable) FIRST, board
# move second — the same ordering by hand.
printf 'mutations:\n  move NNN STATE\n' >"$FAKE_BOARD_FIXTURES/help.txt"
printf '{"result":{"agents":[]}}\n' >"$FAKE_HERDR_FIXTURES/agent-list.json"
: >"$CLOG"
run_answer '1
Fallback ordering.
.

'
is "answer old-CLI: exits 0" "0" "$RC"
line_has "answer old-CLI: the fallback is announced" "$OUT" "predates the answer verb"
is "answer old-CLI: never calls the missing verb" "0" "$(fcount "$CLOG" "answer 123")"
ordered "answer old-CLI: gh comment (durable) precedes the board move" \
  "$CLOG" "gh issue comment 123" "move 123 In Progress"
rm -f "$FAKE_BOARD_FIXTURES/help.txt"

# Empty answer: nothing posted, nothing moved.
: >"$CLOG"
run_answer '1
.

'
is "answer empty body: rc 0" "0" "$RC"
line_has "answer empty body: aborts honestly" "$OUT" "empty answer — nothing posted"
is "answer empty body: no verb, no comment, no move" "0 0 0" \
  "$(fcount "$CLOG" "answer 123") $(fcount "$CLOG" "gh issue comment") $(fcount "$CLOG" "move 123")"

# A pick outside the queue refuses.
: >"$CLOG"
run_answer '7

'
is "answer bad pick: rc 1" "1" "$RC"
line_has "answer bad pick: names the bound" "$OUT" "only 1 item(s)"
rm -f "$FAKE_BOARD_FIXTURES/list.json"

# ═══ 5. cockpit-view — the stub's three probe branches, always rc 0 ══════════
RC=0
OUT=$(bash "$SCRIPTS/cockpit-view.sh" 2>&1) || RC=$?
is "cockpit-view no-surface: rc 0" "0" "$RC"
line_has "cockpit-view no-surface: chrome skipped honestly" "$OUT" \
  "no agent-view CLI surface in this herdr"

printf 'herdr agent commands:\n  list\n  view\nusage: herdr agent view set --source S\n' \
  >"$FAKE_HERDR_FIXTURES/agent-help.txt"
RC=0
OUT=$(bash "$SCRIPTS/cockpit-view.sh" 2>&1) || RC=$?
is "cockpit-view surface-arrived: rc 0" "0" "$RC"
line_has "cockpit-view surface-arrived: nudges an update, never guesses syntax" "$OUT" \
  "EXISTS in this CLI"
rm -f "$FAKE_HERDR_FIXTURES/agent-help.txt"

RC=0
OUT=$(HERDR_BIN_PATH="$TMP/definitely-missing" bash "$SCRIPTS/cockpit-view.sh" 2>&1) || RC=$?
is "cockpit-view no-herdr: rc 0 (chrome only, never a failure)" "0" "$RC"
line_has "cockpit-view no-herdr: says what it saw" "$OUT" "herdr missing or unrecognized"

echo "1..$n"
echo "# $pass passed, $fail failed"
[ "$fail" -eq 0 ]
