---
date: 2026-02-17
status: draft
type: feature
parent_epic: 2026-02-17-ralph-hero-v3-architecture-epic.md
github_issues: []
---

# Plan 1: Critical Bug Fixes - Branch Isolation & Worktree Enforcement

## Overview

Ralph-hero agents performing implementation work on tickets write changes directly to the main branch instead of isolated worktree branches. This is caused by three reinforcing bugs: (1) the worktree gate hook only warns but never blocks, (2) the `create-worktree.sh` script is missing from the repo, and (3) the impl postcondition doesn't verify worktree isolation. This plan fixes all three and adds enforcement hooks to make worktree violations impossible.

## Current State Analysis

### Bug 1: impl-worktree-gate.sh only warns

**File**: `plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh:9`

```bash
# Exit codes:
#   0 - Always allows (warnings only)
```

The hook checks if the current directory contains "worktrees" but exits 0 regardless. Write/Edit operations proceed even when the agent is in the main repo directory.

### Bug 2: create-worktree.sh missing

**File**: `plugin/ralph-hero/skills/ralph-impl/SKILL.md` Step 5.3 references:
```bash
./scripts/create-worktree.sh "$WORKTREE_ID" [--epic "GH-$EPIC_NUMBER" if epic]
```

But `create-worktree.sh` does not exist in the current repo. The only copy is in an old LAN-164 worktree at `/home/chad_a_dubiel/projects/landcrawler-worktrees/LAN-164/ralph-hero/scripts/`. The current `plugin/ralph-hero/scripts/` directory only contains `ralph-loop.sh` and `ralph-team-loop.sh`.

### Bug 3: Postconditions don't enforce worktree isolation

**File**: `plugin/ralph-hero/hooks/scripts/impl-postcondition.sh`

The Stop hook only checks if a worktree *exists* and reports branch commit count. It doesn't verify that implementation changes were actually made IN the worktree (not in main repo). It always exits 0.

### Bug 4: impl-verify-commit.sh only warns

**File**: `plugin/ralph-hero/hooks/scripts/impl-verify-commit.sh`

Post-commit validation warns about failures but always allows (exit 0). Push rejections and pre-commit hook failures should be blocking errors.

### Bug 5: Branch ambiguity for impl skill

The impl SKILL registers `branch-gate.sh` for Bash commands... but `branch-gate.sh` enforces being on `main`. The impl skill needs to be on a FEATURE branch, not main. Looking at the skill frontmatter, actually it does NOT register branch-gate - only the research and plan skills do. But the plugin-level `hooks.json` registers `pre-worktree-validator.sh` for ALL Bash commands globally. This only checks for worktree collisions, not branch correctness.

### Root Cause

When ralph-team spawns the implementer agent:
1. Agent starts in the project root directory (on main branch)
2. Impl skill Step 5 instructs the agent to create/cd into a worktree
3. `create-worktree.sh` doesn't exist → script fails silently
4. Agent falls through and writes files to the main repo
5. `impl-worktree-gate.sh` sees the wrong directory but only warns (exit 0)
6. All changes go to main

## Desired End State

After this plan:
- `create-worktree.sh` and `remove-worktree.sh` exist at the repo root `scripts/` directory
- `impl-worktree-gate.sh` BLOCKS (exit 2) any Write/Edit targeting files outside a worktree during implementation
- `impl-postcondition.sh` BLOCKS (exit 2) if no commits exist on a feature branch
- `impl-verify-commit.sh` BLOCKS (exit 2) on push rejection (to prevent silent failures)
- Running `ralph_team` on itself produces changes on `feature/GH-NNN` branches, not main

### Verification

- [ ] Running impl skill creates a worktree at `worktrees/GH-NNN/`
- [ ] Write/Edit operations outside worktrees are blocked with clear error message
- [ ] Commits land on `feature/GH-NNN` branch, not main
- [ ] `ralph_team` on a test issue creates proper branch isolation

## What We're NOT Doing

- Refactoring spawn prompt templates (Plan 2)
- Making skills fork-by-default (Plan 3)
- Changing the memory layer (Plan 4)
- Modifying the MCP server
- Changing workflow states or the state machine

## Implementation Approach

