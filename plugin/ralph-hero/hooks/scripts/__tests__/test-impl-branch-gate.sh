#!/bin/bash
# Test impl-branch-gate.sh worktree-aware branch detection
#
# Covers:
#   1. cd-prefix to worktree feature branch is allowed
#   2. RALPH_WORKTREE_PATHS substring match without leading cd is allowed
#   3. cd-prefix resolving to main branch is blocked
#   4. git checkout is always allowed (existing behavior preserved)
#   5. non-impl context falls through allow

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
GATE="$HOOKS_DIR/impl-branch-gate.sh"

pass=0
fail=0

assert_eq() {
  local expected="$1" actual="$2" desc="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
  else
    echo "FAIL: $desc — expected '$expected', got '$actual'"
    fail=$((fail + 1))
  fi
}

# Build a minimal hook input JSON for testing
make_input() {
  local cmd="$1"
  local agent_type="${2:-}"
  # Use jq to safely escape the command string for embedding in JSON
  jq -n --arg cmd "$cmd" --arg at "$agent_type" \
    '{tool_name:"Bash", agent_type:$at, tool_input:{command:$cmd}}'
}

# ── Fixture: feature-branch worktree ──────────────────────────────────────
TMP_DIR=$(mktemp -d)
( cd "$TMP_DIR" \
  && git -c init.defaultBranch=main init -q \
  && git config user.email "test@test" \
  && git config user.name "test" \
  && git commit --allow-empty -qm "init" \
  && git checkout -qb GH-983-test ) > /dev/null

# ── Fixture: main-branch repo (deterministically named "main") ────────────
MAIN_TMP_DIR=$(mktemp -d)
( cd "$MAIN_TMP_DIR" \
  && git -c init.defaultBranch=main init -q \
  && git config user.email "test@test" \
  && git config user.name "test" \
  && git commit --allow-empty -qm "init" ) > /dev/null

trap 'rm -rf "$TMP_DIR" "$MAIN_TMP_DIR"' EXIT

# Sanity-check the fixtures so failures here are obvious.
fixture_branch=$(cd "$TMP_DIR" && git branch --show-current)
assert_eq "GH-983-test" "$fixture_branch" "Fixture: TMP_DIR is on feature branch GH-983-test"

main_branch=$(cd "$MAIN_TMP_DIR" && git branch --show-current)
assert_eq "main" "$main_branch" "Fixture: MAIN_TMP_DIR is on main branch"

# ── Test 1: cd-prefix to worktree feature branch is allowed ───────────────
input=$(make_input "cd $TMP_DIR && git commit -m test" "impl-agent")
result=$(echo "$input" | RALPH_COMMAND=impl bash "$GATE" 2>/dev/null; echo $?)
assert_eq "0" "$result" "cd-prefix to worktree feature branch is allowed"

# ── Test 2: RALPH_WORKTREE_PATHS substring match (no leading cd) ──────────
input=$(make_input "git -C $TMP_DIR add file.txt" "impl-agent")
result=$(echo "$input" | RALPH_COMMAND=impl RALPH_WORKTREE_PATHS="$TMP_DIR" bash "$GATE" 2>/dev/null; echo $?)
assert_eq "0" "$result" "RALPH_WORKTREE_PATHS substring match without leading cd is allowed"

# ── Test 3: cd-prefix resolving to main branch is blocked ─────────────────
input=$(make_input "cd $MAIN_TMP_DIR && git commit -m test" "impl-agent")
result=$(echo "$input" | RALPH_COMMAND=impl bash "$GATE" 2>/dev/null; echo $?)
assert_eq "2" "$result" "cd-prefix resolving to main branch is blocked"

# ── Test 4: git checkout is always allowed ────────────────────────────────
input=$(make_input "git checkout -b foo" "impl-agent")
result=$(echo "$input" | RALPH_COMMAND=impl bash "$GATE" 2>/dev/null; echo $?)
assert_eq "0" "$result" "git checkout is always allowed (existing behavior preserved)"

# ── Test 5: non-impl context falls through allow ──────────────────────────
input=$(make_input "git commit" "")
result=$(echo "$input" | bash "$GATE" 2>/dev/null; echo $?)
assert_eq "0" "$result" "non-impl context falls through allow"

echo ""
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]] || exit 1
