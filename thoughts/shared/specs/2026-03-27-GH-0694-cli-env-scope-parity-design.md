---
date: 2026-03-27
status: approved
type: spec
github_issue: 694
github_url: https://github.com/cdubiel08/ralph-hero/issues/694
tags: [spec, cli, env-resolution, setup, scope-detection, settings]
---

# Design: CLI Environment Resolution Scope Parity

## Prior Work

- builds_on:: [[2026-03-26-GH-0694-ralph-cli-env-resolution-outside-repo]]
- builds_on:: [[2026-03-06-GH-0546-ralph-cli-justfile-architecture]]
- builds_on:: [[2026-03-25-GH-0684-userconfig-healthcheck-setup-rewrite]]

## Problem

The `ralph` CLI fails with `"owner is required (set RALPH_GH_OWNER env var or pass explicitly)"` when run outside the ralph-hero repo. Root cause: env vars are stored in project-scoped `settings.local.json`, which is invisible to other directories.

## Design Principle

Use Claude Code's native settings hierarchy — no parallel config system (`~/.ralph/config`, etc.):

| Install scope | Config file for env vars | Implication |
|---|---|---|
| User (`"scope": "user"`) | `~/.claude/settings.json` | Works wherever Claude runs |
| Project (`"scope": "project"`) | `<project>/.claude/settings.local.json` | Only works from that project root |

The authoritative scope signal is the `"scope"` field in `~/.claude/plugins/installed_plugins.json`.

## Approach

**Scope Detection + Correct Config Placement** (Approach A from brainstorming). One source of truth per install scope, no dual-write drift, no parallel resolution logic.

## Design Sections

### 1. Scope Detection

Read `~/.claude/plugins/installed_plugins.json`, find the `ralph-hero@ralph-hero` entry, check `"scope"`:

```json
"ralph-hero@ralph-hero": [
  {
    "scope": "user",
    "installPath": "/Users/dubiel/.claude/plugins/cache/ralph-hero/ralph-hero/2.5.50",
    ...
  }
]
```

- `"user"` → target `~/.claude/settings.json`
- `"project"` → target `<project>/.claude/settings.local.json`

Used by: setup skill (write), doctor (diagnostic), `read_settings_env()` (read).

### 2. Setup Skill Changes

The setup skill currently always writes to `<project>/.claude/settings.local.json`. Changes:

1. **Detect scope** from `installed_plugins.json`
2. **Write non-sensitive env vars** (`RALPH_GH_OWNER`, `RALPH_GH_PROJECT_NUMBER`, optionally `RALPH_GH_REPO`) to the scope-appropriate file
3. **Token handling** stays as-is (manual `settings.local.json` for the token specifically). This design is independent of GH-684 `userConfig` work — when that lands, it changes only the token delivery path, not the non-sensitive env var placement. Setup communicates where the token needs to go based on scope
4. **Warn on scope mismatch**: If user-scoped install but env vars only in a project-local file, surface as diagnostic

### 3. Doctor / `read_settings_env()` Parity

Current search: repo-local `settings.local.json` → global `settings.local.json`. Updated search order:

1. Shell environment (already checked)
2. `<repo>/.claude/settings.local.json` (project-scoped user secrets)
3. `<repo>/.claude/settings.json` (project-scoped committed config)
4. `~/.claude/settings.json` (user-scoped config)

Additional changes:
- **Source labeling**: Extend doctor labels to distinguish `settings.json` vs `settings.local.json`, repo vs global
- **Scope-aware diagnostics**: If scope is `"user"` but vars only found in project-local file, warn that CLI won't work outside that project

### 4. CLI Dispatch Env Bridging

Two subprocess paths in `cli-dispatch.sh`:

| Path | How env arrives | Fix needed? |
|---|---|---|
| `run_headless` (`claude -p`) | Claude Code resolves settings | No — if settings are in the right file per scope |
| `run_quick` (`mcp call` via mcptools) | Direct subprocess, no Claude Code | **Yes** — must bridge env explicitly |

Fix for `run_quick`:
- **Extract `read_settings_env()`** from the justfile's `doctor` recipe into a shared shell function in `scripts/`
- Before `mcp call`, resolve and export `RALPH_GH_OWNER`, `RALPH_GH_PROJECT_NUMBER`, `RALPH_GH_REPO` if not already in environment
- Makes quick path (`ralph status -q`, `ralph issue -q`) work from any directory

`run_headless` / `run_interactive`: No code change, but verify via manual test that Claude Code reads `~/.claude/settings.json` `"env"` for user-scoped plugins.

### 5. Audit Checklist

| Component | Status | Action |
|---|---|---|
| Setup skill | Change | Write to scope-appropriate config file |
| Doctor | Change | Search full hierarchy, scope-aware diagnostics |
| `read_settings_env()` | Change | Extract to shared function, add `settings.json` paths |
| `run_quick` | Change | Bridge env before `mcp call` |
| `run_headless` / `run_interactive` | Verify | Manual test: Claude Code reads `~/.claude/settings.json` for user-scoped |
| MCP server `resolveEnv()` | No change | Reads `process.env`, correct regardless of source |
| `ralph-cli.sh` | No change | Hardcoded to user cache path — consistent with user-scope only |
| `setup-cli` skill | No change | Document: only supports user-scoped installs |
| Error messages (`helpers.ts:556`) | Change | Update to mention scope-appropriate config file location |

## What We're NOT Doing

- Creating a `~/.ralph/config` or any parallel config system
- Changing the MCP server's `resolveEnv()` or env var names
- Changing the token resolution chain
- Supporting `settings.local.json` at `~/.claude/` (not a real Claude Code pattern)
- Changing `ralph-cli.sh` to support project-scoped installs (no global CLI for project-scope — that's consistent)
