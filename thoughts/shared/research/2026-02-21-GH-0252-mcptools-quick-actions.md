---
date: 2026-02-21
github_issue: 252
github_url: https://github.com/cdubiel08/ralph-hero/issues/252
status: complete
type: research
---

# GH-252: Add mcptools-Based Quick Actions to Ralph CLI

## Problem Statement

The justfile shipped in GH-251 provides LLM-powered recipes that invoke `claude -p` with skills. These incur LLM cold-start latency and API cost even for simple operations like checking issue status or moving an issue to a new workflow state. `mcptools` enables direct MCP tool invocation from the terminal without an LLM, completing in seconds at zero API cost.

## Current State Analysis

### Justfile ([plugin/ralph-hero/justfile](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile))

The justfile has 14 recipes, all LLM-powered via `_run_skill` helper that calls `claude -p`. Structure:
- `set shell := ["bash", "-euc"]` and `set dotenv-load`
- Individual phase recipes (triage, split, research, plan, review, impl, hygiene, status)
- Orchestrator recipes (team, hero, loop)
- Utility recipes (setup, report)
- Internal helper `_run_skill` (lines 79-98)

No mcptools recipes exist yet.

### MCP Server Configuration ([.mcp.json](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/.mcp.json))

```json
{
  "mcpServers": {
    "ralph-github": {
      "command": "npx",
      "args": ["-y", "ralph-hero-mcp-server@latest"],
      "env": {
        "RALPH_GH_OWNER": "${RALPH_GH_OWNER:-cdubiel08}",
        "RALPH_GH_REPO": "${RALPH_GH_REPO:-ralph-hero}",
        "RALPH_GH_PROJECT_NUMBER": "${RALPH_GH_PROJECT_NUMBER:-3}"
      }
    }
  }
}
```

The server runs via `npx -y ralph-hero-mcp-server@latest` with environment variables for owner, repo, and project number.

### Available MCP Tools (44 total)

The ralph-hero MCP server registers 44 tools. The ones most relevant for quick actions:

| Tool | Parameters | Use Case |
|------|-----------|----------|
| `ralph_hero__pipeline_dashboard` | `format`, `projectNumbers`, `includeHealth`, etc. | **status**: Pipeline overview |
| `ralph_hero__update_workflow_state` | `number`, `state`, `command` | **move**: Transition issue state |
| `ralph_hero__pick_actionable_issue` | `workflowState`, `maxEstimate` | **pick**: Find next issue to work on |
| `ralph_hero__update_issue` | `number`, `labels`, `assignees`, `title`, `body` | **assign**: Set assignees |
| `ralph_hero__get_issue` | `number` | Quick issue lookup |
| `ralph_hero__list_issues` | `workflowState`, `priority`, `estimate`, etc. | List/filter issues |
| `ralph_hero__create_issue` | `title`, `body`, etc. | Create new issue |
| `ralph_hero__create_comment` | `number`, `body` | Add comment |
| `ralph_hero__update_estimate` | `number`, `estimate` | Set estimate |
| `ralph_hero__update_priority` | `number`, `priority` | Set priority |
| `ralph_hero__project_hygiene` | `format`, etc. | Board health check |

### mcptools CLI

