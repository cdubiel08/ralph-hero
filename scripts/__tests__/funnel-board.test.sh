#!/usr/bin/env bash
# scripts/__tests__/funnel-board.test.sh
# Tests ralph/hooks/funnel-board.sh (the PreToolUse courtesy rail) by feeding
# it simulated hook payloads on stdin — the same shape Claude Code sends for
# a Bash PreToolUse event: {"tool_input": {"command": "..."}}.
#
# Covers: the blocked raw-mutation tokens (gh project item-*, GraphQL
# mutation names including deleteProjectV2Item and updateProjectV2( ), the
# deliberate non-block of `gh issue close` (the reconcile/event lane owns
# direct issue closes), and the narrowed escape valve — a real board-CLI
# invocation is exempt even when its arguments mention a blocked token, while
# a trailing comment that merely mentions scripts/board is not.

set -euo pipefail

HOOK="$(cd "$(dirname "$0")/../.." && pwd)/ralph/hooks/funnel-board.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# run_hook <command> -> sets LAST_OUT, LAST_ERR, LAST_RC
# RALPH_BOARD is unset for the default cases: shell profiles export RALPH_*
# vars, and the hook prefers RALPH_BOARD in its refusal text by design — the
# assertions on that text must not depend on the machine running the suite.
run_hook() {
  local cmd="$1"
  local payload
  payload=$(jq -n --arg cmd "$cmd" '{tool_input: {command: $cmd}}')
  set +e
  LAST_OUT=$(printf '%s' "$payload" | env -u RALPH_BOARD bash "$HOOK" 2>"$TMP_ROOT/stderr")
  LAST_RC=$?
  set -e
  LAST_ERR=$(<"$TMP_ROOT/stderr")
}

# expect_rc <desc> <expected_rc>
expect_rc() {
  local desc="$1" expected="$2"
  if [[ "$LAST_RC" == "$expected" ]]; then
    pass "$desc (exit $LAST_RC)"
  else
    fail "$desc — expected exit $expected, got $LAST_RC. stderr: $LAST_ERR"
  fi
}

echo "=== funnel-board.sh ==="

# --- Blocked tokens -> redirect (exit 2) -----------------------------------

# 1. gh project item-edit -> redirected, message names the CLI.
run_hook "gh project item-edit --id ITEM --field-id F --single-select-option-id X"
expect_rc "gh project item-edit redirects" 2
if [[ "$LAST_ERR" == *"scripts/board"* ]]; then
  pass "redirect message names the board CLI"
else
  fail "redirect message missing board CLI mention: $LAST_ERR"
fi

# 2. Raw GraphQL field mutation -> redirected.
run_hook "gh api graphql -f query='mutation { updateProjectV2ItemFieldValue(input:{}) }'"
expect_rc "updateProjectV2ItemFieldValue redirects" 2

# 3. New token: deleteProjectV2Item -> redirected.
run_hook "gh api graphql -f query='mutation { deleteProjectV2Item(input:{}) }'"
expect_rc "deleteProjectV2Item redirects" 2

# 4. New token: updateProjectV2( -> redirected.
run_hook "gh api graphql -f query='mutation { updateProjectV2(input:{projectId:\"P\"}) }'"
expect_rc "updateProjectV2( redirects" 2

# 5. Sub-issue mutation -> redirected.
run_hook "gh api graphql -f query='mutation { addSubIssue(input:{}) }'"
expect_rc "addSubIssue redirects" 2

# --- Deliberately NOT blocked ----------------------------------------------

# 6. Closing an issue directly is legitimate (reconcile lane owns folding it in).
run_hook "gh issue close 42 --reason completed"
expect_rc "gh issue close passes through" 0

# 7. updateProjectV2 without the mutation-call paren (e.g. reading docs/typing
# the bare word in a grep) is not the raw mutation -> untouched.
run_hook "grep -rn updateProjectV2ItemsPage docs/"
expect_rc "updateProjectV2 token without '(' passes through" 0

# 8. Benign command, no tokens at all -> untouched.
run_hook "git status && ls -la"
expect_rc "benign command passes through" 0

# --- Escape valve: real board-CLI invocations ------------------------------

# 9. Board CLI invocation whose -m text mentions a blocked token -> allowed.
run_hook 'ralph/scripts/board release 5 -m "stopped at the addSubIssue bug"'
expect_rc "board CLI with token-like argument text passes through" 0

# 10. Compound command invoking the CLI -> allowed.
run_hook 'cd /tmp/wt && ralph/scripts/board move 1 done -m "removeSubIssue fixed"'
expect_rc "compound command invoking the CLI passes through" 0

# 11. Quoted absolute path to the CLI (the hook's own suggested form) -> allowed.
run_hook '"/some/plugin/root/scripts/board" claim 12 -m "updateProjectV2ItemFieldValue repro"'
expect_rc "quoted-path CLI invocation passes through" 0

# --- Escape valve narrowing: mentions are not invocations ------------------