Fix bugs bottom-up: first restore the missing scripts, then upgrade hooks from warn→block, then update the skill to handle the corrected paths.

---

## Phase 1: Restore Worktree Management Scripts

### Overview
Add `create-worktree.sh` and `remove-worktree.sh` to the repo. These scripts create git worktrees for isolated feature development and are referenced by the impl skill.

### Changes Required

#### 1. Create `scripts/create-worktree.sh`

**File**: `scripts/create-worktree.sh` (new file at REPO ROOT, not under plugin/)

Based on the working version from LAN-164 worktree, adapted for ralph-hero's structure:

```bash
#!/bin/bash
# Create a git worktree for isolated feature development
#
# Usage: ./scripts/create-worktree.sh TICKET-ID [branch-name]
#
# Examples:
#   ./scripts/create-worktree.sh GH-42
#   ./scripts/create-worktree.sh GH-42 my-custom-branch

set -e

TICKET_ID="${1:?Usage: $0 TICKET_ID [BRANCH_NAME]}"
BRANCH_NAME="${2:-feature/$TICKET_ID}"

# Always resolve from git root to handle being called from any directory
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [[ -z "$PROJECT_ROOT" ]]; then
  echo "Error: Not in a git repository"
  exit 1
fi

WORKTREE_BASE="$PROJECT_ROOT/worktrees"
WORKTREE_PATH="$WORKTREE_BASE/$TICKET_ID"

cd "$PROJECT_ROOT"

mkdir -p "$WORKTREE_BASE"

echo "Fetching latest from origin..."
git fetch origin main 2>/dev/null || git fetch origin master 2>/dev/null || echo "Warning: Could not fetch from origin"

BASE_BRANCH="origin/main"
if ! git rev-parse --verify "$BASE_BRANCH" &>/dev/null; then
  BASE_BRANCH="origin/master"
  if ! git rev-parse --verify "$BASE_BRANCH" &>/dev/null; then
    echo "Error: Could not find origin/main or origin/master"
    exit 1
  fi
fi

if [ -d "$WORKTREE_PATH" ]; then
  echo "Worktree already exists at: $WORKTREE_PATH"
  CURRENT_BRANCH=$(cd "$WORKTREE_PATH" && git branch --show-current 2>/dev/null || echo "unknown")
  echo "Current branch: $CURRENT_BRANCH"
  echo "Use: cd $WORKTREE_PATH"
  exit 0
fi

if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
  echo "Branch $BRANCH_NAME exists, checking out..."
  git worktree add "$WORKTREE_PATH" "$BRANCH_NAME"
else
  echo "Creating new branch $BRANCH_NAME from $BASE_BRANCH..."
  git worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" "$BASE_BRANCH"
fi

echo ""
echo "Worktree created successfully!"
echo "  Path: $WORKTREE_PATH"
echo "  Branch: $BRANCH_NAME"
echo ""
echo "To work in this worktree:"
echo "  cd $WORKTREE_PATH"
```

#### 2. Create `scripts/remove-worktree.sh`

**File**: `scripts/remove-worktree.sh` (new file at REPO ROOT)

```bash
#!/bin/bash
# Remove a git worktree
#
# Usage: ./scripts/remove-worktree.sh TICKET-ID

set -e

TICKET_ID="${1:?Usage: $0 TICKET_ID}"

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [[ -z "$PROJECT_ROOT" ]]; then
  echo "Error: Not in a git repository"
  exit 1
fi

WORKTREE_PATH="$PROJECT_ROOT/worktrees/$TICKET_ID"

if [ ! -d "$WORKTREE_PATH" ]; then
  echo "No worktree found at: $WORKTREE_PATH"
  exit 0
fi

cd "$PROJECT_ROOT"

echo "Removing worktree: $WORKTREE_PATH"
git worktree remove "$WORKTREE_PATH" --force
echo "Worktree removed: $TICKET_ID"
```

#### 3. Make scripts executable

```bash
chmod +x scripts/create-worktree.sh scripts/remove-worktree.sh
```

### Success Criteria

#### Automated Verification:
- [ ] `scripts/create-worktree.sh` exists and is executable
- [ ] `scripts/remove-worktree.sh` exists and is executable
- [ ] Running `./scripts/create-worktree.sh GH-TEST` from repo root creates `worktrees/GH-TEST/` on branch `feature/GH-TEST`
- [ ] Running `./scripts/remove-worktree.sh GH-TEST` removes the worktree cleanly
- [ ] Running create-worktree twice for the same ticket exits gracefully (idempotent)

