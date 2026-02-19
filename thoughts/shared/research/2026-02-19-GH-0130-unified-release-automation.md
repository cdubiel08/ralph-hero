---
date: 2026-02-19
github_issue: 130
github_url: https://github.com/cdubiel08/ralph-hero/issues/130
status: complete
type: research
---

# GH-130: Unified Release Automation

## Problem Statement

The release workflow (`release.yml`) only triggers on MCP server source/config changes. Merging PR #89 (agent/skill changes) to main produced no release — plugin consumers get no version bump for non-MCP changes.

The plugin has significant non-MCP content (4 agents, 10+ skills, 45+ hook scripts, 7 spawn templates, 2 orchestrator scripts) that all constitute publishable changes.

## Current State

### Release Workflow (`.github/workflows/release.yml`)

**Triggers** (push to `main`):
- `plugin/ralph-hero/mcp-server/src/**`
- `plugin/ralph-hero/mcp-server/package.json`
- `plugin/ralph-hero/mcp-server/package-lock.json`
- `plugin/ralph-hero/mcp-server/tsconfig.json`
- `plugin/ralph-hero/.claude-plugin/plugin.json`

**Always does**: build, test, version bump (both files), git tag, npm publish, GitHub Release.

**Version sync**: `npm version` bumps `package.json`, then `jq` updates `plugin.json` to match. Both committed atomically. Currently v2.4.4 across all files.

### CI Workflow (`.github/workflows/ci.yml`)

Runs on ALL pushes to `main` and all PRs. No path filters. Tests across Node 18/20/22.

### Plugin Content Not Triggering Releases

| Directory | Files | Purpose |
|-----------|-------|---------|
| `agents/` | 4 markdown | Worker agent definitions |
| `skills/` | 10 SKILL.md + conventions.md | Workflow instructions |
| `hooks/scripts/` | 45 bash + 2 JSON | Validators, state machine |
| `scripts/` | 2 bash | Loop orchestrators |
| `templates/spawn/` | 7 markdown | Multi-agent spawn templates |

## Key Discoveries

### 1. Plugin Distribution Model

The plugin has TWO distribution channels:
- **npm** (`ralph-hero-mcp-server`): Only compiled JS from `mcp-server/dist/`. Consumed via `npx` in `.mcp.json`.
- **Plugin install**: Skills, agents, hooks, templates, scripts served directly by Claude Code from the plugin directory.

This means: **skill/agent changes don't need npm publish** — they're available as soon as the plugin version updates. But they DO need a version bump and GitHub Release so consumers know to update.

### 2. Recommended Architecture: Single Workflow, Conditional npm Publish

**Pattern**: Broaden path triggers, classify changes via `git diff`, conditionally skip npm publish for non-code changes.

```
Merge to main
  → paths filter (broad: code + skills + agents + hooks + scripts + templates)
  → classify step (git diff: did MCP server source change?)
  → build + test (always — validates integrity)
  → version bump both files (always)
  → commit + tag (always)
  → npm publish (ONLY if MCP server source changed)
  → GitHub Release (always)
```

### 3. Change Classification: Native git diff (no third-party actions)

Research evaluated three options:

