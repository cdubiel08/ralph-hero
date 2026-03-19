# Design: `/ralph-hero:setup-cli` Skill

**Date:** 2026-03-18
**Status:** Approved
**Relates to:** `plugin/ralph-hero/skills/setup-cli/`, `plugin/ralph-hero/skills/setup/SKILL.md`

---

## Problem

Ralph Hero has a bootstrapping paradox: the global `ralph` CLI is installed via `just install-cli`, but that requires the user to already be in `plugin/ralph-hero/` — a directory most users won't know to navigate to. There is no discoverable entry point for first-time CLI setup, and no skill to guide users through it. Three failure modes compound this:

1. **Discovery** — users don't know which commands exist or what to run first
2. **Bootstrap** — `just install-cli` requires being in the plugin directory; no skill bridges this gap
3. **Working directory** — once `ralph` is installed it works from anywhere, but getting there requires knowing the paradox exists

## Solution

A new `/ralph-hero:setup-cli` skill that runs inside Claude Code (before `ralph` exists) and installs the global `ralph` binary by operating directly on the filesystem — no dependency on `just` being installed. Additionally, the existing `/ralph-hero:setup` skill gets a one-line tip pointing to `setup-cli` as a natural follow-up.

## Skill: `/ralph-hero:setup-cli`

### Metadata

```yaml
description: Install the global 'ralph' CLI command and shell completions. Run this once after installing the ralph-hero plugin to make 'ralph' available from anywhere in your terminal.
context: fork
model: haiku
allowed-tools:
  - Bash
```

### Behavior

The skill executes these steps using the `Bash` tool directly (no `just` invocation):

**Step 1 — Locate plugin**

Scan `~/.claude/plugins/cache/ralph-hero/ralph-hero/`, pick the latest version via `ls | sort -V | tail -1`. If the directory doesn't exist, hard stop:

```
Error: ralph-hero plugin not found.
Install it first: claude plugin install https://github.com/cdubiel08/ralph-hero
```

If `ralph-cli.sh` is not found inside the latest version dir, hard stop with the checked path + reinstall suggestion.

**Step 2 — Install binary**

```bash
mkdir -p ~/.local/bin
cp <plugin-dir>/scripts/ralph-cli.sh ~/.local/bin/ralph
chmod +x ~/.local/bin/ralph
```

Auto-creates `~/.local/bin` if it doesn't exist. No confirmation prompt — this is the core action.

**Step 3 — Detect shell and install completions**

Read `$SHELL`. Handle:

| Shell | Completions file | Destination |
|-------|-----------------|-------------|
| zsh | `ralph-completions.zsh` | `~/.local/share/zsh/site-functions/_ralph` |
| bash | `ralph-completions.bash` | `~/.local/share/bash-completion/completions/ralph` |
| other | (skip) | Print: only bash/zsh completions available |

Auto-create the destination directory if it doesn't exist.

**Step 4 — PATH check**

Check if `~/.local/bin` is in `$PATH`. If not, print the exact line to add — do NOT modify shell profile automatically:

For zsh (`~/.zshrc`):
```bash
export PATH="$HOME/.local/bin:$PATH"
```

For bash (`~/.bashrc` or `~/.bash_profile`):
```bash
export PATH="$HOME/.local/bin:$PATH"
```

**Step 5 — fpath check (zsh only)**

Check if `~/.local/share/zsh/site-functions` is in `$fpath`. If not, print:

```bash
# Add to ~/.zshrc:
fpath=(~/.local/share/zsh/site-functions $fpath)
autoload -U compinit && compinit
```

For bash, note that the system bash-completion setup typically sources from the installed directory automatically; if uncertain, print:

```bash
# Add to ~/.bashrc if completions don't work:
source ~/.local/share/bash-completion/completions/ralph
```

**Step 6 — just check**

Check if `just` is installed via `command -v just`. If missing, print a **warning** (not a hard stop):

```
Warning: 'just' is not installed. The 'ralph' binary is installed, but it
won't work until just is available at runtime.
Install: brew install just  (or see https://just.systems)
```

**Step 7 — Summary and next steps**

Print a clean summary of what succeeded and what was warned, then:

```
Done! Ralph CLI installed.

Next steps:
1. Restart your shell (or run: source ~/.zshrc)
2. Verify: ralph doctor
3. Set up your GitHub project: /ralph-hero:setup
```

### Error handling summary

| Situation | Action |
|-----------|--------|
| Plugin cache missing | Hard stop + install instruction |
| `ralph-cli.sh` not found | Hard stop + path shown + reinstall suggestion |
| `~/.local/bin` missing | Auto-create, continue |
| Completions dir missing | Auto-create, continue |
| Unknown shell | Skip completions, note it, continue |
| `~/.local/bin` not in PATH | Print export line, do NOT edit profile |
| `just` not installed | Warning only, continue |

**Principle:** only hard-stop when the binary itself cannot be installed. Everything else is a warning or auto-fix.

---

## Change to `/ralph-hero:setup`

At the end of the **Next steps** block in Step 7 of `skills/setup/SKILL.md`, add one line:

```
Tip: To use Ralph from your terminal, run /ralph-hero:setup-cli to install the global `ralph` command.
```

This appears as a non-blocking suggestion after the primary next steps — discoverable but not in the critical path.

---

## What this does NOT do

- Does not run `ralph doctor` automatically (prints instructions instead)
- Does not modify shell profile files automatically
- Does not chain into `/ralph-hero:setup`
- Does not require `just` to be installed at skill-run time
- Does not touch `.mcp.json` or env vars

---

## File layout

```
plugin/ralph-hero/skills/setup-cli/
└── SKILL.md          # new skill definition
plugin/ralph-hero/skills/setup/
└── SKILL.md          # existing skill, +1 tip line at end
```
