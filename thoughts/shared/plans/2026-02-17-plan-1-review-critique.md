---
date: 2026-02-17
status: reviewed
type: review
reviews: 2026-02-17-plan-1-critical-bug-fixes.md
verdict: REJECT (fixable - 3 critical issues, 3 warnings)
---

# Plan 1 Review: Critical Bug Fixes - Branch Isolation & Worktree Enforcement

## Verdict: REJECT with required changes

The plan correctly identifies all five bugs and the proposed fix direction is architecturally sound. However, three critical implementation bugs in the proposed code would cause false-positive blocking or test failures in practice. All are fixable without changing the plan's architecture.

---

## Current State Analysis: VERIFIED ACCURATE

All five bug descriptions match the actual code:

| Bug | Claimed | Verified |
|-----|---------|----------|
| Bug 1: impl-worktree-gate.sh only warns | Exit 0 always | **Confirmed** - line 9: `0 - Always allows (warnings only)`, line 35: `allow` |
| Bug 2: create-worktree.sh missing | Not in repo | **Confirmed** - `scripts/` directory does not exist at repo root |
| Bug 3: Postcondition doesn't enforce | Always exit 0 | **Confirmed** - line 34: `echo "...passed"`, line 35: `allow` |
| Bug 4: impl-verify-commit.sh only warns | Uses `warn` not `block` | **Confirmed** - lines 25, 29, 33 all use `warn` |
| Bug 5: No branch enforcement for impl | No branch-gate in impl skill | **Confirmed** - impl SKILL.md has no Bash PreToolUse hooks |

Root cause analysis (Steps 1-6) is accurate.

---

## CRITICAL ISSUES (must fix before approval)

### C1: `impl-postcondition.sh` will false-positive block when CWD is in worktree

**Severity**: CRITICAL - Will block every successful impl session

**Location**: Phase 2, proposed `impl-postcondition.sh`, lines 388-389

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "$(pwd)")
worktree_path="$PROJECT_ROOT/worktrees/$ticket_id"
```

**Problem**: `git rev-parse --show-toplevel` when CWD is inside a worktree returns the **worktree path**, not the main repo root. Example:

- CWD = `/home/user/projects/ralph-hero/worktrees/GH-42` (agent cd'd here per SKILL Step 5.3)
- `--show-toplevel` returns `/home/user/projects/ralph-hero/worktrees/GH-42`
- `worktree_path` = `/home/user/projects/ralph-hero/worktrees/GH-42/worktrees/GH-42` (WRONG)
- `[ ! -d "$worktree_path" ]` is TRUE → script BLOCKs with "No worktree found"

The Stop hook fires when the session ends. The agent is almost certainly still in the worktree directory at that point (the SKILL told it to `cd` there in Step 5.3). **Every successful impl run would be blocked by the postcondition.**

**Fix**: Use `git rev-parse --git-common-dir` to find the main repo root:

```bash
GIT_COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "")
if [[ -n "$GIT_COMMON_DIR" && "$GIT_COMMON_DIR" != ".git" ]]; then
  # In a worktree - common dir points to main repo's .git
  PROJECT_ROOT=$(dirname "$GIT_COMMON_DIR")
else
  PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "$(pwd)")
fi
```

### C2: Integration test script has `set -e` bugs

**Severity**: CRITICAL - Test script will abort on first test instead of running all tests

**Location**: Phase 5, proposed `test-branch-isolation.sh`

**Problem 1**: The script uses `set -e` (line 636) but Tests 2 and 3 execute commands *expected* to exit non-zero (exit 2 from blocking hooks). Under `set -e`, the test script itself will exit on the first non-zero return, before `$?` can be captured.

```bash
# This line kills the test script when the hook exits 2:
echo '...' | bash "$PROJECT_ROOT/plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh" 2>/dev/null
check "Write outside worktree blocked" "2" "$?"   # Never reached
```

**Problem 2**: `((PASS++))` when PASS=0 evaluates to `((0))` which returns exit code 1 in bash. Under `set -e`, the first `check` that passes will kill the script.

**Fix**:
```bash
# Capture exit code safely:
result=0
echo '...' | bash "..." 2>/dev/null || result=$?
check "Write outside worktree blocked" "2" "$result"