#### Manual Verification:
- [ ] Scripts work when called from any subdirectory (not just repo root)

---

## Phase 2: Upgrade Hooks from Warn to Block

### Overview
Convert impl hooks from advisory warnings (exit 0) to blocking enforcement (exit 2). This is the core fix that prevents changes from landing on main.

### Changes Required

#### 1. Fix `impl-worktree-gate.sh` to BLOCK

**File**: `plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh`

Replace entire file:

```bash
#!/bin/bash
# ralph-hero/hooks/scripts/impl-worktree-gate.sh
# PreToolUse (Write|Edit): Block writes outside worktree during implementation
#
# Environment:
#   RALPH_COMMAND - Current command (only enforced for "impl")
#
# Exit codes:
#   0 - Allowed (in worktree or non-impl command)
#   2 - Blocked (impl writes outside worktree)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Only enforce for impl command
if [[ "${RALPH_COMMAND:-}" != "impl" ]]; then
  allow
fi

file_path=$(get_field '.tool_input.file_path')

# Allow writes to thoughts/ and docs/ (research artifacts go on main)
if [[ "$file_path" == *"/thoughts/"* ]] || [[ "$file_path" == *"/docs/"* ]]; then
  allow
fi

# Check if file_path is inside a worktree
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
if [[ -n "$PROJECT_ROOT" ]]; then
  WORKTREE_BASE="$PROJECT_ROOT/worktrees"
  if [[ "$file_path" == "$WORKTREE_BASE/"* ]]; then
    allow
  fi
fi

# Check if CWD is in a worktree (agent may use relative paths)
current_dir="$(pwd)"
if [[ "$current_dir" == *"/worktrees/"* ]]; then
  allow
fi

block "Implementation writes must be in a worktree

File: $file_path
Current directory: $current_dir

To fix:
1. Create worktree: ./scripts/create-worktree.sh GH-NNN
2. Change to worktree: cd worktrees/GH-NNN/
3. Then make your changes

Implementation requires branch isolation to prevent changes on main."
```

#### 2. Upgrade `impl-verify-commit.sh` to block on push rejection

**File**: `plugin/ralph-hero/hooks/scripts/impl-verify-commit.sh`

Replace the push rejection and pre-commit failure handling:

```bash
#!/bin/bash
# ralph-hero/hooks/scripts/impl-verify-commit.sh
# PostToolUse (Bash): Verify phase commit/push succeeded
#
# Exit codes:
#   0 - Git operation successful or not a git command
#   2 - Push rejected or pre-commit hook failed (blocks)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

command=$(get_field '.tool_input.command')
if [[ -z "$command" ]]; then
  allow
fi

if [[ "$command" != *"git commit"* ]] && [[ "$command" != *"git push"* ]]; then
  allow
fi

tool_output=$(get_field '.tool_output // ""')

if [[ "$tool_output" == *"nothing to commit"* ]]; then
  warn "Git commit had nothing to commit. Phase changes may not have been staged with 'git add'."
fi

if [[ "$tool_output" == *"rejected"* ]] || [[ "$tool_output" == *"failed to push"* ]]; then
  block "Git push was rejected

$tool_output

To fix: git pull --rebase origin [branch] && git push

Do not proceed to the next phase until push succeeds."
fi

if [[ "$tool_output" == *"pre-commit hook"* ]] && [[ "$tool_output" == *"failed"* ]]; then
  block "Pre-commit hook failed

$tool_output

Fix the issues reported by the pre-commit hook before continuing."
fi

allow
```

#### 3. Upgrade `impl-postcondition.sh` to verify worktree work

**File**: `plugin/ralph-hero/hooks/scripts/impl-postcondition.sh`

Replace entire file:

