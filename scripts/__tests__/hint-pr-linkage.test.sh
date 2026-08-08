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
  "issue view") cat "$STUB_DIR/labels-$3.txt" 2>/dev/null || cat "$STUB_DIR/labels.txt" 2>/dev/null || exit 1 ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$BIN/gh"
export PATH="$BIN:$PATH"

# stub_pr <headRefName> <closing-count> [title] [body]
stub_pr() {
  local br="$1" n="$2" title="${3:-a title}" body="${4:-a body}" nodes="[]"
  [[ "$n" -gt 0 ]] && nodes='[{"number":42}]'
  jq -n --arg br "$br" --arg t "$title" --arg b "$body" --argjson nodes "$nodes" \
    '{headRefName: $br, title: $t, body: $b, closingIssuesReferences: $nodes}' >"$STUB_DIR/pr.json"
}
stub_labels() { printf '%s\n' "$@" >"$STUB_DIR/labels.txt"; }
# stub_issue_labels <issue> <label>... — per-issue override of the above
stub_issue_labels() { local n="$1"; shift; printf '%s\n' "$@" >"$STUB_DIR/labels-$n.txt"; }

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

# 7b. Origin must BE the configured repo, not merely end with owner/repo. A
#     suffix test would accept a mirror on another forge — the case board.ts
#     scopeMatches() calls out by name.
MIRROR_REPO="$TMP_ROOT/mirror"
mk_repo "$MIRROR_REPO" "https://evil.example.com/cdubiel08/ralph-hero.git"
mkdir -p "$MIRROR_REPO/.claude"
cp "$SETTINGS_REPO/.claude/settings.json" "$MIRROR_REPO/.claude/settings.json"
run_hook "$MIRROR_REPO" "gh pr create --title t"
expect_silent "same owner/repo on a different forge"

DEEP_REPO="$TMP_ROOT/deep"
mk_repo "$DEEP_REPO" "https://github.com/enterprise/cdubiel08/ralph-hero.git"
mkdir -p "$DEEP_REPO/.claude"
cp "$SETTINGS_REPO/.claude/settings.json" "$DEEP_REPO/.claude/settings.json"
run_hook "$DEEP_REPO" "gh pr create --title t"
expect_silent "owner/repo nested under an extra path segment"

# 7c. The created PR's URL must be OUR repo's. A bare `/pull/N` match would let
#     a PR created in another clone (a `cd`, GH_REPO=…, `gh repo set-default` —
#     none of which the -R guard sees) name an unrelated LOCAL issue number.
run_hook "$SETTINGS_REPO" "cd ../other && gh pr create --title t" \
  '{"exit_code":0,"stdout":"https://github.com/some-other-org/some-other-repo/pull/777\n","stderr":""}'
expect_silent "created PR URL belongs to a different repo"

# 7d. gh prints an EXISTING PR's URL when a create fails because the branch
#     already has one. A non-zero exit_code is authoritative over the URL.
run_hook "$SETTINGS_REPO" "gh pr create --title t" \
  '{"exit_code":1,"stdout":"","stderr":"a pull request for branch feature/GH-1717 already exists: https://github.com/cdubiel08/ralph-hero/pull/777"}'
expect_silent "failed create whose stderr carries an existing PR URL"

# 7e. ...and the exit_code is NOT load-bearing: today's Bash tool_response
#     carries stdout/stderr and no exit status, so the same payload minus
#     exit_code must still be recognised as a failure.
run_hook "$SETTINGS_REPO" "gh pr create --title t" \
  '{"stdout":"","stderr":"a pull request for branch feature/GH-1717 already exists: https://github.com/cdubiel08/ralph-hero/pull/777","interrupted":false,"isImage":false}'
expect_silent "same failure with no exit_code field (the real payload shape)"

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
# ...and the silence must come from the label lookup, not from an earlier bail:
# without this the case would keep passing if a future edit exited sooner.
if grep -q "issue view 1717" "$STUB_DIR/calls.log"; then
  pass "carve-out silence is genuine (the issue's labels were actually read)"
else
  fail "carve-out never consulted the issue: $(cat "$STUB_DIR/calls.log")"
fi

# 9b. gh writes one label per line and `grep -q` exits on the first match; piped,
#     `pipefail` would turn gh's resulting EPIPE into a FAILED condition and skip
#     the carve-out. Apply label FIRST, then more than one pipe buffer (64 KiB)
#     of trailing labels, so the producer is still writing when grep quits —
#     under 64 KiB the write completes into the buffer and nothing reproduces.
{ echo "ralph:apply"; seq -f 'filler-label-%g' 1 20000; } >"$STUB_DIR/labels.txt"
run_hook "$SETTINGS_REPO" "gh pr create --title t"
expect_silent "apply label first, >64 KiB of trailing labels (no EPIPE race)"
stub_labels "ralph:apply" "enhancement"

# 9c. Apply units are REQUIRED to say "Refs #N" (gate 6 bans "Closes"), and an
#     `apply/…` branch carries no GH-N — the carve-out must still resolve them.
stub_pr "apply/arm-the-kind" 0 "apply: arm the kind" "Refs #1717 — deploy step"
run_hook "$SETTINGS_REPO" "gh pr create --title t"
expect_silent "apply unit resolved from 'Refs #N' on a branch with no GH-N"

