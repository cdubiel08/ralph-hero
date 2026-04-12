---
date: 2026-03-26
github_issue: 693
github_url: https://github.com/cdubiel08/ralph-hero/issues/693
topic: "timeout command not found on macOS — ralph CLI headless mode failure"
tags: [research, codebase, cli-dispatch, timeout, macos, coreutils]
status: complete
type: research
git_commit: c4eea06e2f97fd7806ceae8258b3727f2e1c1859
---

# Research: `timeout: command not found` on macOS

## Prior Work

- builds_on:: [[2026-03-18-justfile-cli-setup-fallbacks]]
- builds_on:: [[2026-03-06-GH-0546-ralph-cli-justfile-architecture]]
- builds_on:: [[2026-02-21-GH-0293-ls-v-portability-macos]] (prior macOS/coreutils portability issue)

## Research Question

Running `ralph review` fails with `timeout: command not found` (exit 127) because macOS does not ship GNU `timeout`.

## Summary

The `timeout` command (GNU coreutils) is used in 3 active scripts to enforce time limits on headless Claude sessions. macOS does not include `timeout` in its base system — it must be installed via `brew install coreutils`, which provides it as `gtimeout` (or `timeout` if `gnubin` is on PATH). There is no fallback, no `gtimeout` check, and `ralph doctor` does not verify `timeout` is installed.

## Detailed Findings

### Where `timeout` is invoked

| File | Line | Context |
|------|------|---------|
| `plugin/ralph-hero/scripts/cli-dispatch.sh` | 47 | `run_headless()` — wraps `claude -p` with timeout |
| `plugin/ralph-hero/scripts/ralph-loop.sh` | 79 | Per-phase runner inside autonomous loop |
| `plugin/ralph-hero/scripts/ralph-team-loop.sh` | 54 | Team orchestrator runner |
| `plugin/ralph-hero/justfile` | ~556 | Deprecated `_run_skill` recipe (still present) |

All four sites use the same pattern:
```bash
timeout "$TIMEOUT" claude -p "$cmd" --max-budget-usd "$BUDGET" --dangerously-skip-permissions 2>&1
```

Exit code `124` is detected as the timeout signal (cli-dispatch.sh:59, ralph-loop.sh:84, ralph-team-loop.sh:56).

### Default timeout values

| Script | Default | Source |
|--------|---------|--------|
| cli-dispatch.sh | `15m` | `DEFAULT_TIMEOUT` variable (line 11) |
| ralph-loop.sh | `15m` | `TIMEOUT` env var (line 54) |
| ralph-team-loop.sh | `30m` | `TIMEOUT` env var (line 30) |

### macOS compatibility gap

- macOS ships BSD userland — no `timeout` binary
- GNU coreutils provides `timeout` as `gtimeout` when installed via Homebrew
- Adding `/opt/homebrew/opt/coreutils/libexec/gnubin` to PATH makes it available as `timeout`
- No script checks for `gtimeout` as a fallback
- The string `gtimeout` appears zero times in the codebase

### `ralph doctor` dependency checks (justfile:312-332)

Currently checked:
- `just` — hard requirement (FAIL)
- `npx` — hard requirement (FAIL)
- `node` — hard requirement (FAIL)
- `mcp` (mcptools) — soft requirement (WARN)
- `claude` — soft requirement (WARN)

**`timeout` is not checked.**

### Documentation (docs/cli.md:16)

The only mention of timeout as a prerequisite:
```
3. **timeout** -- included in GNU coreutils (pre-installed on most Linux)
```

No macOS install instructions are provided.

### Prior macOS portability fix

GH-293 addressed a similar BSD vs GNU issue: `ls -v` (GNU natural sort) doesn't exist on macOS BSD `ls`. That was resolved by switching to `ls | sort -V`. This is the same category of problem — relying on GNU-specific commands without macOS fallbacks.

## Code References

- `plugin/ralph-hero/scripts/cli-dispatch.sh:11` — DEFAULT_TIMEOUT set to `15m`
- `plugin/ralph-hero/scripts/cli-dispatch.sh:47` — `timeout "$TIMEOUT" claude -p ...` invocation
- `plugin/ralph-hero/scripts/cli-dispatch.sh:59-61` — exit code 124 handling
- `plugin/ralph-hero/scripts/ralph-loop.sh:79` — timeout invocation in loop
- `plugin/ralph-hero/scripts/ralph-team-loop.sh:54` — timeout invocation in team loop
- `plugin/ralph-hero/justfile:312-332` — doctor dependency checks (timeout absent)
- `plugin/ralph-hero/docs/cli.md:16` — timeout prerequisite documentation

## Architecture Documentation

The CLI dispatch architecture uses a layered approach:
1. `ralph` (global wrapper in `~/.local/bin/`) resolves the latest cached plugin version
2. Delegates to `just` recipes in `plugin/ralph-hero/justfile`
3. Recipes source `cli-dispatch.sh` for shared mode handling
4. `dispatch()` routes to `run_headless()`, `run_interactive()`, or `run_quick()` based on flags
5. `run_headless()` wraps the `claude` invocation with `timeout` for safety

The `timeout` command is the enforcement mechanism that prevents runaway headless sessions from consuming unlimited budget/time.

## Historical Context (from thoughts/)

- The 3-mode dispatch system (headless/interactive/quick) was documented in the justfile CLI setup fallbacks research (2026-03-18)
- GH-293 established precedent for fixing macOS/GNU portability issues in these scripts
- The doctor command has been incrementally enhanced (GH-479 error counter, GH-634 settings.local.json fallback) but timeout was never added to its checks

## Open Questions

- Should the fix use a `gtimeout`/`timeout` detection pattern, or should it use a pure-bash alternative (e.g., background process + `kill` after delay)?
- Should `ralph doctor` gain a `timeout` check as a hard or soft requirement?
