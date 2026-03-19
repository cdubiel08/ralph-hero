---
date: 2026-03-18
github_issue: 607
github_url: https://github.com/cdubiel08/ralph-hero/issues/607
status: complete
type: research
tags: [cli, shell, ralph-cli, ux, onboarding]
---

# Research: Add --help Flag with Usage Summary (GH-607)

## Prior Work

- builds_on:: [[2026-03-18-GH-0606-cli-version-help-banner]]
- tensions:: None identified.

## Problem Statement

`ralph-cli.sh` has no `--help` flag — running `ralph --help` currently falls through to the justfile `default` recipe, which shows `just --list` or `just --choose`. This is an implementation detail, not a user-facing command reference.

Issue #607 asks for a proper `--help` / `-h` flag that prints a concise usage summary listing common Ralph commands and flags.

This is a sub-issue of umbrella #604 and is part of the three-issue CLI greeting group alongside #606 (--version) and #605 (welcome banner).

## Current State Analysis

See group research document: [[2026-03-18-GH-0606-cli-version-help-banner]]

Key facts specific to this issue:
- `ralph-cli.sh` on `main` passes all args to `exec just` — no `--help` interception
- The justfile `default` recipe (line 20-27) runs `just --list` or `just --choose` — not a proper CLI help
- `demo-cleanup.sh` implements `--help`/`-h` via `sed` to extract script header — valid pattern but verbose for ralph-cli.sh
- This feature shares the same arg-parsing block as #606 (`--version`)

## Key Discoveries

### Implementation Already Complete

Commit `f97f4f5` on branch `feature/GH-604` implements `--help`/`-h` as part of an atomic three-feature commit covering #605, #606, and #607.

Implementation details (`plugin/ralph-hero/scripts/ralph-cli.sh:42-72`):

- Intercepts `--help` or `-h` as first argument (`"${1:-}"`)
- Prints a static heredoc to stdout listing: common commands (loop, impl, plan, triage, research, review, hygiene, doctor), flags (--version, --help, -i, -q, --budget, --timeout), and examples
- Exits 0 — consistent with POSIX/GNU convention
- Uses `cat <<EOF ... EOF` heredoc — no external deps

### Design Decisions Validated

1. **Static heredoc over `just --list` delegation**: Faster (no justfile resolution needed), cleaner output format, focuses on high-level UX commands not internal recipes
2. **`-h` alias included**: Consistent with common CLI conventions
3. **Placement before `exec just`**: Arg is consumed before passthrough, so `just` never sees `--help`
4. **Stdout not stderr**: Help output is informational, not an error — exit 0 is correct

### Command List Validated Against Justfile

All 8 commands listed in the help output (`loop`, `impl`, `plan`, `triage`, `research`, `review`, `hygiene`, `doctor`) exist as recipes in the cached justfile.

## Files Affected

### Will Modify
- `plugin/ralph-hero/scripts/ralph-cli.sh` - Add --help/-h flag with static usage heredoc

### Will Read (Dependencies)
- `plugin/ralph-hero/scripts/demo-cleanup.sh` - Reference --help pattern (sed-based alternative)
- `plugin/ralph-hero/scripts/cli-dispatch.sh` - Reference for existing arg-parsing patterns
