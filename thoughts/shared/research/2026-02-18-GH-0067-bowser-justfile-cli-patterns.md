---
date: 2026-02-18
github_issue: 67
github_url: https://github.com/cdubiel08/ralph-hero/issues/67
status: complete
type: research
---

# Research: Bowser/Justfile CLI Automation Patterns for Ralph

## Problem Statement

Ralph workflows currently require typing `claude -p "/ralph-triage" --dangerously-skip-permissions` or running shell scripts (`ralph-loop.sh`, `ralph-team-loop.sh`). The goal is to find ergonomic CLI patterns for wrapping these invocations. This research informs the parent epic #59 (Terminal CLI for Ralph workflow commands) and blocks #68, #72, and #73.

## Current State Analysis

### Existing Shell Scripts

Two shell scripts exist in [`plugin/ralph-hero/scripts/`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/scripts/):

1. **[`ralph-loop.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/scripts/ralph-loop.sh)** (157 lines) -- Sequential autonomous loop that runs triage -> split -> research -> plan -> review -> implement. Supports `--triage-only`, `--research-only`, etc. mode filters and `--review=skip|auto|interactive` configuration. Uses `timeout` + `claude -p` + `--dangerously-skip-permissions` pattern.

2. **[`ralph-team-loop.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/scripts/ralph-team-loop.sh)** (53 lines) -- Launches the multi-agent team coordinator. Simpler: accepts optional issue number, runs `claude -p "/ralph-team [N]" --dangerously-skip-permissions`.

Both scripts follow the same pattern: banner output, argument parsing, `timeout "$TIMEOUT" claude -p "$COMMAND" --dangerously-skip-permissions`.

### No Existing Task Runner

No `justfile`, `Makefile`, `Taskfile`, or similar task runner files exist in the repository.

## Key Discoveries

### 1. Bowser Init-Automation Patterns

