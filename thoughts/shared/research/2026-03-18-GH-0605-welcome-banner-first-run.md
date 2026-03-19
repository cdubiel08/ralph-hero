---
date: 2026-03-18
github_issue: 605
github_url: https://github.com/cdubiel08/ralph-hero/issues/605
status: complete
type: research
tags: [cli, shell, ralph-cli, ux, onboarding]
---

# Research: Add Welcome to Ralph Banner on First Run (GH-605)

## Prior Work

- builds_on:: [[2026-03-18-GH-0606-cli-version-help-banner]]
- tensions:: None identified.

## Problem Statement

`ralph-cli.sh` has no welcome banner — new users get no onboarding message on their first invocation. Issue #605 asks for a one-time "Welcome to Ralph" banner displayed on first run, after which it should stay silent.

This is a sub-issue of umbrella #604 and is part of the three-issue CLI greeting group alongside #606 (--version) and #607 (--help).

## Current State Analysis

See group research document: [[2026-03-18-GH-0606-cli-version-help-banner]]

Key facts specific to this issue:
- No first-run detection exists in `plugin/ralph-hero/scripts/ralph-cli.sh` on `main`
- No `~/.ralph/` state directory is created by the current script
- The banner feature depends on the version string resolved by #606 (to display `Welcome to Ralph v2.5.25`)

## Key Discoveries

### Implementation Already Complete

Commit `f97f4f5` on branch `feature/GH-604` implements the welcome banner as part of an atomic three-feature commit covering #605, #606, and #607.

Implementation details (`plugin/ralph-hero/scripts/ralph-cli.sh:74-88`):

- Sentinel file: `~/.ralph/welcomed` (path configurable via `RALPH_STATE_DIR` env var)
- On first invocation: creates `~/.ralph/` dir, prints banner, touches sentinel
- Subsequent invocations: banner is suppressed (sentinel file exists)
- Banner text includes version string (from `$RALPH_VERSION` resolved earlier in the script) and a hint to run `ralph --help`

### Design Decisions Validated

1. **Sentinel file over counter**: Simplest reliable mechanism; `touch` is atomic enough for CLI use
2. **`RALPH_STATE_DIR` override**: Enables easy testing by setting env var to a temp dir
3. **Banner placement**: After `--version`/`--help` interception, before `exec just` — banner only shows for normal commands, not for flag-only invocations
4. **No external deps**: Pure bash `cat <<EOF ... EOF` heredoc

### No Regressions

- Existing `exec just "$@"` passthrough unaffected
- First-run detection only adds a file existence check (`[ ! -f "$WELCOMED_FILE" ]`) — negligible overhead

## Files Affected

### Will Modify
- `plugin/ralph-hero/scripts/ralph-cli.sh` - Add first-run banner with sentinel file detection

### Will Read (Dependencies)
- `plugin/ralph-hero/.claude-plugin/plugin.json` - Version string (read at runtime from cache, via #606 logic)
