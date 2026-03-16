---
date: 2026-03-06
github_issue: 546
github_url: https://github.com/cdubiel08/ralph-hero/issues/546
topic: "Ralph CLI with justfile - architecture and current limitations"
tags: [research, codebase, cli, justfile, cli-dispatch, interactive-mode]
status: complete
type: research
git_commit: bfc2320
---

# Research: Ralph CLI with Justfile - Architecture & Current Limitations

## Research Question
The Ralph CLI using justfile doesn't seem to be working well. How does the CLI work today, what are its limitations, and what's the status of planned improvements?

## Summary

The Ralph CLI is a `just`-based command runner that wraps Claude Code skill invocations. It currently supports only **headless mode** (all commands run `claude -p`, print output, and exit). A comprehensive plan exists for a 3-mode dispatch system (interactive/headless/quick) with `cli-dispatch.sh` already created as Phase 1 infrastructure, but the justfile hasn't been updated to use it -- the refactor stalled after Phase 1.

Key issues with the current CLI:
1. **No interactive mode** -- `_run_skill` always uses `claude -p` (headless), so `ralph plan 42` can never open an interactive session
2. **TTY hanging bug** -- `_run_skill` doesn't redirect stdin (`</dev/null`), causing Claude to get SIGTSTP'd (process stops waiting for terminal input)
3. **Rigid argument handling** -- recipes use named `issue=""` parameter, making it impossible to pass file paths, flags like `--plan-doc`, or multi-word arguments
4. **Split command namespaces** -- workflow recipes (triage, plan, etc.) and quick-* recipes (quick-status, quick-info) are separate tiers with different invocation patterns
5. **Interactive skills unreachable** -- `research`, `plan`, and `impl` interactive skills exist but have no CLI entry point

## Detailed Findings

### Current Architecture

#### Global CLI wrapper: `plugin/ralph-hero/scripts/ralph-cli.sh`
- Resolves the latest plugin version from `~/.claude/plugins/cache/ralph-hero/ralph-hero/`
- Delegates to `just --justfile "$RALPH_JUSTFILE" "$@"`
- Installed to `~/.local/bin/ralph` via `just install-cli`

#### Justfile dispatch: `plugin/ralph-hero/justfile`
- **`_run_skill`** (line 343): Core dispatch function for all workflow recipes
  - Constructs command: `"/ralph-hero:${skill} ${issue}"`
  - Runs: `timeout "$timeout" claude -p "$cmd" --max-budget-usd "$budget" --dangerously-skip-permissions`
  - No `</dev/null` redirect -- causes TTY hang bug
  - No support for interactive mode (`exec claude "$cmd"` without `-p`)
- **`_mcp_call`** (line 372): Direct MCP tool invocation for quick-* recipes
  - Uses mcptools: `mcp call "$tool" --params "$params" npx -y ralph-hero-mcp-server@2.5.4`
  - Formats JSON output via jq
  - Handles error responses

#### Recipe structure (all follow same pattern):
```
triage issue="" budget="1.00" timeout="15m":
    @just _run_skill "ralph-triage" "{{issue}}" "{{budget}}" "{{timeout}}"
```
The `issue` parameter is positional -- `ralph triage 42` sets `issue=42`. But `ralph impl 42 --plan-doc path` would set `budget="--plan-doc"`, breaking the invocation.

### The 3-Mode Dispatch Plan

A comprehensive plan exists at `thoughts/shared/plans/2026-02-27-ralph-cli-qol-improvements.md` that redesigns the CLI into a unified namespace with 3 modes:

| Mode | Flag | Behavior | Example |
|------|------|----------|---------|
| Interactive | (default) | Opens Claude session | `ralph plan 42` |
| Headless | `-h` | Print and exit | `ralph plan -h 42` |
| Quick | `-q` | Direct MCP call | `ralph status -q` |

**Status of implementation:**
- **Phase 1 (Dispatch Infrastructure)**: DONE -- `cli-dispatch.sh` exists at `plugin/ralph-hero/scripts/cli-dispatch.sh` with `parse_mode()`, `run_interactive()`, `run_headless()`, `run_quick()`, `no_mode()` functions
- **Phase 2 (Refactor Core Flow)**: NOT STARTED -- justfile still uses old `_run_skill` pattern
- **Phase 3 (New Commands)**: NOT STARTED -- `approve`, `next`, `ls`, `deps`, `where`, `assign`, `kill` not added

The `cli-dispatch.sh` is kept in sync by the release workflow (MCP_VERSION bumped automatically) but is not referenced by the justfile.

### Skill Argument Handling

Skills receive arguments via the `ARGUMENTS` mechanism when invoked as `/ralph-hero:skill-name ARGS`:

| Skill | argument-hint | What it accepts |
|-------|--------------|-----------------|
| `ralph-triage` | `[optional-issue-number]` | Issue number only |
| `ralph-research` | `[optional-issue-number]` | Issue number only |
| `ralph-plan` | `[optional-issue-number] [--research-doc path]` | Issue number + optional flag |
| `ralph-impl` | `[optional-issue-number] [--plan-doc path]` | Issue number + optional flag |
| `ralph-split` | `[optional-issue-number]` | Issue number only |
| `ralph-review` | `[optional-issue-number]` | Issue number only |
| `form` | `<idea-path-or-description>` | File path or free text |
| `impl` (interactive) | `<#NNN issue number or plan-path>` | Issue number or file path |
| `plan` (interactive) | File path, `#NNN`, or description | Flexible |
| `research` (interactive) | Research question or `#NNN` | Flexible |

