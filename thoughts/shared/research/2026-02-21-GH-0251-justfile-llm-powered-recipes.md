---
date: 2026-02-21
github_issue: 251
github_url: https://github.com/cdubiel08/ralph-hero/issues/251
status: complete
type: research
---

# GH-251: Create Justfile with Core LLM-Powered Ralph Recipes

## Problem Statement

Ralph workflows require verbose CLI invocations: `timeout 15m claude -p "/ralph-triage" --dangerously-skip-permissions`. A justfile at `plugin/ralph-hero/justfile` should wrap these in ergonomic recipes with discoverable commands (`just --list`), named parameters with defaults, and configurable cost/turn limits.

## Current State Analysis

### Existing Scripts

Two shell scripts in [`plugin/ralph-hero/scripts/`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/scripts/):

1. **[`ralph-loop.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/scripts/ralph-loop.sh)** (178 lines): Sequential autonomous loop. Runs hygiene -> triage -> split -> research -> plan -> review -> implement. Configurable via `--review=skip|auto|interactive`, `--split=auto|skip`, `--hygiene=auto|skip`, and mode filters (`--triage-only`, `--analyst-only`, etc.). Uses `timeout "$TIMEOUT" claude -p "$COMMAND" --dangerously-skip-permissions` pattern. Default timeout: `15m`. Max iterations: `10`.

2. **[`ralph-team-loop.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/scripts/ralph-team-loop.sh)** (53 lines): Launches team coordinator. Accepts optional issue number. Default timeout: `30m`.

### Available Skills (from `skills/` directory)

| Skill | CLI invocation | Purpose |
|-------|---------------|---------|
| `ralph-triage` | `/ralph-triage [N]` | Triage one backlog issue |
| `ralph-split` | `/ralph-split [N]` | Split large issues into sub-issues |
| `ralph-research` | `/ralph-research [N]` | Research one issue |
| `ralph-plan` | `/ralph-plan [N]` | Create implementation plan |
| `ralph-review` | `/ralph-review [N]` | Review/critique a plan |
| `ralph-impl` | `/ralph-impl [N]` | Implement from plan |
| `ralph-team` | `/ralph-team [N]` | Multi-agent team coordinator |
| `ralph-hero` | `/ralph-hero [N]` | Single-agent tree-expansion orchestrator |
| `ralph-hygiene` | `/ralph-hygiene` | Board hygiene check |
| `ralph-status` | `/ralph-status` | Pipeline status dashboard |
| `ralph-report` | `/ralph-report [N]` | Generate progress report |
| `ralph-setup` | `/ralph-setup` | Initialize GitHub project |

### Claude CLI Flags Available

From `claude --help`, the relevant flags for justfile recipes:

| Flag | Description | Default suggestion |
|------|-------------|-------------------|
| `--model <model>` | Model alias (e.g., `sonnet`, `opus`) | `sonnet` for triage/research; `opus` for plan/impl/team |
| `--max-budget-usd <amount>` | Cost cap per invocation | `2.00` for single-phase; `10.00` for loop/team |
| `--allowedTools <tools...>` | Whitelist specific tools | Per-skill tool lists from SKILL.md frontmatter |
| `--fallback-model <model>` | Auto-fallback when primary overloaded | `sonnet` |
| `--output-format <format>` | `text`, `json`, `stream-json` | `text` (default) |
| `-p, --print` | Non-interactive mode | Always for justfile recipes |
| `--dangerously-skip-permissions` | Bypass permission checks | Current default, migrate to `--allowedTools` |
| `--agent <agent>` | Agent for the session | Not needed (skills handle this) |

**Key finding**: `--max-turns` is NOT available in the current Claude CLI. The `--max-budget-usd` flag is the primary cost control mechanism. The issue's acceptance criteria mention "cost/turn limits" -- only cost limits are available.

### `just` Not Installed

`just` is not currently installed on the system. It requires installation via `cargo install just`, `brew install just`, or downloading a prebuilt binary. This is a prerequisite documented in the issue.

## Key Discoveries

### 1. Justfile Recipe Syntax for Parameterized Claude Invocations

Just recipes support named parameters with defaults, conditional expressions, and string interpolation:

```just
# Recipe with optional parameter
research issue="":
  timeout 15m claude -p "/ralph-research {{issue}}" -p --dangerously-skip-permissions

# Recipe with conditional logic
loop mode="all" review="skip" hygiene="auto":
  ./scripts/ralph-loop.sh {{if mode != "all" { "--" + mode + "-only" } else { "" }}} --review={{review}} --hygiene={{hygiene}}
```

**Important syntax rules**:
- Parameters use `{{param}}` double-brace syntax (not `$param`)
- Default values are specified inline: `param="default"`
- Conditional expressions use `{{if ... { ... } else { ... }}}`
- Recipes can call shell commands directly
- `set shell := ["bash", "-euc"]` controls the shell interpreter
- `set dotenv-load` can load `.env` files for configuration

### 2. Recommended Recipe Set

Based on the available skills and existing scripts:

**Individual phase recipes** (wrap `claude -p` directly):
- `triage issue=""` -- `/ralph-triage [N]`
- `split issue=""` -- `/ralph-split [N]`
- `research issue=""` -- `/ralph-research [N]`
- `plan issue=""` -- `/ralph-plan [N]`
- `review issue=""` -- `/ralph-review [N]`
- `impl issue=""` -- `/ralph-impl [N]`
- `hygiene` -- `/ralph-hygiene`
- `status` -- `/ralph-status`