# 9d. A body routinely names its epic or a superseded issue BEFORE the unit
#     itself, so stopping at the first reference reads the wrong issue's labels
#     and the apply unit draws the hint anyway. Every reference must be checked.
stub_issue_labels 1692 "epic"
stub_issue_labels 1400 "enhancement"
stub_issue_labels 1717 "ralph:apply"
stub_pr "apply/arm-the-kind" 0 "apply: arm the kind (part of #1692)" \
  "Supersedes #1400. Epic #1692. Refs #1717 — the actual unit."
run_hook "$SETTINGS_REPO" "gh pr create --title t"
expect_silent "apply unit named AFTER an epic/superseded reference"
rm -f "$STUB_DIR"/labels-*.txt
stub_pr "feature/GH-1717" 0

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

# 12b. A malformed policy fails CLOSED — same rule as scripts/apply-keywords.sh
#      ("a truncated policy must not silently disable the gate it configures").
printf '{"apply":{"enabled":true,' >"$POLICY"
stub_labels "ralph:apply"
run_hook "$SETTINGS_REPO" "gh pr create --title t"
expect_silent "malformed policy fails closed (carve-out stays armed)"

# 12c. A non-string apply.label must not silently disable the carve-out — jq's
#      `//` only defends against null/absent, so `[]` would emit a literal "[]".
printf '{"apply":{"enabled":true,"label":[]}}\n' >"$POLICY"
run_hook "$SETTINGS_REPO" "gh pr create --title t"
expect_silent "non-string apply.label falls back to the default label"

# 12d. A policy that PARSES but has the wrong shape. `jq -e .` only proves the
#      file is valid JSON; indexing a scalar makes jq exit 5, and under `set -e`
#      that would become the hook's exit status. `"apply": true` and
#      `"apply": "ralph:apply"` are the plausible hand-edit typos.
while IFS= read -r bad_policy; do
  printf '%s\n' "$bad_policy" >"$POLICY"
  run_hook "$SETTINGS_REPO" "gh pr create --title t"
  expect_silent "wrong-shape policy fails closed: $bad_policy"
done <<'POLICIES'
{"apply":"yes"}
{"apply":true}
{"apply":[1,2]}
{"apply":42}
[1,2,3]
"a bare json string"
42
POLICIES

# 13. Armed policy, but nothing in the branch, title, or body names a unit: the
#     carve-out can't fire. Documented limit — gate 6 is the backstop. Asserted
#     so a future change to this trade-off has to be deliberate.
policy_armed
stub_pr "chore/tidy-readme" 0 "tidy the readme" "no references here"
stub_labels "ralph:apply"
run_hook "$SETTINGS_REPO" "gh pr create --title t"
expect_hint "PR naming no unit at all (carve-out cannot resolve one)"

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
# Never-non-zero, under hostile conditions. The whole design rests on this, so
# it gets tested directly rather than inferred from the happy-path cases above.
# ---------------------------------------------------------------------------
stub_pr "feature/GH-1717" 0
policy_none

# 16. The emit itself must not leak a status. `set -e` makes an unguarded final
#     jq the hook's exit status, and jq exits 2 when it cannot write — which is
#     exactly the blocking value. Closing stdout reproduces that.
set +e
printf '%s' "$(jq -n --arg cwd "$SETTINGS_REPO" --argjson r "$OK_RESULT" \
  '{tool_input: {command: "gh pr create --title t"}, cwd: $cwd, tool_response: $r}')" \
  | bash "$HOOK" >&- 2>/dev/null
EMIT_RC=$?
set -e
if [[ "$EMIT_RC" == 0 ]]; then
  pass "emit with stdout closed still exits 0"
else
  fail "emit with stdout closed exited $EMIT_RC — a hook that can exit 2 gates the turn"
fi

# 17. Malformed and hostile payloads: silent, exit 0, never a hook error.
while IFS= read -r bad; do
  set +e
  BAD_OUT=$(printf '%s' "$bad" | bash "$HOOK" 2>/dev/null)
  BAD_RC=$?
  set -e
  if [[ "$BAD_RC" != 0 ]]; then
    fail "hostile payload exited $BAD_RC: ${bad:0:60}"
  elif [[ -n "$BAD_OUT" ]]; then
    fail "hostile payload produced output: ${bad:0:60}"
  else
    pass "hostile payload handled silently: ${bad:0:40}"
  fi
done <<'PAYLOADS'
not json at all
{"tool_input": {"command": "gh pr create"}
null
[]
{"tool_input": {"command": 42}, "cwd": "/nonexistent/nowhere"}
{"tool_input": {"command": "gh pr create"}, "cwd": "/nonexistent/nowhere"}
{"tool_input": {"command": "gh pr create"}}
PAYLOADS

# 18. Empty stdin.
set +e
BAD_OUT=$(printf '' | bash "$HOOK" 2>/dev/null)
BAD_RC=$?
set -e
if [[ "$BAD_RC" == 0 && -z "$BAD_OUT" ]]; then
  pass "empty stdin handled silently"
else
  fail "empty stdin: rc=$BAD_RC out='$BAD_OUT'"
fi

# ---------------------------------------------------------------------------
echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
