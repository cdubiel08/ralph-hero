---
type: plan
title: "Demo: Add greeting message to CLI"
date: 2026-03-18
github_issues: [605, 606, 607]
primary_issue: 604
estimate: XS
status: approved
---

# Group Implementation Plan: GH-604 — Demo CLI Greeting Messages

## Overview

Three XS sub-issues that add user-facing polish to `ralph-cli.sh`:

- **#605**: Add "Welcome to Ralph" banner on first run
- **#606**: Add `--version` flag
- **#607**: Add `--help` flag with usage summary

All changes are confined to a single file: `plugin/ralph-hero/scripts/ralph-cli.sh`.

## Shared Constraints

- Shell: `bash` with `set -euo pipefail`
- No external dependencies — pure shell
- First-run detection uses a sentinel file `~/.ralph/welcomed` (created on first run)
- Version is read from the plugin's `plugin.json` at runtime so it stays in sync with releases
- Help output goes to stdout; exit code 0
- Changes must not break existing passthrough behavior (`exec just ...`)

## Phase 1: All Three Features

### Tasks

#### Task 1.1: Add --version flag

- **files**: `plugin/ralph-hero/scripts/ralph-cli.sh`
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - `ralph --version` prints a version string and exits 0
  - Version is sourced from the installed plugin's `plugin.json`
  - Existing `exec just ...` passthrough is unaffected

#### Task 1.2: Add --help flag

- **files**: `plugin/ralph-hero/scripts/ralph-cli.sh`
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - `ralph --help` prints a usage summary and exits 0
  - Summary lists common commands (loop, impl, plan, triage, doctor)
  - Existing `exec just ...` passthrough is unaffected

#### Task 1.3: Add welcome banner on first run

- **files**: `plugin/ralph-hero/scripts/ralph-cli.sh`
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - On first invocation, prints a "Welcome to Ralph" banner
  - Subsequent invocations do not print the banner
  - Sentinel file stored at `~/.ralph/welcomed`
  - Banner includes version and a hint about `ralph --help`

### Automated Verification

- [x] `ralph --version` exits 0 and prints a non-empty version string
- [x] `ralph --help` exits 0 and output contains "Usage:"
- [x] Sentinel file `~/.ralph/welcomed` is created after first run
- [x] Removing sentinel file causes banner to reappear

## File Ownership Summary

| File | Phase |
|------|-------|
| `plugin/ralph-hero/scripts/ralph-cli.sh` | 1 |
| `thoughts/shared/plans/2026-03-18-group-GH-0604-demo-cli-greeting.md` | 1 |
