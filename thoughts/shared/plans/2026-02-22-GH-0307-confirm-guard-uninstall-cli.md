---
date: 2026-02-22
status: draft
github_issues: [307]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/307
primary_issue: 307
---

# Add [confirm] Guard to uninstall-cli - Implementation Plan

## Overview

Single XS issue: add a `[confirm('Are you sure you want to uninstall the ralph CLI?')]` attribute to the `uninstall-cli` justfile recipe to prevent accidental execution.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-307 | Add [confirm] guard to `uninstall-cli` justfile recipe | XS |

## Current State Analysis

- **`plugin/ralph-hero/justfile:209-230`**: The `uninstall-cli` recipe has `[group('setup')]` but no `[confirm]` guard. Running `just uninstall-cli` immediately deletes `~/.local/bin/ralph` and legacy symlinks without prompting.
- **`set min-version := "1.27.0"`** (line 9): The `[confirm('msg')]` attribute requires just v1.29+. This must be bumped to `"1.29.0"`.
- **Sibling #308** handles `install-cli` and `install-completions` guards separately — out of scope here.

## Desired End State

### Verification
- [ ] `uninstall-cli` recipe has `[confirm]` attribute with descriptive prompt
- [ ] Running `just uninstall-cli` prompts for confirmation before proceeding
- [ ] Declining aborts without deleting anything
- [ ] Confirming proceeds with normal uninstall behavior
- [ ] `set min-version` is bumped to `"1.29.0"`

## What We're NOT Doing

- Not adding `[confirm]` to `install-cli` or `install-completions` (sibling #308)
- Not adding `[confirm]` to any other recipes
- Not changing any recipe behavior beyond adding the confirmation prompt

## Implementation Approach

Single phase — two edits to one file.

---

## Phase 1: GH-307 - Add [confirm] guard to uninstall-cli

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/307 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-cli-ux-improvements.md

### Changes Required

#### 1. Bump minimum just version
**File**: `plugin/ralph-hero/justfile:9`
**Change**: Update `set min-version := "1.27.0"` to `set min-version := "1.29.0"` to support `[confirm]` attributes.

#### 2. Add [confirm] attribute to uninstall-cli
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
- [ ] Automated: `just --list` still shows `uninstall-cli` in the `setup` group (justfile parses correctly)
- [ ] Manual: `just uninstall-cli` prompts for confirmation before proceeding

---

## Integration Testing
- [ ] `just --list` parses correctly with bumped min-version
- [ ] `just doctor` passes all checks
- [ ] No other recipes affected by the version bump

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-cli-ux-improvements.md
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/301
- Sibling issue: https://github.com/cdubiel08/ralph-hero/issues/308
- just [confirm] docs: https://just.systems/man/en/attributes.html
