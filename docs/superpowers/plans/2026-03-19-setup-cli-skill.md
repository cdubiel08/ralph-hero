# setup-cli Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a `/ralph-hero:setup-cli` skill that installs the global `ralph` CLI binary and shell completions from inside Claude Code, solving the bootstrapping paradox where `just install-cli` requires already being in the plugin directory.

**Architecture:** A single new skill file (`setup-cli/SKILL.md`) that runs headless Bash commands directly — no MCP tools, no `just` dependency. The skill detects the plugin cache, copies `ralph-cli.sh` to `~/.local/bin/ralph`, copies the appropriate completions file, checks PATH and `just`, then prints shell-specific next steps. The existing `setup` skill gets a one-line tip added to all four of its Step 7 Next steps blocks.

**Tech Stack:** Bash (skill body), YAML frontmatter (skill metadata), no TypeScript or tests — validation is frontmatter parsing + path existence checks.

**Spec:** `docs/superpowers/specs/2026-03-18-setup-cli-skill-design.md`

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Create | `plugin/ralph-hero/skills/setup-cli/SKILL.md` | New skill definition |
| Modify | `plugin/ralph-hero/skills/setup/SKILL.md` | Add tip to 4× Step 7 Next steps blocks |

---

### Task 1: Create setup-cli skill directory and SKILL.md

**Files:**
- Create: `plugin/ralph-hero/skills/setup-cli/SKILL.md`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p plugin/ralph-hero/skills/setup-cli
```

- [ ] **Step 2: Write the full SKILL.md**

Create `plugin/ralph-hero/skills/setup-cli/SKILL.md` with this exact content:

```markdown
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
ls "$HOME/.claude/plugins/cache/ralph-hero/ralph-hero/" 2>/dev/null | sort -V | tail -1
```

- If the directory does not exist or produces no output, stop with:
  ```
  Error: ralph-hero plugin not found.
  Install it first: claude plugin install https://github.com/cdubiel08/ralph-hero
  ```
- Set `PLUGIN_DIR="$HOME/.claude/plugins/cache/ralph-hero/ralph-hero/<latest-version>"`
- Check that `$PLUGIN_DIR/scripts/ralph-cli.sh` exists. If not, stop with:
  ```
  Error: ralph-cli.sh not found at $PLUGIN_DIR/scripts/ralph-cli.sh
  Try reinstalling: claude plugin install https://github.com/cdubiel08/ralph-hero
  ```

## Step 2: Install binary

Run:

```bash
mkdir -p "$HOME/.local/bin"
cp "$PLUGIN_DIR/scripts/ralph-cli.sh" "$HOME/.local/bin/ralph"
chmod +x "$HOME/.local/bin/ralph"
```

Print: `Installed: ~/.local/bin/ralph`

## Step 3: Detect shell and install completions

Detect shell: `basename "$SHELL"`

**For zsh:**

Check if `$PLUGIN_DIR/scripts/ralph-completions.zsh` exists.

- If it exists:
  ```bash
  mkdir -p "$HOME/.local/share/ralph"
  cp "$PLUGIN_DIR/scripts/ralph-completions.zsh" "$HOME/.local/share/ralph/ralph-completions.zsh"
  ```
  Print: `Installed: ~/.local/share/ralph/ralph-completions.zsh`
- If it does not exist: print `Warning: ralph-completions.zsh not found in plugin — skipping completions.`

**For bash:**

Check if `$PLUGIN_DIR/scripts/ralph-completions.bash` exists.

- If it exists:
  ```bash
  mkdir -p "$HOME/.local/share/ralph"
  cp "$PLUGIN_DIR/scripts/ralph-completions.bash" "$HOME/.local/share/ralph/ralph-completions.bash"
  ```
  Print: `Installed: ~/.local/share/ralph/ralph-completions.bash`
- If it does not exist: print `Warning: ralph-completions.bash not found in plugin — skipping completions.`

**For any other shell:**

Print: `Note: only bash/zsh completions are available — skipping completions.`

## Step 3a: Check compinit (zsh only)

Only run this step if the shell is zsh AND completions were installed in Step 3.

Run:

```bash
grep -q "compinit" "$HOME/.zshrc" 2>/dev/null && echo "compinit_ok" || echo "compinit_missing"
```

Record the result as `COMPINIT_OK` (true/false) for use in Step 6. If the shell is not zsh or completions were skipped, treat `COMPINIT_OK` as true (no action needed).

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

**For zsh**, print (omit the PATH line if `PATH_OK` is true, omit the `autoload` and `source` lines if completions were not installed in Step 3, omit the `autoload` line if `COMPINIT_OK` is true, omit just warning if `JUST_OK` is true):

```
Done! Ralph CLI installed.

