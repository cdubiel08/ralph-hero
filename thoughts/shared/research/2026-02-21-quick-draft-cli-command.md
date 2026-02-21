---
date: 2026-02-21
status: complete
type: research
---

# Quick-Draft CLI Command Research

## Problem Statement

Users want a `ralph quick-draft "my thoughts"` CLI command that creates a draft issue in the GitHub Project with appropriate tagging (workflow state, priority, estimate) and adds it to the backlog — without requiring a full GitHub issue.

## Current Architecture

### Draft Issue MCP Tools

The MCP server already provides two draft issue tools in `project-management-tools.ts`:

1. **`ralph_hero__create_draft_issue`** (`project-management-tools.ts:422-493`)
   - Creates a project-only item via `addProjectV2DraftIssue` GraphQL mutation
   - Accepts: `title` (required), `body`, `workflowState`, `priority`, `estimate`
   - Returns: `{ projectItemId, title, fieldsSet }`
   - No repository association, no issue number, no URL, no labels

2. **`ralph_hero__update_draft_issue`** (`project-management-tools.ts:498-549`)
   - Updates title/body via `updateProjectV2DraftIssue` mutation
   - Requires the content node ID (`DI_...`), not the project item ID

### Draft Issues vs Regular Issues

| Capability | Draft Issue | Regular Issue |
|---|---|---|
| Workflow State | Yes | Yes |
| Priority | Yes | Yes |
| Estimate | Yes | Yes |
| Labels | No (no GitHub issue) | Yes |
| Assignees | No (no GitHub issue) | Yes |
| Issue number/URL | No | Yes |
| Body (markdown) | Yes | Yes |
| Lives in | Project board only | Repository + project |

### Existing `quick-*` Pattern

All `quick-*` recipes live in the justfile (`justfile:233-274`) and follow the same pattern:

```just
quick-<name> arg1 arg2="default":
    @just _mcp_call "ralph_hero__<tool>" \
        '{"param1":"{{arg1}}","param2":"{{arg2}}"}'
```

The `_mcp_call` helper (`justfile:305-315`) shells out to `mcp call` via `mcptools`, launching the MCP server on-demand via `npx`.

For recipes with optional fields, the `quick-issue` recipe (`justfile:256-264`) demonstrates the bash-based conditional JSON construction pattern:

```just
quick-issue title label="" priority="" estimate="" state="Backlog":
    #!/usr/bin/env bash
    set -eu
    params='{"title":"{{title}}"'
    if [ -n "{{label}}" ]; then params="$params,\"labels\":[\"{{label}}\"]"; fi
    if [ -n "{{priority}}" ]; then params="$params,\"priority\":\"{{priority}}\""; fi
    if [ -n "{{estimate}}" ]; then params="$params,\"estimate\":\"{{estimate}}\""; fi
    params="$params,\"workflowState\":\"{{state}}\"}"
    just _mcp_call "ralph_hero__create_issue" "$params"
```

## Recommended Implementation

### New `quick-draft` Recipe

Add to the justfile alongside other `quick-*` recipes, following the `quick-issue` pattern for optional field handling:

```just
# Create a draft issue on the project board (no GitHub issue, just a card)
quick-draft title priority="" estimate="" state="Backlog":
    #!/usr/bin/env bash
    set -eu
    params='{"title":"{{title}}"'
    if [ -n "{{priority}}" ]; then params="$params,\"priority\":\"{{priority}}\""; fi
    if [ -n "{{estimate}}" ]; then params="$params,\"estimate\":\"{{estimate}}\""; fi
    params="$params,\"workflowState\":\"{{state}}\"}"
    just _mcp_call "ralph_hero__create_draft_issue" "$params"
```

Usage examples:
```bash
ralph quick-draft "Add dark mode support"
ralph quick-draft "Fix login timeout" priority=P1
ralph quick-draft "Refactor auth module" priority=P2 estimate=M
ralph quick-draft "Spike: evaluate Redis" state="Research Needed"
```

### Key Design Decisions

1. **Draft vs real issue**: Uses `create_draft_issue` (not `create_issue`) — no repo issue created, just a project board card. This is intentional for quick capture of thoughts/ideas that haven't been validated yet.

2. **No `body` parameter**: Kept minimal for quick capture. The title IS the thought. Users can flesh out via `update_draft_issue` later or convert to a real issue when ready.

3. **No `label` parameter**: Draft issues don't support labels (project-only items). This is a GitHub API limitation, not a design choice.

4. **Default to Backlog**: Matches `quick-issue` default. Drafts land in the backlog triage queue.

5. **Follows existing pattern**: Mirrors `quick-issue` structure exactly — same optional params, same bash JSON construction, same `_mcp_call` delegation.

### Scope

- XS estimate — single recipe addition to the justfile
- No MCP server changes needed — `create_draft_issue` tool already exists
- No new dependencies
- Should be added to the `quick` group when #291 (group attributes) lands
