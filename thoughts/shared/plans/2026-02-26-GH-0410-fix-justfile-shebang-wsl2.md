---
date: 2026-02-26
status: draft
github_issues: [410]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/410
primary_issue: 410
---

# Fix Justfile Shebang WSL2 Permission Denied - Implementation Plan

## Overview

1 issue for implementation:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-410 | Justfile recipes fail with "Permission denied (os error 13)" on shebang execution | S |

## Current State Analysis

The justfile at `plugin/ralph-hero/justfile` uses 10 shebang-based recipes (`#!/usr/bin/env bash`). On WSL2 2.5.7+, the `XDG_RUNTIME_DIR` directory is mounted with the `noexec` flag, causing `just` to fail when it writes and executes temp script files for shebang recipes.

All workflow recipes (`triage`, `research`, `plan`, `impl`, `hero`, etc.) are affected because they delegate to the `_run_skill` private recipe which uses a shebang. The `quick-*` MCP-based recipes are affected via `_mcp_call`.

Additionally, there is no `issue` recipe - users get `Justfile does not contain recipe 'issue'` when running `ralph issue`.

The justfile already requires `just >= 1.37` (line 4), and `set shell := ["bash", "-euc"]` is configured (line 7).

## Desired End State

### Verification
- [ ] `ralph hero` succeeds on WSL2 (no "Permission denied" error)
- [ ] `ralph quick-issue 'test'` succeeds on WSL2
- [ ] `ralph issue 123` fetches issue details (alias works)
- [ ] `just doctor` includes WSL2 tempdir diagnostic
- [ ] All existing recipes still work on native Linux/macOS

## What We're NOT Doing
- NOT migrating all shebang recipes to `[script]` attribute (separate future issue)
- NOT changing recipe logic or behavior — only fixing the tempdir
- NOT adding Windows native support (WSL2 is the supported path)

## Implementation Approach

Single phase with 3 targeted changes to the justfile:
1. Add `set tempdir` directive to fix the root cause
2. Add `issue` alias for UX consistency
3. Add WSL2 diagnostic to `doctor` recipe

All changes are in one file (`plugin/ralph-hero/justfile`), low-risk, and independently verifiable.

---

## Phase 1: GH-410 - Fix Shebang Permission Denied and Add Missing Recipe

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/410 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-26-GH-0410-justfile-shebang-wsl2-permission-denied.md

### Changes Required

#### 1. Add `set tempdir` directive
**File**: `plugin/ralph-hero/justfile`
**Location**: Line 9 (after existing `set dotenv-load` on line 8)
**Changes**: Add `set tempdir := "/tmp"` to redirect temp file creation to an exec-mounted filesystem.

```just
set shell := ["bash", "-euc"]
set dotenv-load
set tempdir := "/tmp"
```

**Why `/tmp`**: On all Linux systems (including WSL2), `/tmp` is a Linux-native filesystem with exec permissions. The `set tempdir` directive was added in just 1.3.0 (well below the 1.37 requirement). This one-line change fixes all 10 shebang recipes.

#### 2. Add `issue` alias
**File**: `plugin/ralph-hero/justfile`
**Location**: Line 17-18 area (after existing aliases)
**Changes**: Add an alias mapping `issue` to `quick-info` so `ralph issue 123` works.

```just
alias t  := triage
alias r  := research
alias p  := plan
alias i  := impl
alias s  := status
alias sp := split
alias h  := hygiene
alias issue := quick-info
```

**Rationale**: `quick-info` fetches issue details via `ralph_hero__get_issue`, which matches the expected behavior of `ralph issue <number>`.

#### 3. Add WSL2 diagnostic to `doctor` recipe
**File**: `plugin/ralph-hero/justfile`
**Location**: Inside the `doctor` recipe, after the environment variables check section (after line ~118)
**Changes**: Add a diagnostic check that detects WSL2 and verifies the tempdir is executable. This helps users who don't use the justfile's `set tempdir` (e.g., calling `just` with `--tempdir` override or having `JUST_TEMPDIR` set to a noexec path).

Add a new section in the doctor diagnostics:

```bash
echo ""
echo "--- WSL2 Compatibility ---"
if grep -qi microsoft /proc/version 2>/dev/null; then
    echo "  WSL2 detected"
    tempdir="${JUST_TEMPDIR:-/tmp}"
    if mount | grep -q "on $tempdir.*noexec"; then
        echo "WARN: $tempdir is mounted noexec — shebang recipes will fail"
        echo "      Fix: export JUST_TEMPDIR=/tmp"
        warnings=$((warnings + 1))
    else
        echo "  OK: tempdir ($tempdir) supports exec"
    fi
else
    echo "  OK: Not WSL2 (no shebang restrictions)"
fi
```

### Success Criteria
- [ ] Automated: `just --justfile plugin/ralph-hero/justfile --evaluate 2>&1` exits 0 (justfile parses correctly)
- [ ] Automated: `just --justfile plugin/ralph-hero/justfile --list 2>&1 | grep -q issue` (issue alias appears in list)
- [ ] Manual: Run `ralph hero` on WSL2 — should not get "Permission denied (os error 13)"
- [ ] Manual: Run `ralph issue 410` — should return issue details
- [ ] Manual: Run `ralph doctor` on WSL2 — should show WSL2 compatibility section

---

## Integration Testing
- [ ] `just --justfile plugin/ralph-hero/justfile --list` shows all recipes including `issue` alias
- [ ] `just --justfile plugin/ralph-hero/justfile --evaluate` parses without errors
- [ ] Workflow recipes (`triage`, `research`, `plan`, `impl`, `hero`) still work via `_run_skill`
- [ ] Quick recipes (`quick-status`, `quick-issue`) still work via `_mcp_call`
- [ ] `doctor` recipe runs to completion and shows WSL2 section

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-26-GH-0410-justfile-shebang-wsl2-permission-denied.md
- casey/just WSL2 issue: https://github.com/casey/just/issues/2702
- casey/just `--tempdir` addition: https://github.com/casey/just/issues/2719
- just `set tempdir` docs: https://just.systems/man/en/settings.html