| Approach | Risk | Maintenance |
|----------|------|-------------|
| `dorny/paths-filter` v3 | Node 20 deprecated April 2026 ([issue #286](https://github.com/dorny/paths-filter/issues/286)), no maintainer response | High — dependency on unmaintained action |
| `step-security/paths-filter` v3 | Same Node 20 cliff, less community adoption | Medium |
| Native `git diff` | Zero supply chain risk | Low — shell script, no dependencies |

**Recommendation**: Native `git diff` using `github.event.before` / `github.sha` for multi-commit push support.

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0  # Full history for multi-commit pushes

- name: Classify changes
  id: classify
  run: |
    BEFORE="${{ github.event.before }}"
    AFTER="${{ github.sha }}"
    DIFF=$(git diff --name-only "$BEFORE" "$AFTER")

    MCP_CHANGED=false
    echo "$DIFF" | grep -qE '^plugin/ralph-hero/mcp-server/(src/|package\.json|package-lock\.json|tsconfig\.json)' && MCP_CHANGED=true

    echo "mcp_changed=$MCP_CHANGED" >> "$GITHUB_OUTPUT"
```

### 4. Semver Strategy

Current behavior (commit message flags) is sufficient:
- Default: **patch** (any change type)
- `#minor` in commit message: minor bump
- `#major` in commit message: major bump
- Manual `workflow_dispatch`: explicit choice

No need for "intelligent" per-category semver — the user controls it via commit messages, and both categories use the same version number.

### 5. Version Sync is Already Bidirectional

The workflow bumps BOTH `package.json` AND `plugin.json` in every release. This means:
- MCP-only changes → both files bumped → npm published → GitHub Release
- Skill-only changes → both files bumped → npm **skipped** → GitHub Release
- Mixed changes → both files bumped → npm published → GitHub Release

The npm package version will skip numbers when skill-only releases occur (e.g., npm 2.4.4 → 2.4.5 skipped → 2.4.6). This is fine — semver doesn't require contiguous versions, and it keeps the single source of truth.

### 6. MCP Servers Precedent

The official `modelcontextprotocol/servers` repo uses `workflow_dispatch` + daily cron (not path-based triggers) with a Python script for change detection. This is overkill for a single-package repo. Their `always()` + result-check pattern for conditional release creation is applicable.

## Recommended Approach

### Changes to `release.yml`

1. **Expand `paths` trigger** to include all plugin content directories
2. **Add `fetch-depth: 0`** to checkout (needed for `github.event.before` diff)
3. **Add `classify` step** using native `git diff` to detect MCP server changes
4. **Gate npm publish** with `if: steps.classify.outputs.mcp_changed == 'true'`
5. **Keep everything else unconditional** (build, test, version bump, tag, GitHub Release)

### New Paths to Add

```yaml
paths:
  # Existing (MCP server)
  - 'plugin/ralph-hero/mcp-server/src/**'
  - 'plugin/ralph-hero/mcp-server/package.json'
  - 'plugin/ralph-hero/mcp-server/package-lock.json'
  - 'plugin/ralph-hero/mcp-server/tsconfig.json'
  - 'plugin/ralph-hero/.claude-plugin/plugin.json'
  # New (plugin content)
  - 'plugin/ralph-hero/agents/**'
  - 'plugin/ralph-hero/skills/**'
  - 'plugin/ralph-hero/hooks/**'
  - 'plugin/ralph-hero/scripts/**'
  - 'plugin/ralph-hero/templates/**'
```

### Edge Cases

- **`[skip ci]` on version bump commit**: Already handled — the release commit includes `[skip ci]` which prevents recursive triggers.
- **Multi-commit pushes**: Handled by `github.event.before` approach (compares full push range, not just last commit).
- **New branch push**: `github.event.before` is all-zeros — treat as code change (safe default).
- **workflow_dispatch**: Always publishes npm (manual trigger = explicit intent). The classify step should default `mcp_changed=true` for dispatch events.

## Risks

1. **npm version gaps**: Skill-only releases bump `package.json` but don't publish. The npm registry will have version gaps. Acceptable — semver doesn't require contiguous versions.
2. **`.mcp.json` uses `@latest`**: Consumers get the latest npm version regardless. Skill-only bumps don't affect npm, so `@latest` stays on the last published version. The `plugin.json` version may be ahead of npm. This is the intended behavior — the plugin version tracks ALL changes, npm version tracks code changes.
3. **Build/test on skill-only changes**: Minor CI cost but validates that the TypeScript still compiles. Worth it for safety.

## Implementation Estimate

This is a small change to a single file (`release.yml`):
- Add ~6 paths to the trigger
- Add one checkout option (`fetch-depth: 0`)
- Add one classification step (~15 lines)
- Add one `if:` condition to the npm publish step

No new files, no new workflows, no new dependencies.
