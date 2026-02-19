---
date: 2026-02-19
status: draft
github_issues: [130]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/130
primary_issue: 130
---

# Unified Release Automation - Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-130 | Unified release automation: bump plugin version on all publishable changes | S |

## Current State Analysis

The release workflow (`.github/workflows/release.yml`) only triggers on MCP server source/config changes. Plugin content changes (agents, skills, hooks, scripts, templates) merged to main produce no release -- plugin consumers get no version bump for non-MCP changes. PR #89 demonstrated this gap.

The workflow currently:
- Triggers on 5 path patterns (all under `mcp-server/` or `.claude-plugin/`)
- Always: builds, tests, bumps both `package.json` and `plugin.json`, commits, tags, publishes to npm, creates GitHub Release
- Uses `[skip ci]` in the version bump commit to prevent recursive triggers
- Supports `#minor`/`#major` commit message flags and `workflow_dispatch` manual override

The plugin has two distribution channels:
1. **npm** (`ralph-hero-mcp-server`): Only compiled JS from `mcp-server/dist/`, consumed via `npx`
2. **Plugin install**: Skills, agents, hooks, templates, scripts served directly by Claude Code

Skill/agent changes don't need npm publish -- they're available as soon as the plugin version updates. But they DO need a version bump and GitHub Release so consumers know to update.

## Desired End State

A single workflow that triggers on ALL publishable plugin content changes, classifies whether MCP server source changed, and conditionally gates npm publish while always performing version bump + tag + GitHub Release.

### Verification
- [ ] Merging a PR that only touches `skills/` or `agents/` triggers a release with version bump
- [ ] The npm package version and plugin.json version stay in sync after any release
- [ ] GitHub Release is created for every version bump
- [ ] `#minor` and `#major` commit message flags still work
- [ ] MCP-server-only changes still publish to npm
- [ ] Skill/agent-only changes bump versions but skip npm publish if no server code changed
- [ ] `workflow_dispatch` continues to always publish to npm (explicit intent)
- [ ] Multi-commit pushes are handled correctly (full push range diff)

## What We're NOT Doing
- No new workflows or files -- all changes in the existing `release.yml`
- No third-party actions (no `dorny/paths-filter`) -- native `git diff` only
- No per-category semver intelligence -- default patch, `#minor`/`#major` via commit message
- No changes to `ci.yml` (it already runs on all pushes to main and all PRs)
- No changes to `package.json`, `plugin.json`, or any plugin content files

## Implementation Approach

This is a single-phase change to `.github/workflows/release.yml` with four discrete modifications: expand trigger paths, deepen checkout, add a classification step, and gate npm publish.

---

