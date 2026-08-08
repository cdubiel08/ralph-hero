#!/usr/bin/env bash
# scripts/__tests__/hint-pr-linkage.test.sh
# Tests ralph/hooks/hint-pr-linkage.sh (the PostToolUse observation, GH-1717)
# by feeding it simulated hook payloads on stdin.
#
# The load-bearing property is NON-BLOCKING: every single case below asserts
# exit 0. This hook deliberately fails the funnel-merge test's redirect
# question (#1713) — there is no sanctioned alternative to `gh pr create`, so
# it observes and never gates. An exit 2 anywhere here is a defect.
#
# Second load-bearing property: the apply-unit carve-out. Merge gate 6
# (scripts/apply-keywords.sh) FORBIDS a closing keyword binding an apply-kind
# issue, so hinting "add a keyword" on apply work would push the agent into
# exactly what the gate blocks. The hook must stay silent there.
#
# `gh` is stubbed on PATH; its canned responses come from $STUB_DIR.

set -euo pipefail

HOOK="$(cd "$(dirname "$0")/../.." && pwd)/ralph/hooks/hint-pr-linkage.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# --- stub gh ----------------------------------------------------------------
export STUB_DIR="$TMP_ROOT/stub"
BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_DIR" "$BIN"
cat >"$BIN/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_DIR/calls.log"
case "${1:-} ${2:-}" in
  "pr view") cat "$STUB_DIR/pr.json" 2>/dev/null || exit 1 ;;
  "issue view") cat "$STUB_DIR/labels.txt" 2>/dev/null || exit 1 ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$BIN/gh"
export PATH="$BIN:$PATH"

# stub_pr <headRefName> <closing-count>
stub_pr() {
  local br="$1" n="$2" nodes="[]"
  [[ "$n" -gt 0 ]] && nodes='[{"number":42}]'
  jq -n --arg br "$br" --argjson nodes "$nodes" \
    '{headRefName: $br, closingIssuesReferences: $nodes}' >"$STUB_DIR/pr.json"
}
stub_labels() { printf '%s\n' "$@" >"$STUB_DIR/labels.txt"; }

# --- throwaway repos --------------------------------------------------------
#   SETTINGS_REPO — ralph scope via .claude/settings.json env block (ralph-hero's shape)
#   RALPHJSON_REPO — ralph scope via .ralph.json (the higher-precedence source)
#   PLAIN_REPO     — no ralph config at all; the hook must stay out of its way
#   OFFSCOPE_REPO  — ralph config present, but origin points at another repo
mk_repo() { # mk_repo <dir> <origin-url>
  mkdir -p "$1"
  git init -q "$1"
  git -C "$1" remote add origin "$2"
}
SETTINGS_REPO="$TMP_ROOT/settings"
RALPHJSON_REPO="$TMP_ROOT/ralphjson"
PLAIN_REPO="$TMP_ROOT/plain"
OFFSCOPE_REPO="$TMP_ROOT/offscope"
mk_repo "$SETTINGS_REPO" "https://github.com/cdubiel08/ralph-hero.git"
mk_repo "$RALPHJSON_REPO" "git@github.com:cdubiel08/ralph-hero.git"
mk_repo "$PLAIN_REPO" "https://github.com/cdubiel08/ralph-hero.git"
mk_repo "$OFFSCOPE_REPO" "https://github.com/someone-else/other-repo.git"

mkdir -p "$SETTINGS_REPO/.claude" "$SETTINGS_REPO/.github" \
  "$RALPHJSON_REPO/nested/sub" "$OFFSCOPE_REPO/.claude"
printf '{"env":{"RALPH_GH_OWNER":"cdubiel08","RALPH_GH_REPO":"ralph-hero","RALPH_GH_PROJECT_NUMBER":"12"}}\n' \
  >"$SETTINGS_REPO/.claude/settings.json"
printf '{"env":{"RALPH_GH_OWNER":"cdubiel08","RALPH_GH_REPO":"ralph-hero","RALPH_GH_PROJECT_NUMBER":"12"}}\n' \
  >"$OFFSCOPE_REPO/.claude/settings.json"
printf '{"owner":"cdubiel08","repo":"ralph-hero","projectNumber":12}\n' >"$RALPHJSON_REPO/.ralph.json"

# apply policy variants, dropped into SETTINGS_REPO on demand
POLICY="$SETTINGS_REPO/.github/ralph-merge-policy.json"
policy_armed() { printf '{"apply":{"enabled":true,"label":"ralph:apply"}}\n' >"$POLICY"; }
policy_inert() { printf '{"apply":{"enabled":false,"label":"ralph:apply"}}\n' >"$POLICY"; }
policy_none() { rm -f "$POLICY"; }