The `--plan-doc` and `--research-doc` flags on `ralph-plan` and `ralph-impl` enable artifact path passthrough for team orchestration but are unreachable from the current CLI since `issue=""` is a single named parameter.

### Interactive vs Headless Skill Pairs

| CLI Command | Headless Skill (current) | Interactive Skill (unreachable) |
|-------------|-------------------------|-------------------------------|
| `research` | `ralph-research` | `research` |
| `plan` | `ralph-plan` | `plan` |
| `impl` | `ralph-impl` | `impl` |

Interactive skills support richer argument types (file paths, free text) and pause for human verification between phases. The recent skill rename (commit c752c22) shortened these to `research`, `plan`, `impl` but they remain unreachable from the CLI.

### Loop Scripts

#### `ralph-loop.sh`
- Orchestrates sequential phases: hygiene, triage, split, research, plan, review, impl
- Uses `run_claude()` which runs `claude -p "$command"` -- same headless pattern
- Detects "Queue empty" in output to stop iteration
- Supports `--mode-only` flags and `--review=skip|auto|interactive`

#### `ralph-team-loop.sh`
- Launches the team coordinator skill
- Passes optional issue number: `"/ralph-hero:team $ISSUE_NUMBER"`
- Simpler -- single `timeout "$TIMEOUT" claude -p "$COMMAND"` call

### TTY Hanging Bug

Identified in the QoL improvements plan: `_run_skill` doesn't redirect stdin. When `claude -p` is invoked without `</dev/null`, the process can get SIGTSTP'd (stopped by terminal). The `cli-dispatch.sh` `run_headless()` function fixes this with `</dev/null` on line 47, but since the justfile doesn't use cli-dispatch.sh, the fix isn't active.

### Related Plans and Issues

1. **GH-418 Interactive / Ralph Parity** (`thoughts/shared/plans/2026-02-26-GH-0418-interactive-ralph-parity.md`): 5-phase plan to align interactive and autonomous skills on state machine transitions, hooks, and artifact protocols. Status: draft, not implemented.

2. **Ralph CLI QoL** (`thoughts/shared/plans/2026-02-27-ralph-cli-qol-improvements.md`): 3-phase plan for unified 3-mode dispatch. Status: Phase 1 done (cli-dispatch.sh created), Phases 2-3 not started.

3. **GH-477 MCP_VERSION Mismatch** (closed): Fixed stale version in cli-dispatch.sh, added auto-sync to release workflow.

4. **GH-394 Justfile Parse Error** (closed): Fixed comment placement causing parse errors.

5. **GH-410 WSL2 Shebang Fix** (closed): Fixed `set tempdir` for WSL2 noexec /tmp mounts.

## Code References

- `plugin/ralph-hero/scripts/ralph-cli.sh:1-22` -- Global CLI wrapper
- `plugin/ralph-hero/justfile:343-369` -- `_run_skill` private recipe
- `plugin/ralph-hero/justfile:372-397` -- `_mcp_call` private recipe
- `plugin/ralph-hero/justfile:32-68` -- Workflow recipes (triage through status)
- `plugin/ralph-hero/scripts/cli-dispatch.sh:1-103` -- 3-mode dispatch infrastructure (unused)
- `plugin/ralph-hero/scripts/ralph-loop.sh:69-103` -- `run_claude()` headless execution
- `plugin/ralph-hero/scripts/ralph-team-loop.sh:44-61` -- Team orchestrator dispatch

## Architecture Documentation

The CLI follows a 3-layer architecture:
1. **Global wrapper** (`ralph-cli.sh` installed to `~/.local/bin/ralph`): resolves justfile from plugin cache
2. **Justfile recipes**: named parameters, delegate to private helper recipes
3. **Private helpers** (`_run_skill`, `_mcp_call`): construct and execute commands

The planned architecture adds a 4th layer:
1. **Global wrapper** (unchanged)
2. **Justfile recipes**: variadic `*args`, source cli-dispatch.sh
3. **Dispatch script** (`cli-dispatch.sh`): parse mode flags, route to appropriate function
4. **Execution functions**: `run_interactive()`, `run_headless()`, `run_quick()`

## Historical Context (from thoughts/)

- The CLI QoL plan was drafted 2026-02-27 and Phase 1 was implemented (cli-dispatch.sh)
- The interactive parity plan (GH-418) was drafted 2026-02-26 and remains in draft
- Both plans are related -- the CLI dispatch needs interactive skills to have proper hook enforcement (GH-418) for the interactive mode to work reliably
- The skill rename (c752c22, 2026-03-05) simplified skill names but didn't update CLI dispatch

## Open Questions

1. Should the CLI QoL Phase 2-3 be resumed, or does it need re-evaluation given the skill renames?
2. Should the TTY fix be applied to `_run_skill` as a quick fix independent of the larger refactor?
3. Is the GH-418 interactive parity plan a prerequisite for the CLI 3-mode dispatch, or can they proceed independently?
4. The `cli-dispatch.sh` hardcodes `MCP_VERSION="2.5.4"` -- should this be derived dynamically from package.json or the release workflow?
