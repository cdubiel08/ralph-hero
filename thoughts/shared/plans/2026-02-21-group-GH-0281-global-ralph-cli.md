---
date: 2026-02-21
status: draft
github_issues: [281, 282, 283, 284]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/281
  - https://github.com/cdubiel08/ralph-hero/issues/282
  - https://github.com/cdubiel08/ralph-hero/issues/283
  - https://github.com/cdubiel08/ralph-hero/issues/284
primary_issue: 281
---

# Global `ralph` CLI Command - Atomic Implementation Plan

## Overview

4 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-281 | Create `ralph` CLI wrapper script | XS |
| 2 | GH-282 | Create installer/uninstaller recipes for global CLI access | S |
| 3 | GH-283 | Update CLI documentation for global `ralph` command | XS |
| 4 | GH-284 | Add shell completions for global `ralph` command | XS |

**Why grouped**: These are sub-issues of GH-279 (Global CLI access). Each phase builds on the previous: the wrapper script (Phase 1) is installed by the recipes (Phase 2), documented (Phase 3), and gets completions (Phase 4). They form a single cohesive feature.

## Current State Analysis

- The justfile lives at `plugin/ralph-hero/justfile` and requires `cd plugin/ralph-hero` before use
- `docs/cli.md:132-145` documents a manual `--justfile` alias as a workaround
- Recipes using relative paths (`./scripts/ralph-loop.sh`, `./scripts/ralph-team-loop.sh`) depend on CWD being the justfile's directory
- `just --justfile` without `--working-directory` defaults CWD to the justfile's parent directory, so relative paths resolve correctly
- The `completions` recipe at line 206 already generates `just` completions but these complete `just` recipes, not a `ralph` command
- No existing scripts in `plugin/ralph-hero/scripts/` handle CLI installation

## Desired End State

### Verification
- [ ] `ralph` command works from any directory after `just install-cli`
- [ ] `ralph triage 42`, `ralph loop`, `ralph team 42` all work correctly
- [ ] `just uninstall-cli` cleanly removes the global command
- [ ] `ralph <TAB>` completes recipe names in bash and zsh
- [ ] `docs/cli.md` documents the full global access workflow
- [ ] Installer is idempotent (safe to re-run)

## What We're NOT Doing