[mcptools](https://github.com/f/mcptools) is a Go CLI for direct MCP server interaction. Key syntax:

```bash
# Call a tool with parameters
mcp call <tool_name> --params '<JSON>' <server_command>

# List available tools
mcp tools <server_command>

# Interactive shell
mcp shell <server_command>

# Register server alias
mcp alias add <name> <server_command>
```

**Installation**: `brew tap f/mcptools && brew install mcp` (macOS) or `go install github.com/f/mcptools/cmd/mcptools@latest`.

**Output formats**: `--format table` (default), `--format json`, `--format pretty`.

**Environment variables**: Passed through the process environment or via `--env` in config commands.

## Key Discoveries

### 1. Server Command String for mcptools

The mcptools `mcp call` syntax appends the server command after the tool call. For ralph-hero:

```bash
mcp call ralph_hero__pipeline_dashboard \
  --params '{"format":"markdown"}' \
  npx -y ralph-hero-mcp-server@latest
```

This is verbose. An **alias** simplifies it:

```bash
mcp alias add ralph npx -y ralph-hero-mcp-server@latest
mcp call ralph_hero__pipeline_dashboard --params '{"format":"markdown"}' ralph
```

However, aliases are user-global -- they can't be bundled with the justfile. The justfile should use a helper variable or recipe instead.

### 2. Environment Variable Passing

The MCP server needs `RALPH_HERO_GITHUB_TOKEN`, `RALPH_GH_OWNER`, `RALPH_GH_REPO`, and `RALPH_GH_PROJECT_NUMBER`. When invoked via `mcp call ... npx -y ralph-hero-mcp-server@latest`, the server process inherits the current shell environment. Since the justfile uses `set dotenv-load`, a `.env` file in the plugin directory can provide these values.

**Critical**: The `RALPH_HERO_GITHUB_TOKEN` must be available in the environment. In the Claude Code context, it's set via `settings.local.json`. For direct `mcp call`, it must be in the shell environment or `.env` file.

### 3. Proposed Quick Action Recipes

Based on the issue title ("status, move, pick, assign"), here are the 4 recipes:

**`quick-status`** -- Pipeline dashboard without LLM:
```just
# Quick pipeline status (no LLM, instant)
quick-status format="markdown":
    @just _mcp_call "ralph_hero__pipeline_dashboard" \
        '{"format":"{{format}}","includeHealth":true}'
```

**`quick-move`** -- Move issue to workflow state:
```just
# Move issue to a workflow state (no LLM, instant)
quick-move issue state:
    @just _mcp_call "ralph_hero__update_workflow_state" \
        '{"number":{{issue}},"state":"{{state}}","command":"ralph_cli"}'
```

**`quick-pick`** -- Find next actionable issue:
```just
# Pick highest-priority actionable issue from a workflow state (no LLM, instant)
quick-pick state="Research Needed" max-estimate="S":
    @just _mcp_call "ralph_hero__pick_actionable_issue" \
        '{"workflowState":"{{state}}","maxEstimate":"{{max-estimate}}"}'
```

**`quick-assign`** -- Assign issue to user:
```just
# Assign issue to a GitHub user (no LLM, instant)
quick-assign issue user:
    @just _mcp_call "ralph_hero__update_issue" \
        '{"number":{{issue}},"assignees":["{{user}}"]}'
```

### 4. Internal Helper for mcptools

Similar to `_run_skill` for LLM recipes, a `_mcp_call` helper wraps the mcptools invocation:

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

### 5. Additional Quick Actions Worth Considering

Beyond the 4 in the issue title, these are natural candidates:

| Recipe | Tool | Use Case |
|--------|------|----------|
| `quick-info` | `ralph_hero__get_issue` | Get full issue details |
| `quick-list` | `ralph_hero__list_issues` | List issues by state |
| `quick-create` | `ralph_hero__create_issue` | Create a new issue |
| `quick-comment` | `ralph_hero__create_comment` | Add comment to issue |
| `quick-estimate` | `ralph_hero__update_estimate` | Set issue estimate |
| `quick-priority` | `ralph_hero__update_priority` | Set issue priority |

**Recommendation**: Start with the 4 core actions (status, move, pick, assign) as specified. Additional actions can be added incrementally.

### 6. Naming Convention: `quick-*` Prefix

The `quick-` prefix distinguishes no-LLM recipes from LLM-powered ones:
- `just status` -- LLM-powered, uses `claude -p "/ralph-status"`, costs API tokens
- `just quick-status` -- Direct MCP call, instant, free

This makes it clear to users which recipes are fast/free vs slow/costly.

### 7. Output Formatting

mcptools returns raw JSON by default. For human-readable output:
- `ralph_hero__pipeline_dashboard` supports `format: "markdown"` natively
- Other tools return JSON which could be piped through `jq` for formatting
- The `--format pretty` flag on mcptools provides indented JSON

**Recommendation**: Use the tool's native format parameter where available (dashboard), rely on `--format pretty` for other tools, and optionally pipe through `jq` for specific field extraction.

### 8. mcptools Is Not Yet Installed

Like `just` before GH-251, `mcptools` is not installed on the system. The `_mcp_call` helper should check for its presence and provide installation instructions, matching the pattern established by GH-251.

## Potential Approaches

### Approach A: Justfile Recipes with `_mcp_call` Helper (Recommended)

Add quick-action recipes to the existing justfile, using a `_mcp_call` internal helper that wraps mcptools invocation with dependency checking.

**Pros**:
- Integrates naturally with the existing justfile
- `just --list` shows both LLM and quick recipes
- Consistent UX with existing recipes
- `_mcp_call` helper centralizes server invocation and dependency check

**Cons**:
- Requires mcptools installation (external dependency)
- JSON parameter construction in justfile is verbose

### Approach B: Standalone Shell Script

Create a `ralph-quick.sh` script for direct MCP calls.

**Pros**: No justfile dependency, can be used independently.
**Cons**: Duplicates the CLI surface, inconsistent with the justfile approach, harder to discover.

### Approach C: Justfile + jq Formatting

Like Approach A but pipes all output through `jq` for formatted display.

**Pros**: Nicer human-readable output.
**Cons**: Adds `jq` as another dependency, over-engineering for quick actions.

### Recommendation

**Approach A** is best. It follows the pattern established by GH-251 and keeps all CLI recipes in one place.

## Files to Change

| File | Change | Risk |
|------|--------|------|
| [`plugin/ralph-hero/justfile`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile) | Add `_mcp_call` helper + 4 `quick-*` recipes (status, move, pick, assign) | Low |

Single file change. No MCP server modifications. No test changes (justfile recipes are integration-level).

## Risks and Considerations

1. **mcptools installation**: External Go dependency. Not as common as `just`. The `_mcp_call` helper should fail gracefully with installation instructions.

2. **Token availability**: `RALPH_HERO_GITHUB_TOKEN` must be in the shell environment for `mcp call` to work. Unlike `claude -p` (which reads `settings.local.json`), mcptools passes environment directly to the subprocess. Users need to `export RALPH_HERO_GITHUB_TOKEN=ghp_xxx` or use a `.env` file with `set dotenv-load`.

3. **npx cold start**: The first `mcp call` with `npx -y ralph-hero-mcp-server@latest` downloads the package. Subsequent calls are cached. This is a one-time latency, not ongoing.

4. **JSON parameter escaping**: Justfile's `{{param}}` interpolation inside JSON strings can break if parameters contain quotes or special characters. For simple values (numbers, state names, usernames), this is fine. Complex values would need escaping.

5. **Server compatibility**: The mcptools stdio transport connects to the same MCP server that Claude Code uses. Tool names and parameters are identical. No compatibility issues expected.

## Recommended Next Steps

1. Add `_mcp_call` helper recipe to justfile (with mcptools dependency check)
2. Add `quick-status` recipe (pipeline dashboard with markdown format)
3. Add `quick-move` recipe (update workflow state)
4. Add `quick-pick` recipe (find next actionable issue)
5. Add `quick-assign` recipe (set issue assignees)
6. Test all 4 recipes manually to verify mcptools + ralph-hero-mcp-server integration
7. Update justfile header comment to list mcptools as optional dependency
