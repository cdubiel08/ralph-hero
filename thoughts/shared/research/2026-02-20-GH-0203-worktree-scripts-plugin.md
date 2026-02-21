---
date: 2026-02-20
github_issue: 203
github_url: https://github.com/cdubiel08/ralph-hero/issues/203
status: complete
type: research
---

# GH-203: Deterministic Worktree Scripts for Plugin

## Problem Statement

The issue requests self-contained, deterministic `create-worktree.sh` and `remove-worktree.sh` scripts inside `plugin/ralph-hero/scripts/` so that worktree logic is decoupled from `ralph-impl` skill prose and callable standalone by humans or CI.

## Current State Analysis

### Existing Scripts (Repo Root)

The ralph-hero repo already has well-structured worktree scripts at the **repo root** level:

- [`scripts/create-worktree.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/create-worktree.sh) (64 lines)
- [`scripts/remove-worktree.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/remove-worktree.sh) (28 lines)

These already implement most of what the issue requests:

| Requirement | Status | Notes |
|---|---|---|
| Accepts `GH-NNN` as required argument | Done | `${1:?Usage: $0 TICKET_ID [BRANCH_NAME]}` |
| Resolves `GIT_ROOT` dynamically | Done | `git rev-parse --show-toplevel` |
| Creates worktree at `$GIT_ROOT/worktrees/GH-NNN/` | Done | `WORKTREE_PATH="$WORKTREE_BASE/$TICKET_ID"` |
| Runs `git fetch origin main` before branching | Done | With fallback to master |
| Checks local refs for existing branch | Done | `git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"` |
| Checks remote refs | **Missing** | Only checks `refs/heads/`, not `refs/remotes/origin/` |
| Branches from `origin/main` if new | Done | Uses `$BASE_BRANCH` (origin/main or origin/master) |
| Prints clear instructions | Done | Path, branch, how-to-use |
| Idempotent create (exits cleanly if exists) | Done | `exit 0` with info |
| `remove --force` option | Done | Uses `--force` |
| Idempotent remove (exit 0 if not found) | Done | `exit 0` when not found |
| `set -e` | Done | |

### Plugin Scripts Directory

`plugin/ralph-hero/scripts/` contains only loop scripts:
- `ralph-loop.sh` -- sequential phase runner
- `ralph-team-loop.sh` -- multi-agent orchestrator launcher

There are **no** worktree scripts in the plugin directory.

### How Skills/Hooks Reference Worktree Scripts

All references use `$GIT_ROOT/scripts/` or `./scripts/` (repo root), not `$CLAUDE_PLUGIN_ROOT/scripts/`:

| Location | Reference |
|---|---|
| `ralph-impl/SKILL.md:170` | `"$GIT_ROOT/scripts/create-worktree.sh" "$WORKTREE_ID"` |
| `ralph-impl/SKILL.md:298` | `Run ./scripts/remove-worktree.sh [WORKTREE_ID] after PR is merged.` |
| `ralph-integrator.md:46` | `scripts/remove-worktree.sh GH-NNN (from git root)` |
| `impl-worktree-gate.sh:57` | `./scripts/create-worktree.sh GH-NNN` (error message) |
| `impl-branch-gate.sh:49` | `./scripts/create-worktree.sh GH-NNN` (error message) |
| `impl-postcondition.sh:47` | `./scripts/create-worktree.sh $ticket_id` (error message) |

### Workspace Reference Scripts

The workspace-level scripts at `~/projects/scripts/` use a different pattern:
- Hardcoded `cd ~/projects` and `REPO_DIR="landcrawler-ai"`
- Worktrees stored in `landcrawler-worktrees/` (sibling directory)
- Only check local refs (`refs/heads/`)
- Non-idempotent remove (`exit 1` when not found)

The repo root scripts are already **better** than the workspace reference in several ways (dynamic `GIT_ROOT`, idempotent remove, main/master fallback).

## Key Discoveries

### 1. The Issue's Premise Is Partially Outdated

The issue states that plugin scripts at `plugin/ralph-hero/scripts/` exist but aren't usable standalone. In reality:
- No worktree scripts exist in `plugin/ralph-hero/scripts/`
- Good worktree scripts already exist at the **repo root** `scripts/`
- All skill/hook references correctly point to `$GIT_ROOT/scripts/`

