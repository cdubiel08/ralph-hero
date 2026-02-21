---
date: 2026-02-21
status: draft
github_issues: [252]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/252
primary_issue: 252
---

# Add mcptools-Based Quick Actions to Ralph CLI - Atomic Implementation Plan

## Overview
Single issue (GH-252) to add 4 mcptools-based quick-action recipes (`quick-status`, `quick-move`, `quick-pick`, `quick-assign`) and a `_mcp_call` internal helper to the existing justfile.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-252 | Add mcptools-based quick actions to Ralph CLI (status, move, pick, assign) | S |

## Current State Analysis

The justfile ([`plugin/ralph-hero/justfile`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile)) has 14 LLM-powered recipes that call `claude -p` via the `_run_skill` helper. All recipes incur LLM cold-start latency and API cost. No direct MCP tool invocation exists.

`mcptools` (`mcp call`) enables direct MCP tool invocation without an LLM -- instant results at zero API cost. The ralph-hero MCP server exposes 44 tools, 4 of which map directly to the requested quick actions: `pipeline_dashboard`, `update_workflow_state`, `pick_actionable_issue`, `update_issue`.

## Desired End State

### Verification
- [ ] `_mcp_call` helper exists in justfile with mcptools dependency check
- [ ] `just quick-status` calls `ralph_hero__pipeline_dashboard` and returns markdown output
- [ ] `just quick-move <issue> <state>` calls `ralph_hero__update_workflow_state`
- [ ] `just quick-pick` calls `ralph_hero__pick_actionable_issue` with configurable state/estimate
- [ ] `just quick-assign <issue> <user>` calls `ralph_hero__update_issue` with assignees
- [ ] Justfile header comment lists mcptools as optional dependency
- [ ] `just --list` shows all 4 quick-action recipes with descriptions

