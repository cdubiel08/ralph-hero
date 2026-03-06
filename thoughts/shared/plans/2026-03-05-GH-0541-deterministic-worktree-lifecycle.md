---
date: 2026-03-05
status: draft
github_issues: [541]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/541
primary_issue: 541
---

# Deterministic Worktree Lifecycle Management

## Overview

Worktree cleanup is currently LLM-dependent — skills must remember to call `remove-worktree.sh` at the right time, and the ordering in `ralph-merge` causes `--delete-branch` to fail because the branch is still checked out in a worktree. This plan makes cleanup implicit and deterministic through two mechanisms: a merge script that handles worktree removal atomically, and a SessionStart pruner that catches strays.

## Current State Analysis

### The Ordering Bug (`ralph-merge/SKILL.md:99-107`)

```bash
# Step 5: merge — tries to delete branch
gh pr merge NNN --merge --delete-branch    # FAILS: branch checked out in worktree

# Step 6: remove worktree — too late
./scripts/remove-worktree.sh GH-NNN
```

`--delete-branch` fails because git refuses to delete a branch checked out in a worktree. The skill says "warn but continue" on Step 6 failure, but the real failure is Step 5.

### No Automated Cleanup

The only removal paths are:
1. `ralph-merge` Step 6 (runs after the failing merge, LLM-dependent)
2. `ralph-impl` advisory text: "Run ./scripts/remove-worktree.sh after PR is merged" (humans ignore this)
3. Nothing else

Result: 13+ stale worktrees accumulated in `worktrees/` plus 3 in `.claude/worktrees/`.

### Nested Agent Confusion

Agents receive worktree paths in task prompts. The `impl-worktree-gate.sh` hook blocks writes outside the worktree during impl. But agents don't know when to clean up, and the gate hook only fires during `RALPH_COMMAND=impl`.

## Desired End State

1. **Merge never fails due to worktree**: The merge operation atomically removes the worktree before deleting the branch.
2. **Stale worktrees are pruned automatically**: On every session start, worktrees whose branches are already merged to main are removed. No LLM action required.
3. **Skills don't reference cleanup scripts**: `ralph-merge`, `ralph-impl`, and `ralph-pr` don't instruct the LLM to run cleanup — it's handled by the script and the pruner.

### Verification

- `git worktree list` shows only the main repo and actively-in-progress worktrees
- `gh pr merge --delete-branch` succeeds without worktree errors
- After merging a PR, the corresponding `worktrees/GH-NNN` directory no longer exists
- Starting a new session prunes any stale worktrees from previous sessions

## What We're NOT Doing

- **Not pivoting to `EnterWorktree`**: The built-in tool is session-scoped; our workflow is multi-session. The naming conventions and stacked branch support in the scripts are still needed.
- **Not adding an MCP tool**: Cleanup should be deterministic shell logic, not an LLM-invoked tool.
- **Not changing `create-worktree.sh`**: Creation logic is fine. Only lifecycle management (cleanup) needs fixing.
- **Not changing the `impl-worktree-gate.sh` hook**: The write gate works correctly for enforcement.

## Implementation Approach

Two changes: a merge wrapper script (fixes the acute bug) and a session-start pruner (fixes accumulation). Both are pure shell — no LLM decisions involved.

---

## Phase 1: Atomic Merge Script

### Overview

Create `scripts/merge-pr.sh` that handles worktree removal → PR merge → branch cleanup as a single atomic operation. Update `ralph-merge` skill to call this instead of separate steps.

### Changes Required

#### 1. New script: `scripts/merge-pr.sh`

**File**: `scripts/merge-pr.sh` (new)