### 2. Remote Ref Check Gap

Both the repo root scripts and workspace scripts only check local refs:
```bash
git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"
```

This misses the case where a branch exists on remote but not locally (e.g., after a fresh clone or when another machine pushed the branch). The fix is to also check:
```bash
git show-ref --verify --quiet "refs/remotes/origin/$BRANCH_NAME"
```

If a remote-only branch is found, the script should `git checkout -b $BRANCH_NAME origin/$BRANCH_NAME` or `git worktree add "$WORKTREE_PATH" --track "origin/$BRANCH_NAME"`.

### 3. Plugin Scripts Placement Decision

The issue title says "add ... scripts **to plugin**" but the current architecture uses repo-root scripts referenced via `$GIT_ROOT`. Two options:

**Option A: Keep at repo root (recommended)**
- All existing references already work
- No hook/skill changes needed
- Harden the existing scripts with remote ref checks
- Plugin scripts remain loop/orchestration only

**Option B: Move to plugin, symlink from root**
- Centralizes everything under `plugin/ralph-hero/`
- Requires updating `$GIT_ROOT/scripts/` references or symlinking
- More moving parts, marginal benefit

### 4. Inline Logic in ralph-impl SKILL.md

The `ralph-impl` SKILL.md Step 5 has some inline worktree logic (sync/pull after reuse) that goes beyond what the script does. This is appropriate because:
- The create script handles first-time setup
- The skill handles ongoing sync (fetch + pull) which is session-specific
- No duplication -- the skill delegates creation to the script and only adds the reuse-sync logic

### 5. Hook Ecosystem Is Already Aligned

Five hooks reference the repo-root scripts in error messages:
- `impl-worktree-gate.sh` -- blocks writes outside worktree
- `impl-branch-gate.sh` -- blocks git ops on main
- `impl-postcondition.sh` -- verifies worktree exists
- `pre-worktree-validator.sh` -- detects worktree collisions

All use the pattern `./scripts/create-worktree.sh GH-NNN` which resolves correctly from `$GIT_ROOT`.

## Potential Approaches

### Approach A: Harden Existing Repo-Root Scripts (Recommended)

**Scope**: Modify `scripts/create-worktree.sh` to add remote ref checking. No other file changes needed.

**Changes to `create-worktree.sh`:**
1. After `git fetch origin main`, also fetch the specific branch: `git fetch origin "$BRANCH_NAME" 2>/dev/null || true`
2. Check remote refs if local ref not found:
   ```bash
   if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
     # Local branch exists
     git worktree add "$WORKTREE_PATH" "$BRANCH_NAME"
   elif git show-ref --verify --quiet "refs/remotes/origin/$BRANCH_NAME"; then
     # Remote-only branch -- create local tracking branch
     git worktree add --track -b "$BRANCH_NAME" "$WORKTREE_PATH" "origin/$BRANCH_NAME"
   else
     # New branch from origin/main
     git worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" "$BASE_BRANCH"
   fi
   ```
3. Add remove instructions to create output

**Pros**: Minimal changes, all existing references work, no skill/hook updates needed.
**Cons**: Scripts stay outside plugin directory (but they're repo-level infrastructure, not plugin-specific).

### Approach B: Copy Scripts to Plugin + Symlink

Move scripts to `plugin/ralph-hero/scripts/`, create symlinks at `scripts/`. Higher risk, marginal benefit.

### Approach C: Full Rewrite to Plugin

Rewrite scripts to be plugin-aware with `$CLAUDE_PLUGIN_ROOT`. Would require updating all skill/hook references. Unnecessary churn.

## Risks

1. **Remote ref fetch could fail** (network issues, branch deleted on remote). Handle with `|| true` and fall through to new branch creation.
2. **Tracking branch conflicts** -- if local and remote have diverged, `git worktree add --track` will use the remote version. The `ralph-impl` skill's sync step (fetch + pull) handles ongoing divergence.

## Recommendation

**Approach A** -- harden the existing `scripts/create-worktree.sh` at repo root with remote ref checking. This is an XS change (one file, ~10 lines changed). The `remove-worktree.sh` is already correct and idempotent. No skill/hook/agent updates needed since all references already point to the right place.

The issue's scope should be re-estimated from S to XS given that the foundation already exists.