Next steps:
1. Add to ~/.zshrc, then restart your shell (or run: source ~/.zshrc):
   export PATH="$HOME/.local/bin:$PATH"           # omit if PATH_OK
   autoload -Uz compinit && compinit               # omit if COMPINIT_OK or completions skipped
   source ~/.local/share/ralph/ralph-completions.zsh

2. Verify: ralph doctor

3. Set up your GitHub project: /ralph-hero:setup

Warning: 'just' is not installed — ralph won't work until it is.
Install: brew install just  (or see https://just.systems)
```

**For bash**, print (same conditional omissions):

```
Done! Ralph CLI installed.

Next steps:
1. Add to ~/.bashrc, then restart your shell (or run: source ~/.bashrc):
   export PATH="$HOME/.local/bin:$PATH"           # omit if PATH_OK
   source ~/.local/share/ralph/ralph-completions.bash

2. Verify: ralph doctor

3. Set up your GitHub project: /ralph-hero:setup

Warning: 'just' is not installed — ralph won't work until it is.
Install: brew install just  (or see https://just.systems)
```

**For other shells**, substitute the appropriate RC file note or omit the completions line if it was skipped.
```

> **Note on nested code fences:** The SKILL.md above uses triple-backtick fences inside a triple-backtick block in this plan. When writing the actual file use the Write tool — do NOT try to write it as a heredoc in the shell. The inner fences in the skill body do not need escaping because the file is written directly, not via shell.

- [ ] **Step 3: Validate YAML frontmatter is parseable**

Run:

```bash
python3 -c "
import sys
try:
    import yaml
except ImportError:
    print('PyYAML not available, skipping')
    sys.exit(0)
content = open('plugin/ralph-hero/skills/setup-cli/SKILL.md').read()
front = content.split('---')[1]
yaml.safe_load(front)
print('YAML OK')
"
```

Expected: `YAML OK` (or `PyYAML not available, skipping` — either is fine).

- [ ] **Step 4: Verify referenced scripts exist in the plugin source**

```bash
ls plugin/ralph-hero/scripts/ralph-cli.sh \
   plugin/ralph-hero/scripts/ralph-completions.zsh \
   plugin/ralph-hero/scripts/ralph-completions.bash
```

Expected: all three files listed with no errors.

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/skills/setup-cli/SKILL.md
git commit -m "feat(skill): add setup-cli skill for ralph CLI bootstrap"
```

---

### Task 2: Add tip to setup/SKILL.md (all four Step 7 Next steps blocks)

**Files:**
- Modify: `plugin/ralph-hero/skills/setup/SKILL.md`

The four Next steps blocks end at these lines (with the tip appended inside the closing ` ``` ` of each block):

| Block | Location | Last item before tip |
|-------|----------|---------------------|
| Simple + routing enabled | ~line 537 | `5. Run /ralph-triage to start processing issues` |
| Simple + routing skipped | ~line 545 | `3. Run /ralph-triage to start processing issues` |
| Split-owner + routing enabled | ~line 605 | `5. Run /ralph-triage to start processing issues` |
| Split-owner + routing skipped | ~line 613 | `3. Run /ralph-triage to start processing issues` |

The tip line to add (inside the closing ` ``` `, after the last numbered item):

```
Tip: To use Ralph from your terminal, run /ralph-hero:setup-cli to install the global `ralph` command.
```

- [ ] **Step 1: Add tip to simple + routing enabled block**

In `plugin/ralph-hero/skills/setup/SKILL.md`, find the block:
```
5. Run /ralph-triage to start processing issues
```
(first occurrence, around line 537). Change it to:
```
5. Run /ralph-triage to start processing issues
Tip: To use Ralph from your terminal, run /ralph-hero:setup-cli to install the global `ralph` command.
```

- [ ] **Step 2: Add tip to simple + routing skipped block**

Find the block (around line 545):
```
3. Run /ralph-triage to start processing issues
```
(first occurrence after `use the original 3-item list`). Change it to:
```
3. Run /ralph-triage to start processing issues
Tip: To use Ralph from your terminal, run /ralph-hero:setup-cli to install the global `ralph` command.
```

- [ ] **Step 3: Add tip to split-owner + routing enabled block**

Find the block (around line 605, after `**If routing was enabled:**`):
```
5. Run /ralph-triage to start processing issues
```
(second occurrence of this line). Change it to:
```
5. Run /ralph-triage to start processing issues
Tip: To use Ralph from your terminal, run /ralph-hero:setup-cli to install the global `ralph` command.
```

- [ ] **Step 4: Add tip to split-owner + routing skipped block**

Find the block (around line 613, after `**If routing was skipped:**`):
```
3. Run /ralph-triage to start processing issues
```
(second occurrence of this line after the split-owner section). Change it to:
```
3. Run /ralph-triage to start processing issues
Tip: To use Ralph from your terminal, run /ralph-hero:setup-cli to install the global `ralph` command.
```

- [ ] **Step 5: Verify exactly 4 tip lines were added**

```bash
grep -c "setup-cli to install the global" plugin/ralph-hero/skills/setup/SKILL.md
```

Expected: `4`

- [ ] **Step 6: Commit**

```bash
git add plugin/ralph-hero/skills/setup/SKILL.md
git commit -m "feat(skill): add setup-cli tip to setup skill next steps"
```

---

### Task 3: Manual smoke test checklist

This task has no automated test — it's a verification checklist to run manually after implementation.

- [ ] **Step 1: Confirm skill appears in Claude Code**

Open Claude Code in this project. Run:

```
/ralph-hero:setup-cli
```

Expected: skill loads and begins executing (asks for nothing — it's `context: fork` and runs headlessly).

- [ ] **Step 2: Verify binary installed**

After running the skill:

```bash
ls -la ~/.local/bin/ralph
```

Expected: file exists, is executable.

- [ ] **Step 3: Verify completions installed**

```bash
ls -la ~/.local/share/ralph/
```

Expected: appropriate completions file (`ralph-completions.zsh` or `ralph-completions.bash`) present.

- [ ] **Step 4: Verify ralph runs**

```bash
~/.local/bin/ralph --version
```

Expected: `ralph version X.Y.Z`

- [ ] **Step 5: Verify tip appears in setup skill**

In Claude Code, run `/ralph-hero:setup`. Proceed to the final report. Confirm the tip line appears in the Next steps section.

- [ ] **Step 6: Commit any fixups found during smoke test**

```bash
git add -p
git commit -m "fix(skill): setup-cli smoke test fixups"
```

Only needed if issues were found.

---

### Task 4: Evaluate skill efficacy with skill-creator

Run the skill-creator evaluator on the completed skill to measure quality and identify gaps.

- [ ] **Step 1: Run skill-creator eval**

In Claude Code, invoke:

```
/skill-creator eval setup-cli
```

Expected: skill-creator runs the skill against representative scenarios, scores output quality, and reports any cases where the skill mishandles edge cases (e.g., other shells, missing completions, existing compinit in .zshrc, PATH already set).

- [ ] **Step 2: Address any failures**

For each failure or low-score scenario reported:
- Edit `plugin/ralph-hero/skills/setup-cli/SKILL.md` to fix the issue
- Re-run the eval to confirm the fix

- [ ] **Step 3: Commit eval fixes (if any)**

```bash
git add plugin/ralph-hero/skills/setup-cli/SKILL.md
git commit -m "fix(skill): setup-cli eval-driven improvements"
```

Only needed if step 2 produced changes.