```bash
#!/bin/bash
# Merge a PR with deterministic worktree cleanup
#
# Usage: ./scripts/merge-pr.sh PR_NUMBER [WORKTREE_ID]
#
# Removes the associated worktree BEFORE merging so --delete-branch succeeds.
# WORKTREE_ID defaults to GH-$PR_NUMBER. Pass explicitly for group/epic worktrees.

set -euo pipefail

PR_NUMBER="${1:?Usage: $0 PR_NUMBER [WORKTREE_ID]}"
WORKTREE_ID="${2:-}"

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [[ -z "$PROJECT_ROOT" ]]; then
  echo "Error: Not in a git repository" >&2
  exit 1
fi

# Determine worktree ID from PR's head branch if not provided
if [[ -z "$WORKTREE_ID" ]]; then
  HEAD_BRANCH=$(gh pr view "$PR_NUMBER" --json headRefName --jq '.headRefName' 2>/dev/null || echo "")
  if [[ "$HEAD_BRANCH" == feature/GH-* ]]; then
    WORKTREE_ID="${HEAD_BRANCH#feature/}"
  fi
fi

# Step 1: Remove worktree (if it exists)
if [[ -n "$WORKTREE_ID" ]]; then
  WORKTREE_PATH="$PROJECT_ROOT/worktrees/$WORKTREE_ID"
  if [[ -d "$WORKTREE_PATH" ]]; then
    echo "Removing worktree: $WORKTREE_PATH"
    cd "$PROJECT_ROOT"
    git worktree remove "$WORKTREE_PATH" --force 2>/dev/null || {
      echo "Warning: git worktree remove failed, forcing cleanup" >&2
      rm -rf "$WORKTREE_PATH"
      git worktree prune
    }
    echo "Worktree removed: $WORKTREE_ID"
  fi
fi

# Step 2: Merge PR with branch deletion
echo "Merging PR #$PR_NUMBER..."
gh pr merge "$PR_NUMBER" --merge --delete-branch

echo "PR #$PR_NUMBER merged successfully."
```

#### 2. Update `ralph-merge/SKILL.md`

**File**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md`

Replace Steps 5 and 6 with a single step:

**Current** (lines 96-110):
```markdown
## Step 5: Merge PR
gh pr merge NNN --merge --delete-branch
If merge fails, report the error and stop.

## Step 6: Clean Up Worktree
./scripts/remove-worktree.sh GH-NNN
Run from the project root. If cleanup fails, warn but continue.
```

**New**:
```markdown
## Step 5: Merge PR and Clean Up Worktree

From the project root:

./scripts/merge-pr.sh PR_NUMBER [WORKTREE_ID]

Where PR_NUMBER is the PR number and WORKTREE_ID is the worktree name (e.g., GH-NNN).
For group/epic worktrees, pass the worktree ID explicitly. If omitted, it is inferred
from the PR's head branch.

If merge fails, report the error and stop.
```

Remove the old Step 6 entirely. Renumber subsequent steps (old 7→6, 8→7, 9→8, 10→9).

### Success Criteria

#### Automated Verification:
- [x] `scripts/merge-pr.sh` is executable: `test -x scripts/merge-pr.sh`
- [x] Script passes shellcheck: `shellcheck scripts/merge-pr.sh`
- [x] `ralph-merge/SKILL.md` references `merge-pr.sh` instead of separate `gh pr merge` and `remove-worktree.sh`

#### Manual Verification:
- [ ] Create a test branch + worktree, open a PR, merge via `merge-pr.sh` — worktree removed, branch deleted, no errors
- [ ] Merge a PR that has no worktree — script succeeds (no-op on cleanup)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Session-Start Worktree Pruner

### Overview

Create a hook script that runs at session start and removes any worktree whose branch has already been merged to main. Wire it into the plugin-level hooks so it fires for every skill.

### Changes Required

#### 1. New script: `hooks/scripts/prune-merged-worktrees.sh`

**File**: `plugin/ralph-hero/hooks/scripts/prune-merged-worktrees.sh` (new)

```bash
#!/bin/bash
# SessionStart hook: prune worktrees whose branches are merged to main
#
# Runs silently on every session start. Removes worktrees that are no longer
# needed because their branches have been merged into main.
#
# Safe: only removes worktrees where the branch is confirmed merged.
# Stacked branches that aren't merged yet are left alone.

set -euo pipefail

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
if [[ -z "$PROJECT_ROOT" ]]; then
  exit 0
fi

WORKTREE_DIR="$PROJECT_ROOT/worktrees"
if [[ ! -d "$WORKTREE_DIR" ]]; then
  exit 0
fi

# Fetch latest main to ensure merge checks are accurate
git fetch origin main --quiet 2>/dev/null || exit 0

