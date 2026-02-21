---
date: 2026-02-21
github_issue: 300
github_url: https://github.com/cdubiel08/ralph-hero/issues/300
status: complete
type: research
---

# GH-300: Fix completions to use cache-based path resolution

## Problem Statement

Both shell completion scripts resolve the justfile via a legacy hardcoded path (`$HOME/.config/ralph-hero/justfile`). This was the original symlink location before the plugin moved to Claude's cache-based installation. The legacy path no longer exists for users who installed via `claude plugin install`, so completions silently fail (no tab completion).

## Current State

**`plugin/ralph-hero/scripts/ralph-completions.bash:6`**:
```bash
local justfile="${RALPH_JUSTFILE:-$HOME/.config/ralph-hero/justfile}"
```

**`plugin/ralph-hero/scripts/ralph-completions.zsh:6`**:
```bash
local justfile="${RALPH_JUSTFILE:-$HOME/.config/ralph-hero/justfile}"
```

Both scripts check `if [ ! -f "$justfile" ]; then return; fi` -- so they silently return with no completions when the legacy path doesn't exist. No error, no fallback.

## Key Findings

### Resolution logic in ralph-cli.sh

[`plugin/ralph-hero/scripts/ralph-cli.sh:6-14`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/scripts/ralph-cli.sh#L6-L14) has the correct resolution:

```bash
RALPH_JUSTFILE="${RALPH_JUSTFILE:-}"

if [ -z "$RALPH_JUSTFILE" ]; then
    CACHE_DIR="$HOME/.claude/plugins/cache/ralph-hero/ralph-hero"
    if [ -d "$CACHE_DIR" ]; then
        LATEST=$(ls -v "$CACHE_DIR" | tail -1)
        RALPH_JUSTFILE="$CACHE_DIR/$LATEST/justfile"
    fi
fi
```

Note: this uses `ls -v` which is being fixed in GH-293. The completions scripts should use `sort -V` instead (the corrected pattern).

### Files to modify

| File | Change |
|------|--------|
| `plugin/ralph-hero/scripts/ralph-completions.bash` | Replace line 6 with cache resolution block |
| `plugin/ralph-hero/scripts/ralph-completions.zsh` | Replace line 6 with cache resolution block |

### Correct resolution pattern (incorporating GH-293 fix)

```bash
local justfile="${RALPH_JUSTFILE:-}"
if [ -z "$justfile" ]; then
    local cache_dir="$HOME/.claude/plugins/cache/ralph-hero/ralph-hero"
    if [ -d "$cache_dir" ]; then
        local latest
        latest=$(ls "$cache_dir" | sort -V | tail -1)
        justfile="$cache_dir/$latest/justfile"
    fi
fi
```

Using `sort -V` (not `ls -v`) for cross-platform portability per GH-293.

### Scope

- 2 files, each ~13 lines
- Each file needs 1 line replaced with a ~6-line block
- No new dependencies, no API changes, no test infrastructure needed
- `RALPH_JUSTFILE` env var override is preserved for power users

## Recommended Approach

In each completion script, replace the single-line fallback:
```bash
local justfile="${RALPH_JUSTFILE:-$HOME/.config/ralph-hero/justfile}"
```

With the multi-line cache resolution block using `sort -V`. The check `if [ ! -f "$justfile" ]; then return; fi` immediately after can remain as a safety guard.

## Dependencies

- Soft dependency on GH-293 (ls -v -> sort -V) -- should use `sort -V` directly rather than copying the not-yet-fixed pattern from `ralph-cli.sh`
- No blocking dependency -- these files are independent

## Risks

- None significant. If the cache dir doesn't exist, `justfile` remains empty and the existing guard (`if [ ! -f "$justfile" ]; then return; fi`) handles it gracefully.
