---
date: 2026-03-18
github_issue: 606
github_url: https://github.com/cdubiel08/ralph-hero/issues/606
status: complete
type: research
tags: [cli, shell, ralph-cli, ux, onboarding]
---

# Research: Add --version flag to ralph-cli.sh (GH-606)

## Prior Work

- builds_on:: None identified.
- tensions:: None identified.

## Problem Statement

`ralph-cli.sh` is the user-facing entry point for Ralph Hero workflows. It currently has no argument parsing — all arguments pass directly to `exec just`. This means:

- `ralph --version` silently fails (just tries to run a justfile recipe named `--version`)
- `ralph --help` falls through to the justfile's `default` recipe (`just --list` or `just --choose`)
- No welcome message greets new users on first run

Issues #605, #606, and #607 together add the three missing CLI affordances that make Ralph feel polished for the onboarding demo (umbrella #604).

## Current State Analysis

`plugin/ralph-hero/scripts/ralph-cli.sh` (on `main`, 23 lines):

- Resolves `RALPH_JUSTFILE` by finding the latest cached plugin version under `~/.claude/plugins/cache/ralph-hero/ralph-hero/`
- Falls back to an install error if justfile not found
- Calls `exec just --justfile "$RALPH_JUSTFILE" "$@"` — no arg interception

Key facts:
- Version is stored in `plugin/ralph-hero/.claude-plugin/plugin.json` as `"version": "2.5.25"`
- The plugin cache path is already resolved in the script; `plugin.json` lives at `$CACHE_DIR/$LATEST/.claude-plugin/plugin.json`
- `jq` is a common dependency and already used in other scripts
- `cli-dispatch.sh` has a `MCP_VERSION` constant but that is the npm package version for direct MCP calls, not the plugin version
- `demo-cleanup.sh` demonstrates the `--help`/`-h` with `sed`-based header extraction — but a static heredoc is cleaner for `ralph-cli.sh` given its short header

## Key Discoveries

### Implementation Already Complete

Commit `f97f4f5` on branch `feature/GH-604` implements all three features atomically:

- `--version` / `-V`: reads version from `plugin.json` via `jq`, falls back to directory name
- `--help` / `-h`: static heredoc listing common commands and options
- First-run welcome banner: shown once using sentinel file `~/.ralph/welcomed`

The implementation is in `plugin/ralph-hero/scripts/ralph-cli.sh` (75-line diff, +71 lines).

A plan document was also committed: `thoughts/shared/plans/2026-03-18-group-GH-0604-demo-cli-greeting.md`

### Implementation Approach Validated

The chosen approach is sound:

1. **Version detection** (`plugin/ralph-hero/scripts/ralph-cli.sh:18-28`): Reuses the existing `CACHE_DIR`/`LATEST` resolution to find `plugin.json`, then reads `version` field with `jq`. Falls back to the directory name (which is the version string) if `jq` is absent.

2. **Arg interception** (`ralph-cli.sh:30-40`): Simple `case`-style if-chain before the `exec just` call. Checks `"${1:-}"` so it is safe with `set -u`.

3. **Help output** (`ralph-cli.sh:42-72`): Static heredoc listing `loop`, `impl`, `plan`, `triage`, `research`, `review`, `hygiene`, `doctor` commands plus flag options. Exits 0. Consistent with POSIX convention.

4. **Welcome banner** (`ralph-cli.sh:74-88`): Sentinel file at `~/.ralph/welcomed`. `RALPH_STATE_DIR` env var allows override for testing. Banner includes version and `ralph --help` hint.

### No Regressions Identified

- Existing `exec just "$@"` passthrough is unaffected for all commands that are not `--version`, `--help`, `-V`, or `-h`
- `set -euo pipefail` is maintained throughout
- No new external dependencies introduced (`jq` is optional with graceful fallback)

## Potential Approaches (for reference)

| Approach | Pros | Cons |
|----------|------|------|
| **Static heredoc** (chosen) | Simple, no dep on justfile, fast | Must be updated manually when commands change |
| Delegate to `just --list` | Always current | Slower, requires justfile resolved first |
| Parse script header with sed (demo-cleanup pattern) | Self-documenting | Script header would need careful maintenance |

Static heredoc is the right choice for a short list of high-level commands.

## Risks

- **`jq` absence**: Handled by fallback to directory name (which equals the version string)
- **Sentinel file permissions**: `mkdir -p ~/.ralph` could fail in restricted envs; low probability
- **`LATEST` computed twice**: The current implementation resolves `LATEST` in two separate blocks. Minor inefficiency, not a bug.

## Recommended Next Steps

1. The branch `feature/GH-604` is ready for PR creation and merge
2. No additional research needed — implementation validated against all three acceptance criteria
3. After merge, issues #605, #606, #607 should be closed (commit message includes `Closes #NNN`)

## Files Affected

### Will Modify
- `plugin/ralph-hero/scripts/ralph-cli.sh` - Add --version, --help, and first-run banner

### Will Read (Dependencies)
- `plugin/ralph-hero/.claude-plugin/plugin.json` - Source of version string (read at runtime from cache)
- `plugin/ralph-hero/scripts/cli-dispatch.sh` - Reference for MCP_VERSION constant and arg-parsing patterns
- `plugin/ralph-hero/scripts/demo-cleanup.sh` - Reference --help pattern (sed-based)