# --- driver -----------------------------------------------------------------
# run_hook <cwd> <command> [result-json] -> sets LAST_OUT, LAST_ERR, LAST_RC
# result-json defaults to a successful `gh pr create` (Bash-shaped tool_response).
OK_RESULT='{"exit_code":0,"stdout":"https://github.com/cdubiel08/ralph-hero/pull/777\n","stderr":""}'
run_hook() {
  local cwd="$1" cmd="$2"
  local result="${3:-$OK_RESULT}"
  local payload
  payload=$(jq -n --arg cmd "$cmd" --arg cwd "$cwd" --argjson r "$result" \
    '{tool_name: "Bash", hook_event_name: "PostToolUse",
      tool_input: {command: $cmd}, cwd: $cwd, tool_response: $r}')
  : >"$STUB_DIR/calls.log"
  set +e
  LAST_OUT=$(printf '%s' "$payload" | bash "$HOOK" 2>"$TMP_ROOT/stderr")
  LAST_RC=$?
  set -e
  LAST_ERR=$(<"$TMP_ROOT/stderr")
}

# expect_silent <desc>
expect_silent() {
  if [[ "$LAST_RC" == 0 && -z "$LAST_OUT" ]]; then
    pass "$1 (silent, exit 0)"
  else
    fail "$1 — expected silence+exit 0, got rc=$LAST_RC out='$LAST_OUT' err='$LAST_ERR'"
  fi
}

# expect_hint <desc>
expect_hint() {
  if [[ "$LAST_RC" != 0 ]]; then
    fail "$1 — hook must never exit non-zero, got rc=$LAST_RC (err: $LAST_ERR)"
  elif [[ "$LAST_OUT" == *"has no closing keyword"* && "$LAST_OUT" == *"PR #777"* ]]; then
    pass "$1 (hint emitted, exit 0)"
  else
    fail "$1 — expected the linkage hint, got out='$LAST_OUT' err='$LAST_ERR'"
  fi
}

echo "=== hint-pr-linkage.sh ==="

stub_pr "feature/GH-1717" 0
policy_none

# 1. Baseline: successful create, PR closes nothing, ralph-configured repo.
run_hook "$SETTINGS_REPO" "gh pr create --title t --body b"
expect_hint "unlinked PR in a configured repo emits the hint"

# The emitted line must be machine-readable, non-blocking hook output — a bare
# prose line on stdout is not a channel Claude reads for PostToolUse.
if jq -e '.hookSpecificOutput.hookEventName == "PostToolUse"' <<<"$LAST_OUT" >/dev/null 2>&1; then
  pass "hint is structured PostToolUse JSON (additionalContext channel)"
else
  fail "hint is not valid PostToolUse hook JSON: $LAST_OUT"
fi

# 2. Not a `gh pr create` at all.
run_hook "$SETTINGS_REPO" "gh pr list"
expect_silent "unrelated gh command"
run_hook "$SETTINGS_REPO" "npm test"
expect_silent "unrelated command entirely"

# 3. The PR already closes an issue -> nothing anomalous, stay quiet.
stub_pr "feature/GH-1717" 1
run_hook "$SETTINGS_REPO" "gh pr create --title t --body 'Closes #1717'"
expect_silent "PR with closing-issue linkage"
stub_pr "feature/GH-1717" 0

# 4. The create failed: no PR URL in the tool result.
run_hook "$SETTINGS_REPO" "gh pr create --title t" \
  '{"exit_code":1,"stdout":"","stderr":"pull request create failed: no commits"}'
expect_silent "failed gh pr create (no PR URL in result)"

# 5. -R/--repo targeting another repo -> out of jurisdiction, every form.
run_hook "$SETTINGS_REPO" "gh pr create -R other-org/other-repo --title t"
expect_silent "-R <val> (space) bypasses"
run_hook "$SETTINGS_REPO" "gh pr create --repo other-org/other-repo --title t"
expect_silent "--repo <val> (space) bypasses"
run_hook "$SETTINGS_REPO" "gh pr create --repo=other-org/other-repo --title t"
expect_silent "--repo=<val> bypasses"
run_hook "$SETTINGS_REPO" "gh pr create -Rother-org/other-repo --title t"
expect_silent "-R<val> (attached, GH-1684 shape) bypasses"
run_hook "$SETTINGS_REPO" "gh pr create -Rghe.example.com/other-org/other-repo --title t"
expect_silent "-R<host/owner/repo> (attached) bypasses"

# 6. Over-match guard: "-R"-prefixed prose with no slash is not a repo target.
run_hook "$SETTINGS_REPO" 'gh pr create --title t --body "-Release notes, no repo flag"'
expect_hint "-R-prefixed prose without a slash still observes"