# 12. Blocked token + trailing comment merely mentioning scripts/board ->
# still redirected (the old substring valve let this through).
run_hook "gh project item-edit --id ITEM --field-id F # normally via scripts/board"
expect_rc "comment-smuggled scripts/board mention still redirects" 2

# 13. Same for a raw GraphQL mutation with a comment naming a subcommand.
run_hook "gh api graphql -f query='mutation { deleteProjectV2Item(input:{}) }' # scripts/board cancel 9"
expect_rc "comment-smuggled 'scripts/board cancel' still redirects" 2

# 14. Bare trailing mention with no subcommand (pre-comment) -> still redirected.
run_hook "gh api graphql -f query='mutation { addBlockedBy(input:{}) }' && echo scripts/board"
expect_rc "bare scripts/board mention without subcommand still redirects" 2

# --- Escape valve must be command-anchored (regression, PR #1691 review) ---

# 16. Blocked mutation whose ARGUMENT mentions a board invocation -> redirected.
run_hook 'gh project item-edit --id ITEM --field-id F -m "typically done via scripts/board move"'
expect_rc "quoted-argument 'scripts/board move' does not exempt a raw mutation" 2

# 17. Absolute, quoted board path at command start -> allowed.
run_hook "'/abs/path/ralph/scripts/board' move 1 done"
expect_rc "quoted absolute board path is a real invocation" 0

# 18. Real invocation whose own -m text names a blocked token -> allowed.
run_hook 'ralph/scripts/board comment 1 -m "do not use gh project item-edit"'
expect_rc "board invocation may quote a blocked token in its message" 0

# 19. A sanctioned board command must not exempt a LATER raw mutation.
run_hook 'ralph/scripts/board get 1; gh project item-edit --id X'
expect_rc "board invocation does not exempt a chained raw mutation (;)" 2

# 20. Same, joined with && rather than ;.
run_hook 'ralph/scripts/board get 1 && gh project item-edit --id X'
expect_rc "board invocation does not exempt a chained raw mutation (&&)" 2

# 21. Unrelated command with no blocked token -> passes through.
run_hook 'git status'
expect_rc "ordinary commands pass through untouched" 0

# --- Degenerate payloads ---------------------------------------------------

# 15. Payload without a command -> hook stays silent.
set +e
LAST_OUT=$(printf '%s' '{"tool_input": {}}' | bash "$HOOK" 2>"$TMP_ROOT/stderr")
LAST_RC=$?
set -e
LAST_ERR=$(<"$TMP_ROOT/stderr")
expect_rc "payload without command passes through" 0


# 16. Quoted vs run (GH-1930): a command that merely QUOTES a blocked token as
# an argument — an issue body describing this rail — mutates nothing.
run_hook "gh issue create --title 'funnel' --body 'redirect gh project item-edit to the CLI'"
expect_rc "quoted blocked token in an issue body passes" 0

# 17. ...but the `gh api` exception holds: a GraphQL mutation lives INSIDE the
# quotes, so that segment is still matched whole.
run_hook "gh api graphql -f query='mutation { addSubIssue(input:{}) }'"
expect_rc "gh api keeps matching inside quotes" 2


# --- GH-2058: the stripper and the segmenter both read the WHOLE command ----
#
# Quoted-is-not-run (GH-1930) was implemented line-at-a-time, and every real
# `--body` is multi-line. The bash split turned each newline and each `;`/`&`/
# `|` INSIDE a quoted span into a segment break, so the quotes bounding the
# body landed in different segments and every per-segment `sed` matched
# nothing. A body that merely described a blocked mutation was then refused as
# though it were running one — reproduced against this rail while fixing it.

MULTILINE_BODY='Paragraph one describes the rail.

It catches gh project item-edit; and the separators & and | inside this
body must not split it into segments.
Paragraph two.'
run_hook "$(printf 'gh issue create --title T --body "%s"' "$MULTILINE_BODY")"
expect_rc "multi-line quoted body naming a blocked token passes" 0

# The single-line form already passed before the fix — pinned so a regression
# cannot be mistaken for the multi-line case alone.
run_hook 'gh issue create --title T --body "it catches gh project item-edit"'
expect_rc "single-line quoted body naming a blocked token passes" 0

# ...and the real thing on a LATER line of the same command still redirects:
# the fix may not become a blanket amnesty for anything multi-line.
run_hook 'echo "a quoted
mention of nothing" && gh project item-delete --id X'
expect_rc "a real mutation after a multi-line quoted span still redirects" 2

