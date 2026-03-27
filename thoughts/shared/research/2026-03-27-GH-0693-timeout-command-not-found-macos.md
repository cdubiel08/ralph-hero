---
date: 2026-03-27
github_issue: 693
github_url: https://github.com/cdubiel08/ralph-hero/issues/693
status: complete
type: research
tags: [portability, macos, bsd, cli, shell-scripting]
---

# GH-693: CLI `timeout: command not found` on macOS — replace GNU timeout with portable alternative

## Prior Work

- builds_on:: [[2026-02-21-GH-0293-ls-v-portability-macos]]
- tensions:: None identified.

## Problem Statement

Any headless `ralph` command fails on macOS with:

```
ralph review
>>> /ralph-hero:ralph-review (budget: $2.00, timeout: 15m)
cli-dispatch.sh: line 47: timeout: command not found
--- failed (exit 127, 0s) ---
```

macOS ships BSD userland, which does not include GNU `timeout`. The `timeout` command is used in three active scripts to enforce time limits on headless Claude sessions and is also present in a deprecated `justfile` recipe.

## Current State Analysis

### Affected Call Sites

| File | Line | Pattern | Active? |
|------|------|---------|---------|
| `plugin/ralph-hero/scripts/cli-dispatch.sh` | 47 | `timeout "$TIMEOUT" claude ... \| _output_filter` | Yes |
| `plugin/ralph-hero/scripts/ralph-loop.sh` | 79 | `output=$(timeout "$TIMEOUT" claude ...)` | Yes |
| `plugin/ralph-hero/scripts/ralph-team-loop.sh` | 54 | `timeout "$TIMEOUT" claude ... \|\| { exit_code=$? ...}` | Yes |
| `plugin/ralph-hero/justfile` | 400 | `if timeout "{{timeout}}" claude ...` | Deprecated |

### Exit Code 124 Semantics

All three active scripts check for exit code 124 to detect timeout:

- `cli-dispatch.sh:59`: `elif [ "$exit_code" -eq 124 ]`
- `ralph-loop.sh:84`: `if [ $exit_code -eq 124 ]`
- `ralph-team-loop.sh:56`: `if [ $exit_code -eq 124 ]`

GNU `timeout` returns 124 when the time limit is exceeded. Any replacement must preserve this contract.

### Duration Format

All call sites use the `"15m"` / `"30m"` / `"60m"` format, not raw seconds. The replacement must parse this format.

### Script Relationship

- `ralph-loop.sh` and `ralph-team-loop.sh` are **standalone scripts** — they do not source `cli-dispatch.sh`.
- `cli-dispatch.sh` is **sourced by justfile recipes** (lines 33, 42, 51, 61, 71) via `source "{{justfile_directory()}}/scripts/cli-dispatch.sh"`.
- `ralph doctor` currently checks `just`, `npx`, `node`, `mcp`, `claude` but **does not check** for `timeout`.

## Key Discoveries

### GNU `timeout` is Absent from macOS BSD Userland

macOS ships BSD `coreutils` without `timeout`. Users can install GNU coreutils via `brew install coreutils`, which provides `gtimeout`, but this adds a new dependency and requires knowing to install it.

### `perl` is the Portable Fallback

`perl` has been bundled with every macOS release since 10.0 (2001). While Apple deprecated it starting in macOS 12 (Monterey), it remains installed and functional through macOS 15 Sequoia. On Linux, `perl` ships with virtually every distribution.

The `perl -e 'alarm(N); exec @ARGV'` pattern provides kernel-level process timeout:
- `alarm(N)` sets a SIGALRM to fire after N seconds
- `exec @ARGV` replaces the perl process with the target command (no extra process layer)
- When SIGALRM fires, the process receives signal 14, exiting with code 142 (`128 + 14`)
- Code 142 must be normalized to 124 to match GNU `timeout` semantics

### Verified Behavior (tested on this system)

```bash
# Fast command completes normally
portable_timeout 5s sleep 1  # exit 0 - correct

# Slow command times out
portable_timeout 1s sleep 5  # exit 124 - correct (142 normalized to 124)
```

### Piping Compatibility

`cli-dispatch.sh` uses `PIPESTATUS[0]` to capture the timeout process exit code through a pipe to `_output_filter`. A bash function replacement for `timeout` participates in `PIPESTATUS` correctly — confirmed by local testing.

### Alternative Approaches Considered

| Approach | macOS | Linux | No New Deps | Exit 124 | Complexity |
|----------|-------|-------|-------------|----------|------------|
| `perl -e alarm()` | Yes (pre-installed) | Yes | Yes | With normalization | Low |
| Pure bash background+kill | Yes | Yes | Yes | Manual | Medium |
| `gtimeout` detection | Only with brew | Yes | No | Yes | Low |
| Python subprocess | Yes | Yes | Yes | Manual | Medium |

The **perl approach** wins on all axes: no new dependencies, no additional complexity, identical behavior to GNU `timeout` after exit code normalization.

### Pure Bash Background+Kill Tradeoffs

The background+kill approach runs the target command in a subshell (`$(...) &`), which breaks process group membership and can leave orphan processes. It also has a race condition between the watchdog kill and process natural completion. For a tool that invokes long-running `claude` CLI sessions, the perl approach is more reliable.

### Recommended `portable_timeout` Function