# 7. Repos where the recommendation doesn't apply.
run_hook "$PLAIN_REPO" "gh pr create --title t"
expect_silent "repo with no ralph config"
run_hook "$OFFSCOPE_REPO" "gh pr create --title t"
expect_silent "ralph config present but origin is another repo"

# 8. .ralph.json as the scope source, from a subdirectory cwd (ROOT comes from
#    `git rev-parse --show-toplevel`), with an SSH-form origin.
run_hook "$RALPHJSON_REPO/nested/sub" "gh pr create --title t"
expect_hint ".ralph.json scope + ssh origin + subdirectory cwd"

# ---------------------------------------------------------------------------
# Payload-shape tolerance. The PostToolUse result field has drifted across
# releases; the hook flattens every string it finds rather than betting on one
# spelling. A rename must not silently turn this hook off.
# ---------------------------------------------------------------------------
run_hook "$SETTINGS_REPO" "gh pr create --title t" \
  '"https://github.com/cdubiel08/ralph-hero/pull/777"'
expect_hint "tool_response as a bare string"
run_hook "$SETTINGS_REPO" "gh pr create --title t" \
  '{"type":"text","text":"https://github.com/cdubiel08/ralph-hero/pull/777"}'
expect_hint "tool_response as {type,text}"

# The field itself renamed: a payload carrying `tool_output` and no
# `tool_response` at all must still be read.
: >"$STUB_DIR/calls.log"
set +e
LAST_OUT=$(jq -n '{tool_name: "Bash", tool_input: {command: "gh pr create --title t"},
    cwd: $cwd, tool_output: {type: "text", text: "https://github.com/cdubiel08/ralph-hero/pull/777"}}' \
  --arg cwd "$SETTINGS_REPO" | bash "$HOOK" 2>"$TMP_ROOT/stderr")
LAST_RC=$?
set -e
LAST_ERR=$(<"$TMP_ROOT/stderr")
expect_hint "payload uses tool_output instead of tool_response"

# ---------------------------------------------------------------------------
# Apply-unit carve-out (mandatory, GH-1692 gate 6).
# ---------------------------------------------------------------------------
policy_armed
stub_pr "feature/GH-1717" 0

# 9. The branch's issue IS an apply unit -> silent. Hinting here would push the
#    agent into the exact closing keyword scripts/apply-keywords.sh rejects.
stub_labels "ralph:apply" "enhancement"
run_hook "$SETTINGS_REPO" "gh pr create --title t"
expect_silent "apply-labelled branch issue (gate 6 forbids the keyword)"

# 10. Same repo, same armed policy, ordinary ship issue -> hint stands.
stub_labels "enhancement"
run_hook "$SETTINGS_REPO" "gh pr create --title t"
expect_hint "armed policy + non-apply branch issue"

# 11. A custom apply label is honoured (the policy's label, not a literal).
printf '{"apply":{"enabled":true,"label":"deploy-me"}}\n' >"$POLICY"
stub_labels "deploy-me"
run_hook "$SETTINGS_REPO" "gh pr create --title t"
expect_silent "custom apply.label from the policy file"
policy_armed

# 12. Policy present but not armed -> the label is meaningless, and the hook
#     must not spend an API call resolving it.
policy_inert
stub_labels "ralph:apply"
run_hook "$SETTINGS_REPO" "gh pr create --title t"
expect_hint "inert apply policy still observes"
if grep -q "issue view" "$STUB_DIR/calls.log"; then
  fail "inert apply policy must not call \`gh issue view\`"
else
  pass "inert apply policy skips the issue lookup entirely"
fi

# 13. Armed policy, but the branch carries no GH-N: the unit can't be
#     identified, so the carve-out can't fire. Documented limit — gate 6 is
#     the backstop. Asserted so a future change to this trade-off is deliberate.
policy_armed
stub_pr "chore/tidy-readme" 0
stub_labels "ralph:apply"
run_hook "$SETTINGS_REPO" "gh pr create --title t"
expect_hint "branch with no GH-N (carve-out cannot resolve a unit)"

# 14. Armed policy and the issue lookup fails (gh error) -> still non-blocking.
stub_pr "feature/GH-1717" 0
rm -f "$STUB_DIR/labels.txt"
run_hook "$SETTINGS_REPO" "gh pr create --title t"
expect_hint "issue lookup failure degrades to the hint, never to an error"

# 15. `gh pr view` itself fails -> silent, and certainly not an exit 2.
rm -f "$STUB_DIR/pr.json"
run_hook "$SETTINGS_REPO" "gh pr create --title t"
expect_silent "gh pr view failure"

# ---------------------------------------------------------------------------
echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
