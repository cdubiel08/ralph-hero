# CLI install — global `ralph` command + completions

> Consulted by `/ralph:setup --mode cli`. Step-by-step install with conditional summary.

## Step 1: Locate plugin

Try the slim cache first, fall back to legacy. The CLI binary + completion files live in `scripts/` of whichever resolves. Latest version wins:

```bash
# Try slim cache first
LATEST_SLIM=$(ls "$HOME/.claude/plugins/cache/ralph/ralph/" 2>/dev/null | sort -V | tail -1)
if [ -n "$LATEST_SLIM" ] && [ -f "$HOME/.claude/plugins/cache/ralph/ralph/$LATEST_SLIM/scripts/ralph-cli.sh" ]; then
  PLUGIN_DIR="$HOME/.claude/plugins/cache/ralph/ralph/$LATEST_SLIM"
else
  # Fall back to legacy ralph-hero cache (authoritative until Plan 10 sunset)
  LATEST_LEGACY=$(ls "$HOME/.claude/plugins/cache/ralph-hero/ralph-hero/" 2>/dev/null | sort -V | tail -1)
  if [ -z "$LATEST_LEGACY" ]; then
    echo "Error: neither ralph nor ralph-hero plugin cache found."
    echo "Install via: claude plugin install https://github.com/cdubiel08/ralph-hero"
    exit 1
  fi
  PLUGIN_DIR="$HOME/.claude/plugins/cache/ralph-hero/ralph-hero/$LATEST_LEGACY"
fi
echo "Plugin found: $PLUGIN_DIR"
```

If `scripts/ralph-cli.sh` is not present in the resolved dir, report the error and exit — the install is incomplete.

## Step 2: Install binary

```bash
mkdir -p "$HOME/.local/bin"
cp "$PLUGIN_DIR/scripts/ralph-cli.sh" "$HOME/.local/bin/ralph"
chmod +x "$HOME/.local/bin/ralph"
```

Print: `Installed: ~/.local/bin/ralph`

## Step 3: Detect shell + install completions

Detect via `basename "$SHELL"`. Install completions only for zsh and bash; skip for any other shell.

```bash
# zsh
cp "$PLUGIN_DIR/scripts/ralph-completions.zsh" "$HOME/.local/share/ralph/ralph-completions.zsh"
# bash
cp "$PLUGIN_DIR/scripts/ralph-completions.bash" "$HOME/.local/share/ralph/ralph-completions.bash"
```

Use `mkdir -p "$HOME/.local/share/ralph"` before copying. Skip the copy (with a warning) if the source file is not in the plugin.

## Step 4: Environment checks

Record these flags for the Step 5 summary:

```bash
echo "$PATH" | tr ':' '\n' | grep -qx "$HOME/.local/bin" && PATH_OK=true || PATH_OK=false
# zsh only
grep -q "compinit" "$HOME/.zshrc" 2>/dev/null && COMPINIT_OK=true || COMPINIT_OK=false
command -v just >/dev/null 2>&1 && JUST_OK=true || JUST_OK=false
```

## Step 5: Per-shell summary

Conditional content:

- Omit the `export PATH` line if `PATH_OK=true`.
- Omit the `autoload -Uz compinit` line if `COMPINIT_OK=true` (zsh only) or completions were skipped.
- Omit the `source <completions>` line if completions were skipped.
- Append the `just` warning if `JUST_OK=false`.

### zsh template

```
Done! Ralph CLI installed.

Next steps:
1. Add to ~/.zshrc, then restart your shell (or run: source ~/.zshrc):
   export PATH="$HOME/.local/bin:$PATH"               # omit if PATH_OK
   autoload -Uz compinit && compinit                   # omit if COMPINIT_OK or completions skipped
   source ~/.local/share/ralph/ralph-completions.zsh   # omit if completions skipped

2. Verify: ralph doctor
3. Set up your GitHub project: /ralph:setup

Warning: 'just' is not installed — ralph won't work until it is.  # omit if JUST_OK
Install: brew install just  (or see https://just.systems)
```

### bash template

```
Done! Ralph CLI installed.

Next steps:
1. Add to ~/.bashrc, then restart your shell (or run: source ~/.bashrc):
   export PATH="$HOME/.local/bin:$PATH"               # omit if PATH_OK
   source ~/.local/share/ralph/ralph-completions.bash  # omit if completions skipped

2. Verify: ralph doctor
3. Set up your GitHub project: /ralph:setup

Warning: 'just' is not installed — ralph won't work until it is.  # omit if JUST_OK
Install: brew install just  (or see https://just.systems)
```

### Other shells

Skip completions entirely. Print the PATH export (omit if `PATH_OK=true`), `ralph doctor`, `/ralph:setup`, and the optional `just` warning.
