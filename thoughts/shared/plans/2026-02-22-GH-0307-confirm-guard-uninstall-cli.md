---
date: 2026-02-22
status: draft
github_issues: [307, 308]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/307
  - https://github.com/cdubiel08/ralph-hero/issues/308
primary_issue: 307
---

# Add [confirm] Guards to Destructive Justfile Recipes - Atomic Implementation Plan

## Overview

2 related issues for atomic implementation in a single PR. Both are children of #301 (Add [confirm] guards to destructive justfile recipes).

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-307 | Add [confirm] guard to `uninstall-cli` justfile recipe | XS |
| 2 | GH-308 | Add [confirm] guards to `install-cli` and `install-completions` recipes | XS |

**Why grouped**: Both issues modify the same file (`plugin/ralph-hero/justfile`) to add the same type of attribute (`[confirm]`) to related setup recipes. They share the `min-version` bump requirement (1.27 -> 1.29). Implementing atomically ensures the version bump happens once and recipes stay consistent.

## Current State Analysis

The justfile (`plugin/ralph-hero/justfile`) has three setup recipes that perform file system operations without confirmation:

- **`install-cli`** (line 185): Copies `ralph-cli.sh` to `~/.local/bin/ralph`, overwriting any existing file. Has `[group('setup')]` but no `[confirm]` guard.
- **`uninstall-cli`** (line 211): Deletes `~/.local/bin/ralph` and cleans up legacy symlinks. Has `[group('setup')]` but no `[confirm]` guard.
- **`install-completions`** (line 234): Copies completion scripts to shell-specific directories, overwriting existing files. Has `[group('setup')]` but no `[confirm]` guard.

The justfile currently requires `just >= 1.27.0` (line 9: `set min-version := "1.27.0"`). The `[confirm('msg')]` attribute requires `just >= 1.29`.

The prerequisites comment at line 4 references `just >= 1.27` and needs updating.

## Desired End State

### Verification
- [ ] `set min-version` is bumped to `"1.29.0"`
- [ ] Prerequisites comment reflects `just >= 1.29`
- [ ] `uninstall-cli` prompts for confirmation before proceeding
- [ ] `install-cli` prompts for confirmation before proceeding
- [ ] `install-completions` prompts for confirmation before proceeding
- [ ] All three recipes abort without side effects when user declines
- [ ] All three recipes proceed normally when user confirms

## What We're NOT Doing

- Not adding `[confirm]` to `setup` recipe (creates a new project, not destructive)
- Not adding `[confirm]` to `doctor` recipe (read-only diagnostics)
- Not adding `[confirm]` to workflow/quick recipes (API operations, not local filesystem)
- Not adding `--yes` or `--force` bypass flags (users can use `just --yes` globally)

## Implementation Approach

Phase 1 handles the most destructive recipe (`uninstall-cli`) and bumps `min-version`. Phase 2 adds guards to the two install recipes, building on the version bump from Phase 1.

---

## Phase 1: GH-307 - Add [confirm] guard to `uninstall-cli` recipe

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/307 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-cli-ux-improvements.md

### Changes Required

#### 1. Bump minimum just version
**File**: `plugin/ralph-hero/justfile:9`
**Change**: Update `set min-version := "1.27.0"` to `set min-version := "1.29.0"` to support `[confirm]` attributes.

#### 2. Update prerequisites comment
**File**: `plugin/ralph-hero/justfile:4`
**Change**: Update `just >= 1.27` to `just >= 1.29` in the header comment.

#### 3. Add [confirm] attribute to uninstall-cli
**File**: `plugin/ralph-hero/justfile:209-211`
**Change**: Insert `[confirm('Are you sure you want to uninstall the ralph CLI?')]` between the existing `[group('setup')]` and the recipe comment.

Before:
```just
[group('setup')]
# Remove global 'ralph' command
uninstall-cli:
```

After:
```just
[group('setup')]
[confirm('Are you sure you want to uninstall the ralph CLI?')]
# Remove global 'ralph' command
uninstall-cli:
```

### Success Criteria
- [ ] Automated: `grep "confirm.*uninstall" plugin/ralph-hero/justfile` matches the `[confirm]` attribute
- [ ] Automated: `grep 'min-version.*1.29' plugin/ralph-hero/justfile` confirms version bump
- [ ] Automated: `grep 'just >= 1.29' plugin/ralph-hero/justfile` confirms comment update
- [ ] Automated: `just --list` still shows `uninstall-cli` in the `setup` group (justfile parses correctly)
- [ ] Manual: `just uninstall-cli` prompts for confirmation before proceeding

**Creates for next phase**: Version bump already in place; Phase 2 just adds more `[confirm]` attributes.

---

## Phase 2: GH-308 - Add [confirm] guards to `install-cli` and `install-completions`

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/308 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-cli-ux-improvements.md | **Depends on**: Phase 1 (GH-307, min-version bump)

### Changes Required

#### 1. Add [confirm] attribute to install-cli
**File**: `plugin/ralph-hero/justfile:183-185`
**Change**: Insert `[confirm]` between `[group('setup')]` and the recipe comment.

Before:
```just
[group('setup')]
# Install global 'ralph' command - run from anywhere after setup
install-cli:
```

After:
```just
[group('setup')]
[confirm('This will install ralph to ~/.local/bin/ralph (overwriting if exists). Continue?')]
# Install global 'ralph' command - run from anywhere after setup
install-cli:
```

#### 2. Add [confirm] attribute to install-completions
**File**: `plugin/ralph-hero/justfile:232-234`
**Change**: Insert `[confirm]` between `[group('setup')]` and the recipe comment.

Before:
```just
[group('setup')]
# Install shell completions for the global 'ralph' command
install-completions shell="bash":
```

After:
```just
[group('setup')]
[confirm('This will install shell completions (overwriting if exists). Continue?')]
# Install shell completions for the global 'ralph' command
install-completions shell="bash":
```

### Success Criteria
- [ ] Automated: `grep -c "\[confirm(" plugin/ralph-hero/justfile` returns `3` (all three recipes guarded)
- [ ] Automated: `just --list` still shows all recipes correctly
- [ ] Manual: `just install-cli` prompts for confirmation before proceeding
- [ ] Manual: `just install-completions` prompts for confirmation before proceeding

---

## Integration Testing
- [ ] `just --list` shows all recipes correctly (groups, aliases intact)
- [ ] `just doctor` passes all checks
- [ ] Running `just` on `just < 1.29` gives a clear version error message
- [ ] All three guarded recipes abort cleanly when user declines confirmation

## File Ownership Summary

| Phase | Files Modified |
|-------|---------------|
| 1 | `plugin/ralph-hero/justfile` |
| 2 | `plugin/ralph-hero/justfile` |

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-cli-ux-improvements.md
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/301
- just [confirm] docs: https://just.systems/man/en/attributes.html
