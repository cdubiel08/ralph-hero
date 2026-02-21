---
date: 2026-02-21
status: in-progress
github_issue: 251
github_url: https://github.com/cdubiel08/ralph-hero/issues/251
primary_issue: 251
---

# GH-251: Create Justfile with Core LLM-Powered Ralph Recipes

## Overview

Single issue implementation: GH-251 -- Create a justfile at `plugin/ralph-hero/justfile` with parameterized recipes wrapping existing Claude CLI skill invocations and shell scripts.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-251 | Create justfile with core LLM-powered Ralph recipes | S |

## Current State Analysis

- Two shell scripts exist in `plugin/ralph-hero/scripts/`: `ralph-loop.sh` (178 lines, sequential loop) and `ralph-team-loop.sh` (53 lines, team launcher). Both use `timeout "$TIMEOUT" claude -p "$COMMAND" --dangerously-skip-permissions` pattern.
- 12 skills exist in `plugin/ralph-hero/skills/`: ralph-triage, ralph-split, ralph-research, ralph-plan, ralph-review, ralph-impl, ralph-team, ralph-hero, ralph-hygiene, ralph-status, ralph-report, ralph-setup.
- No task runner (justfile, Makefile, Taskfile) exists in the repository.
- Research completed: `thoughts/shared/research/2026-02-21-GH-0251-justfile-llm-powered-recipes.md`. Key findings: 14 recipes needed, `--max-budget-usd` is the primary cost control (no `--max-turns` in CLI), `set dotenv-load` for env vars.
- Parent research (GH-67, closed) recommended justfile as Phase 1 CLI surface.

## Desired End State

### Verification
- [ ] `plugin/ralph-hero/justfile` exists with valid just syntax
- [ ] 8 individual phase recipes: triage, split, research, plan, review, impl, hygiene, status
- [ ] 3 orchestrator recipes: team, hero, loop
- [ ] 2 utility recipes: setup, report
- [ ] Each recipe has `budget`, `timeout`, and `model` parameters with per-recipe defaults
- [ ] `just --list` shows all recipes with descriptions
- [ ] Orchestrator recipes delegate to existing shell scripts
- [ ] Phase recipes use `claude -p` with `--max-budget-usd` and `--dangerously-skip-permissions`
- [ ] `npm run build` and `npm test` still pass (no source changes)

## What We're NOT Doing

