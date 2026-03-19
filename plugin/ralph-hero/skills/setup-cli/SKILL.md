---
description: Install the global 'ralph' CLI command and shell completions. Run this once after installing the ralph-hero plugin to make 'ralph' available from anywhere in your terminal.
argument-hint: ""
context: fork
model: haiku
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=setup-cli"
allowed-tools:
  - Bash
---

# Install Ralph CLI

Install the global `ralph` command and shell completions from the installed ralph-hero plugin.

## Step 1: Locate plugin

Run:

```bash
LATEST=$(ls "$HOME/.claude/plugins/cache/ralph-hero/ralph-hero/" 2>/dev/null | sort -V | tail -1)
if [ -z "$LATEST" ]; then
  echo "Error: ralph-hero plugin not found."
  echo "Install it first: claude plugin install https://github.com/cdubiel08/ralph-hero"
  exit 1
fi
PLUGIN_DIR="$HOME/.claude/plugins/cache/ralph-hero/ralph-hero/$LATEST"
if [ ! -f "$PLUGIN_DIR/scripts/ralph-cli.sh" ]; then
  echo "Error: ralph-cli.sh not found at $PLUGIN_DIR/scripts/ralph-cli.sh"
  echo "Try reinstalling: claude plugin install https://github.com/cdubiel08/ralph-hero"
  exit 1
fi
echo "Plugin found: $PLUGIN_DIR"
```

## Step 2: Install binary

Run:

```bash
LATEST=$(ls "$HOME/.claude/plugins/cache/ralph-hero/ralph-hero/" 2>/dev/null | sort -V | tail -1)
PLUGIN_DIR="$HOME/.claude/plugins/cache/ralph-hero/ralph-hero/$LATEST"
mkdir -p "$HOME/.local/bin"
cp "$PLUGIN_DIR/scripts/ralph-cli.sh" "$HOME/.local/bin/ralph"
chmod +x "$HOME/.local/bin/ralph"
```

Print: `Installed: ~/.local/bin/ralph`

## Step 3: Detect shell and install completions

Detect shell: `basename "$SHELL"`

**For zsh**, run this self-contained block:

```bash
LATEST=$(ls "$HOME/.claude/plugins/cache/ralph-hero/ralph-hero/" 2>/dev/null | sort -V | tail -1)
PLUGIN_DIR="$HOME/.claude/plugins/cache/ralph-hero/ralph-hero/$LATEST"
if [ -f "$PLUGIN_DIR/scripts/ralph-completions.zsh" ]; then
  mkdir -p "$HOME/.local/share/ralph"
  cp "$PLUGIN_DIR/scripts/ralph-completions.zsh" "$HOME/.local/share/ralph/ralph-completions.zsh"
  echo "Installed: ~/.local/share/ralph/ralph-completions.zsh"
else
  echo "Warning: ralph-completions.zsh not found in plugin — skipping completions."
fi
```

**For bash**, run this self-contained block:

```bash
LATEST=$(ls "$HOME/.claude/plugins/cache/ralph-hero/ralph-hero/" 2>/dev/null | sort -V | tail -1)
PLUGIN_DIR="$HOME/.claude/plugins/cache/ralph-hero/ralph-hero/$LATEST"
if [ -f "$PLUGIN_DIR/scripts/ralph-completions.bash" ]; then
  mkdir -p "$HOME/.local/share/ralph"
  cp "$PLUGIN_DIR/scripts/ralph-completions.bash" "$HOME/.local/share/ralph/ralph-completions.bash"
  echo "Installed: ~/.local/share/ralph/ralph-completions.bash"
else
  echo "Warning: ralph-completions.bash not found in plugin — skipping completions."
fi
```

**For any other shell:** no bash block to run. Print: `Note: only bash/zsh completions are available — skipping completions.`

## Step 4: Check PATH

Run:

```bash
echo "$PATH" | tr ':' '\n' | grep -qx "$HOME/.local/bin" && echo "in_path" || echo "not_in_path"
```

Record the result as `PATH_OK` (true/false) for use in Step 6.

## Step 5: Check just

Run:

```bash
command -v just >/dev/null 2>&1 && echo "just_ok" || echo "just_missing"
```

Record the result as `JUST_OK` (true/false) for use in Step 6.

## Step 6: Print summary

Print what was done and the next steps, tailored to the detected shell and what warnings were triggered.

**For zsh**, print (omit the PATH line if `PATH_OK` is true, omit the `source` completions line if completions were not installed in Step 3):

```
Done! Ralph CLI installed.

Next steps:
1. Add to ~/.zshrc, then restart your shell (or run: source ~/.zshrc):
   export PATH="$HOME/.local/bin:$PATH"           # omit if PATH_OK
   source ~/.local/share/ralph/ralph-completions.zsh  # omit if completions skipped in Step 3

2. Verify: ralph doctor

3. Set up your GitHub project: /ralph-hero:setup

Warning: 'just' is not installed — ralph won't work until it is.  # omit if JUST_OK
Install: brew install just  (or see https://just.systems)          # omit if JUST_OK
```

**For bash**, print (omit the PATH line if `PATH_OK` is true, omit the `source` completions line if completions were not installed in Step 3):

```
Done! Ralph CLI installed.

Next steps:
1. Add to ~/.bashrc, then restart your shell (or run: source ~/.bashrc):
   export PATH="$HOME/.local/bin:$PATH"           # omit if PATH_OK
   source ~/.local/share/ralph/ralph-completions.bash  # omit if completions skipped in Step 3

2. Verify: ralph doctor

3. Set up your GitHub project: /ralph-hero:setup

Warning: 'just' is not installed — ralph won't work until it is.  # omit if JUST_OK
Install: brew install just  (or see https://just.systems)          # omit if JUST_OK
```

**For other shells**, Step 3 skipped completions entirely. Print the summary without any `source` completions line and without any RC file instruction — only the PATH export line (omit if `PATH_OK` is true), the verify step, the setup step, and the `just` warning (omit if `JUST_OK` is true).