## What We're NOT Doing
- Modifying the MCP server (no new tools or parameters)
- Adding `jq` formatting pipelines (raw mcptools output is sufficient)
- Registering mcptools aliases (user-global, can't be bundled)
- Adding more than the 4 core quick actions (quick-info, quick-list, etc. are future scope)
- Creating tests (justfile recipes are integration-level, tested manually)

## Implementation Approach

Single phase with 3 sequential changes in one file:
1. Update justfile header comment to list mcptools as optional dependency
2. Add `_mcp_call` internal helper recipe
3. Add 4 `quick-*` recipes in a new "Quick Actions" section

---

## Phase 1: GH-252 - Add mcptools Quick Actions
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/252 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0252-mcptools-quick-actions.md

### Changes Required

#### 1. Update justfile header comment
**File**: `plugin/ralph-hero/justfile`
**Lines**: 1-5
**Changes**: Add mcptools as optional dependency in the header comment.

Current:
```
# Ralph Hero - LLM-powered workflow recipes
#
# Usage: just <recipe> [params...]
# Prerequisites: claude CLI, timeout (coreutils)
# Optional: just (https://github.com/casey/just)
```

Replace with:
```
# Ralph Hero - LLM-powered workflow recipes
#
# Usage: just <recipe> [params...]
# Prerequisites: claude CLI, timeout (coreutils)
# Optional: mcptools (https://github.com/f/mcptools) for quick-* recipes
```

#### 2. Add `_mcp_call` internal helper
**File**: `plugin/ralph-hero/justfile`
**Location**: After the existing `_run_skill` helper (after line 104), within the "Internal Helpers" section.
**Changes**: Add a new helper recipe that wraps mcptools invocation with dependency checking.

```just
_mcp_call tool params:
    #!/usr/bin/env bash
    set -eu
    if ! command -v mcp &>/dev/null; then
        echo "Error: mcptools not installed."
        echo "Install: brew tap f/mcptools && brew install mcp"
        echo "   or: go install github.com/f/mcptools/cmd/mcptools@latest"
        exit 1
    fi
    mcp call "{{tool}}" --params '{{params}}' \
        npx -y ralph-hero-mcp-server@latest
```

**Design notes**:
- Mirrors `_run_skill` pattern: internal helper prefixed with `_`, contains dependency check
- Uses `command -v mcp` for portable existence check
- Server command `npx -y ralph-hero-mcp-server@latest` matches `.mcp.json` configuration
- Environment variables (`RALPH_HERO_GITHUB_TOKEN`, etc.) are inherited from shell via `set dotenv-load`
- No timeout wrapper needed -- MCP calls are fast (seconds)

#### 3. Add Quick Action recipes
**File**: `plugin/ralph-hero/justfile`
**Location**: New section "Quick Actions (no LLM)" between "Utility Recipes" (line 76) and "Completion & Documentation" (line 77-81).
**Changes**: Add 4 recipes using the `_mcp_call` helper.

```just
# --- Quick Actions (no LLM, requires mcptools) ---

# Pipeline status dashboard - instant, no API cost
quick-status format="markdown":
    @just _mcp_call "ralph_hero__pipeline_dashboard" \
        '{"format":"{{format}}","includeHealth":true}'

# Move issue to a workflow state - instant, no API cost
quick-move issue state:
    @just _mcp_call "ralph_hero__update_workflow_state" \
        '{"number":{{issue}},"state":"{{state}}","command":"ralph_cli"}'

# Find next actionable issue by workflow state - instant, no API cost
quick-pick state="Research Needed" max-estimate="S":
    @just _mcp_call "ralph_hero__pick_actionable_issue" \
        '{"workflowState":"{{state}}","maxEstimate":"{{max-estimate}}"}'

# Assign issue to a GitHub user - instant, no API cost
quick-assign issue user:
    @just _mcp_call "ralph_hero__update_issue" \
        '{"number":{{issue}},"assignees":["{{user}}"]}'
```

**Design notes**:
- `quick-*` prefix distinguishes instant/free recipes from LLM-powered ones
- `quick-status` defaults to markdown format (native to `pipeline_dashboard`)
- `quick-move` uses `command: "ralph_cli"` to identify the source of state transitions
- `quick-pick` defaults to "Research Needed" state and "S" max estimate (most common use case)
- `quick-assign` takes bare issue number and username (no JSON escaping needed for simple values)
- Issue numbers passed as bare integers (no quotes in JSON) since justfile `{{issue}}` interpolates directly
- Recipe comments include "instant, no API cost" to reinforce the quick-action value proposition

### File Ownership Summary

| File | Changes |
|------|---------|
| `plugin/ralph-hero/justfile` | Update header, add `_mcp_call` helper, add 4 `quick-*` recipes |

### Success Criteria
- [ ] Automated: `grep -c "quick-" plugin/ralph-hero/justfile` returns 4 (4 quick-action recipes)
- [ ] Automated: `grep "_mcp_call" plugin/ralph-hero/justfile | head -1` shows the helper definition
- [ ] Automated: `grep "mcptools" plugin/ralph-hero/justfile` shows header dependency comment
- [ ] Manual: `just --list` in the plugin directory shows quick-status, quick-move, quick-pick, quick-assign
- [ ] Manual: `just quick-status` returns pipeline dashboard output (requires mcptools + token)

---

## Integration Testing
- [ ] Verify `_mcp_call` gracefully errors when mcptools is not installed
- [ ] Verify `quick-status` calls `pipeline_dashboard` with markdown format
- [ ] Verify `quick-move` constructs correct JSON with number and state parameters
- [ ] Verify `quick-pick` defaults work (Research Needed, S estimate)
- [ ] Verify `quick-assign` constructs correct JSON with assignees array
- [ ] Verify `just --list` groups quick-action recipes visibly

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0252-mcptools-quick-actions.md
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/68
- Sibling (justfile created): https://github.com/cdubiel08/ralph-hero/issues/251
- mcptools: https://github.com/f/mcptools