## Phase 1: GH-130 - Unified Release Automation
> **Issue**: [GH-130](https://github.com/cdubiel08/ralph-hero/issues/130) | **Research**: [2026-02-19-GH-0130-unified-release-automation.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0130-unified-release-automation.md)

### Changes Required

#### 1. Expand path triggers
**File**: [`.github/workflows/release.yml`](https://github.com/cdubiel08/ralph-hero/blob/main/.github/workflows/release.yml)
**Lines**: 6-11 (the `paths:` block under `push:`)
**Changes**: Add 5 new path patterns for plugin content directories after the existing 5 patterns:

```yaml
paths:
  # MCP server (existing)
  - 'plugin/ralph-hero/mcp-server/src/**'
  - 'plugin/ralph-hero/mcp-server/package.json'
  - 'plugin/ralph-hero/mcp-server/package-lock.json'
  - 'plugin/ralph-hero/mcp-server/tsconfig.json'
  - 'plugin/ralph-hero/.claude-plugin/plugin.json'
  # Plugin content (new)
  - 'plugin/ralph-hero/agents/**'
  - 'plugin/ralph-hero/skills/**'
  - 'plugin/ralph-hero/hooks/**'
  - 'plugin/ralph-hero/scripts/**'
  - 'plugin/ralph-hero/templates/**'
```

This ensures ANY publishable plugin content change triggers the release workflow.

#### 2. Add `fetch-depth: 0` to checkout
**File**: [`.github/workflows/release.yml`](https://github.com/cdubiel08/ralph-hero/blob/main/.github/workflows/release.yml)
**Line**: 39 (the `actions/checkout@v4` step)
**Changes**: Add `with: fetch-depth: 0` to enable `git diff` against `github.event.before` for multi-commit push support:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
```

Without full history, `github.event.before` may not be reachable and `git diff` would fail for multi-commit pushes.

#### 3. Add change classification step
**File**: [`.github/workflows/release.yml`](https://github.com/cdubiel08/ralph-hero/blob/main/.github/workflows/release.yml)
**Location**: After the checkout step (line 39), before the Node.js setup step
**Changes**: Insert a new step that classifies whether MCP server source files changed:

```yaml
- name: Classify changes
  id: classify
  working-directory: .
  run: |
    BEFORE="${{ github.event.before }}"
    AFTER="${{ github.sha }}"

    # For workflow_dispatch or new branch push (before is all-zeros), default to mcp_changed=true
    if [ "${{ github.event_name }}" = "workflow_dispatch" ] || echo "$BEFORE" | grep -qE '^0+$'; then
      echo "mcp_changed=true" >> "$GITHUB_OUTPUT"
      echo "Classification: mcp_changed=true (dispatch or new branch)"
      exit 0
    fi

    DIFF=$(git diff --name-only "$BEFORE" "$AFTER")
    echo "Changed files:"
    echo "$DIFF"

    MCP_CHANGED=false
    echo "$DIFF" | grep -qE '^plugin/ralph-hero/mcp-server/(src/|package\.json|package-lock\.json|tsconfig\.json)' && MCP_CHANGED=true

    echo "mcp_changed=$MCP_CHANGED" >> "$GITHUB_OUTPUT"
    echo "Classification: mcp_changed=$MCP_CHANGED"
```

Key design decisions:
- `workflow_dispatch` defaults to `mcp_changed=true` because manual trigger = explicit intent to publish
- New branch push (`github.event.before` is all-zeros) defaults to `mcp_changed=true` as a safe default
- Uses `grep -qE` with the exact MCP server source paths (src/, package.json, package-lock.json, tsconfig.json)
- Logs changed files and classification result for debuggability

#### 4. Gate npm publish with conditional
**File**: [`.github/workflows/release.yml`](https://github.com/cdubiel08/ralph-hero/blob/main/.github/workflows/release.yml)
**Location**: The "Publish to npm" step (currently line 101-103)
**Changes**: Add an `if:` condition so npm publish only runs when MCP server source changed:

```yaml
- name: Publish to npm
  if: steps.classify.outputs.mcp_changed == 'true'
  run: npm publish --provenance --access public
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

All other steps (build, test, version bump, commit, tag, GitHub Release) remain unconditional -- they execute for every trigger regardless of change classification.

### Success Criteria
- [ ] Automated: Push a commit touching only `plugin/ralph-hero/skills/` to main -> workflow triggers, version bumps, GitHub Release created, npm publish SKIPPED
- [ ] Automated: Push a commit touching `plugin/ralph-hero/mcp-server/src/` to main -> workflow triggers, version bumps, GitHub Release created, npm publish RUNS
- [ ] Automated: Push a commit touching both MCP server and skills -> workflow triggers, version bumps, GitHub Release created, npm publish RUNS
- [ ] Automated: `workflow_dispatch` trigger -> npm publish RUNS (explicit intent)
- [ ] Manual: Verify `package.json` and `plugin.json` versions match after each release type
- [ ] Manual: Verify `#minor` and `#major` commit message flags still produce correct bump types

---

## Integration Testing

Since this modifies CI/CD infrastructure, testing requires actual pushes to main or a test branch:

- [ ] Create a test branch with skills-only change, verify workflow triggers and correctly classifies `mcp_changed=false`
- [ ] Create a test branch with mcp-server change, verify workflow triggers and correctly classifies `mcp_changed=true`
- [ ] Verify the `[skip ci]` version bump commit does not re-trigger the workflow
- [ ] Verify `concurrency: release` still prevents parallel releases

**Note**: The classify step logs its output, so failures are debuggable from the Actions run log without re-running.

## Edge Cases

| Edge Case | Handling |
|-----------|----------|
| `[skip ci]` on version bump commit | Already handled -- existing behavior preserved |
| Multi-commit push | `github.event.before` covers full push range |
| New branch push | `github.event.before` is all-zeros -> defaults to `mcp_changed=true` |
| `workflow_dispatch` | Always sets `mcp_changed=true` (explicit intent) |
| npm version gaps | Acceptable -- semver doesn't require contiguous versions |
| `.mcp.json` uses `@latest` | `@latest` stays on last published version; plugin.json may be ahead -- intended behavior |

## References
- Research: [2026-02-19-GH-0130-unified-release-automation.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0130-unified-release-automation.md)
- Issue: [GH-130](https://github.com/cdubiel08/ralph-hero/issues/130)
- Current workflow: [`.github/workflows/release.yml`](https://github.com/cdubiel08/ralph-hero/blob/main/.github/workflows/release.yml)
- CI workflow: [`.github/workflows/ci.yml`](https://github.com/cdubiel08/ralph-hero/blob/main/.github/workflows/ci.yml)