```bash
#!/bin/bash
# ralph-hero/hooks/scripts/impl-postcondition.sh
# Stop: Verify implementation made progress in a worktree
#
# Exit codes:
#   0 - Postconditions met (work done in worktree)
#   2 - No worktree work detected (blocks session end)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Only enforce for impl command
if [[ "${RALPH_COMMAND:-}" != "impl" ]]; then
  allow
fi

ticket_id="${RALPH_TICKET_ID:-}"
if [[ -z "$ticket_id" ]]; then
  current_dir="$(pwd)"
  ticket_id=$(echo "$current_dir" | grep -oE 'GH-[0-9]+' | head -1)
fi

# If we can't determine the ticket, allow (may be early exit)
if [[ -z "$ticket_id" ]]; then
  allow
fi

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "$(pwd)")
worktree_path="$PROJECT_ROOT/worktrees/$ticket_id"

if [[ ! -d "$worktree_path" ]]; then
  block "Implementation postcondition failed: No worktree found

Expected worktree at: $worktree_path
Ticket: $ticket_id

Implementation must create and work in a worktree.
Run: ./scripts/create-worktree.sh $ticket_id"
fi

# Check that the feature branch has commits ahead of main
branch_name="feature/$ticket_id"
if git -C "$worktree_path" rev-parse --verify "$branch_name" >/dev/null 2>&1; then
  commit_count=$(git -C "$worktree_path" rev-list --count "main..$branch_name" 2>/dev/null || echo "0")
  if [[ "$commit_count" == "0" ]]; then
    warn "Worktree exists but branch $branch_name has no commits ahead of main. Phase may not have completed."
  else
    echo "Implementation postcondition passed: $commit_count commit(s) on $branch_name"
  fi
fi

allow
```

### Success Criteria

#### Automated Verification:
- [ ] `impl-worktree-gate.sh` exits 2 when `RALPH_COMMAND=impl` and file_path is outside worktrees/
- [ ] `impl-worktree-gate.sh` exits 0 when file_path is inside worktrees/ or in thoughts/
- [ ] `impl-worktree-gate.sh` exits 0 when `RALPH_COMMAND` is not "impl" (e.g., research, plan)
- [ ] `impl-verify-commit.sh` exits 2 when git push is rejected
- [ ] `impl-verify-commit.sh` exits 2 when pre-commit hook fails
- [ ] `impl-postcondition.sh` exits 2 when no worktree exists for the ticket
- [ ] All hook scripts pass shellcheck: `shellcheck plugin/ralph-hero/hooks/scripts/impl-*.sh`

#### Manual Verification:
- [ ] Running impl skill without creating a worktree first is blocked with a clear error message
- [ ] The error message tells the agent exactly how to fix the issue

---

## Phase 3: Update Impl Skill Worktree Paths

### Overview
Fix the impl SKILL.md to reference the correct script paths and handle worktree creation robustly. The skill currently references `./scripts/create-worktree.sh` relative to an unclear CWD - it should use paths relative to the git root.

### Changes Required

#### 1. Fix worktree path in impl SKILL.md

**File**: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`

Update Step 5.2 and 5.3 to use consistent, absolute-relative paths:

In the "Step 5: Set Up or Reuse Worktree" section, replace the worktree path resolution:

**Old** (Step 5.3):
```bash
WORKTREE_PATH="../worktrees/$WORKTREE_ID"
if [ -d "$WORKTREE_PATH" ]; then
    cd "$WORKTREE_PATH"
    git fetch origin main && git pull origin "$(git branch --show-current)" --no-edit
else
    ./scripts/create-worktree.sh "$WORKTREE_ID" [--epic "GH-$EPIC_NUMBER" if epic]
    cd "$WORKTREE_PATH"
fi
```

**New** (Step 5.3):
```bash
# Resolve paths from git root (works from any directory)
GIT_ROOT=$(git rev-parse --show-toplevel)
WORKTREE_PATH="$GIT_ROOT/worktrees/$WORKTREE_ID"

if [ -d "$WORKTREE_PATH" ]; then
    cd "$WORKTREE_PATH"
    git fetch origin main && git pull origin "$(git branch --show-current)" --no-edit
    # If merge conflict -> escalate (5.4)
else
    "$GIT_ROOT/scripts/create-worktree.sh" "$WORKTREE_ID"
    cd "$WORKTREE_PATH"
