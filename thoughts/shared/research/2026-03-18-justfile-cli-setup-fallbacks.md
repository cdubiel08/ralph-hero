---
date: 2026-03-18
topic: "Justfile CLI setup, fallbacks, and intuitiveness for ralph-hero"
tags: [research, cli, justfile, setup, fallbacks, ralph-cli, doctor, dispatch]
status: complete
type: research
git_commit: 894be29768c771f71204e6f5e9f091704efbe106
---

# Research: Justfile CLI Setup, Fallbacks, and Intuitiveness

## Research Question

Is there a setup-cli skill for ralph-hero? Do we have elegant fallbacks and is the CLI intuitive to use?

## Summary

There is **no skill named `setup-cli`**. The two setup skills are `setup` (GitHub Project V2 creation) and `setup-repos` (multi-repo bootstrap). CLI installation is handled entirely by the justfile via `just install-cli`. The system has a layered fallback architecture across `ralph-cli.sh`, `cli-dispatch.sh`, and the `doctor` recipe — but the entry point for getting `ralph` available globally requires the user to know to run `just install-cli` first, which is the main friction point.

## Detailed Findings

### Skills That Exist for Setup

| Skill | Purpose |
|-------|---------|
| `/ralph-hero:setup` | One-time GitHub Project V2 creation with interactive health checks, field configuration, split-owner/dual-token support, routing setup. |
| `/ralph-hero:setup-repos` | Bootstrap `.ralph-repos.yml` for multi-repo portfolio tracking. |

There is **no `setup-cli` skill**. CLI installation is a justfile concern, not a skill.

### How Global CLI Installation Works

`plugin/ralph-hero/justfile:246-271` — `install-cli` recipe in the `[group('setup')]` section:

```bash
just install-cli
```

- Copies `scripts/ralph-cli.sh` to `~/.local/bin/ralph`
- Guarded by a `[confirm(...)]` attribute requiring user approval
- Warns if `~/.local/bin` is not in `$PATH`
- Shows usage examples after install
- Suggests `just install-completions bash` (or `zsh`) as a follow-up

To uninstall: `just uninstall-cli` (also confirm-guarded).

Shell completions: `just install-completions bash` or `just install-completions zsh` — copies completion scripts to the appropriate platform directories.

### How `ralph-cli.sh` Works (the Global Wrapper)

`plugin/ralph-hero/scripts/ralph-cli.sh` — resolves the latest plugin version at runtime:

1. Scans `~/.claude/plugins/cache/ralph-hero/ralph-hero/` for the latest version via `ls | sort -V | tail -1`
2. Reads version from `.claude-plugin/plugin.json` (via `jq`) — falls back to directory name
3. Handles `--version`/`-V`: prints `ralph version X.Y.Z` and exits
4. Handles `--help`/`-h`: prints a full usage summary with common commands, options, and examples
5. **First-run welcome banner**: checks `~/.ralph/welcomed` — if absent, prints a welcome message and creates the file. Shows once only.
6. **Missing justfile fallback**: if the plugin cache doesn't exist, prints clear error + install instruction (`claude plugin install ...`)
7. Delegates to `just --justfile <path> "$@"` — all args passed through to justfile

### Fallback Architecture in `cli-dispatch.sh`

`plugin/ralph-hero/scripts/cli-dispatch.sh` — sourced by every LLM-powered justfile recipe:

**Three modes** parsed from args:

| Flag | Mode | Behavior |
|------|------|---------|
| (none) | headless | Runs `claude -p` non-interactively with streaming output |
| `-i` / `--interactive` | interactive | Opens a full Claude Code session |
| `-q` / `--quick` | quick | Direct MCP tool call via mcptools, no AI |

**`no_mode()` function** (`cli-dispatch.sh:193-203`): when a recipe doesn't support the requested mode, it explicitly tells the user what modes ARE available and how to use them. Example:
```
Error: 'triage' does not support quick mode.
Try: ralph triage (headless) or ralph triage -i (interactive)
```

**Headless run error handling** (`cli-dispatch.sh:57-65`):
- Exit 0: `--- done (Ns) ---`
- Exit 124 (timeout): `--- timed out after $TIMEOUT ---` + `Try: --timeout=30m`
- Other exits: `--- failed (exit N) ---` + `Run: ralph doctor`

**Summary footer** (`cli-dispatch.sh:74-139`): after every headless run, an `awk` filter collects GitHub URLs, `thoughts/shared/*` file paths (as `vscode://file/` links), and state transitions (e.g., `Backlog → Research Needed`) from the output stream, then prints them as a structured footer.

**`run_quick()` fallback** (`cli-dispatch.sh:164-190`): if mcptools is not installed, prints clear error with install instructions. If `jq` is not available, falls back to raw output.

### `doctor` Recipe — Comprehensive Diagnostics

`plugin/ralph-hero/justfile:148-244` — runs entirely in bash with no AI or MCP calls:

**What it checks:**

