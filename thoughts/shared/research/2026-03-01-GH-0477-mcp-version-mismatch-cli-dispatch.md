---
date: 2026-03-01
github_issue: 477
github_url: https://github.com/cdubiel08/ralph-hero/issues/477
status: complete
type: research
---

# GH-477: MCP_VERSION Mismatch Between cli-dispatch.sh and justfile _mcp_call

## Problem Statement

`cli-dispatch.sh` hardcodes `MCP_VERSION="2.4.88"` (line 5) while both `justfile` and `.mcp.json` reference `ralph-hero-mcp-server@2.4.95`. Quick-mode (`-q`) commands routed through `run_quick()` in `cli-dispatch.sh` therefore spawn the old MCP server version, creating behavioral inconsistencies between quick-mode and interactive/headless modes.

## Current State Analysis

### Three Version Locations

| File | Location | Current Value | Updated by release.yml |
|------|----------|---------------|------------------------|
| `plugin/ralph-hero/scripts/cli-dispatch.sh` | Line 5, `MCP_VERSION=` variable | `"2.4.88"` | **No** |
| `plugin/ralph-hero/justfile` | Line 715, `_mcp_call` literal | `ralph-hero-mcp-server@2.4.95` | Yes (sed line 128) |
| `plugin/ralph-hero/.mcp.json` | Line 5, `args` array | `ralph-hero-mcp-server@2.4.95` | Yes (sed line 128) |

### How `run_quick()` Uses `MCP_VERSION`

In `cli-dispatch.sh:74-75`:
```bash
raw=$(mcp call "$tool" --params "$params" \
    npx -y "ralph-hero-mcp-server@${MCP_VERSION}")
```
The `${MCP_VERSION}` variable is interpolated directly into the `npx` invocation. Any recipe using `-q` mode (e.g., `status -q`, `hygiene -q`, `ls -q`) uses this stale version.

### The Release Workflow Gap

In `.github/workflows/release.yml:128-130`:
```bash
sed -i "s/ralph-hero-mcp-server@[0-9][0-9.]*/ralph-hero-mcp-server@${NEW_VERSION}/g" \
  plugin/ralph-hero/justfile \
  plugin/ralph-hero/.mcp.json
```

The regex `ralph-hero-mcp-server@[0-9][0-9.]*` matches the `@X.Y.Z` suffix pattern used in `justfile` and `.mcp.json`. However, `cli-dispatch.sh` uses a **different format**: `MCP_VERSION="2.4.88"` — no `ralph-hero-mcp-server@` prefix — so the regex never matches.

Additionally, the `git add` step (release.yml:132-146) explicitly lists:
- `plugin/ralph-hero/mcp-server/package.json`
- `plugin/ralph-hero/mcp-server/package-lock.json`
- `plugin/ralph-hero/.claude-plugin/plugin.json`
- (conditionally) `plugin/ralph-hero/justfile` and `plugin/ralph-hero/.mcp.json`

`plugin/ralph-hero/scripts/cli-dispatch.sh` is absent from the staging list.

## Key Discoveries

### Discovery 1: Dual Version Tracking
The codebase has two independently-tracked version references:
- `cli-dispatch.sh:5` — shell variable `MCP_VERSION="2.4.88"`
- `justfile:715` and `.mcp.json:5` — literal `ralph-hero-mcp-server@2.4.95`

### Discovery 2: `_mcp_call` vs `run_quick()` Divergence
The `justfile` has its own `_mcp_call` private recipe (lines 704-725) that independently hard-codes the version. Both code paths do the same thing but are separately maintained. The existing sed **does** keep `justfile` current; only `cli-dispatch.sh` is missed.

### Discovery 3: `cli-dispatch.sh` Added After Release Workflow Stabilized
The script at `plugin/ralph-hero/scripts/cli-dispatch.sh` is an untracked new file (confirmed by git status), suggesting it was recently introduced and the release workflow was never updated to cover it.

### Discovery 4: Affected Commands
All recipes that source `cli-dispatch.sh` and use `-q` mode are affected: `status`, `hygiene`, `ls`, `info`, `next`, `move`, `deps`, `where`, `assign`, `draft`, `comment`, `issue`, `approve` — approximately 13+ commands.

## Potential Approaches

### Option A: Add a Second `sed` Pattern for `MCP_VERSION` Format (Recommended)

Add a second `sed` command targeting the `MCP_VERSION="X.Y.Z"` format in the release workflow:

```bash
sed -i "s/MCP_VERSION=\"[0-9][0-9.]*\"/MCP_VERSION=\"${NEW_VERSION}\"/g" \
  plugin/ralph-hero/scripts/cli-dispatch.sh
```

And add `plugin/ralph-hero/scripts/cli-dispatch.sh` to the `git add` step.

**Pros:**
- Minimal change surface — only the release workflow and git add list
- Preserves the current `cli-dispatch.sh` architecture
- Follows the same pattern already used for other files
- Easiest to review and verify

**Cons:**
- Two different version patterns must remain synchronized in the regex
- Slight duplication of sed logic

### Option B: Unify Format in `cli-dispatch.sh`

Refactor `cli-dispatch.sh` so `run_quick()` uses the same `ralph-hero-mcp-server@X.Y.Z` inline literal instead of a `MCP_VERSION` variable. Then the existing single `sed` command covers all three files.

**Pros:**
- Single version format across all files — simpler long-term maintenance
- No changes needed to release workflow regex

**Cons:**
- Requires modifying `cli-dispatch.sh` itself, not just the release workflow
- Loses the named variable (`MCP_VERSION`), making future refactors harder
- The version string becomes a literal embedded in `run_quick()` body

## Risks

- **Low risk overall** — this is a targeted, mechanical fix
- If `cli-dispatch.sh` was meant to be covered by Option B originally, Option A creates technical debt by introducing a second format
- The `mcp_changed` condition gate on the sed step (release.yml:123) means both new sed commands should be inside the same conditional block

## Recommended Next Steps

1. Implement **Option A**: add a second `sed` targeting `MCP_VERSION="X.Y.Z"` in `cli-dispatch.sh`
2. Add `plugin/ralph-hero/scripts/cli-dispatch.sh` to the `git add` list in release.yml
3. Fix the immediate mismatch: update `MCP_VERSION` in `cli-dispatch.sh` from `"2.4.88"` to `"2.4.95"`
4. Add a test or doctor check that validates all three version locations agree

## Files Affected

### Will Modify
- `plugin/ralph-hero/scripts/cli-dispatch.sh` - Update `MCP_VERSION` from `2.4.88` to `2.4.95`
- `.github/workflows/release.yml` - Add sed for `MCP_VERSION="X.Y.Z"` format; add `cli-dispatch.sh` to git add step

### Will Read (Dependencies)
- `plugin/ralph-hero/justfile` - Reference for `_mcp_call` version format and `mcp_changed` gate behavior
- `plugin/ralph-hero/.mcp.json` - Reference for current version (2.4.95)
