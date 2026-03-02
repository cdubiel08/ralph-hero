---
date: 2026-03-01
status: draft
github_issues: [465]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/465
primary_issue: 465
---

# Stacked Branch Strategy for Parallel Implementations - Atomic Implementation Plan

## Overview
1 issue enabling stacked worktree creation so that overlapping-file implementations branch from their predecessor instead of `origin/main`.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-465 | stacked branch strategy for parallel implementations | S |

## Current State Analysis

All worktrees created by `ralph-impl` branch from `origin/main` via [`scripts/create-worktree.sh:33`](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/create-worktree.sh#L33). There is no parameter to specify a different base branch. When overlapping-file issues are implemented in parallel, this causes predictable merge conflicts (documented in the GH-451 post-mortem).

The stream detection infrastructure already exists — `detect_stream_positions` MCP tool and `work-stream-detection.ts` Union-Find algorithm. The `ralph-hero` orchestrator uses it (Step 2.5 of `ralph-hero/SKILL.md`) but `ralph-team` does not. **GH-488 will add stream detection to `ralph-team`** — this plan focuses on the downstream mechanics that consume stream metadata: worktree creation, implementation, and integration.

## Desired End State

### Verification
- [x] `create-worktree.sh` accepts an optional 3rd argument (`BASE_BRANCH_OVERRIDE`) and creates worktrees from that branch when provided
- [x] `ralph-impl` reads `base_branch` from task context and passes it to `create-worktree.sh`
- [x] `ralph-impl` runs `git rebase origin/main` when starting a stream-sequential issue whose predecessor has merged
- [x] Integrator agent documentation includes rebase guidance for stacked branches
- [x] Existing behavior (branching from `origin/main`) unchanged when no base branch is specified

## What We're NOT Doing
- Stream detection in `ralph-team` — that's GH-488
- Full cascade rebase automation (multi-level stacks) — deferred per research recommendation
- External stacking tools (ghstack, Graphite) — agent-native approach only
- Runtime conflict monitoring — detection is pre-implementation only

## Implementation Approach

Three coordinated changes: (1) enable the plumbing in `create-worktree.sh`, (2) teach `ralph-impl` to use it, (3) document integrator rebase steps. Changes are ordered so the script change is tested independently before skill changes reference it.

---

## Phase 1: GH-465 — Stacked Branch Strategy
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/465 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0465-stacked-branch-strategy.md

### Changes Required

#### 1. Add BASE_BRANCH_OVERRIDE to create-worktree.sh
**File**: [`scripts/create-worktree.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/create-worktree.sh)

**Changes**:

1. Update usage comment (line 4) to document 3rd argument:
   ```
   # Usage: ./scripts/create-worktree.sh TICKET-ID [branch-name] [base-branch-override]
   ```

2. Add 3rd positional argument after line 13:
   ```bash
   BASE_BRANCH_OVERRIDE="${3:-}"
   ```

3. After the `origin/main` / `origin/master` fallback chain (line 40), add override logic:
   ```bash
   # Apply base branch override if specified (for stacked branches)
   if [[ -n "$BASE_BRANCH_OVERRIDE" ]]; then
     echo "Using base branch override: $BASE_BRANCH_OVERRIDE"
     git fetch origin "$BASE_BRANCH_OVERRIDE" 2>/dev/null || true
     if git rev-parse --verify "origin/$BASE_BRANCH_OVERRIDE" &>/dev/null; then
       BASE_BRANCH="origin/$BASE_BRANCH_OVERRIDE"
     elif git rev-parse --verify "$BASE_BRANCH_OVERRIDE" &>/dev/null; then
       BASE_BRANCH="$BASE_BRANCH_OVERRIDE"
     else
       echo "Warning: Base branch override '$BASE_BRANCH_OVERRIDE' not found, using $BASE_BRANCH"
     fi
   fi
   ```

   This keeps the override graceful — falls back to main if the specified branch doesn't exist yet (e.g., predecessor hasn't pushed).

4. Update the examples section to show stacked usage:
   ```
   #   ./scripts/create-worktree.sh GH-43 "" feature/GH-42  # Stack on GH-42's branch
   ```

#### 2. Update ralph-impl to pass base_branch
**File**: [`plugin/ralph-hero/skills/ralph-impl/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-impl/SKILL.md)

**Changes**:

1. In Step 6.2 (Determine Worktree ID, around line 159), add a new row to the context detection table and a note about base branch:

   Add after the WORKTREE_ID table (after line 170):
   ```markdown
   **Base branch detection**: If the task description or plan frontmatter contains a `base_branch` value (set by the team lead via stream detection), store it:
   - `BASE_BRANCH_ARG="$base_branch"` (e.g., `feature/GH-42`)
   - If no `base_branch` found: `BASE_BRANCH_ARG=""` (default to origin/main)
   ```

2. In Step 6.3 (Check for Existing Worktree and Sync, line 184), update the `create-worktree.sh` call to pass the base branch:

   Change:
   ```bash
   "$GIT_ROOT/scripts/create-worktree.sh" "$WORKTREE_ID"
   ```
   To:
   ```bash
   "$GIT_ROOT/scripts/create-worktree.sh" "$WORKTREE_ID" "" "$BASE_BRANCH_ARG"
   ```

   The empty string `""` preserves the default branch naming (`feature/$WORKTREE_ID`).

3. Add a new Step 6.3a after Step 6.3 (after line 187) for stream-sequential rebase:
   ```markdown
   **6.3a. Rebase onto main if predecessor merged**

   When `BASE_BRANCH_ARG` is set (stacked branch), check if the predecessor branch has been merged to main:
   ```bash
   if [[ -n "$BASE_BRANCH_ARG" ]]; then
     git fetch origin main
     # Check if predecessor's commits are already in main
     if git merge-base --is-ancestor "origin/$BASE_BRANCH_ARG" origin/main 2>/dev/null; then
       echo "Predecessor branch $BASE_BRANCH_ARG merged to main. Rebasing..."
       git rebase origin/main
     fi
   fi
   ```

   This handles the case where the team lead created a stacked task but the predecessor merged before implementation started. The worktree was created from the predecessor branch, but since that's now in main, rebase to avoid a redundant merge base.
   ```

#### 3. Add integrator rebase guidance
**File**: [`plugin/ralph-hero/agents/ralph-integrator.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-integrator.md)

**Changes**:

Add a new section before the final line (after line 31):
```markdown
## Stacked Branch Handling

When merging a PR for an issue that has downstream stacked branches (indicated by task metadata `base_branch` pointing to the merged branch):

1. After merging the upstream PR, identify any in-progress or pending implementation tasks whose `base_branch` references the just-merged branch name
2. For each downstream branch:
   ```bash
   git checkout feature/GH-NNN-downstream
   git fetch origin main
   git rebase origin/main
   git push --force-with-lease
   ```
3. If the downstream PR already exists, update its base: `gh pr edit NNN --base main`
4. Use `--force-with-lease` (never bare `--force`) for safety

This step is only needed when streams detected overlapping files and created stacked task chains. For independent streams, no action is needed after merge.
```

#### 4. Add stream metadata guidance to ralph-team
**File**: [`plugin/ralph-hero/skills/ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md)

**Changes**:

In the "Build the Task List" section (after line 56), add a note about base_branch metadata for stacked tasks:
```markdown
When creating implementation tasks for issues within the same work stream (detected via `detect_stream_positions`), set `base_branch` in the task description to the predecessor's branch name (e.g., `feature/GH-42`). This tells the builder to create its worktree stacked on the predecessor branch instead of main. Issues in independent streams or standalone issues should not have `base_branch` set.
```

This is a lightweight touch — GH-488 will add the full stream detection logic. This note ensures the contract between team lead and builder is documented now.

### Success Criteria
- [x] Automated: `./scripts/create-worktree.sh GH-test-stacked "" feature/main` creates a worktree from `origin/main` (override resolves to the branch)
- [x] Automated: `./scripts/create-worktree.sh GH-test-default` creates from `origin/main` (no override, backward compatible)
- [x] Automated: `./scripts/create-worktree.sh GH-test-missing "" nonexistent-branch` falls back to `origin/main` with a warning
- [x] Manual: `ralph-impl` SKILL.md contains base_branch detection in Step 6.2 and passes it in Step 6.3
- [x] Manual: `ralph-impl` SKILL.md contains Step 6.3a rebase-on-predecessor-merged logic
- [x] Manual: `ralph-integrator.md` contains stacked branch rebase guidance
- [x] Manual: `ralph-team/SKILL.md` documents `base_branch` metadata contract

---

## Integration Testing
- [ ] Create a worktree with no base branch override — branches from `origin/main` (existing behavior)
- [ ] Create a worktree with a valid base branch override — branches from the specified branch
- [ ] Create a worktree with an invalid base branch override — falls back to `origin/main` with warning
- [ ] Verify `create-worktree.sh` still handles the existing 2-arg case (`TICKET_ID BRANCH_NAME`) correctly

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0465-stacked-branch-strategy.md
- GH-451 post-mortem: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/reports/2026-02-27-ralph-team-GH-451.md
- Stream detection reference: [`plugin/ralph-hero/skills/ralph-hero/SKILL.md` Step 2.5](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-hero/SKILL.md)
- Related issue: https://github.com/cdubiel08/ralph-hero/issues/488 (stream detection in ralph-team)
