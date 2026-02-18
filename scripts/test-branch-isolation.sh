#!/bin/bash
# Integration test: verify branch isolation for impl workflow
#
# Usage: ./scripts/test-branch-isolation.sh
#
# Tests:
# 1. create-worktree.sh creates proper worktree
# 2. impl-worktree-gate blocks writes outside worktree
# 3. impl-branch-gate blocks git operations on main
#
# NOTE: Tests 2-3 validate blocking behavior by running hooks from the
# main repo root (not from inside a worktree). If this script is invoked
# from a worktree, it resolves the main repo via --git-common-dir.

set -e

# Resolve the MAIN repo root even when run from inside a worktree
GIT_COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "")
if [[ -n "$GIT_COMMON_DIR" && "$GIT_COMMON_DIR" != ".git" && "$GIT_COMMON_DIR" != "$(pwd)/.git" ]]; then
  MAIN_ROOT=$(dirname "$GIT_COMMON_DIR")
else
  MAIN_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
fi

# PROJECT_ROOT is the worktree or repo we're running from (where scripts/ lives)
PROJECT_ROOT=$(git rev-parse --show-toplevel)

cd "$PROJECT_ROOT"

TICKET="GH-TEST-$$"  # Unique per run
PASS=0
FAIL=0
HOOK_DIR="$PROJECT_ROOT/plugin/ralph-hero/hooks/scripts"

check() {
  local desc="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected=$expected, got=$actual)"
    FAIL=$((FAIL + 1))
  fi
}

# Run a hook from a specific directory with RALPH_COMMAND=impl
# Usage: run_hook_from <dir> <hook-script> <json-input>
# Returns: exit code of the hook
run_hook_from() {
  local dir="$1"
  local hook="$2"
  local input="$3"
  local rc=0
  (export RALPH_COMMAND="impl" && cd "$dir" && echo "$input" | bash "$hook") 2>/dev/null || rc=$?
  echo "$rc"
}

echo "=== Branch Isolation Integration Tests ==="
echo "Main repo: $MAIN_ROOT"
echo "Script root: $PROJECT_ROOT"
echo ""

# Test 1: create-worktree.sh
echo "Test 1: Worktree creation"
./scripts/create-worktree.sh "$TICKET"
check "Worktree directory exists" "true" "$([ -d worktrees/$TICKET ] && echo true || echo false)"
check "Branch created" "true" "$(git show-ref --verify --quiet refs/heads/feature/$TICKET && echo true || echo false)"

# Test 2: impl-worktree-gate blocks outside worktree
# Run blocking test from main repo root so CWD doesn't contain /worktrees/
echo ""
echo "Test 2: Worktree gate enforcement"

result=$(run_hook_from "$MAIN_ROOT" "$HOOK_DIR/impl-worktree-gate.sh" \
  '{"tool_name":"Write","tool_input":{"file_path":"'"$MAIN_ROOT"'/plugin/ralph-hero/test-file.txt"}}')
check "Write outside worktree blocked" "2" "$result"

result=$(run_hook_from "$PROJECT_ROOT" "$HOOK_DIR/impl-worktree-gate.sh" \
  '{"tool_name":"Write","tool_input":{"file_path":"'"$PROJECT_ROOT"'/worktrees/'"$TICKET"'/test-file.txt"}}')
check "Write inside worktree allowed" "0" "$result"

# Test 3: impl-branch-gate blocks on main
# Run blocking test from main repo root (which is on the 'main' branch)
echo ""
echo "Test 3: Branch gate enforcement"

result=$(run_hook_from "$MAIN_ROOT" "$HOOK_DIR/impl-branch-gate.sh" \
  '{"tool_name":"Bash","tool_input":{"command":"git commit -m test"}}')
check "Git commit on main blocked" "2" "$result"

result=$(run_hook_from "$PROJECT_ROOT/worktrees/$TICKET" "$HOOK_DIR/impl-branch-gate.sh" \
  '{"tool_name":"Bash","tool_input":{"command":"git commit -m test"}}')
check "Git commit on feature branch allowed" "0" "$result"

# Cleanup
echo ""
echo "Cleaning up test worktree..."
./scripts/remove-worktree.sh "$TICKET"
git branch -D "feature/$TICKET" 2>/dev/null || true

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
