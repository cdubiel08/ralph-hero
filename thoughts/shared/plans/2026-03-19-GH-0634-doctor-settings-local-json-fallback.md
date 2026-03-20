---
date: 2026-03-19
status: draft
type: plan
github_issue: 634
github_issues: [634]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/634
primary_issue: 634
tags: [cli, doctor, env-vars, settings-local-json]
---

# ralph doctor: resolve env vars from settings.local.json - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-19-GH-0634-doctor-settings-local-json-fallback]]
- builds_on:: [[2026-02-21-GH-0073-ralph-doctor-cli-command]]

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-634 | ralph doctor: resolve env vars from settings.local.json | XS |

## Current State Analysis

The `doctor` recipe in [justfile:149-244](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile#L149-L244) checks required env vars via bash indirect expansion `${!var:-}`. These vars are configured in `.claude/settings.local.json` and only available inside Claude Code's process. The doctor command always reports FAIL when run from the terminal.

A secondary issue: the API Health Check section (line 216) also gates on `${RALPH_HERO_GITHUB_TOKEN:-}` from shell env, so even if the env var section were fixed to show OK, the health check would still SKIP unless the token is also made available for that check.

## Desired End State

### Verification
- [ ] `ralph doctor` shows `OK: RALPH_GH_OWNER = cdubiel08 (from settings.local.json)` when vars are only in settings.local.json
- [ ] `ralph doctor` shows `OK: RALPH_HERO_GITHUB_TOKEN (set, redacted) (from settings.local.json)` for the token
- [ ] `ralph doctor` still shows OK without the source label when vars are in shell env
- [ ] `ralph doctor` shows FAIL when vars are in neither shell env nor settings.local.json
- [ ] API Health Check uses the resolved token (not just shell env) so it no longer SKIPs unnecessarily

## What We're NOT Doing

- Not adding the resolved vars to the shell environment globally (they stay scoped to doctor)
- Not supporting user-level `~/.claude/settings.json` — only project-level `settings.local.json`
- Not changing how the MCP server resolves env vars (it already works correctly inside Claude Code)

## Implementation Approach

Add a `read_settings_env()` bash helper function at the top of the doctor recipe that uses `node -e` to read a specific key from `.claude/settings.local.json`. The env var loop then tries shell env first, falls back to this helper. The resolved values are stored in local variables so the API Health Check section can also use them.

---

## Phase 1: Add settings.local.json fallback to doctor recipe (GH-634)

### Overview
Add `read_settings_env()` helper and modify the env var check loop and API health check gate in the doctor recipe.

### Tasks

#### Task 1.1: Add read_settings_env() helper function
- **files**: `plugin/ralph-hero/justfile` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `read_settings_env()` function defined after `set -eu` and before the env var loop (between lines 152 and 155)
  - [ ] Uses `git rev-parse --show-toplevel` to find project root
  - [ ] Uses `node -e` to parse JSON and extract `env.<VAR>` value
  - [ ] Filters out unexpanded `${...}` literals (matching `resolveEnv()` pattern from `index.ts:34`)
  - [ ] Returns exit code 1 if file missing, parse fails, or value empty/unexpanded
  - [ ] Writes value to stdout on success with no trailing newline

#### Task 1.2: Modify env var check loop to use fallback
- **files**: `plugin/ralph-hero/justfile` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Loop first checks `${!var:-}` (shell env) — unchanged behavior when var is set
  - [ ] If shell env empty, calls `read_settings_env "$var"` as fallback
  - [ ] On fallback success, appends ` (from settings.local.json)` to the OK output
  - [ ] On fallback failure, reports FAIL as before
  - [ ] Token is still redacted regardless of source
  - [ ] Stores a local `resolved_token` variable when `RALPH_HERO_GITHUB_TOKEN` is resolved (for Task 1.3)

#### Task 1.3: Update API Health Check gate to use resolved token
- **files**: `plugin/ralph-hero/justfile` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] Line 216 condition changes from `[ -n "${RALPH_HERO_GITHUB_TOKEN:-}" ]` to `[ -n "${resolved_token:-}" ]`
  - [ ] If token was resolved from settings.local.json, the health check runs (no longer SKIPs)
  - [ ] If token was resolved from settings.local.json, exports it temporarily for the `_mcp_call` subprocess: `RALPH_HERO_GITHUB_TOKEN="$resolved_token" just _mcp_call ...`
  - [ ] Also export `RALPH_GH_OWNER` and `RALPH_GH_PROJECT_NUMBER` if they were resolved from settings, since the MCP server needs all three

### Phase Success Criteria

#### Automated Verification:
- [ ] `just doctor` runs without syntax errors from the `plugin/ralph-hero/` directory
- [ ] `bash -n` syntax check on the recipe passes (no parse errors)

#### Manual Verification:
- [ ] With env vars unset in shell but present in `.claude/settings.local.json`: all three show OK with `(from settings.local.json)` suffix
- [ ] With env vars set in shell: all three show OK without suffix (shell env takes precedence)
- [ ] With env vars in neither: all three show FAIL
- [ ] API Health Check runs when token is available from settings.local.json (requires mcptools)

---

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-19-GH-0634-doctor-settings-local-json-fallback.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/634
