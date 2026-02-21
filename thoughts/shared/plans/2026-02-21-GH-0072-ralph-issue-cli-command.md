---
date: 2026-02-21
status: draft
github_issues: [72]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/72
primary_issue: 72
---

# Implement `ralph issue` CLI Command - Atomic Implementation Plan

## Overview
Single issue (GH-72) to add a `quick-issue` recipe to the justfile for quick GitHub issue creation with project field values (label, priority, estimate, workflow state) using the existing `_mcp_call` helper and `ralph_hero__create_issue` MCP tool.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-72 | Implement `ralph issue` CLI command for quick issue creation | S |

## Current State Analysis

The justfile (`plugin/ralph-hero/justfile`, 139 lines) has 14 LLM-powered recipes via `_run_skill` and 4 quick-action recipes via `_mcp_call` (quick-status, quick-move, quick-pick, quick-assign, shipped in GH-252). The `ralph_hero__create_issue` MCP tool already supports all needed parameters (title, labels, priority, estimate, workflowState) -- no server changes required.

## Desired End State

### Verification
- [x] `quick-issue` recipe exists in justfile with title (required), label, priority, estimate, state parameters
- [x] `quick-info` recipe exists in justfile for fetching issue details
- [x] `quick-comment` recipe exists in justfile for adding comments
- [x] All 3 new recipes use `_mcp_call` helper
- [x] `just --list` shows all 3 new recipes with descriptions

## What We're NOT Doing
- Modifying the MCP server (no new tools or parameters)
- Supporting multiple labels per invocation (single label covers most common case)
- Adding `jq` as a dependency (conditional JSON construction in bash)
- Adding body/assignees parameters to `quick-issue` (can be added later, or use `quick-assign` post-creation)
- Creating tests (justfile recipes are integration-level, tested manually)

## Implementation Approach

Single phase with additions to one file. Three new recipes added to the "Quick Actions" section of the justfile:
1. `quick-issue` -- bash script recipe with conditional JSON construction (Approach B from research)
2. `quick-info` -- inline `_mcp_call` recipe (natural companion)
3. `quick-comment` -- inline `_mcp_call` recipe (natural companion)

---

## Phase 1: GH-72 - Add Quick Issue Creation and Companion Recipes
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/72 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0072-ralph-issue-cli-command.md

### Changes Required

#### 1. Add `quick-issue`, `quick-info`, and `quick-comment` recipes
**File**: `plugin/ralph-hero/justfile`
**Location**: In the "Quick Actions (no LLM, requires mcptools)" section (after line 97, before line 99).
**Changes**: Add 3 new recipes.

After the existing `quick-assign` recipe (line 97), add:

```just
# Create a new issue with project fields - instant, no API cost
quick-issue title label="" priority="" estimate="" state="Backlog":
    #!/usr/bin/env bash
    set -eu
    params='{"title":"{{title}}"'
    if [ -n "{{label}}" ]; then params="$params,\"labels\":[\"{{label}}\"]"; fi
    if [ -n "{{priority}}" ]; then params="$params,\"priority\":\"{{priority}}\""; fi
    if [ -n "{{estimate}}" ]; then params="$params,\"estimate\":\"{{estimate}}\""; fi
    params="$params,\"workflowState\":\"{{state}}\"}"
    just _mcp_call "ralph_hero__create_issue" "$params"

# Get full issue details with project fields - instant, no API cost
quick-info issue:
    @just _mcp_call "ralph_hero__get_issue" \
        '{"number":{{issue}}}'

# Add a comment to an issue - instant, no API cost
quick-comment issue body:
    @just _mcp_call "ralph_hero__create_comment" \
        '{"number":{{issue}},"body":"{{body}}"}'
```

**Design notes**:
- `quick-issue` uses Approach B from research: bash script recipe with conditional JSON construction, single label support, no `jq` dependency
- `title` is the only required parameter; all others have defaults or are conditionally included
- `state` defaults to `"Backlog"` (standard entry point for new issues)
- `workflowState` is always included since the default is meaningful
- `label` supports a single label string (e.g., `label="enhancement"`); wraps in JSON array `["label"]`
- `quick-info` and `quick-comment` are simple inline recipes using the existing `_mcp_call` pattern
- All recipes follow the `quick-*` naming convention and include "instant, no API cost" in their comments

### File Ownership Summary

| File | Changes |
|------|---------|
| `plugin/ralph-hero/justfile` | Add 3 recipes: `quick-issue`, `quick-info`, `quick-comment` |

### Success Criteria
- [x] Automated: `grep -c "^quick-" plugin/ralph-hero/justfile` returns 7 (4 existing + 3 new)
- [x] Automated: `grep "quick-issue\|quick-info\|quick-comment" plugin/ralph-hero/justfile | wc -l` returns at least 3 (recipe definitions)
- [x] Automated: `grep "_mcp_call" plugin/ralph-hero/justfile | wc -l` returns at least 7 (helper definition + 7 recipe calls)
- [ ] Manual: `just quick-issue "Test issue" label="enhancement" priority="P2" estimate="XS"` creates an issue
- [ ] Manual: `just quick-info 72` returns issue details
- [ ] Manual: `just quick-comment 72 "Test comment"` adds a comment

---

## Integration Testing
- [ ] Verify `quick-issue` with only title (all optional params empty) creates issue in Backlog
- [ ] Verify `quick-issue` with all params populated creates issue with correct fields
- [ ] Verify `quick-issue` with label adds label array to JSON
- [ ] Verify `quick-info` returns full issue details including project fields
- [ ] Verify `quick-comment` adds comment body to the specified issue
- [ ] Verify `just --list` shows all 7 quick-action recipes

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0072-ralph-issue-cli-command.md
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/59
- Sibling (justfile created): https://github.com/cdubiel08/ralph-hero/issues/68
- Quick actions (GH-252): https://github.com/cdubiel08/ralph-hero/issues/252