[Bowser](https://github.com/disler/bowser) uses a **two-layer command architecture**:

- **Orchestrator layer** (`hop-automate.md`): Higher-order command that parses arguments via keyword detection, resolves defaults from workflow frontmatter, validates workflow file existence, and delegates to underlying skills.
- **Workflow layer** (individual `.md` files): Pure instructions with `{PROMPT}` placeholders. No configuration logic embedded.

**Key patterns applicable to Ralph:**
- Parameterized markdown workflows with placeholder substitution (Ralph already does this with spawn templates)
- Orchestrator that resolves defaults then delegates (similar to ralph-loop.sh's mode parsing)
- Workflows discoverable as standalone slash commands for power users
- Configuration separated from instruction content

**What does NOT apply:**
- Bowser is browser-automation focused -- its skill layer (Playwright/Chrome MCP) is irrelevant
- Bowser runs inside Claude Code sessions; Ralph needs terminal-first invocation
- Bowser's orchestrator is a Claude slash command, not a shell CLI

### 2. Justfile as Task Runner

[`just`](https://github.com/casey/just) is a Rust-based command runner that reads recipes from a `justfile`. Key advantages over shell scripts for Ralph:

| Feature | Shell Scripts | Justfile |
|---------|--------------|----------|
| Discoverability | `ls scripts/` | `just --list` with descriptions |
| Tab completion | Custom script needed | Built-in: `just --completions bash/zsh/fish` |
| Parameterization | `$1`, `$2` parsing | Named params with defaults: `team issue=""` |
| Cross-platform | Bash-only | Linux/macOS/Windows |
| Working directory | Manual `cd` | Auto-set to justfile directory |
| Documentation | Comments in code | Inline `# comment` above recipe |
| Multi-language | Bash only | Any language per-recipe (`#!/usr/bin/env python`) |

**Example justfile for Ralph:**

```just
# Start ralph team for an issue (or auto-detect from backlog)
team issue="":
  ./scripts/ralph-team-loop.sh {{issue}}

# Triage issues
triage:
  timeout 15m claude -p "/ralph-triage" --dangerously-skip-permissions

# Research a specific issue
research issue:
  timeout 15m claude -p "/ralph-research {{issue}}" --dangerously-skip-permissions

# Run full autonomous loop
loop mode="all" review="skip":
  ./scripts/ralph-loop.sh {{if mode != "all" { "--" + mode + "-only" } else { "" }}} --review={{review}}
```

### 3. just-mcp: Justfile Recipes as MCP Tools

[just-mcp](https://github.com/toolprint/just-mcp) dynamically exposes justfile recipes as MCP tools via the Model Context Protocol. This means Claude itself can discover and invoke Ralph CLI commands -- creating a feedback loop where the AI agent can use the same CLI as the human.

- Real-time updates when justfile changes (Justfile Watcher -> AST Parser -> Tool Registry -> MCP Server)
- Safer than raw bash: LLMs use structured tool calls instead of arbitrary shell commands
- Available via both Rust (toolprint/just-mcp) and production-ready (PromptExecution/just-mcp) implementations

### 4. mcptools: Direct MCP Tool Invocation Without Claude

[mcptools](https://github.com/f/mcptools) is a Go CLI that calls MCP server tools directly from the terminal without an LLM in the loop. For Ralph, this enables quick operations that don't need AI reasoning:

```bash
# Quick state transition (no LLM needed)
mcp call ralph_hero__update_workflow_state \
  --params '{"number":42,"state":"In Progress"}' \
  npx ralph-hero-mcp-server

# List backlog (no LLM needed)
mcp call ralph_hero__list_issues \
  --params '{"workflowState":"Backlog"}' \
  npx ralph-hero-mcp-server
```

This is particularly relevant for #72 (`ralph issue` command) -- issue creation doesn't need AI reasoning and can call `ralph_hero__create_issue` directly.

### 5. Claude CLI Flags for Better Headless Control

Current scripts only use `-p` and `--dangerously-skip-permissions`. Additional flags available:

| Flag | Value for Ralph |
|------|----------------|
| `--max-turns 50` | Prevent runaway agents |
| `--max-budget-usd 5.00` | Cost cap per invocation |
| `--output-format json` | Parse results programmatically |
| `--allowedTools "..."` | Safer than `--dangerously-skip-permissions` |
| `--model sonnet` | Cheaper model for triage/simple tasks |

## Potential Approaches

### Approach A: Justfile Only (Recommended for Phase 1)

Create a `justfile` at the plugin root with recipes wrapping existing shell scripts and direct `claude -p` invocations.

**Pros:**
- Simplest to implement (S estimate)
- Free tab completion, self-documenting via `just --list`
- Can call existing shell scripts as-is (zero migration risk)
- Named parameters with defaults
- No new dependencies beyond installing `just`

**Cons:**
- Still uses `--dangerously-skip-permissions` (no improvement on safety)
- No direct MCP tool access for quick operations
- Each recipe is still a shell command under the hood

### Approach B: Justfile + mcptools (Recommended for Phase 2)

Add mcptools for operations that don't need AI reasoning (issue creation, state transitions, status queries).

**Pros:**
- Quick actions complete in seconds (no LLM cold start)
- Structured MCP tool calls instead of arbitrary shell
- Cost savings: simple operations don't consume API tokens

**Cons:**
- Requires mcptools installation (`brew tap f/mcptools && brew install mcp`)
- MCP server must be running or startable via `npx`
- More complex recipes

### Approach C: Custom Bash CLI (`ralph` Wrapper Script)

Single `ralph` bash script with subcommand routing (like `git`).

**Pros:**
- No external dependencies
- Full control over UX
- Can embed completion generation

**Cons:**
- Reinvents what `just` provides out of the box
- More code to maintain
- Bash argument parsing is error-prone

### Approach D: Agent SDK Orchestrator (Future)

Replace bash loop scripts with TypeScript/Python using the Claude Agent SDK for programmatic orchestration.

**Pros:**
- Session chaining, structured output, proper error handling
- `--allowedTools` whitelisting instead of `--dangerously-skip-permissions`
- Cost/turn control built in

**Cons:**
- L/XL effort, significant architecture change
- Overkill for current needs
- Agent SDK is still evolving

## Risks and Considerations

1. **`just` is an external dependency**: Requires installation (`cargo install just`, `brew install just`, etc.). Not present on the system currently. However, it's a single binary with no runtime dependencies.

2. **Plugin distribution**: The justfile would live in the plugin root (`plugin/ralph-hero/justfile`). Users need to be in the plugin directory to run `just` commands, or use `just --justfile path/to/justfile`. This could be wrapped in a shell alias.

3. **Interaction with existing scripts**: The justfile should call existing shell scripts initially (not replace them), allowing incremental migration. Shell scripts remain the fallback if `just` isn't installed.

4. **Group implementation order matters**: This research (#67) must complete before #68 (CLI implementation) can start. #72 and #73 can proceed independently once #68 establishes the CLI framework.

5. **`--dangerously-skip-permissions` is the elephant**: All approaches still rely on this flag. The safer `--allowedTools` alternative requires enumerating exact tools per command, which is more work but significantly safer. This should be tracked as a separate improvement.

## Implementation Order for Group

Based on this research, the recommended implementation order for the #59 group:

1. **#67 (this issue)**: Research complete
2. **#68**: Implement core justfile with recipes for team, triage, research, plan, impl, review, loop. This creates the CLI framework.
3. **#72**: Add `ralph issue` recipe using either `claude -p` for NL-driven creation or `mcptools` for direct MCP call
4. **#73**: Add `ralph doctor` recipe as a pure shell script (no LLM needed) that checks env vars, plugin manifest, and optionally calls `health_check`

## Recommended Next Steps

Start with **Approach A** (Justfile only) for #68. Create a `justfile` in `plugin/ralph-hero/` with recipes wrapping existing scripts. Add `just` to the project's recommended tooling. Plan for **Approach B** (mcptools) as a follow-up enhancement once the basic CLI surface is proven.