- Fish shell completions (bash and zsh only per research recommendation)
- Windows/native CMD support (WSL works via the bash script)
- npm global package distribution
- `just --global-justfile` approach (known bugs, conflicts)
- Auto-PATH modification (warn only, don't edit shell RC files)

## Implementation Approach

Phase 1 creates the standalone wrapper script. Phase 2 adds justfile recipes that install/uninstall it (symlink justfile + copy script to PATH). Phase 3 updates documentation. Phase 4 adds shell completions that are optionally installed during `install-cli`. Each phase is independently testable but they combine into one coherent feature.

---

## Phase 1: Create `ralph` CLI wrapper script (GH-281)
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/281 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0279-global-cli-access-shell-shortcut.md

### Changes Required

#### 1. Create wrapper script
**File**: `plugin/ralph-hero/scripts/ralph-cli.sh` (new)
**Changes**:
```bash
#!/usr/bin/env bash
# ralph -- global CLI for Ralph Hero workflows
# Delegates to just --justfile, resolving the justfile via symlink or env var.
set -euo pipefail

RALPH_JUSTFILE="${RALPH_JUSTFILE:-$HOME/.config/ralph-hero/justfile}"

if [ ! -f "$RALPH_JUSTFILE" ]; then
    echo "Error: Ralph justfile not found at $RALPH_JUSTFILE"
    echo "Run 'just install-cli' from the ralph-hero plugin directory to set up."
    exit 1
fi

exec just --justfile "$RALPH_JUSTFILE" "$@"
```

Key design decisions from research:
- Uses `exec` for clean process tree
- Does NOT pass `--working-directory` so relative `./scripts/` paths in `team`, `loop`, and `doctor` recipes resolve to the justfile's directory
- Configurable via `RALPH_JUSTFILE` env var with sensible default
- `set -euo pipefail` for robustness

### Success Criteria
- [x] Automated: `bash -n plugin/ralph-hero/scripts/ralph-cli.sh` (syntax check passes)
- [x] Automated: `test -x plugin/ralph-hero/scripts/ralph-cli.sh` (executable bit set)
- [ ] Manual: Script shows error message when justfile symlink is missing

**Creates for next phase**: The script file that `install-cli` will copy/symlink to `~/.local/bin/ralph`.

---

## Phase 2: Create installer/uninstaller recipes (GH-282)
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/282 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0279-global-cli-access-shell-shortcut.md | **Depends on**: Phase 1

### Changes Required

#### 1. Add `install-cli` recipe
**File**: `plugin/ralph-hero/justfile`
**Changes**: Add new recipe in the "Utility Recipes" section (after `doctor`, before "Quick Actions"):

```just
# Install global 'ralph' command - run from anywhere after setup
install-cli:
    #!/usr/bin/env bash
    set -eu
    CONFIG_DIR="$HOME/.config/ralph-hero"
    BIN_DIR="$HOME/.local/bin"
    JUSTFILE_SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)/justfile"
    SCRIPT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)/scripts/ralph-cli.sh"
    # Create directories
    mkdir -p "$CONFIG_DIR" "$BIN_DIR"
    # Symlink justfile (idempotent via -sf)
    ln -sf "$(just --evaluate --justfile "{{justfile()}}" _justfile_dir)/justfile" "$CONFIG_DIR/justfile"
    # Copy wrapper script
    cp "$(just --evaluate --justfile "{{justfile()}}" _justfile_dir)/scripts/ralph-cli.sh" "$BIN_DIR/ralph"
    chmod +x "$BIN_DIR/ralph"
    echo "Installed: $BIN_DIR/ralph -> delegates to $CONFIG_DIR/justfile"
    # Check PATH
    if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
        echo ""
        echo "WARNING: $BIN_DIR is not in your PATH."
        echo "Add to your shell profile (~/.bashrc or ~/.zshrc):"
        echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    fi
    echo ""
    echo "Usage: ralph <recipe> [args...]"
    echo "  ralph triage 42"
    echo "  ralph loop"
    echo "  ralph team 42"
```

The recipe needs a helper to resolve the justfile directory. Add an internal helper:

```just
_justfile_dir := justfile_directory()
```

Actually, `just` provides `justfile_directory()` as a built-in function. The recipe should use it directly. Revised approach:

```just
# Install global 'ralph' command - run from anywhere after setup
install-cli:
    #!/usr/bin/env bash
    set -eu
    PLUGIN_DIR="{{justfile_directory()}}"
    CONFIG_DIR="$HOME/.config/ralph-hero"
    BIN_DIR="$HOME/.local/bin"
    mkdir -p "$CONFIG_DIR" "$BIN_DIR"
    ln -sf "$PLUGIN_DIR/justfile" "$CONFIG_DIR/justfile"
    cp "$PLUGIN_DIR/scripts/ralph-cli.sh" "$BIN_DIR/ralph"
    chmod +x "$BIN_DIR/ralph"
    echo "Installed: $BIN_DIR/ralph"
    echo "  Justfile: $CONFIG_DIR/justfile -> $PLUGIN_DIR/justfile"
    if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
        echo ""
        echo "WARNING: $BIN_DIR is not in your PATH."
        echo "Add to your shell profile (~/.bashrc or ~/.zshrc):"
        echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    fi
    echo ""
    echo "Usage: ralph <recipe> [args...]"
    echo "  ralph triage 42"
    echo "  ralph loop"
    echo "  ralph team 42"
```

#### 2. Add `uninstall-cli` recipe
**File**: `plugin/ralph-hero/justfile`
**Changes**: Add after `install-cli`:

```just
# Remove global 'ralph' command and config
uninstall-cli:
    #!/usr/bin/env bash
    set -eu
    CONFIG_DIR="$HOME/.config/ralph-hero"
    BIN_DIR="$HOME/.local/bin"
    removed=0
    if [ -f "$BIN_DIR/ralph" ]; then
        rm "$BIN_DIR/ralph"
        echo "Removed: $BIN_DIR/ralph"
        removed=1
    fi
    if [ -L "$CONFIG_DIR/justfile" ]; then
        rm "$CONFIG_DIR/justfile"
        echo "Removed: $CONFIG_DIR/justfile"
        removed=1
    fi
    if [ -d "$CONFIG_DIR" ] && [ -z "$(ls -A "$CONFIG_DIR")" ]; then
        rmdir "$CONFIG_DIR"
        echo "Removed: $CONFIG_DIR/"
    fi
    if [ "$removed" -eq 0 ]; then
        echo "Nothing to uninstall -- ralph CLI was not installed."
    else
        echo "Ralph CLI uninstalled."
    fi
```

### Success Criteria
- [ ] Automated: `just --justfile plugin/ralph-hero/justfile --dry-run install-cli` (recipe parses)
- [ ] Automated: `just --justfile plugin/ralph-hero/justfile --dry-run uninstall-cli` (recipe parses)
- [ ] Manual: `just install-cli` creates symlink and copies script
- [ ] Manual: `just uninstall-cli` removes everything cleanly
- [ ] Manual: Running `install-cli` twice works without errors (idempotent)

**Creates for next phase**: Working `install-cli`/`uninstall-cli` commands for documentation.

---

## Phase 3: Update CLI documentation (GH-283)
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/283 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0279-global-cli-access-shell-shortcut.md | **Depends on**: Phase 2

### Changes Required

#### 1. Add "Global Access" section to CLI docs
**File**: `plugin/ralph-hero/docs/cli.md`
**Changes**: Add a new "Global Access" section after "Quick Start" (after line 34, before "Recipes"):

```markdown
## Global Access

Install the `ralph` command for use from any directory:

```bash
cd plugin/ralph-hero
just install-cli
```

Then use Ralph from anywhere:

```bash
ralph triage 42
ralph loop
ralph team 42
ralph status
```

To remove:

```bash
just uninstall-cli
```

### How It Works

The installer:
1. Symlinks the justfile to `~/.config/ralph-hero/justfile`
2. Copies a wrapper script to `~/.local/bin/ralph`
3. The wrapper delegates to `just --justfile` so all recipes work normally

Override the justfile location with `RALPH_JUSTFILE`:

```bash
export RALPH_JUSTFILE="/custom/path/to/justfile"
```
```

#### 2. Update "Overriding from Project Root" section
**File**: `plugin/ralph-hero/docs/cli.md`
**Changes**: Replace the existing section at lines 132-145 to reference the global approach:

```markdown
## Overriding from Project Root

For one-off use from the repository root:

```bash
just --justfile plugin/ralph-hero/justfile triage 42
```

For persistent global access, use `just install-cli` instead (see [Global Access](#global-access) above).
```

#### 3. Add `RALPH_JUSTFILE` to environment variables table
**File**: `plugin/ralph-hero/docs/cli.md`
**Changes**: Add row to the environment variables table (after line 155):

| Variable | Description |
|----------|-------------|
| `RALPH_JUSTFILE` | Override justfile path for global `ralph` command (default: `~/.config/ralph-hero/justfile`) |

### Success Criteria
- [ ] Manual: `docs/cli.md` has "Global Access" section with install/uninstall instructions
- [ ] Manual: `RALPH_JUSTFILE` is documented in the environment variables table
- [ ] Manual: Old alias workaround is replaced with reference to global access

**Creates for next phase**: Documentation that Phase 4 completions section will extend.

---

## Phase 4: Add shell completions for global `ralph` command (GH-284)
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/284 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0279-global-cli-access-shell-shortcut.md | **Depends on**: Phase 1

### Changes Required

#### 1. Create bash completion script
**File**: `plugin/ralph-hero/scripts/ralph-completions.bash` (new)
**Changes**:
```bash
# Bash completions for the global 'ralph' command
# Source this file or add to ~/.bashrc:
#   source <path>/ralph-completions.bash

_ralph_completions() {
    local justfile="${RALPH_JUSTFILE:-$HOME/.config/ralph-hero/justfile}"
    if [ ! -f "$justfile" ]; then
        return
    fi
    COMPREPLY=($(compgen -W "$(just --justfile "$justfile" --summary 2>/dev/null)" -- "${COMP_WORDS[COMP_CWORD]}"))
}
complete -F _ralph_completions ralph
```

#### 2. Create zsh completion script
**File**: `plugin/ralph-hero/scripts/ralph-completions.zsh` (new)
**Changes**:
```zsh
# Zsh completions for the global 'ralph' command
# Source this file or add to ~/.zshrc:
#   source <path>/ralph-completions.zsh

_ralph_completions() {
    local justfile="${RALPH_JUSTFILE:-$HOME/.config/ralph-hero/justfile}"
    if [ ! -f "$justfile" ]; then
        return
    fi
    local recipes
    recipes=(${(f)"$(just --justfile "$justfile" --summary 2>/dev/null | tr ' ' '\n')"})
    compadd -a recipes
}
compdef _ralph_completions ralph
```

#### 3. Add `install-completions` recipe
**File**: `plugin/ralph-hero/justfile`
**Changes**: Add after `uninstall-cli`:

```just
# Install shell completions for the global 'ralph' command
install-completions shell="bash":
    #!/usr/bin/env bash
    set -eu
    PLUGIN_DIR="{{justfile_directory()}}"
    case "{{shell}}" in
        bash)
            COMP_DIR="$HOME/.local/share/bash-completion/completions"
            mkdir -p "$COMP_DIR"
            cp "$PLUGIN_DIR/scripts/ralph-completions.bash" "$COMP_DIR/ralph"
            echo "Installed bash completions: $COMP_DIR/ralph"
            echo "Restart your shell or run: source $COMP_DIR/ralph"
            ;;
        zsh)
            COMP_DIR="$HOME/.local/share/zsh/site-functions"
            mkdir -p "$COMP_DIR"
            cp "$PLUGIN_DIR/scripts/ralph-completions.zsh" "$COMP_DIR/_ralph"
            echo "Installed zsh completions: $COMP_DIR/_ralph"
            echo "Restart your shell or run: source $COMP_DIR/_ralph"
            ;;
        *)
            echo "Unsupported shell: {{shell}}. Use 'bash' or 'zsh'."
            exit 1
            ;;
    esac
```

#### 4. Update `install-cli` to mention completions
**File**: `plugin/ralph-hero/justfile`
**Changes**: Add a line at the end of the `install-cli` recipe output:

```
echo "For tab completions: just install-completions bash  (or zsh)"
```

#### 5. Update documentation with completion instructions
**File**: `plugin/ralph-hero/docs/cli.md`
**Changes**: Update the "Tab Completion" section (lines 99-130) to add `ralph` command completions alongside existing `just` completions:

Add after the existing completions content:

```markdown
### Global `ralph` Command

After installing the global CLI (`just install-cli`), install completions for the `ralph` command:

```bash
just install-completions bash   # For bash
just install-completions zsh    # For zsh
```

Or source directly:

```bash
# Bash - add to ~/.bashrc:
source plugin/ralph-hero/scripts/ralph-completions.bash

# Zsh - add to ~/.zshrc:
source plugin/ralph-hero/scripts/ralph-completions.zsh
```
```

### Success Criteria
- [ ] Automated: `bash -n plugin/ralph-hero/scripts/ralph-completions.bash` (syntax check)
- [ ] Automated: `just --justfile plugin/ralph-hero/justfile --dry-run install-completions` (recipe parses)
- [ ] Manual: `ralph <TAB>` completes recipe names in bash after sourcing
- [ ] Manual: `ralph <TAB>` completes recipe names in zsh after sourcing

---

## Integration Testing

- [ ] Full workflow: `just install-cli` then `ralph triage 42` from home directory
- [ ] Full workflow: `just install-completions bash` then `ralph <TAB>` shows recipes
- [ ] Uninstall: `just uninstall-cli` removes command, `ralph` no longer resolves
- [ ] Idempotency: Run `just install-cli` twice without errors
- [ ] Error case: Uninstall first, then `ralph` shows helpful error message
- [ ] ENV override: `RALPH_JUSTFILE=/dev/null ralph` shows error (justfile not valid)

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0279-global-cli-access-shell-shortcut.md
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/279
- Related: `just --justfile` docs: https://just.systems/man/en/chapter_55.html