```bash
# Portable replacement for GNU timeout (absent on macOS BSD userland).
# Uses perl alarm() when timeout is unavailable; normalizes exit 142 -> 124.
# Supports duration formats: 15m, 30s, 2h, or raw seconds.
portable_timeout() {
    local duration="$1"; shift
    if command -v timeout &>/dev/null; then
        timeout "$duration" "$@"
        return $?
    fi
    # Parse duration to seconds for perl alarm()
    local secs
    case "$duration" in
        *m) secs=$(( ${duration%m} * 60 )) ;;
        *s) secs="${duration%s}" ;;
        *h) secs=$(( ${duration%h} * 3600 )) ;;
        *)  secs="$duration" ;;
    esac
    perl -e "alarm($secs); exec @ARGV" -- "$@"
    local rc=$?
    # SIGALRM -> exit 142; normalize to GNU timeout's exit 124
    [ $rc -eq 142 ] && return 124
    return $rc
}
```

### Where to Define the Function

Since `ralph-loop.sh` and `ralph-team-loop.sh` are standalone (do not source `cli-dispatch.sh`), the function must be either:

- **Option A**: Defined in `cli-dispatch.sh` only (for justfile-sourced commands), and duplicated inline in the two loop scripts — DRY violation but minimal coupling
- **Option B**: Extracted to a new `portable-utils.sh` file, sourced by all three — clean but adds a file
- **Option C**: Embedded inline in all three files — 3x duplication, maximum independence

**Recommended: Option A with minimal shared approach.** Add `portable_timeout` to `cli-dispatch.sh` (already the shared utility file for justfile recipes). For `ralph-loop.sh` and `ralph-team-loop.sh`, define the same function at the top of each file. Given the function is only 12 lines and the scripts are standalone by design, this is the pragmatic choice.

### `ralph doctor` Update

The doctor recipe should check for `timeout` availability and report the fallback:

```bash
if command -v timeout &>/dev/null; then
    echo "  OK: timeout ($(command -v timeout))"
elif command -v perl &>/dev/null; then
    echo "  OK: timeout (not found, using perl fallback)"
else
    echo "WARN: timeout not found and perl unavailable -- headless commands may fail"
    warnings=$((warnings + 1))
fi
```

This is informational (WARN rather than FAIL) since the perl fallback makes it work.

### `justfile:4` Prerequisites Comment

Line 4 currently reads:
```
# Prerequisites: claude CLI, timeout (coreutils), just >= 1.37
```

Should be updated to reflect that `timeout` is no longer required:
```
# Prerequisites: claude CLI, just >= 1.37 (timeout auto-detected or perl fallback used)
```

### `docs/cli.md` Prerequisite Table

The doctor table in `docs/cli.md` should gain a row for `timeout`:

| Category | What it checks |
|----------|---------------|
| Dependencies (new row) | `timeout` — used for headless session time limits; falls back to `perl` on macOS |

## Risks

- **perl deprecation on macOS**: Apple deprecated bundled Perl in macOS 12 but has not removed it as of macOS 15. The deprecation notice only appears when running `perl --version`, not during `exec`-based usage. Risk: negligible for current macOS versions.
- **`PIPESTATUS[0]` after function call in pipe**: Verified to work correctly for bash functions used as the left side of a pipe. Not an issue.
- **Duration format coverage**: The parser handles `15m`, `30s`, `2h`, and raw seconds. The codebase only uses `15m`, `30m`, `60m` — all covered by the `*m` case.

## Recommended Next Steps

1. Add `portable_timeout()` to `plugin/ralph-hero/scripts/cli-dispatch.sh` (top of file, before other functions). Replace `timeout` call at line 47.
2. Add `portable_timeout()` inline to `plugin/ralph-hero/scripts/ralph-loop.sh` (top of `run_claude()`). Replace `timeout` call at line 79.
3. Add `portable_timeout()` inline to `plugin/ralph-hero/scripts/ralph-team-loop.sh` (before line 54). Replace `timeout` call at line 54.
4. Update `plugin/ralph-hero/justfile _run_skill` recipe (line 400): replace `timeout` with the function or inline the logic. Mark as deprecated in comment.
5. Update `plugin/ralph-hero/justfile doctor` recipe (after line 190): add `timeout`/`perl` check.
6. Update `plugin/ralph-hero/justfile` line 4 prerequisites comment.
7. Update `docs/cli.md` doctor table to document the `timeout` check.

## Files Affected

### Will Modify
- `plugin/ralph-hero/scripts/cli-dispatch.sh` - Add `portable_timeout()` function, replace `timeout` call at line 47
- `plugin/ralph-hero/scripts/ralph-loop.sh` - Add `portable_timeout()` inline, replace `timeout` call at line 79
- `plugin/ralph-hero/scripts/ralph-team-loop.sh` - Add `portable_timeout()` inline, replace `timeout` call at line 54
- `plugin/ralph-hero/justfile` - Update `_run_skill` (line 400), `doctor` (after line 190), and prerequisites comment (line 4)
- `docs/cli.md` - Update doctor table to document `timeout` / perl fallback check

### Will Read (Dependencies)
- `plugin/ralph-hero/scripts/cli-dispatch.sh` - Existing `run_headless()` pattern and `PIPESTATUS[0]` usage
- `plugin/ralph-hero/scripts/ralph-loop.sh` - Existing `run_claude()` pattern
- `plugin/ralph-hero/scripts/ralph-team-loop.sh` - Existing inline `timeout` pattern
- `plugin/ralph-hero/justfile` - Existing `doctor` and `_run_skill` recipes
- `thoughts/shared/research/2026-02-21-GH-0293-ls-v-portability-macos.md` - BSD portability precedent
