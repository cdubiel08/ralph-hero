---
date: 2026-02-21
github_issue: 279
github_url: https://github.com/cdubiel08/ralph-hero/issues/279
status: complete
type: research
---

# GH-279: Global CLI Access — Shell Shortcut for Running Ralph from Anywhere

## Problem Statement

Currently, users must `cd plugin/ralph-hero` before running any `just` recipe. This friction discourages casual use and makes it harder to integrate Ralph into daily workflows, especially when working across multiple projects or worktrees.

## Current State

### Justfile Location & Directory Dependency

The justfile lives at `plugin/ralph-hero/justfile` and has implicit directory requirements:

- **`team` recipe (line 52)**: `./scripts/ralph-team-loop.sh` — relative path
- **`loop` recipe (line 65)**: `./scripts/ralph-loop.sh` — relative path
- **`doctor` recipe (lines 122, 133)**: Checks `.claude-plugin/plugin.json` and `.mcp.json` by relative path
- **`set dotenv-load` (line 8)**: Loads `.env` from CWD

Most recipes (triage, research, plan, impl, etc.) call `claude -p "/ralph-<skill>"` which is directory-independent. The directory dependency only affects `team`, `loop`, and `doctor`.

### Existing CLI Documentation

`docs/cli.md:132-145` already documents a manual alias approach:

```bash
alias ralph='just --justfile plugin/ralph-hero/justfile'
```

But this is repository-root-relative — it only works from within the ralph-hero repo.

### How `just --justfile` and `--working-directory` Work

- `--justfile <PATH>` — Use exactly this file, skip directory search
- `--working-directory <PATH>` (or `-d`) — Set CWD for recipe execution. Defaults to the justfile's directory when `--justfile` is used
- Combined: `just --justfile /abs/path/justfile --working-directory /abs/path/dir` gives full control

**Critical insight**: When using `--justfile` without `--working-directory`, `just` sets CWD to the justfile's parent directory. This means the relative `./scripts/` paths in `team`, `loop`, and `doctor` will resolve correctly as long as we omit `--working-directory` or set it to the justfile's directory.

## Approaches Evaluated

### 1. Standalone Script in PATH (Recommended)

A `ralph` shell script installed to `~/.local/bin/ralph` (or any PATH directory):

```bash
#!/usr/bin/env bash
# ralph — global CLI for Ralph Hero workflows
RALPH_JUSTFILE="${RALPH_JUSTFILE:-$HOME/.config/ralph-hero/justfile}"
exec just --justfile "$RALPH_JUSTFILE" "$@"
```

**Pros**: Works in non-interactive shells, CI, cron. No shell-specific syntax. Single file. `which ralph` works. Clean process tree via `exec`.

**Cons**: Requires the justfile to exist at the configured path (symlink or copy).

### 2. Shell Function in RC File

```bash
ralph() {
    just --justfile "${RALPH_JUSTFILE:-$HOME/.config/ralph-hero/justfile}" "$@"
}
```

**Pros**: Can modify current shell env if needed. No file in PATH required.

**Cons**: Shell-specific (bash vs zsh syntax identical here, but fish differs). Not available in non-interactive contexts. Harder to discover (`type ralph` vs `which ralph`).

### 3. `just --global-justfile` (`just -g`)

`just` natively supports a global justfile at `~/.config/just/justfile`. Users would invoke `just -g research 42`.

**Pros**: Zero wrapper code. Native `just` feature.

**Cons**: Requires `just -g` prefix (not `ralph`). Known bug in just (#2723) where `-g` can fall back to local justfiles unexpectedly. Conflicts if user has other global justfile recipes.

### 4. npm Global Package

Publish a `ralph-hero-cli` package with a bin entry.

**Pros**: Familiar `npm install -g` workflow. Automatic updates.

**Cons**: Adds Node.js runtime dependency for what is a 5-line shell script. Over-engineered.

### 5. Shebang Justfile

Make the justfile itself executable with `#!/usr/bin/env -S just --justfile`:

```
#!/usr/bin/env -S just --justfile
```

**Pros**: Self-contained, no wrapper.

**Cons**: Requires GNU `env -S` (not available on older macOS). Doesn't allow customizing the `--justfile` path dynamically.

## Recommendation: Standalone Script + Installer Recipe

**Approach 1** (standalone script in PATH) is the best fit because:

1. Works everywhere — interactive, non-interactive, CI, scripts
2. Single POSIX-compatible file
3. `which ralph` and `ralph --help` work intuitively
4. `exec` keeps the process tree clean
5. Symlink strategy avoids file duplication

### Proposed Architecture

```
~/.config/ralph-hero/
├── justfile → symlink to plugin/ralph-hero/justfile
└── (future: config.env for defaults)

~/.local/bin/
└── ralph        # wrapper script
```

The installer should:
1. Create `~/.config/ralph-hero/` directory
2. Symlink the justfile from the plugin directory
3. Install the `ralph` wrapper script to `~/.local/bin/`
4. Verify `~/.local/bin` is in PATH (warn if not)
5. Optionally install shell completions

### Key Design Decisions

**Symlink vs copy**: Symlink is better — the justfile stays in sync with the repo. When the user pulls updates, the global `ralph` command automatically gets new recipes.

**`--working-directory` behavior**: We should NOT pass `--working-directory .` because that would break the `team`, `loop`, and `doctor` recipes that use relative `./scripts/` paths. By omitting it, `just` defaults to the justfile's directory (which is correct for those recipes). The `claude -p` recipes are directory-independent anyway.

**Uninstall**: A `just uninstall-cli` recipe that reverses the setup — removes the symlink, wrapper script, and config directory.

**Naming**: `ralph` as the command name. Short, memorable, matches the project name.

## Risks & Edge Cases

1. **`~/.local/bin` not in PATH**: Common on fresh Linux installs. The installer should detect and warn, with instructions for adding it.
2. **Symlink breaks if plugin moves**: The symlink points to an absolute path. If the user moves the repo, they need to re-run the installer. Could mitigate by storing the path in a config file.
3. **Multiple ralph-hero installs**: If user has multiple clones, the symlink points to whichever was last installed. This is probably fine — recipes are directory-independent except for `team`/`loop`/`doctor`.
4. **Fish shell**: The wrapper script works with fish (it's a standalone script, not a function). Completions would need separate handling.
5. **Windows/WSL**: Script works in WSL. Native Windows would need a `.cmd` wrapper (out of scope).

## Suggested Ticket Breakdown

This is an M-sized feature. Suggested split into XS/S sub-issues:

1. **XS: Create `ralph` wrapper script** — The standalone script in `plugin/ralph-hero/scripts/ralph-cli.sh`
2. **S: Create installer/uninstaller recipes** — `just install-cli` and `just uninstall-cli` recipes in the justfile
3. **XS: Update CLI documentation** — Update `docs/cli.md` with global access instructions
4. **XS: Add shell completions for `ralph` wrapper** — Generate completions that work with the global command

## File References

- `plugin/ralph-hero/justfile` — Current justfile with all recipes
- `plugin/ralph-hero/docs/cli.md:132-145` — Existing alias documentation
- `plugin/ralph-hero/scripts/ralph-loop.sh` — Script with relative path dependency
- `plugin/ralph-hero/scripts/ralph-team-loop.sh` — Script with relative path dependency