| Category | Items |
|----------|-------|
| Environment Variables | `RALPH_HERO_GITHUB_TOKEN`, `RALPH_GH_OWNER`, `RALPH_GH_PROJECT_NUMBER` |
| Dependencies | `just`, `npx`, `node` (errors); `mcp` (mcptools, warning); `claude` CLI (warning) |
| Plugin Files | `.claude-plugin/plugin.json` (valid JSON?), `.mcp.json` (valid JSON?) |
| API Health | Calls `ralph_hero__health_check` via `just _mcp_call` — **skipped** if mcptools or token unavailable |
| WSL2 | Detects `/proc/version` microsoft string; checks if tempdir is mounted `noexec` |

- Exits with code 1 on errors; warnings (missing optional deps) do NOT cause non-zero exit
- Missing mcptools: warns but continues, marks API health as `SKIP`

### `default` Recipe — fzf-aware

`plugin/ralph-hero/justfile:20-26`:
```bash
default:
    if command -v fzf >/dev/null 2>&1; then
        just --choose   # interactive fuzzy picker
    else
        just --list     # plain recipe list
    fi
```

Running `just` with no args shows an interactive recipe picker if `fzf` is installed, otherwise a plain list.

### `_mcp_call` Private Recipe — jq-aware

`plugin/ralph-hero/justfile:420-445` — used by all `quick-*` recipes:
- If mcptools not installed: clear error + two install methods (brew, go install)
- If jq not available: falls back to raw output (no crash)
- Error response detection via `jq -e '.isError // false'`
- Pretty-prints JSON nested text when possible

### Recipe Groups

Justfile organizes recipes into four groups:

| Group | Recipes |
|-------|---------|
| `workflow` | triage, split, research, plan, review, impl, hygiene, status, report |
| `orchestrate` | team, hero, loop |
| `setup` | setup, doctor, install-cli, uninstall-cli, install-completions, completions |
| `quick` | quick-status, quick-move, quick-pick, quick-assign, quick-issue, quick-info, quick-comment, quick-draft |

### Key Friction Points with Justfile Access

1. **Must run from `plugin/ralph-hero/`** — justfile recipes use `{{justfile_directory()}}` to find scripts. Running `just` from the repo root or any other directory fails.
2. **Global `ralph` command requires explicit installation** — `just install-cli` must be run first. The user must know this step exists.
3. **`just install-cli` requires knowing to go to `plugin/ralph-hero/` first** — bootstrapping paradox: to install the CLI, you need to be in the plugin directory already.
4. **PATH warning only shown at install time** — if `~/.local/bin` isn't in PATH, the warning appears once then never again.

## Code References

- `plugin/ralph-hero/justfile:1-26` — Header, aliases, default recipe with fzf fallback
- `plugin/ralph-hero/justfile:139-271` — `[group('setup')]` recipes: setup, doctor, install-cli, uninstall-cli, install-completions, completions
- `plugin/ralph-hero/justfile:420-445` — `_mcp_call` private recipe
- `plugin/ralph-hero/scripts/ralph-cli.sh:1-96` — Global CLI wrapper with version, help, welcome banner, fallback errors
- `plugin/ralph-hero/scripts/cli-dispatch.sh:1-203` — Three-mode dispatch, output filter, `no_mode()` error handler
- `plugin/ralph-hero/skills/setup/SKILL.md` — GitHub Project V2 setup skill (not CLI setup)
- `docs/cli.md` — CLI reference documentation for quick-* recipes and doctor

## Architecture

```
User
  │
  ├─ via global `ralph` command
  │   └─ ~/.local/bin/ralph (ralph-cli.sh)
  │       ├─ --version / --help (handled inline)
  │       ├─ first-run banner (one-time, ~/.ralph/welcomed)
  │       ├─ missing plugin: clear error + install hint
  │       └─ delegates to: just --justfile <plugin-cache>/justfile "$@"
  │
  └─ via `just` directly from plugin/ralph-hero/
      └─ justfile recipes
          ├─ [group('setup')]: setup, doctor, install-cli, uninstall-cli, install-completions
          ├─ [group('workflow')]: triage, research, plan, impl, etc.
          │   └─ source cli-dispatch.sh → dispatch()
          │       ├─ headless: claude -p + output filter + summary footer
          │       ├─ interactive: exec claude (full session)
          │       └─ quick: mcp call → raw/jq output
          └─ [group('quick')]: quick-status, quick-move, quick-pick, etc.
              └─ just _mcp_call → mcptools → MCP server
```

## Historical Context

Per thoughts/ documents:
- `2026-02-18-GH-0067` — initial justfile vs shell script design tradeoffs
- `2026-02-21-group-GH-0281` — global CLI access via symlink (later changed to copy)
- `2026-02-27-ralph-cli-qol-improvements.md` — added `--budget`, `--timeout` flags
- `2026-03-18-GH-0606` — `--version` / `--help` flags added to `ralph-cli.sh`
- `2026-03-18-GH-0607` — `--help` usage summary added

## Open Questions

- Is there a way to bootstrap `just install-cli` without being in `plugin/ralph-hero/` first? (e.g., a post-plugin-install hook or a one-liner in plugin docs)
- Should `ralph-cli.sh` also accept `ralph doctor` to run the doctor check from anywhere? (It does — `ralph doctor` works today via justfile delegation.)
