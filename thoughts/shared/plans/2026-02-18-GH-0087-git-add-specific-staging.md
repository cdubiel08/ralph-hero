---
date: 2026-02-18
status: draft
github_issue: 87
github_url: https://github.com/cdubiel08/ralph-hero/issues/87
---

# Replace `git add -A` with Specific File Staging

## Overview

The `ralph-impl` skill uses `git add -A` in two commit flows, which blindly stages all files in the working directory. When multiple agents operate in the same directory (or stale files exist from prior runs), one agent's commit can scoop up another agent's work. Evidence: commit `434e970` contained 12 files from 3 different agents' work.

The fix is a defense-in-depth approach: update SKILL.md instructions to use specific file staging (guidance layer) AND add a PreToolUse hook to block blanket staging commands (enforcement layer).

## Current State Analysis

- [`plugin/ralph-hero/skills/ralph-impl/SKILL.md:196`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-impl/SKILL.md#L196) — Step 7 uses `git add -A`
- [`plugin/ralph-hero/skills/ralph-impl/SKILL.md:319`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-impl/SKILL.md#L319) — Address Mode A5 uses `git add -A`
- [`plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh:28`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh#L28) — Already intercepts `git add` commands (validates branch only)
- Plans contain structured "File Ownership Summary" tables per phase (e.g., [GH-0021 plan:430-437](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-16-GH-0021-batch-operations.md#L430-L437))
- `git status --porcelain` is already used in [`hooks/scripts/review-postcondition.sh:40`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/review-postcondition.sh#L40) — proven pattern

## Desired End State

- `git add -A` is eliminated from SKILL.md — agents stage only files they intentionally modified
- A PreToolUse hook blocks `git add -A`, `git add .`, and `git add --all` during impl
- Unexpected files in the working directory trigger a warning instead of silent inclusion
- Address Mode uses PR file list as its staging constraint

### Verification
- [ ] SKILL.md Step 7 no longer contains `git add -A`
- [ ] SKILL.md Address Mode A5 no longer contains `git add -A`
- [ ] `impl-staging-gate.sh` exists and blocks blanket staging commands
- [ ] `impl-staging-gate.sh` is registered in SKILL.md frontmatter PreToolUse hooks
- [ ] `impl-staging-gate.sh` allows `git add <specific-files>` to pass through
- [ ] Step 7 instructions reference plan's File Ownership Summary for expected files
- [ ] Address Mode instructions use PR file list as staging constraint

## What We're NOT Doing

- Programmatically parsing plan file ownership tables in a hook (too complex, relies on LLM to extract)
- Extending `impl-verify-commit.sh` PostToolUse hook (post-commit validation is advisory only — damage already done)
- Modifying `impl-branch-gate.sh` (it has a clear single responsibility: branch validation)
- Adding worktree isolation changes (separate concern, covered by #85)
- Blocking `git add` for non-impl commands (staging gate only applies when `RALPH_COMMAND=impl`)

## Implementation Approach

Two-phase defense in depth:
1. **Guidance**: Update SKILL.md instructions so the agent knows to stage specific files using `git status --porcelain` filtering against the plan's file ownership
2. **Enforcement**: Add `impl-staging-gate.sh` hook that blocks blanket staging patterns (`-A`, `.`, `--all`), registered as PreToolUse→Bash in SKILL.md frontmatter

The hook runs BEFORE `impl-branch-gate.sh` (ordered first in the hooks array) to catch blanket staging before the branch check.

---

## Phase 1: Update SKILL.md Commit Instructions

### Overview

Replace `git add -A` in both Step 7 and Address Mode A5 with specific file staging instructions. The agent uses `git status --porcelain` to discover changes, filters against the plan's file ownership data, and stages only expected files.

### Changes Required

#### 1. Replace Step 7: Commit and Push
**File**: [`plugin/ralph-hero/skills/ralph-impl/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-impl/SKILL.md)
**Lines**: 193-200 (current Step 7 section)

**Current** (lines 193-200):
```markdown
### Step 7: Commit and Push

```bash
git add -A
git commit -m "feat(component): [phase description]
Phase [N] of [M]: #NNN - [Title]"
git push -u origin [branch-name]
```
```

**Replace with**:
```markdown
### Step 7: Commit and Push

1. Review all changes in the working directory:
   ```bash
   git status --porcelain
   ```

2. Compare against this phase's expected files from the plan's **File Ownership Summary** table (or the **Changes Required** file list for this phase). Stage ONLY the expected files:
   ```bash
   git add <file1> <file2> ...
   ```

3. If `git status` shows unexpected modified/new files NOT in this phase's ownership, do NOT stage them. Warn:
   ```
   WARNING: Unexpected files not in Phase [N] ownership:
   - path/to/unexpected-file
   Skipping. These may belong to another agent or phase.
   ```

4. If the plan has no File Ownership Summary, stage only files you explicitly created or modified in this phase. Never use `git add -A`, `git add .`, or `git add --all`.

5. Commit and push:
   ```bash
   git commit -m "feat(component): [phase description]

   Phase [N] of [M]: #NNN - [Title]"
   git push -u origin [branch-name]
   ```
```

#### 2. Replace Address Mode A5: Commit and Push
**File**: [`plugin/ralph-hero/skills/ralph-impl/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-impl/SKILL.md)
**Lines**: 317-324 (current A5 section)

**Current** (lines 317-324):
```markdown
**A5. Commit and push**:
```bash
git add -A
git commit -m "fix: address PR review feedback
- [change summaries]"
git push
```
```

**Replace with**:
```markdown
**A5. Commit and push**:

Stage only files you modified to address feedback. Use the PR's existing file list as your staging constraint — files already in the PR diff plus any new files explicitly requested by reviewers.

```bash
git add <file1> <file2> ...
git commit -m "fix: address PR review feedback

- [change summaries]"
git push
```

Do NOT use `git add -A`, `git add .`, or `git add --all`.
```

### Success Criteria

#### Automated Verification
- [ ] `grep -c 'git add -A' plugin/ralph-hero/skills/ralph-impl/SKILL.md` returns `0`
- [ ] `grep -c 'git add \.' plugin/ralph-hero/skills/ralph-impl/SKILL.md` returns `0` (excluding the new warning text)
- [ ] `grep -c 'git status --porcelain' plugin/ralph-hero/skills/ralph-impl/SKILL.md` returns at least `1`
- [ ] `grep -c 'File Ownership Summary' plugin/ralph-hero/skills/ralph-impl/SKILL.md` returns at least `1`

#### Manual Verification
- [ ] Step 7 instructions are clear and actionable for an LLM agent
- [ ] Address Mode A5 instructions reference PR file list as constraint
- [ ] No ambiguity about what "specific files" means

**Dependencies created for next phase**: Phase 2 adds the enforcement hook that backs up these instructions.

---

## Phase 2: Add impl-staging-gate.sh Hook

### Overview

Create a new PreToolUse→Bash hook that blocks blanket `git add` commands during impl. This provides automated enforcement that the agent cannot bypass, complementing the SKILL.md guidance from Phase 1.

### Changes Required

#### 1. Create `impl-staging-gate.sh`
**File**: `plugin/ralph-hero/hooks/scripts/impl-staging-gate.sh` (NEW)

```bash
#!/bin/bash
# ralph-hero/hooks/scripts/impl-staging-gate.sh
# PreToolUse (Bash): Block blanket git staging during implementation
#
# Prevents `git add -A`, `git add .`, `git add --all` which can
# stage files from other agents or prior failed runs.
# Agents must use `git add <specific-files>` instead.
#
# Exit codes:
#   0 - Allowed (specific file staging or non-git-add command)
#   2 - Blocked (blanket staging command detected)

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

# Only check git add operations
if [[ "$command" != *"git add"* ]]; then
  allow
fi

# Block blanket staging patterns:
# - git add -A / git add --all (stages everything including untracked)
# - git add . (stages all changes in current directory tree)
# - git add -u (stages all tracked modified/deleted — less dangerous but still blanket)
if [[ "$command" =~ git[[:space:]]+add[[:space:]]+(.*-A|-.*--all|\.([[:space:]]|$)|--all) ]]; then
  block "Blanket git staging blocked during implementation

Command: $command

Use specific file staging instead:
  git add <file1> <file2> ...

Why: 'git add -A' / 'git add .' can stage files from other agents,
prior failed runs, or editor temp files. Stage only the files you
intentionally modified for this phase.

Tip: Run 'git status --porcelain' first to review all changes,
then stage only files listed in the plan's File Ownership Summary."
fi

allow
```

#### 2. Register hook in SKILL.md frontmatter
**File**: [`plugin/ralph-hero/skills/ralph-impl/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-impl/SKILL.md)
**Lines**: 17-20 (PreToolUse → Bash section in frontmatter)

**Current**:
```yaml
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-branch-gate.sh"
```

**Replace with** (add staging gate BEFORE branch gate):
```yaml
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-staging-gate.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/impl-branch-gate.sh"
```

### Success Criteria

#### Automated Verification
- [ ] `test -x plugin/ralph-hero/hooks/scripts/impl-staging-gate.sh` passes (file exists and is executable)
- [ ] `bash -n plugin/ralph-hero/hooks/scripts/impl-staging-gate.sh` passes (valid shell syntax)
- [ ] `grep -c 'impl-staging-gate.sh' plugin/ralph-hero/skills/ralph-impl/SKILL.md` returns `1` (registered in frontmatter)
- [ ] Hook appears BEFORE `impl-branch-gate.sh` in the Bash matcher hooks array

#### Manual Verification
- [ ] Hook blocks `git add -A` with a helpful error message
- [ ] Hook blocks `git add .` with a helpful error message
- [ ] Hook blocks `git add --all` with a helpful error message
- [ ] Hook allows `git add path/to/specific-file.ts` to pass
- [ ] Hook only activates when `RALPH_COMMAND=impl` (no impact on other skills)
- [ ] Error message guides the agent to use `git status --porcelain` and specific staging

---

## Testing Strategy

After both phases are implemented:

1. **Regression**: Verify no other skills reference `git add -A` patterns that need updating
2. **Hook isolation**: Confirm `impl-staging-gate.sh` does NOT fire for `ralph-plan`, `ralph-research`, or other non-impl commands
3. **Integration**: Run a test impl phase and verify the agent correctly:
   - Uses `git status --porcelain` to discover changes
   - Stages specific files only
   - Commits successfully with only intended files

## File Ownership Summary

| Phase | Key Files (NEW) | Key Files (MODIFIED) | Key Files (DELETED) |
|-------|-----------------|---------------------|---------------------|
| 1 | — | `plugin/ralph-hero/skills/ralph-impl/SKILL.md` | — |
| 2 | `plugin/ralph-hero/hooks/scripts/impl-staging-gate.sh` | `plugin/ralph-hero/skills/ralph-impl/SKILL.md` | — |

## References

- [Issue #87](https://github.com/cdubiel08/ralph-hero/issues/87) — Replace `git add -A` with specific file staging
- [Research: GH-87](https://github.com/cdubiel08/ralph-hero/blob/feature/GH-53-v2/thoughts/shared/research/2026-02-18-GH-0087-git-add-cross-agent-contamination.md) — Cross-agent contamination analysis
- [impl-branch-gate.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh) — Existing git add interception pattern
- [hook-utils.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/hook-utils.sh) — Shared hook utilities (block, allow, read_input, get_field)
- Related: #53 (template integrity), #85 (context: fork isolation)
