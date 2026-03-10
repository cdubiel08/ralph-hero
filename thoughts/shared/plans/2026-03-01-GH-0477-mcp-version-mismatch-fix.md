---
date: 2026-03-01
status: draft
type: plan
github_issues: [477]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/477
primary_issue: 477
---

# Fix MCP_VERSION Mismatch in cli-dispatch.sh - Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-477 | Bug: MCP_VERSION mismatch between cli-dispatch.sh and justfile _mcp_call | XS |

## Current State Analysis

`cli-dispatch.sh` line 5 hardcodes `MCP_VERSION="2.4.88"` while `justfile` and `.mcp.json` both reference `ralph-hero-mcp-server@2.4.95`. The release workflow (`release.yml`) uses a `sed` regex matching `ralph-hero-mcp-server@[0-9][0-9.]*` which covers the `justfile` and `.mcp.json` formats but not the `MCP_VERSION="X.Y.Z"` format in `cli-dispatch.sh`. The `git add` step also omits `cli-dispatch.sh`.

## Desired End State
### Verification
- [x] `cli-dispatch.sh` line 5 reads `MCP_VERSION="2.4.95"`
- [x] `release.yml` has a sed targeting `MCP_VERSION="X.Y.Z"` format in `cli-dispatch.sh`
- [x] `release.yml` git add step includes `cli-dispatch.sh` (conditionally, when MCP changed)
- [x] All three version locations (`cli-dispatch.sh`, `justfile`, `.mcp.json`) report the same version

## What We're NOT Doing
- Not unifying the version format across files (Option B from research) — preserving the named `MCP_VERSION` variable is preferable for readability
- Not adding automated version consistency checks (can be a follow-up)
- Not refactoring `_mcp_call` in `justfile` to use the `MCP_VERSION` variable

## Implementation Approach
Three surgical edits to two files. All changes are additive/in-place with no structural refactoring.

---

## Phase 1: GH-477 — Fix MCP_VERSION mismatch
> **Issue**: [GH-477](https://github.com/cdubiel08/ralph-hero/issues/477) | **Research**: [research doc](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0477-mcp-version-mismatch-cli-dispatch.md)

### Changes Required

#### 1. Fix immediate version mismatch
**File**: [`plugin/ralph-hero/scripts/cli-dispatch.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/scripts/cli-dispatch.sh#L5)
**Changes**: Update line 5 from `MCP_VERSION="2.4.88"` to `MCP_VERSION="2.4.95"`

#### 2. Add sed for MCP_VERSION format in release workflow
**File**: [`.github/workflows/release.yml`](https://github.com/cdubiel08/ralph-hero/blob/main/.github/workflows/release.yml#L122-L130)
**Changes**: After the existing sed block (line 128-130), add a new sed command:
```bash
sed -i "s/MCP_VERSION=\"[0-9][0-9.]*\"/MCP_VERSION=\"${NEW_VERSION}\"/g" \
  plugin/ralph-hero/scripts/cli-dispatch.sh
```
This must remain inside the same `if: steps.classify.outputs.mcp_changed == 'true'` conditional (line 123).

#### 3. Add cli-dispatch.sh to git add step
**File**: [`.github/workflows/release.yml`](https://github.com/cdubiel08/ralph-hero/blob/main/.github/workflows/release.yml#L143-L146)
**Changes**: Inside the `if [ "$MCP_CHANGED" = "true" ]` block (lines 143-146), add:
```bash
git add plugin/ralph-hero/scripts/cli-dispatch.sh
```
After line 145 (`git add plugin/ralph-hero/.mcp.json`).

### Success Criteria
- [x] Automated: `grep -q 'MCP_VERSION="2.4.95"' plugin/ralph-hero/scripts/cli-dispatch.sh`
- [x] Automated: `grep -q 'MCP_VERSION=\\"' .github/workflows/release.yml` (new sed pattern present)
- [x] Automated: `grep -q 'cli-dispatch.sh' .github/workflows/release.yml` (file in git add list)
- [x] Manual: All three version locations agree: `grep -oP '(?<=@|=")[0-9.]+' plugin/ralph-hero/scripts/cli-dispatch.sh plugin/ralph-hero/justfile plugin/ralph-hero/.mcp.json`

---

## Integration Testing
- [x] Verify `ralph doctor -q` works with the updated version
- [x] Verify release workflow YAML is syntactically valid: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"`

## References
- Research: [GH-0477 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0477-mcp-version-mismatch-cli-dispatch.md)
- Issue: [GH-477](https://github.com/cdubiel08/ralph-hero/issues/477)
- Related: [GH-298 pin npx version research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0298-pin-npx-version.md)
