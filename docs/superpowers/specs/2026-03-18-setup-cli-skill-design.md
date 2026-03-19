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

Check that `<plugin-dir>/scripts/ralph-cli.sh` exists. If not, hard stop with the exact path that was checked and a reinstall suggestion.

**Step 2 — Install binary**

```bash
mkdir -p ~/.local/bin
cp <plugin-dir>/scripts/ralph-cli.sh ~/.local/bin/ralph
chmod +x ~/.local/bin/ralph
```

Auto-creates `~/.local/bin` if it doesn't exist. No confirmation prompt — this is the core action.

**Step 3 — Detect shell and install completions**

Read `$SHELL`. For each supported shell, copy the completions file to `~/.local/share/ralph/` (a dedicated stable directory) and print the `source` line the user needs to add to their shell RC file. The completions files are designed for sourcing (per their own headers); this avoids fpath and bash-completion-v2 setup complexity entirely.

| Shell | Source file | Destination | RC file instruction |
|-------|-------------|-------------|---------------------|
| zsh | `scripts/ralph-completions.zsh` | `~/.local/share/ralph/ralph-completions.zsh` | `source ~/.local/share/ralph/ralph-completions.zsh` → `~/.zshrc` |
| bash | `scripts/ralph-completions.bash` | `~/.local/share/ralph/ralph-completions.bash` | `source ~/.local/share/ralph/ralph-completions.bash` → `~/.bashrc` |
| other | (skip) | — | Print: only bash/zsh completions available |

Check that the completions source file exists in the plugin dir before copying. If missing: warn and skip completions, continue.

Auto-create `~/.local/share/ralph/` if it doesn't exist.

Always print the `source` line as an explicit instruction — do NOT add it to the RC file automatically.

**Step 4 — PATH check**

Check if `~/.local/bin` is in `$PATH`. If not, print the exact line to add — do NOT modify shell profile automatically:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Print the appropriate RC file name based on the shell detected in Step 3 (`~/.zshrc` for zsh, `~/.bashrc` for bash).

**Step 5 — just check**

Check if `just` is installed via `command -v just`. If missing, print a **warning** (not a hard stop):

```
Warning: 'just' is not installed. The 'ralph' binary is installed, but it
won't work until just is available at runtime.
Install: brew install just  (or see https://just.systems)
```

**Step 6 — Summary and next steps**

Print a clean summary of what succeeded and what was warned, then print shell-specific instructions using the shell detected in Step 3:

For zsh:
```
Done! Ralph CLI installed.

Next steps:
1. Add to ~/.zshrc, then restart your shell (or run: source ~/.zshrc):
   export PATH="$HOME/.local/bin:$PATH"          # if PATH warning shown
   source ~/.local/share/ralph/ralph-completions.zsh
2. Verify: ralph doctor
3. Set up your GitHub project: /ralph-hero:setup
```

For bash:
```
Done! Ralph CLI installed.

Next steps:
1. Add to ~/.bashrc, then restart your shell (or run: source ~/.bashrc):
   export PATH="$HOME/.local/bin:$PATH"          # if PATH warning shown
   source ~/.local/share/ralph/ralph-completions.bash
2. Verify: ralph doctor
3. Set up your GitHub project: /ralph-hero:setup
```

Items that are already satisfied (PATH already set, completions skipped, etc.) are omitted from the next steps.

### Error handling summary

| Situation | Action |
|-----------|--------|
| Plugin cache dir missing | Hard stop + install instruction |
| `scripts/ralph-cli.sh` not found in plugin dir | Hard stop + exact path shown + reinstall suggestion |
| `~/.local/bin` missing | Auto-create, continue |
| Completions source file missing from plugin dir | Warn and skip completions, continue |
| `~/.local/share/ralph/` missing | Auto-create, continue |
| Unknown shell | Skip completions with a note, continue |
| `~/.local/bin` not in PATH | Print export line + RC file name, do NOT edit profile |
| `just` not installed | Warning only, continue |

**Principle:** only hard-stop when the binary itself cannot be installed. Everything else is a warning or auto-fix.

---

## Change to `/ralph-hero:setup`

At the end of **all four** Next steps blocks in Step 7 of `skills/setup/SKILL.md` (simple setup with routing enabled, simple setup with routing skipped, split-owner with routing enabled, split-owner with routing skipped), add one line:

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
- Does not use fpath or bash-completion-v2 infrastructure

---

## File layout

```
plugin/ralph-hero/skills/setup-cli/
└── SKILL.md          # new skill definition
plugin/ralph-hero/skills/setup/
└── SKILL.md          # existing skill, +1 tip line in all four Step 7 variants
```
