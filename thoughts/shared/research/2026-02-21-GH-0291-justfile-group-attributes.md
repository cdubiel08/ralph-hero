---
date: 2026-02-21
github_issue: 291
github_url: https://github.com/cdubiel08/ralph-hero/issues/291
status: complete
type: research
---

# GH-291: Add [group()] attributes to all justfile recipes

## Problem Statement

`just --list` outputs 22+ recipes in declaration order with no visual grouping. Users scanning for a recipe cannot distinguish workflow phases from orchestrators, quick actions, or setup utilities.

## Current State Analysis

### File

**[plugin/ralph-hero/justfile](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile)** -- 316 lines, 22 public recipes + 2 private helpers.

### All Current Recipes (22 public)

| Recipe | Current section comment |
|--------|------------------------|
| `default` | (top) |
| `triage` | Individual Phase Recipes |
| `split` | Individual Phase Recipes |
| `research` | Individual Phase Recipes |
| `plan` | Individual Phase Recipes |
| `review` | Individual Phase Recipes |
| `impl` | Individual Phase Recipes |
| `hygiene` | Individual Phase Recipes |
| `status` | Individual Phase Recipes |
| `team` | Orchestrator Recipes |
| `hero` | Orchestrator Recipes |
| `loop` | Orchestrator Recipes |
| `setup` | Utility Recipes |
| `report` | Utility Recipes |
| `doctor` | Utility Recipes |
| `install-cli` | Utility Recipes |
| `uninstall-cli` | Utility Recipes |
| `install-completions` | Utility Recipes |
| `quick-status` | Quick Actions |
| `quick-move` | Quick Actions |
| `quick-pick` | Quick Actions |
| `quick-assign` | Quick Actions |
| `quick-issue` | Quick Actions |
| `quick-info` | Quick Actions |
| `quick-comment` | Quick Actions |
| `completions` | Completion & Documentation |

Private helpers: `_run_skill`, `_mcp_call` (already prefixed with `_`, which hides them from `just --list` by default).

### No `[group()]` Attributes Currently

Confirmed: no `[group()]`, `[private]`, or `alias` directives exist in the justfile.

## Version Requirement Risk

The installed `just` version is **1.21.0**. The `[group()]` attribute requires **just v1.27+**.

This is a compatibility risk. The justfile currently has `set shell := ["bash", "-euc"]` but no `min-version` constraint. Users on older `just` versions (including the dev machine at 1.21.0) will get an error when attributes are used.

**Mitigation options**:
1. Add `set min-version := "1.27.0"` to the justfile -- gives a clear error to users who need to upgrade
2. Document the version requirement in README

## Recommended Taxonomy

Based on existing section comments and issue body:

| Group name | Recipes |
|------------|---------|
| `workflow` | triage, split, research, plan, review, impl, hygiene, status |
| `orchestrate` | team, hero, loop |
| `setup` | setup, doctor, install-cli, uninstall-cli, install-completions, completions |
| `quick` | quick-status, quick-move, quick-pick, quick-assign, quick-issue, quick-info, quick-comment |

Notes:
- `report` fits best in `workflow` (board monitoring) or a standalone `board` group -- recommend `workflow`
- `default` recipe has no group (it's the entry point, stays ungrouped or gets `[private]`)
- `_run_skill` and `_mcp_call` should get `[private]` attribute even though `_` prefix already hides them; belt-and-suspenders

## Implementation Plan

### 1. Add version constraint (line 1)
```just
set min-version := "1.27.0"
```

### 2. Add `[group()]` to each recipe

Example for workflow group:
```just
[group('workflow')]
triage issue="" budget="1.00" timeout="15m":
    @just _run_skill "triage" "{{issue}}" "{{budget}}" "{{timeout}}"
```

### 3. Add `[private]` to helpers
```just
[private]
_run_skill skill issue budget timeout:

[private]
_mcp_call tool params:
```

### 4. Remove section comments

The `---` comment dividers (e.g., `# --- Individual Phase Recipes ---`) become redundant once groups are in place. They can be removed to clean up.

## Estimate Validation

XS is correct. This is purely additive -- 22 attribute lines + 1 version constraint + optional comment cleanup. No logic changes.

## Risks

- **just v1.27+ required**: Dev machine has 1.21.0. Adding `set min-version` will cause failures for users on older just. Should document upgrade path.
- **`report` group placement**: Minor ambiguity -- either `workflow` or a new `board` group. Recommend `workflow` to keep group count to 4.
