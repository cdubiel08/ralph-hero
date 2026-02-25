# Ralph CLI Reference

Ralph workflows are exposed as [`just`](https://github.com/casey/just) recipes in `plugin/ralph-hero/justfile`.

## Prerequisites

1. **just** -- install via one of:
   ```bash
   cargo install just          # Rust toolchain
   brew install just           # macOS/Linuxbrew
   sudo apt install just       # Debian/Ubuntu (24.04+)
   ```

2. **claude** -- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

3. **timeout** -- included in GNU coreutils (pre-installed on most Linux)

## Quick Start

```bash
cd plugin/ralph-hero

# List all available recipes
just

# Triage a specific issue
just triage 42

# Run the full autonomous loop
just loop

# Launch multi-agent team on an issue
just team 42
```

## Global Access

Install the `ralph` command for use from any directory:

```bash
cd plugin/ralph-hero
just install-cli
```

Then use Ralph from anywhere:

```bash
ralph triage 42
ralph loop
ralph team 42
ralph status
```

To remove:

```bash
just uninstall-cli
```

### How It Works

The installer copies a wrapper script to `~/.local/bin/ralph`. At runtime, the wrapper automatically resolves the latest installed plugin version from `~/.claude/plugins/cache/ralph-hero/ralph-hero/`. Plugin updates are picked up immediately — no need to re-run `install-cli`.

Override the justfile location with `RALPH_JUSTFILE`:

```bash
export RALPH_JUSTFILE="/custom/path/to/justfile"
```

## Recipes

### Individual Phase Recipes

Each phase recipe accepts an optional issue number, budget, and timeout:

```bash
just <recipe> [issue] [budget=default] [timeout=default]
```

| Recipe | Default Budget | Default Timeout | Description |
|--------|---------------|-----------------|-------------|
| `triage` | $1.00 | 15m | Assess validity, close duplicates, route to research |
| `split` | $1.00 | 15m | Split large issue into XS/S sub-issues |
| `research` | $2.00 | 15m | Investigate codebase, create findings document |
| `plan` | $3.00 | 15m | Create implementation plan from research |
| `review` | $2.00 | 15m | Review and critique an implementation plan |
| `impl` | $5.00 | 15m | Implement issue following approved plan |
| `hygiene` | $0.50 | 10m | Project hygiene check (no issue number) |
| `status` | $0.50 | 10m | Pipeline status dashboard (no issue number) |

Examples:

```bash
# Triage issue #42
just triage 42

# Research with higher budget
just research 42 budget=4.00

# Implement with longer timeout
just impl 42 timeout=30m
```

### Orchestrator Recipes

| Recipe | Default Timeout | Description |
|--------|-----------------|-------------|
| `team` | 30m | Multi-agent team coordinator |
| `hero` | 30m | Tree-expansion orchestrator |
| `loop` | 60m | Sequential autonomous loop |

The `loop` recipe accepts additional parameters:

```bash
just loop mode=all review=skip split=auto hygiene=auto timeout=60m
```

| Parameter | Values | Default | Description |
|-----------|--------|---------|-------------|
| `mode` | `all`, `triage`, `split`, `research`, `plan`, `review`, `impl`, `hygiene`, `analyst`, `builder`, `integrator` | `all` | Run specific phase only |
| `review` | `skip`, `auto`, `interactive` | `skip` | Review mode |
| `split` | `auto`, `skip` | `auto` | Split mode |
| `hygiene` | `auto`, `skip` | `auto` | Hygiene mode |

### Utility Recipes

| Recipe | Default Budget | Default Timeout | Description |
|--------|---------------|-----------------|-------------|
| `setup` | $1.00 | 10m | One-time GitHub Project V2 setup |
| `report` | $1.00 | 10m | Generate project status report |
| `completions` | -- | -- | Generate shell tab completions |

## Tab Completion

Generate and install tab completions for your shell:

### Bash

```bash
# Add to ~/.bashrc:
eval "$(just --completions bash)"
```

### Zsh

```bash
# Add to ~/.zshrc:
eval "$(just --completions zsh)"
```

### Fish

```bash
# Add to ~/.config/fish/config.fish:
just --completions fish | source
```

Or generate completions on demand:

```bash
just completions bash    # Output bash completions
just completions zsh     # Output zsh completions
just completions fish    # Output fish completions
```

### Global `ralph` Command

After installing the global CLI (`just install-cli`), install completions for the `ralph` command:

```bash
just install-completions bash   # For bash
just install-completions zsh    # For zsh
```

Or source directly:

```bash
# Bash - add to ~/.bashrc:
source plugin/ralph-hero/scripts/ralph-completions.bash

# Zsh - add to ~/.zshrc:
source plugin/ralph-hero/scripts/ralph-completions.zsh
```

## Overriding from Project Root

For one-off use from the repository root:

```bash
just --justfile plugin/ralph-hero/justfile triage 42
```

For persistent global access, use `just install-cli` instead (see [Global Access](#global-access) above).

## Environment Variables

Recipes inherit environment variables from `.env` (via `set dotenv-load` in the justfile) and from the shell. Required variables:

| Variable | Description |
|----------|-------------|
| `RALPH_HERO_GITHUB_TOKEN` | GitHub PAT with `repo` + `project` scopes |
| `RALPH_GH_OWNER` | GitHub owner (user or org) |
| `RALPH_GH_PROJECT_NUMBER` | GitHub Projects V2 number |
| `RALPH_JUSTFILE` | Override justfile path for global `ralph` command (default: auto-resolved from plugin cache) |

See the main [CLAUDE.md](../../../CLAUDE.md) for full configuration details.
