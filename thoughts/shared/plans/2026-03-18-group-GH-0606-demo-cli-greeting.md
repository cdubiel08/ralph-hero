---
date: 2026-03-18
status: draft
type: plan
github_issue: 606
github_issues: [605, 606, 607]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/605
  - https://github.com/cdubiel08/ralph-hero/issues/606
  - https://github.com/cdubiel08/ralph-hero/issues/607
primary_issue: 606
tags: [cli, shell, ralph-cli, ux, onboarding]
---

# Demo CLI Greeting Messages - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-18-GH-0606-cli-version-help-banner]]
- builds_on:: [[2026-03-18-GH-0605-welcome-banner-first-run]]
- builds_on:: [[2026-03-18-GH-0607-help-flag-usage-summary]]
- tensions:: None identified.

## Overview

3 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-606 | Add --version flag to ralph-cli.sh | XS |
| 1 | GH-607 | Add --help flag with usage summary | XS |
| 1 | GH-605 | Add Welcome to Ralph banner on first run | XS |

**Why grouped**: All three issues modify a single file (`plugin/ralph-hero/scripts/ralph-cli.sh`) and together deliver the CLI onboarding experience for the demo. They share a common arg-parsing block and the version-resolution logic. Implementing them atomically eliminates merge conflicts and ensures UX coherence.

## Shared Constraints

- Shell: `bash` with `set -euo pipefail` — must be maintained throughout
- No new external dependencies — pure shell only; `jq` used for version reading with graceful fallback to directory name
- Version sourced from `plugin.json` at runtime (path: `$CACHE_DIR/$LATEST/.claude-plugin/plugin.json`) — stays in sync with releases automatically
- Arg interception uses `"${1:-}"` pattern — safe with `set -u`
- Help output to stdout, exit 0 — POSIX/GNU convention
- First-run detection uses sentinel file `~/.ralph/welcomed`; `RALPH_STATE_DIR` env var overrides the parent dir for testing
- Existing `exec just --justfile "$RALPH_JUSTFILE" "$@"` passthrough must remain unaffected for all non-intercepted args

## Current State Analysis

`plugin/ralph-hero/scripts/ralph-cli.sh` on `main` (23 lines):
- Resolves `RALPH_JUSTFILE` from `~/.claude/plugins/cache/ralph-hero/ralph-hero/$LATEST/justfile`
- No argument parsing — all args pass directly to `exec just`
- `ralph --version` silently falls through to justfile (no `--version` recipe → error)
- `ralph --help` falls through to justfile `default` recipe (`just --list` or `just --choose`)
- No welcome banner or first-run detection

## Desired End State

### Verification
- [ ] `ralph --version` prints `ralph version <VERSION>` and exits 0
- [ ] `ralph -V` behaves identically to `--version`
- [ ] `ralph --help` prints a usage summary including "Usage:" and exits 0
- [ ] `ralph -h` behaves identically to `--help`
- [ ] On first `ralph loop` (or any normal command), welcome banner is displayed
- [ ] On second invocation, banner is suppressed
- [ ] `~/.ralph/welcomed` sentinel file is created after first run
- [ ] Removing sentinel file causes banner to reappear
- [ ] `ralph loop` still works as before (passthrough unaffected)

## What We're NOT Doing

- No changes to the justfile or any other script
- No persistent config beyond the sentinel file
- No color/ANSI formatting (keep it plain text)
- No `--quiet` flag to suppress the banner (out of scope for this XS group)
- No MCP server version surfacing (separate concern from `cli-dispatch.sh`)

## Implementation Approach

All three features are implemented in a single phase as one atomic change to `ralph-cli.sh`. The version-resolution block is added first (before arg interception) so that both `--version` output and the welcome banner can reference `$RALPH_VERSION`. The `--version` and `--help` checks come next (before the justfile-not-found guard and before `exec just`). The welcome banner check comes last, just before `exec just`.

---

## Phase 1: All Three CLI Greeting Features (GH-605, GH-606, GH-607)

### Overview

Add version resolution, `--version`/`-V` flag, `--help`/`-h` flag, and first-run welcome banner to `ralph-cli.sh` in a single atomic edit. All changes occur before the existing `exec just` passthrough.