# The `gh api` exception survives multi-line too: a GraphQL mutation lives
# INSIDE the quotes and its segment is matched whole, so a pretty-printed
# mutation — the form anyone actually writes — is still caught.
run_hook "gh api graphql -f query='mutation {
  addSubIssue(input: {issueId: \"a\", subIssueId: \"b\"}) { clientMutationId }
}'"
expect_rc "multi-line gh api GraphQL mutation still redirects" 2

# A comment runs to end of LINE, not to end of command. The old truncation at
# the first `#` anywhere silenced the rail on every later line.
run_hook 'git status # nothing to see
gh project item-edit --id X'
expect_rc "a comment on one line does not silence the next" 2

# ...and a `#` inside quotes is not a comment at all.
run_hook 'gh issue create --title T --body "fixes #2058 for good"; git status'
expect_rc "a hash inside a quoted body is not a comment" 0

# --- B4 (ways-of-working audit): command position + widened self-allow ------
#
# BLOCKED_PATTERNS were substring-matched in every segment regardless of the
# command word, so pure READS of the mutation names — grep over board.ts, a
# python heredoc editing it, a board comment quoting one — were refused as
# though they ran a mutation (2 of 3 funnel-board trips in one audit shard
# were false positives). Mutation names now count only in segments whose
# command word is gh or curl; every board-CLI spelling the session is told to
# use is self-allowed. All narrowings UNDER-redirect — the safe direction for
# a rail that is never enforcement.

# Observed shape: grep -n "deleteProjectV2Item…" board.ts (feat-2050,
# feature-gh-1788, feature-gh-1815). Unquoted variant is the live one — the
# quoted form was already stripped.
run_hook 'grep -n deleteProjectV2Item ralph/scripts/board.ts'
expect_rc "grep of a mutation name over board.ts passes (unquoted arg)" 0
run_hook 'grep -n "updateProjectV2ItemFieldValue" ralph/scripts/board.ts'
expect_rc "grep of a mutation name over board.ts passes (quoted arg)" 0
run_hook 'rg -c addProjectV2ItemById ralph/scripts/'
expect_rc "rg of a mutation name passes" 0

# Observed shape: a python heredoc EDITING board.ts source refused
# (feat-1948). Each heredoc line is its own segment; none has gh/curl in
# command position.
run_hook "python3 - <<'EOF'
import re
src = open('ralph/scripts/board.ts').read()
src = src.replace('deleteProjectV2Item(', 'deleteProjectV2Item( ')
open('ralph/scripts/board.ts', 'w').write(src)
EOF"
expect_rc "python heredoc editing board.ts passes" 0

# Observed shape: sanctioned `board comment` blocked because the mutation
# name appeared in the comment body (feature-gh-1815) — including the worst
# case, a body that also says `gh api`, which the whole-segment exception
# used to match.
run_hook 'board comment 1815 -m "the fix guards updateProjectV2ItemFieldValue"'
expect_rc "bare-board comment quoting a mutation name passes" 0
run_hook 'board comment 1815 -m "went through gh api graphql updateProjectV2ItemFieldValue"'
expect_rc "board comment whose body says gh api + mutation passes" 0

# The widened self-allow: every spelling the session is actually told to use.
run_hook '"$RALPH_BOARD" move 2 done -m "addSubIssue fixed"'
expect_rc 'quoted $RALPH_BOARD invocation passes' 0
run_hook '$RALPH_BOARD claim 12'
expect_rc 'bare $RALPH_BOARD invocation passes' 0
run_hook '"${RALPH_BOARD}" comment 3 -m "removeSubIssue note"'
expect_rc 'braced ${RALPH_BOARD} invocation passes' 0
run_hook '~/.ralph/bin/board move 2 done -m "addSubIssue note"'
expect_rc 'tilde shim path invocation passes' 0
run_hook '/Users/someone/.ralph/bin/board next'
expect_rc 'absolute shim path invocation passes' 0
run_hook '$HOME/.ralph/bin/board list'
expect_rc '$HOME shim path invocation passes' 0
run_hook 'board move 7 in-review'
expect_rc "bare 'board' invocation passes" 0

# Narrowing regressions: the self-allow is command-anchored, and gh/curl in
# command position still redirect.
run_hook 'echo board move 7 done; gh project item-edit --id X'
expect_rc "'board' as an echo argument does not exempt a later raw mutation" 2
run_hook 'board get 1; gh project item-edit --id X'
expect_rc "bare-board invocation does not exempt a chained raw mutation" 2
run_hook 'curl -d query=mutation+deleteProjectV2Item https://api.github.com/graphql'
expect_rc "curl carrying an unquoted mutation still redirects" 2
run_hook '/opt/homebrew/bin/gh api graphql -f query="mutation { addSubIssue(input:{}) }"'
expect_rc "pathed gh api mutation still redirects" 2

# The refusal names the CLI the session actually calls: RALPH_BOARD when the
# session published one, the plugin-root fallback otherwise (already covered
# by test 1's "names the board CLI").
payload=$(jq -n --arg cmd 'gh project item-edit --id ITEM --field-id F' '{tool_input: {command: $cmd}}')
set +e
LAST_OUT=$(printf '%s' "$payload" | env RALPH_BOARD=/stable/spelling/board bash "$HOOK" 2>"$TMP_ROOT/stderr")
LAST_RC=$?
set -e
LAST_ERR=$(<"$TMP_ROOT/stderr")
expect_rc "redirect still fires with RALPH_BOARD set" 2
if [[ "$LAST_ERR" == *"/stable/spelling/board"* ]]; then
  pass "refusal text prefers RALPH_BOARD when set"
else
  fail "refusal text ignores RALPH_BOARD: $LAST_ERR"
fi

# ---------------------------------------------------------------------------
echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
