# Ralph CLI Feedback UX Design

## Problem

Running `ralph research` (or any workflow command) feels like a black box. The current `_run_skill` function:
1. Hangs silently due to missing `</dev/null` (TTY SIGTSTP bug)
2. No streaming output — you can't see what's happening
3. No links to created artifacts (issues, research docs, PRs)
4. No completion summary with elapsed time or state transitions

## Design

### Flag Convention

```
ralph <command> [args...]     # headless (default) — streams output with summary
ralph <command> -i [args...]  # interactive — opens Claude session
ralph <command> -q [args...]  # quick — direct MCP call, no AI
```

Headless is the default for all workflow commands. Interactive requires `-i`. This is a departure from the original QoL plan which defaulted to interactive.

### Output Wrapper

`run_headless()` pipes `claude -p` output through an `awk` filter that:

1. **Streams everything through** in real-time (no buffering)
2. **Captures GitHub URLs** as they appear in the output
3. **Captures repo-relative file paths** (e.g., `thoughts/shared/research/...`)
4. **Detects state transitions** (lines containing arrow characters)
5. **Prints a summary footer** on completion:

```
--- done (47s) ---
  https://github.com/cdubiel08/ralph-hero/issues/42
  vscode://file/home/user/projects/ralph-hero/thoughts/shared/research/2026-03-06-GH-0042-findings.md
  Research Needed -> Ready for Plan
```

**Link rules:**
- GitHub objects (issues, PRs): `https://github.com/...` links
- Local file artifacts: `vscode://file/...` links (clickable in terminal, opens VS Code)
- No labels, just links and transitions

The filter lives inline in `run_headless()` in `cli-dispatch.sh` — no new files.

### Recipe Structure

Each justfile recipe sources `cli-dispatch.sh` and routes by mode:

```just
research *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=2.00 DEFAULT_TIMEOUT=15m
    parse_mode {{args}}
    case "$MODE" in
        interactive) run_interactive "research" "${ARGS[@]}" ;;
        headless)    run_headless "ralph-research" "${ARGS[@]}" ;;
        quick)       no_mode "research" "quick" ;;
    esac
```

### Command Map

| Command | Default | `-i` | `-q` |
|---------|---------|------|------|
| `research [N]` | headless | interactive | -- |
| `plan [N]` | headless | interactive | -- |
| `impl [N]` | headless | interactive | -- |
| `triage [N]` | headless | interactive | -- |
| `split [N]` | headless | interactive | -- |
| `review [N]` | headless | interactive | -- |
| `status` | headless | interactive | quick (instant) |
| `hygiene` | headless | interactive | quick (instant) |
| `report` | headless | interactive | -- |
| `info N` | quick | -- | quick |
| `ls [state]` | quick | -- | quick |
| `next [state]` | quick | -- | quick |

### Changes to `cli-dispatch.sh`

- Rename `-h` flag to `-i`/`--interactive`, default mode becomes `headless`
- Add output wrapper (awk filter) to `run_headless()`
- Resolve repo root via `git rev-parse --show-toplevel` for vscode links
- Detect `github.com/` URLs, `thoughts/shared/` paths, and state transitions in stream

### Justfile Changes

- Replace all `_run_skill` calls with `cli-dispatch.sh` sourcing pattern
- Switch from named parameters (`issue="" budget=""`) to variadic `*args`
- Keep aliases (`t`, `r`, `p`, `i`, `s`, `sp`, `h`)
- Remove `alias issue := quick-info`
- Keep `_run_skill`, `_mcp_call`, and `quick-*` recipes for backward compat (mark deprecated)

## Scope

**In scope:**
- Wire `cli-dispatch.sh` into justfile recipes (the stalled Phase 2 refactor)
- Flip default mode to headless
- Add output wrapper with link/transition surfacing
- Fix TTY hang bug (already fixed in `cli-dispatch.sh` via `</dev/null`)
- 6 workflow recipes + status + hygiene + report

**Out of scope:**
- New commands (approve, next, ls, deps, where, assign, kill) — separate Phase 3 work
- Skill modifications — feedback comes from the output wrapper
- Loop script changes (`ralph-loop.sh`, `ralph-team-loop.sh`)
- Deprecating `quick-*` recipes

## References

- Existing dispatch: `plugin/ralph-hero/scripts/cli-dispatch.sh`
- Current justfile: `plugin/ralph-hero/justfile`
- Original QoL plan: `thoughts/shared/plans/2026-02-27-ralph-cli-qol-improvements.md`
- CLI architecture research: `thoughts/shared/research/2026-03-06-GH-0546-ralph-cli-justfile-architecture.md`
- GitHub issue: #546