**Orchestrator recipes** (wrap existing scripts or team skill):
- `team issue=""` -- wraps `ralph-team-loop.sh`
- `hero issue=""` -- wraps `/ralph-hero [N]`
- `loop mode="all" review="skip" hygiene="auto"` -- wraps `ralph-loop.sh`

**Utility recipes**:
- `setup` -- `/ralph-setup`
- `report issue=""` -- `/ralph-report [N]`

### 3. Model Selection Per Recipe

Different skills have different complexity requirements:

| Recipe | Recommended Model | Rationale |
|--------|------------------|-----------|
| `triage` | `sonnet` | Pattern matching, no creative work |
| `split` | `sonnet` | Decomposition from existing context |
| `research` | `sonnet` | Information gathering, synthesis |
| `plan` | `opus` | Architectural decisions, cross-cutting analysis |
| `review` | `opus` | Critical evaluation, nuanced judgment |
| `impl` | `sonnet` | Code generation following plan |
| `team` | `opus` | Orchestration, multi-agent coordination |
| `hero` | `opus` | Tree-expansion orchestration |
| `loop` | (per-phase) | Delegates to scripts which use defaults |
| `hygiene`, `status` | `sonnet` | Reporting, no creative work |

The existing skill SKILL.md frontmatter already specifies `model:` for each skill. The justfile can override this via `--model` flag when calling `claude -p`, but the skill's own model specification takes precedence in many cases. The justfile model parameter serves as a suggestion/default.

### 4. `--allowedTools` vs `--dangerously-skip-permissions`

Each skill's SKILL.md frontmatter has an `allowed_tools` list. These could be mapped to `--allowedTools` flags for safer invocation. However:

- The `--allowedTools` flag uses a different format than SKILL.md `allowed_tools`
- Skills need MCP tools (e.g., `ralph_hero__get_issue`) which require the full tool name including MCP prefix
- Enumerating all tools per recipe is verbose and fragile
- **Recommendation**: Start with `--dangerously-skip-permissions` (matching existing scripts), plan migration to `--allowedTools` as a separate improvement

### 5. Justfile Location and Working Directory

The justfile should live at `plugin/ralph-hero/justfile`. Just automatically sets the working directory to the justfile's location, so recipes can use relative paths to `./scripts/`.

Users invoke from the `ralph-hero` project root or plugin root:
- From project root: `just --justfile plugin/ralph-hero/justfile triage`
- From plugin root: `just triage` (just finds the local `justfile`)

**Recommendation**: Place at `plugin/ralph-hero/justfile`. Add a root-level alias justfile or document the `--justfile` flag.

### 6. Budget Defaults Per Recipe

| Recipe | Budget | Rationale |
|--------|--------|-----------|
| `triage` | `$1.00` | Single issue assessment |
| `split` | `$1.00` | Issue decomposition |
| `research` | `$2.00` | Multi-source investigation |
| `plan` | `$3.00` | Architectural planning |
| `review` | `$2.00` | Plan critique |
| `impl` | `$5.00` | Code generation + tests |
| `team` | `$15.00` | Multi-agent session |
| `hero` | `$10.00` | Tree-expansion session |
| `loop` | `$20.00` | Full pipeline iteration |
| `hygiene` | `$0.50` | Board scan |
| `status` | `$0.50` | Dashboard query |

These are suggestions for `--max-budget-usd` defaults. Users can override per invocation: `just impl 42 budget=10.00`.

## Risks and Considerations

1. **`just` installation prerequisite**: Not currently installed. The `setup` recipe or documentation should cover installation. Consider a `check-deps` recipe that verifies `just` and `claude` are available.

2. **Timeout handling**: The existing scripts use `timeout` which sends SIGTERM. Just recipes that call `timeout` inherit this behavior. Recipes wrapping `claude -p` directly need their own timeout handling.

3. **Environment variable propagation**: Skills need `RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER`. These should be inherited from the environment or loaded via `set dotenv-load` if a `.env` file exists. The current scripts rely on the Claude settings.local.json env block.

4. **`--max-budget-usd` only works with `--print`**: This flag is explicitly documented as "only works with --print". Since all justfile recipes use `-p`/`--print`, this is compatible.

5. **Model override interaction with skills**: When `--model sonnet` is passed to `claude -p`, the skill's SKILL.md `model:` frontmatter may override it. Testing needed to confirm precedence.

6. **No `--max-turns` flag**: The issue mentions "cost/turn limits" but Claude CLI does not expose a `--max-turns` flag. Only `--max-budget-usd` is available for cost control. The acceptance criteria should be updated to reflect this.

## Group Context

GH-251 is the first in a 3-issue group under parent #68:
- **#251** (this issue, S): Justfile with LLM-powered recipes -- unblocked
- **#252** (S): mcptools quick actions -- blocked by #251
- **#253** (XS): Shell tab completion and docs -- blocked by #251

## Recommended Approach

1. Create `plugin/ralph-hero/justfile` with `set shell`, `set dotenv-load`, and all 14 recipes listed above
2. Use `--dangerously-skip-permissions` initially (match existing scripts), with `--max-budget-usd` defaults per recipe
3. Add a `model` parameter to each recipe with sensible defaults (sonnet for simple, opus for complex)
4. Add a `timeout` parameter with per-recipe defaults matching existing script behavior
5. Add a `budget` parameter with per-recipe defaults for `--max-budget-usd`
6. Include `--fallback-model sonnet` on opus recipes for resilience
7. Document `just` installation in a recipe comment or companion doc