# Use arithmetic assignment instead of (()):
PASS=$((PASS + 1))
FAIL=$((FAIL + 1))
```

### C3: `pre-worktree-validator.sh` checks wrong worktree path

**Severity**: CRITICAL - Worktree collision detection will silently fail

**Location**: Existing file `plugin/ralph-hero/hooks/scripts/pre-worktree-validator.sh`, line 12 (not addressed by plan)

```bash
WORKTREE_BASE="$PROJECT_ROOT/../worktrees"   # checks OUTSIDE repo
```

But the new `create-worktree.sh` creates worktrees at:
```bash
WORKTREE_BASE="$PROJECT_ROOT/worktrees"      # INSIDE repo
```

The plan introduces a `create-worktree.sh` that puts worktrees at `<repo-root>/worktrees/` but `pre-worktree-validator.sh` (registered as a global plugin hook for ALL Bash commands in `hooks.json`) still checks `<repo-root>/../worktrees/`. The collision detector will never find the worktrees created by the new script.

**Fix**: Add to Phase 2 or as a separate step: update `pre-worktree-validator.sh` line 12:
```bash
WORKTREE_BASE="$PROJECT_ROOT/worktrees"
```

---

## WARNINGS (should fix, non-blocking)

### W1: SKILL.md has other `../worktrees/` references not updated by Phase 3

Phase 3 only updates Step 5.3. These still use `../worktrees/`:

| Location | Current | Should Be |
|----------|---------|-----------|
| Step 2.6 (resumption check) | `ls ../worktrees/GH-NNN` | `ls "$GIT_ROOT/worktrees/GH-NNN"` |
| Address Mode A3 | `cd ../worktrees/GH-NNN` | `cd "$GIT_ROOT/worktrees/GH-NNN"` |
| Step 11 (final report) | `../worktrees/[WORKTREE_ID]` | `$GIT_ROOT/worktrees/[WORKTREE_ID]` |

### W2: Missing `.gitignore` entry for `worktrees/`

The plan creates worktrees inside the repo at `<repo-root>/worktrees/`. The repo has no root-level `.gitignore`, and the plugin `.gitignore` (`plugin/ralph-hero/.gitignore`) doesn't include `worktrees/`. Git status already shows `?? worktrees/` as untracked.

The plan should include adding `worktrees/` to a root `.gitignore` file.

### W3: `impl-worktree-gate.sh` file_path check unreliable in worktree CWD

Same `git rev-parse --show-toplevel` issue as C1. When CWD is in the worktree, `PROJECT_ROOT` is the worktree path, making `WORKTREE_BASE` point to `<worktree>/worktrees` (wrong). The file_path check becomes dead code. This is **saved** by the fallback CWD check (`pwd` contains `/worktrees/`), so it's not a functional bug, but it's fragile.

Recommend using the same `--git-common-dir` fix as C1 for consistency.

---

## MINOR OBSERVATIONS

1. **`get_field` usage with `// ""`**: `impl-verify-commit.sh` calls `get_field '.tool_output // ""'` which produces `jq -r '.tool_output // "" // empty'`. Works correctly but is redundant - `get_field '.tool_output'` would suffice since `get_field` already uses `// empty`.

2. **Phase 4 regex allows `git checkout main`**: The allowlist for `git checkout|switch` is broad. An agent could `git checkout main && git commit` in a single command. However, since the branch check looks at the current branch (before the command runs), and the command hasn't executed yet, this is a timing race that's unlikely in practice. The PostToolUse `impl-verify-commit.sh` provides a second layer of defense.

3. **`allow` function is terminal**: `allow` calls `exit 0`, so any code after it is dead. All proposed scripts use this correctly (no code after `allow`).

4. **Hook-utils `read_input` pattern**: The `read_input > /dev/null` idiom correctly caches stdin while suppressing output. The cached value in `RALPH_HOOK_INPUT` is available to subsequent `get_field` calls. All proposed scripts use this correctly.

---

## Verdict Summary

| Category | Count | Details |
|----------|-------|---------|
| Critical | 3 | C1: postcondition false-positive, C2: test script abort, C3: wrong worktree path in validator |
| Warning | 3 | W1: SKILL.md path refs, W2: .gitignore, W3: fragile file_path check |
| Minor | 4 | Cosmetic/style, no functional impact |

**Recommendation**: Fix C1-C3, address W1-W2, then re-review. The architecture and approach are correct. These are implementation bugs in the proposed code, not design flaws.