### Tasks

#### Task 1.1: Add version resolution block
- **files**: `plugin/ralph-hero/scripts/ralph-cli.sh` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `RALPH_VERSION` variable is set before any arg interception
  - [ ] Reads version from `$CACHE_DIR/$LATEST/.claude-plugin/plugin.json` using `jq -r '.version // empty'`
  - [ ] Falls back to `$LATEST` directory name if `jq` is absent or `plugin.json` not found
  - [ ] `CACHE_DIR` and `LATEST` are resolved once and reused (no duplicate `ls` calls)

#### Task 1.2: Add --version / -V flag
- **files**: `plugin/ralph-hero/scripts/ralph-cli.sh` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `ralph --version` prints `ralph version ${RALPH_VERSION}` and exits 0
  - [ ] `ralph -V` produces identical output
  - [ ] Check uses `"${1:-}"` pattern (safe with `set -u`)
  - [ ] Intercepts before justfile-not-found guard

#### Task 1.3: Add --help / -h flag
- **files**: `plugin/ralph-hero/scripts/ralph-cli.sh` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `ralph --help` prints usage summary containing "Usage:" header and exits 0
  - [ ] `ralph -h` produces identical output
  - [ ] Summary lists at minimum: `loop`, `impl`, `plan`, `triage`, `research`, `review`, `hygiene`, `doctor` commands
  - [ ] Summary lists `--version`, `--help`, `-i`, `-q`, `--budget`, `--timeout` options
  - [ ] Output goes to stdout (not stderr)
  - [ ] Intercepts before justfile-not-found guard

#### Task 1.4: Add first-run welcome banner
- **files**: `plugin/ralph-hero/scripts/ralph-cli.sh` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2, 1.3]
- **acceptance**:
  - [ ] On first invocation (no sentinel), banner is printed before `exec just` runs
  - [ ] Banner includes `$RALPH_VERSION` and a hint to run `ralph --help`
  - [ ] `~/.ralph/welcomed` sentinel file is created (`mkdir -p` + `touch`)
  - [ ] On subsequent invocations, banner is not printed (sentinel exists)
  - [ ] `RALPH_STATE_DIR` env var overrides the sentinel parent directory
  - [ ] Banner does NOT appear when `--version` or `--help` flags are used (they exit before reaching banner)

### Phase Success Criteria

#### Automated Verification:
- [ ] `bash -n plugin/ralph-hero/scripts/ralph-cli.sh` — no syntax errors
- [ ] `RALPH_STATE_DIR=$(mktemp -d) plugin/ralph-hero/scripts/ralph-cli.sh --version` — exits 0, output contains "ralph version"
- [ ] `RALPH_STATE_DIR=$(mktemp -d) plugin/ralph-hero/scripts/ralph-cli.sh --help` — exits 0, output contains "Usage:"

#### Manual Verification:
- [ ] `ralph --version` prints correct installed version
- [ ] `ralph --help` shows readable command reference
- [ ] Delete `~/.ralph/welcomed`, run `ralph loop` — welcome banner appears
- [ ] Run `ralph loop` again — banner does not appear

**Creates for next phase**: None (single-phase plan). PR #608 on `feature/GH-604` implements this plan.

---

## Integration Testing
- [ ] `ralph --version` exits 0 after fresh `claude plugin install`
- [ ] `ralph --help` exits 0 after fresh install
- [ ] Welcome banner shown exactly once across multiple `ralph` invocations
- [ ] All existing `ralph <command>` invocations continue working (no regression)

## References
- Research (GH-606): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-18-GH-0606-cli-version-help-banner.md
- Research (GH-605): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-18-GH-0605-welcome-banner-first-run.md
- Research (GH-607): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-18-GH-0607-help-flag-usage-summary.md
- Implementation PR: https://github.com/cdubiel08/ralph-hero/pull/608
- Related issues: https://github.com/cdubiel08/ralph-hero/issues/604, https://github.com/cdubiel08/ralph-hero/issues/605, https://github.com/cdubiel08/ralph-hero/issues/606, https://github.com/cdubiel08/ralph-hero/issues/607