fi
```

Also add a new note after Step 5:

```markdown
**CRITICAL**: After `cd "$WORKTREE_PATH"`, ALL subsequent file operations (Read, Write, Edit, Bash)
must use paths relative to the worktree OR absolute paths within the worktree.
The impl-worktree-gate hook will BLOCK any Write/Edit outside the worktree directory.
```

#### 2. Remove `--epic` flag reference

The old `create-worktree.sh` from LAN-164 didn't support `--epic` either. Remove the `[--epic "GH-$EPIC_NUMBER" if epic]` parameter from the call in Step 5.3 - the worktree ID already handles this via the WORKTREE_ID determination in Step 5.2.

### Success Criteria

#### Automated Verification:
- [ ] Impl SKILL.md references `$GIT_ROOT/scripts/create-worktree.sh` (not `./scripts/`)
- [ ] No references to `../worktrees` remain in impl SKILL.md (use `$GIT_ROOT/worktrees`)
- [ ] No references to `--epic` flag in create-worktree calls

#### Manual Verification:
- [ ] Reading the updated SKILL.md, the worktree creation flow is unambiguous regardless of CWD
- [ ] The impl agent, when invoked, creates a proper worktree and operates within it

---

## Phase 4: Add Branch Enforcement for Impl Agent

### Overview
Add a PreToolUse hook that validates the impl agent is on a feature branch (not main) before allowing git operations. This is the inverse of the research/plan `branch-gate.sh` which requires main.

### Changes Required

#### 1. Create `impl-branch-gate.sh`

**File**: `plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh` (new)

```bash
#!/bin/bash
# ralph-hero/hooks/scripts/impl-branch-gate.sh
# PreToolUse (Bash): Block git operations on main during implementation
#
# Inverse of branch-gate.sh - impl must NOT be on main for git commit/push.
# Research/plan skills require main; impl requires a feature branch.
#
# Exit codes:
#   0 - Allowed (on feature branch or non-git command)
#   2 - Blocked (on main during impl git operation)

set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

read_input > /dev/null

# Only enforce for impl command
if [[ "${RALPH_COMMAND:-}" != "impl" ]]; then
  allow
fi

command=$(get_field '.tool_input.command')
if [[ -z "$command" ]]; then
  allow
fi

# Only check git commit/push/add operations
if [[ "$command" != *"git commit"* ]] && [[ "$command" != *"git push"* ]] && [[ "$command" != *"git add"* ]]; then
  allow
fi

# Allow git checkout/switch commands (agent may be switching TO a worktree)
if [[ "$command" =~ ^[[:space:]]*git[[:space:]]+(checkout|switch) ]]; then
  allow
fi

# Check current branch
current_branch=$(git branch --show-current 2>/dev/null || echo "unknown")

if [[ "$current_branch" == "main" ]] || [[ "$current_branch" == "master" ]]; then
  block "Implementation git operations blocked on main branch

Current branch: $current_branch
Command: $command

Implementation must commit to a feature branch, not main.

To fix:
1. Create worktree: ./scripts/create-worktree.sh GH-NNN
2. cd worktrees/GH-NNN/
3. Then run your git commands

Never commit implementation changes to main."
fi

allow
```

#### 2. Register the hook in impl skill frontmatter

**File**: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`

Add to the PreToolUse hooks section:

```yaml
hooks:
  PreToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-plan-required.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-worktree-gate.sh"
    - matcher: "ralph_hero__update_workflow_state"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-state-gate.sh"
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-branch-gate.sh"
```

### Success Criteria

#### Automated Verification:
- [ ] `impl-branch-gate.sh` exists and is executable
- [ ] `impl-branch-gate.sh` exits 2 when on main and command contains `git commit`
- [ ] `impl-branch-gate.sh` exits 0 when on `feature/GH-42` and command contains `git commit`
- [ ] `impl-branch-gate.sh` exits 0 for non-git Bash commands
- [ ] `impl-branch-gate.sh` exits 0 for `git checkout` commands (switching branches)
- [ ] Hook is registered in impl SKILL.md frontmatter
- [ ] `shellcheck plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh` passes

#### Manual Verification:
- [ ] Running `/ralph-impl NNN` while on main is blocked at the git commit step with a clear error

---

## Phase 5: Integration Test - ralph_team Self-Work

### Overview
Verify the complete fix by simulating what triggered the original bug: ralph_team working on ralph-hero itself. Create a test issue and ensure the full pipeline creates a proper worktree and feature branch.

