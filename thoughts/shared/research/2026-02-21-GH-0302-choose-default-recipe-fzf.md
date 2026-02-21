---
date: 2026-02-21
github_issue: 302
github_url: https://github.com/cdubiel08/ralph-hero/issues/302
status: complete
type: research
---

# GH-302: Add `--choose` default recipe for interactive fzf selection

## Problem Statement

When `ralph` is invoked with no arguments, the `default` recipe runs `just --list`, showing a static list of recipes. There is no interactive way to browse and select a recipe. Just has a built-in `--choose` flag (since v1.9) that invokes fzf for interactive recipe selection.

## Current State

[`plugin/ralph-hero/justfile:10-12`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile#L10-L12):

```bash
# Show available recipes
default:
    @just --list
```

## Key Findings

### `just --choose` behavior

- Available since just v1.9+. Current environment: just 1.21.0 -- confirmed available.
- Invokes `fzf` by default (configurable via `$JUST_CHOOSER` env var or `--chooser` flag)
- Allows multi-select and runs selected recipe(s)
- If fzf is not installed, `just --choose` exits with an error message

### fzf availability

fzf is not universally installed. `just --choose` silently fails with an error if fzf is absent. A graceful fallback to `just --list` is needed.

### Detection approach

```bash
if command -v fzf >/dev/null 2>&1; then
    just --choose
else
    just --list
fi
```

This is the standard POSIX-portable way to detect a command.

### Justfile recipe implementation

The `default` recipe uses `@just --list` (suppressed echo). For the new version, a bash block is needed for the conditional:

```just
# Browse and select a recipe interactively (falls back to --list if fzf not installed)
default:
    #!/usr/bin/env bash
    if command -v fzf >/dev/null 2>&1; then
        just --choose
    else
        just --list
    fi
```

Note: `just --choose` cannot be called from within a just recipe using `@just --choose` because `just` re-executes itself. Using a `#!/usr/bin/env bash` shebang recipe avoids this.

### Interaction with GH-291 (`[group()]` attributes)

GH-291 adds `[group()]` attributes to all recipes. When `just --list` groups are active, `just --choose` also shows grouped output in fzf. No conflict -- GH-302 can be implemented before or after GH-291.

### Interaction with ralph-cli.sh

When users run `ralph` (the global CLI) with no arguments, it calls `exec just --justfile "$RALPH_JUSTFILE" "$@"` with an empty `$@`, which triggers the `default` recipe. The fzf session will launch in the user's terminal correctly.

## Recommended Approach

Replace the 2-line `default` recipe with a bash shebang recipe that checks for fzf and falls back to `just --list`. This is a single-recipe change in one file.

```just
# Browse and select a recipe interactively (falls back to --list if fzf not installed)
default:
    #!/usr/bin/env bash
    if command -v fzf >/dev/null 2>&1; then
        just --choose
    else
        just --list
    fi
```

## Risks

- **fzf not installed**: Handled by the fallback to `just --list`. No regression for users without fzf.
- **Non-interactive terminals**: `fzf` requires a TTY. In CI/automated contexts where `ralph` is called with no args, fzf would fail. The fallback only triggers on fzf absence, not on non-TTY. Could add `[ -t 1 ]` TTY check, but this is an edge case -- automated contexts virtually never call `ralph` with no args.
- **Scope**: Single file, single recipe -- minimal blast radius.
