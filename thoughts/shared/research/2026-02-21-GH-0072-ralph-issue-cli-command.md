---
date: 2026-02-21
github_issue: 72
github_url: https://github.com/cdubiel08/ralph-hero/issues/72
status: complete
type: research
---

# GH-72: Implement `ralph issue` CLI Command for Quick Issue Creation

## Problem Statement

Users need a fast way to create GitHub issues from the terminal with project field values (labels, priority, estimate, workflow state) pre-set. Currently, issue creation requires either the GitHub web UI, `gh issue create` (which doesn't set project fields), or an LLM-powered skill invocation (slow, expensive). GH-72 adds a `ralph issue` justfile recipe that creates issues with full project integration in seconds at zero API cost.

## Current State

### CLI Framework (shipped in #68, #252)

The justfile at `plugin/ralph-hero/justfile` (139 lines) provides two recipe tiers:

1. **LLM-powered recipes** (14): `triage`, `research`, `plan`, `impl`, etc. via `_run_skill` helper
2. **Quick-action recipes** (4, shipped in #252): `quick-status`, `quick-move`, `quick-pick`, `quick-assign` via `_mcp_call` helper

The `_mcp_call` helper (lines 128-138) wraps mcptools invocation with dependency checking:
```just
_mcp_call tool params:
    #!/usr/bin/env bash
    set -eu
    if ! command -v mcp &>/dev/null; then
        echo "Error: mcptools not installed."
        ...
        exit 1
    fi
    mcp call "{{tool}}" --params '{{params}}' \
        npx -y ralph-hero-mcp-server@latest
```

### `create_issue` MCP Tool (`issue-tools.ts:725-940`)

The `ralph_hero__create_issue` tool accepts:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Issue title |
| `body` | string | No | Issue body (Markdown) |
| `labels` | string[] | No | Label names to apply |
| `assignees` | string[] | No | GitHub usernames to assign |
| `workflowState` | string | No | Initial Workflow State name |
| `estimate` | string | No | Estimate (XS, S, M, L, XL) |
| `priority` | string | No | Priority (P0, P1, P2, P3) |
| `owner` | string | No | GitHub owner (defaults to env) |
| `repo` | string | No | Repository name (defaults to env) |
| `projectNumber` | number | No | Project override (defaults to env) |

The tool creates the issue via GitHub API, adds it to the project, and sets all specified project fields (workflow state, estimate, priority) in a single invocation. Returns: `number`, `id`, `title`, `url`, `projectItemId`, `fieldsSet`.

### Existing Quick-Action Pattern

All 4 existing `quick-*` recipes follow the same pattern:
```just
quick-<action> <required-params> <optional-params-with-defaults>:
    @just _mcp_call "ralph_hero__<tool>" \
        '{"<param1>":{{value1}},"<param2>":"{{value2}}"}'
```

## Analysis

### Recipe Design

The `ralph issue` command (named `quick-issue` to follow the `quick-*` convention) needs to:

1. Accept a required `title` parameter
2. Accept optional parameters for labels, priority, estimate, and workflow state
3. Construct a valid JSON payload for `ralph_hero__create_issue`
4. Call via `_mcp_call`

### Challenge: JSON Array Construction in Justfile

Labels are `string[]` in the MCP tool schema. Justfile parameter interpolation doesn't natively support array construction. Two approaches:

**Approach A -- Comma-separated string, split in bash**:
```just
quick-issue title label="" priority="" estimate="" state="Backlog":
    #!/usr/bin/env bash
    set -eu
    params='{"title":"{{title}}"'
    if [ -n "{{label}}" ]; then
        labels=$(echo '{{label}}' | jq -R 'split(",")')
        params="$params,\"labels\":$labels"
    fi
    if [ -n "{{priority}}" ]; then params="$params,\"priority\":\"{{priority}}\""; fi
    if [ -n "{{estimate}}" ]; then params="$params,\"estimate\":\"{{estimate}}\""; fi
    if [ -n "{{state}}" ]; then params="$params,\"workflowState\":\"{{state}}\""; fi
    params="$params}"
    just _mcp_call "ralph_hero__create_issue" "$params"
```

This requires `jq` for label array splitting -- adds a dependency.

**Approach B -- Single label string (no array)**:
```just
quick-issue title label="" priority="" estimate="" state="Backlog":
    #!/usr/bin/env bash
    set -eu
    params='{"title":"{{title}}"'
    if [ -n "{{label}}" ]; then params="$params,\"labels\":[\"{{label}}\"]"; fi
    if [ -n "{{priority}}" ]; then params="$params,\"priority\":\"{{priority}}\""; fi
    if [ -n "{{estimate}}" ]; then params="$params,\"estimate\":\"{{estimate}}\""; fi
    if [ -n "{{state}}" ]; then params="$params,\"workflowState\":\"{{state}}\""; fi
    params="$params}"
    just _mcp_call "ralph_hero__create_issue" "$params"
```

This only supports a single label per invocation. Simpler, no `jq` dependency. Multiple labels can be applied post-creation via `quick-assign` or the GitHub UI.

**Approach C -- Inline `@just _mcp_call` (simplest)**:
```just
quick-issue title priority="" estimate="" state="Backlog":
    @just _mcp_call "ralph_hero__create_issue" \
        '{"title":"{{title}}","priority":"{{priority}}","estimate":"{{estimate}}","workflowState":"{{state}}"}'
```

This always sends all fields, even empty strings. The MCP tool treats empty strings as no-ops for optional fields (they don't match any valid enum value and are silently skipped). This is the simplest approach but sacrifices label support entirely.

### Recommendation: Approach B (Single Label, Bash Script Recipe)

Approach B balances simplicity with functionality:
- Supports all commonly needed fields: title, label, priority, estimate, workflow state
- Single label covers the most common case (e.g., `enhancement`, `bug`)
- Uses bash script recipe (shebang) for conditional JSON construction -- consistent with `_mcp_call` helper
- No additional dependencies beyond mcptools
- Multiple labels is an edge case that can be handled with `quick-assign` or a follow-up enhancement

### Additional Recipes to Consider

Beyond `quick-issue`, two closely related recipes fit naturally:

**`quick-info`** -- Get full issue details:
```just
quick-info issue:
    @just _mcp_call "ralph_hero__get_issue" \
        '{"number":{{issue}}}'
```

**`quick-comment`** -- Add comment to an issue:
```just
quick-comment issue body:
    @just _mcp_call "ralph_hero__create_comment" \
        '{"number":{{issue}},"body":"{{body}}"}'
```

These are natural companions to `quick-issue` and were already identified as candidates in the GH-252 research (Section 5, "Additional Quick Actions Worth Considering").

### Naming

The triage comments suggest `ralph issue` as the command name. However, the justfile convention established in #252 uses `quick-*` prefix for all non-LLM recipes. Options:

1. **`quick-issue`** -- Consistent with `quick-status`, `quick-move`, `quick-pick`, `quick-assign`
2. **`issue`** -- Shorter, matches the issue title "ralph issue"
3. **Both** -- `issue` as the primary, `quick-issue` as an alias

**Recommendation**: Use `quick-issue` for consistency. The `quick-*` prefix clearly signals "no LLM, instant, free" to users. All 4 existing quick actions use this convention.

## Files to Change

| File | Change | Lines |
|------|--------|-------|
| `plugin/ralph-hero/justfile` | Add `quick-issue` recipe (+ optionally `quick-info` and `quick-comment`) | +15-25 |

Single file change. No MCP server modifications needed -- `create_issue` already supports all required parameters.

## Risks

1. **Title quoting**: If the title contains double quotes, the JSON construction breaks. Bash recipes should use `jq -n --arg title "{{title}}" '{title: $title}'` for safe escaping, but this adds `jq` as a dependency. For initial implementation, document that titles with special characters may need escaping.

2. **Empty optional parameters**: The bash conditional approach (Approach B) only includes non-empty params in the JSON. This is correct -- the MCP tool schema makes all fields except `title` optional.

3. **mcptools dependency**: Same as all `quick-*` recipes -- requires mcptools installation. The `_mcp_call` helper already handles this gracefully.

4. **Workflow state default**: Default `state="Backlog"` means new issues are created in Backlog. This matches the expected workflow. Users can override with `state="Research Needed"` etc.

## Recommendation

Add `quick-issue` to the justfile using Approach B (single label, bash script recipe). Optionally include `quick-info` and `quick-comment` as natural companions. All use the existing `_mcp_call` helper -- no new infrastructure needed.