### Changes Required

#### 1. Create integration test script

**File**: `scripts/test-branch-isolation.sh` (new)

```bash
#!/bin/bash
# Integration test: verify branch isolation for impl workflow
#
# Usage: ./scripts/test-branch-isolation.sh
#
# Tests:
# 1. create-worktree.sh creates proper worktree
# 2. impl-worktree-gate blocks writes outside worktree
# 3. impl-branch-gate blocks git operations on main
# 4. impl-postcondition verifies worktree exists

set -e

PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT"

TICKET="GH-TEST-$$"  # Unique per run
PASS=0
FAIL=0

check() {
  local desc="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS: $desc"
    ((PASS++))
  else
    echo "  FAIL: $desc (expected=$expected, got=$actual)"
    ((FAIL++))
  fi
}

echo "=== Branch Isolation Integration Tests ==="
echo ""

# Test 1: create-worktree.sh
echo "Test 1: Worktree creation"
./scripts/create-worktree.sh "$TICKET"
check "Worktree directory exists" "true" "$([ -d worktrees/$TICKET ] && echo true || echo false)"
check "Branch created" "true" "$(git show-ref --verify --quiet refs/heads/feature/$TICKET && echo true || echo false)"

# Test 2: impl-worktree-gate blocks outside worktree
echo ""
echo "Test 2: Worktree gate enforcement"
export RALPH_COMMAND="impl"
echo '{"tool_name":"Write","tool_input":{"file_path":"'$PROJECT_ROOT'/plugin/ralph-hero/test-file.txt"}}' | \
  bash "$PROJECT_ROOT/plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh" 2>/dev/null
check "Write outside worktree blocked" "2" "$?"

echo '{"tool_name":"Write","tool_input":{"file_path":"'$PROJECT_ROOT'/worktrees/'$TICKET'/test-file.txt"}}' | \
  bash "$PROJECT_ROOT/plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh" 2>/dev/null
check "Write inside worktree allowed" "0" "$?"
unset RALPH_COMMAND

# Test 3: impl-branch-gate blocks on main
echo ""
echo "Test 3: Branch gate enforcement"
export RALPH_COMMAND="impl"
echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m test"}}' | \
  bash "$PROJECT_ROOT/plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh" 2>/dev/null
MAIN_RESULT=$?
check "Git commit on main blocked" "2" "$MAIN_RESULT"

cd "worktrees/$TICKET"
echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m test"}}' | \
  bash "$PROJECT_ROOT/plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh" 2>/dev/null
check "Git commit on feature branch allowed" "0" "$?"
cd "$PROJECT_ROOT"
unset RALPH_COMMAND

# Cleanup
echo ""
echo "Cleaning up test worktree..."
./scripts/remove-worktree.sh "$TICKET"
git branch -D "feature/$TICKET" 2>/dev/null || true

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
```

### Success Criteria

#### Automated Verification:
- [ ] `./scripts/test-branch-isolation.sh` passes all checks (exit 0)
- [ ] No residual test worktrees or branches after cleanup

#### Manual Verification:
- [ ] Run `/ralph-team [test-issue]` on the ralph-hero repo itself and verify changes land on a feature branch

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that ralph_team working on ralph-hero creates proper branch isolation.

---

## Testing Strategy

### Unit Tests (Hook Scripts):
- Each hook tested with piped JSON input matching the actual Claude Code hook format
- Test both allow and block paths
- Test edge cases: missing env vars, empty inputs, non-impl commands

### Integration Tests:
- `test-branch-isolation.sh` covers the full worktree lifecycle
- Manual test with ralph_team on a real issue

### Regression Prevention:
- The test script can be added to CI or run before releases
- Hook exit codes are now self-documenting (block = exit 2, warn = exit 0)

## References

- Bug report: ralph_team working on itself writes to main instead of branches
- Old working create-worktree.sh: `/home/chad_a_dubiel/projects/landcrawler-worktrees/LAN-164/ralph-hero/scripts/create-worktree.sh`
- Hook utils: `plugin/ralph-hero/hooks/scripts/hook-utils.sh`
- Impl skill: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`
- Ralph-team skill: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
