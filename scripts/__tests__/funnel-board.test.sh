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
run_hook() {
  local cmd="$1"
  local payload
  payload=$(jq -n --arg cmd "$cmd" '{tool_input: {command: $cmd}}')
  set +e
  LAST_OUT=$(printf '%s' "$payload" | bash "$HOOK" 2>"$TMP_ROOT/stderr")
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

# ---------------------------------------------------------------------------
echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