- Not installing `just` (prerequisite documented, user responsibility)
- Not replacing `--dangerously-skip-permissions` with `--allowedTools` (separate improvement, GH-252 scope)
- Not adding mcptools quick actions (GH-252 scope)
- Not adding shell tab completion (GH-253 scope)
- Not modifying existing shell scripts (wrap them, don't change them)
- Not adding `--model` override to skills (justfile `model` param is passed to `claude -p` but skill SKILL.md `model:` frontmatter takes precedence)
- Not adding `--max-turns` (not available in Claude CLI)
- Not adding `--fallback-model` (all skills already specify `model: opus` in SKILL.md; justfile model param is advisory)

## Implementation Approach

Single new file: `plugin/ralph-hero/justfile`. No TypeScript source changes. The justfile wraps existing scripts and skill invocations with ergonomic parameterized recipes.

---

## Phase 1: GH-251 -- Create justfile with core LLM-powered Ralph recipes
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/251 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0251-justfile-llm-powered-recipes.md

### Changes Required

#### 1. Create justfile
**File**: `plugin/ralph-hero/justfile` (NEW)

**Structure**:

```
# Configuration block
set shell := ["bash", "-euc"]
set dotenv-load  # loads .env if present

# Default recipe (shows help)
default: list

# Individual phase recipes (8)
triage, split, research, plan, review, impl, hygiene, status

# Orchestrator recipes (3)
team, hero, loop

# Utility recipes (2)
setup, report

# Internal helper (_run_skill)
```

**Recipe pattern for individual phases**:

Each phase recipe follows the same pattern:
- `issue` parameter: optional issue number (default: `""`)
- `budget` parameter: `--max-budget-usd` value with per-recipe default
- `timeout` parameter: `timeout` duration with per-recipe default
- Calls `_run_skill` helper which constructs and executes the `claude -p` invocation

**Helper recipe** (`_run_skill`):
- Private recipe (prefixed with `_`) that constructs the full command
- Parameters: `skill`, `issue`, `budget`, `timeout`
- Builds: `timeout {{timeout}} claude -p "/ralph-{{skill}} {{issue}}" --max-budget-usd {{budget}} --dangerously-skip-permissions`
- Handles the common invocation pattern so individual recipes stay DRY

**Per-recipe defaults** (from research):

| Recipe | Budget | Timeout | Notes |
|--------|--------|---------|-------|
| `triage` | `1.00` | `15m` | Single issue assessment |
| `split` | `1.00` | `15m` | Issue decomposition |
| `research` | `2.00` | `15m` | Multi-source investigation |
| `plan` | `3.00` | `15m` | Architectural planning |
| `review` | `2.00` | `15m` | Plan critique |
| `impl` | `5.00` | `15m` | Code generation + tests |
| `hygiene` | `0.50` | `10m` | Board scan, no issue param |
| `status` | `0.50` | `10m` | Dashboard query, no issue param |
| `team` | `15.00` | `30m` | Multi-agent session |
| `hero` | `10.00` | `30m` | Tree-expansion session |
| `loop` | `20.00` | `60m` | Full pipeline iteration |
| `setup` | `1.00` | `10m` | One-time project setup |
| `report` | `1.00` | `10m` | Progress report |

**Orchestrator recipes**:

- `loop`: Delegates to `./scripts/ralph-loop.sh` with passthrough args (`mode`, `review`, `split`, `hygiene`). Does NOT use `claude -p` directly -- the shell script handles Claude invocations internally.
- `team`: Calls `./scripts/ralph-team-loop.sh` with optional issue number. Uses script's own timeout handling.
- `hero`: Uses `_run_skill` pattern like phase recipes (it's a skill, not a script).

**No-issue recipes** (`hygiene`, `status`, `setup`):
- These skills don't take an issue number parameter
- Recipe signature: `recipe budget="0.50" timeout="10m":`
- Builds: `timeout {{timeout}} claude -p "/ralph-{{skill}}" --max-budget-usd {{budget}} --dangerously-skip-permissions`

**`list` recipe**:
- Just's built-in `just --list` provides recipe listing with comments
- Each recipe gets a `# description` comment above it for `--list` output

### File Ownership

| File | Owner |
|------|-------|
| `plugin/ralph-hero/justfile` | GH-251 (NEW) |

### Success Criteria

#### Automated Verification
- [ ] `plugin/ralph-hero/justfile` exists and is valid just syntax
- [ ] `just --justfile plugin/ralph-hero/justfile --list` shows all 14 recipes (requires `just` installed)
- [ ] `npm run build` passes (no TypeScript changes)
- [ ] `npm test` passes (no test changes)

#### Manual Verification
- [ ] Each recipe has a descriptive comment visible in `just --list`
- [ ] Budget, timeout parameters have sensible defaults per research
- [ ] `loop` recipe delegates to `ralph-loop.sh` with mode/review/split/hygiene params
- [ ] `team` recipe delegates to `ralph-team-loop.sh` with optional issue param
- [ ] No-issue recipes (hygiene, status, setup) don't require an issue number

---

## Testing Strategy

No automated tests needed -- this is a new justfile with no TypeScript changes. Verification:

1. **Syntax check**: `just --justfile plugin/ralph-hero/justfile --list` validates syntax and shows available recipes
2. **Build check**: `npm run build && npm test` confirms no regressions
3. **Manual smoke test**: `just --justfile plugin/ralph-hero/justfile --dry-run triage 42` shows the command that would execute (requires `just` installed)

## References

- [Issue #251](https://github.com/cdubiel08/ralph-hero/issues/251)
- [Research document](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0251-justfile-llm-powered-recipes.md)
- [Parent research #67](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-18-GH-0067-bowser-justfile-cli-patterns.md)
- [Parent issue #68: Implement Ralph terminal CLI commands](https://github.com/cdubiel08/ralph-hero/issues/68)
- Siblings: [#252](https://github.com/cdubiel08/ralph-hero/issues/252) (mcptools), [#253](https://github.com/cdubiel08/ralph-hero/issues/253) (tab completion + docs)