pruned=0
for wt_path in "$WORKTREE_DIR"/*/; do
  [[ -d "$wt_path" ]] || continue

  wt_name=$(basename "$wt_path")

  # Get the branch checked out in this worktree
  branch=$(cd "$wt_path" && git branch --show-current 2>/dev/null || echo "")
  [[ -n "$branch" ]] || continue

  # Check if branch is merged into origin/main
  if git merge-base --is-ancestor "$branch" origin/main 2>/dev/null; then
    echo "Pruning merged worktree: $wt_name (branch: $branch)" >&2
    cd "$PROJECT_ROOT"
    git worktree remove "$wt_path" --force 2>/dev/null || {
      rm -rf "$wt_path"
    }
    pruned=$((pruned + 1))
  fi
done

# Clean up stale git worktree metadata
if [[ $pruned -gt 0 ]]; then
  git worktree prune 2>/dev/null || true
  echo "Pruned $pruned stale worktree(s)" >&2
fi

exit 0
```

#### 2. Wire into plugin-level hooks

**File**: `plugin/ralph-hero/hooks/hooks.json`

Add a `SessionStart` entry to the existing hooks object. Currently it only has `PreToolUse` and `PostToolUse` entries:

```json
"SessionStart": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/prune-merged-worktrees.sh"
      }
    ]
  }
]
```

### Success Criteria

#### Automated Verification:
- [x] Script is executable: `test -x plugin/ralph-hero/hooks/scripts/prune-merged-worktrees.sh`
- [x] Script passes shellcheck: `shellcheck plugin/ralph-hero/hooks/scripts/prune-merged-worktrees.sh`
- [x] `hooks.json` is valid JSON: `jq . plugin/ralph-hero/hooks/hooks.json`
- [x] Script exits 0 when no worktrees exist
- [x] Script exits 0 when not in a git repo

#### Manual Verification:
- [ ] Create a worktree, merge its branch to main, start a new session — worktree is automatically removed
- [ ] Create a worktree with an unmerged branch, start a new session — worktree is preserved
- [ ] Verify stacked branch scenario: GH-42 merged, GH-43 stacked on GH-42 but not merged — only GH-42's worktree is removed

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Clean Up Skill References

### Overview

Remove LLM-directed cleanup instructions from skills. The merge script and pruner handle everything.

### Changes Required

#### 1. `ralph-impl/SKILL.md`

**File**: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`

Remove the advisory text at line 363:
```
Run ./scripts/remove-worktree.sh [WORKTREE_ID] after PR is merged.
```

Replace with:
```
Worktree will be cleaned up automatically during merge.
```

#### 2. `ralph-merge/SKILL.md`

Already handled in Phase 1 — the old Step 6 (manual `remove-worktree.sh`) is replaced by the atomic `merge-pr.sh` call.

#### 3. `impl/SKILL.md` (interactive impl)

**File**: `plugin/ralph-hero/skills/impl/SKILL.md`

No changes needed — it doesn't reference cleanup.

### Success Criteria

#### Automated Verification:
- [ ] `grep -r "remove-worktree" plugin/ralph-hero/skills/` returns zero matches (all references removed from skills)
- [ ] Skills still reference `create-worktree.sh` correctly for creation

---

## Testing Strategy

### Unit-Level:
- `merge-pr.sh` with no worktree → merge succeeds
- `merge-pr.sh` with existing worktree → worktree removed, merge succeeds
- `prune-merged-worktrees.sh` with mixed merged/unmerged → only merged removed
- `prune-merged-worktrees.sh` outside git repo → exits 0 silently

### Integration:
- Full `ralph-impl` → `ralph-pr` → `ralph-merge` cycle on a test issue
- Verify no stale worktree remains after merge
- Start a fresh session — pruner runs, stale worktrees cleaned

### Edge Cases:
- Worktree with detached HEAD (no branch) → pruner skips it
- Worktree with uncommitted changes → `--force` handles it (changes are committed by impl before PR)
- Missing origin remote → scripts exit 0 gracefully
- `.claude/worktrees/` agent worktrees → NOT touched (different path, managed by built-in tool)

## Performance Considerations

The SessionStart pruner runs `git fetch origin main` and iterates worktrees. With ~15 worktrees, this adds <2 seconds to session start. Acceptable trade-off for deterministic cleanup.

## References

- `scripts/create-worktree.sh` — unchanged, handles creation + stacked branches
- `scripts/remove-worktree.sh` — still exists for manual use, no longer called by skills
- `plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh` — unchanged, enforces write isolation
- `plugin/ralph-hero/hooks/scripts/set-skill-env.sh` — SessionStart hook pattern reference
- `plugin/ralph-hero/hooks/hooks.json` — plugin-level hook registry
