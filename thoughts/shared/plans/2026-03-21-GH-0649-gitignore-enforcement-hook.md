---
date: 2026-03-21
status: draft
type: plan
github_issue: 649
github_issues: [649]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/649
primary_issue: 649
tags: [security, gitignore, hooks, secrets, defense-in-depth]
---

# Gitignore Enforcement Hook for Local-Only Files - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-21-secret-protection-gitignore-enforcement]]

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-649 | Add gitignore enforcement hook for local-only files | S |

## Shared Constraints

- **Hook contract**: All hooks source `hook-utils.sh` and use `block()`, `warn()`, `allow()` exit helpers. Exit code 2 blocks, exit code 0 allows.
- **PostToolUse hooks cannot block execution** in Claude Code -- they inject advisory context via `hookSpecificOutput.additionalContext`. Only PreToolUse hooks can block (exit 2). The issue says "PostToolUse" but the acceptance criteria say "blocks with a message". We will use a **PreToolUse** hook on `Write` so we can actually block the write before it happens. A PostToolUse hook would only warn after the file already exists on disk.
- **Hook registration**: Plugin-level hooks go in `hooks.json`. Skill-level hooks go in SKILL.md frontmatter. Since this hook protects against accidental writes in ANY context (not just a specific skill), it must be registered in `hooks.json` at the plugin level.
- **JSON input structure for Write PreToolUse**: `{ "tool_name": "Write", "tool_input": { "file_path": "/absolute/path/to/file", "content": "..." } }`. The `file_path` is always absolute.
- **`git check-ignore` behavior**: `git check-ignore -q <path>` returns exit code 0 if ignored, 1 if not ignored, 128 if not in a git repo. Must be run from within the repo root.
- **Existing PreToolUse Write hook**: `pre-artifact-validator.sh` is already registered on PreToolUse Write in `hooks.json`. The new hook will be added alongside it as a second entry in the same matcher block.
- **No external dependencies**: The hook uses only bash, jq (already required by all hooks), and git (always available in the project context).

## Current State Analysis

The research document identifies three passive gitignore layers with zero enforcement:

1. Claude Code global gitignore (`~/.config/git/ignore`) covers `**/.claude/settings.local.json` but is machine-local -- absent on fresh clones or non-Claude-Code machines.
2. Plugin `.gitignore` (`plugin/ralph-hero/.gitignore`) has `*.local.md` but is scoped to the `plugin/ralph-hero/` subtree only -- does not cover `.claude/ralph-hero.local.md` at the project root.
3. Root `.gitignore` has no entries for `.claude/`, `*.local.md`, `*.local.json`, or `.env`.

PATs have been committed to git history twice due to this gap.

## Desired End State

### Verification
- [ ] When Claude writes `.claude/ralph-hero.local.md` in a repo where it is not gitignored, the Write is blocked with an actionable error message
- [ ] When Claude writes `.claude/settings.local.json` in a repo where it is not gitignored, the Write is blocked with an actionable error message
- [ ] When Claude writes any `*.local.md` or `*.local.json` file that is not gitignored, the Write is blocked
- [ ] Root `.gitignore` includes defense-in-depth entries for `*.local.md` and `.claude/settings.local.json`
- [ ] The hook passes `bash -n` syntax validation
- [ ] Existing hooks continue to function (no regressions in `hooks.json`)

## What We're NOT Doing

- Not adding `gitleaks`, `detect-secrets`, `trufflehog`, or any external secret scanning tool -- that is a separate, heavier initiative
- Not adding git pre-commit hooks (`.git/hooks/pre-commit`) -- those require per-developer installation and are outside the Claude Code plugin hook model
- Not modifying the setup skill to auto-append gitignore entries -- that would be a good follow-up but is a different change surface
- Not scanning staged file content for token patterns -- content inspection is a separate concern from path-based gitignore enforcement
- Not adding `.env` patterns to `.gitignore` -- the codebase does not use `.env` files currently

## Implementation Approach

The implementation has three parts executed in a single phase:

1. **Root `.gitignore` update** -- Add defense-in-depth entries so that even without the hook, the most common sensitive file patterns are covered in this repo.
2. **Hook script** -- A PreToolUse hook on `Write` that checks if the target file matches known local-only patterns and verifies it is gitignored via `git check-ignore`. If not ignored, block with an actionable message telling the agent to add the file to `.gitignore` first.
3. **Hook registration** -- Add the new hook to `hooks.json` under the existing PreToolUse Write matcher.

---

## Phase 1: Gitignore Enforcement Hook (GH-649)

### Overview

Create a PreToolUse Write hook that blocks creation of local-only files when they are not covered by `.gitignore`, and add defense-in-depth entries to the root `.gitignore`.

### Tasks

#### Task 1.1: Add defense-in-depth entries to root .gitignore
- **files**: [`.gitignore`](https://github.com/cdubiel08/ralph-hero/blob/main/.gitignore) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `.gitignore` at repo root contains the entry `*.local.md`
  - [ ] `.gitignore` at repo root contains the entry `*.local.json`
  - [ ] `.gitignore` at repo root contains the entry `.env` and `.env.*`
  - [ ] Entries are grouped under a comment block: `# Local-only files (secrets, tokens, config)`
  - [ ] Existing entries in `.gitignore` are preserved and unchanged
  - [ ] Running `git check-ignore .claude/ralph-hero.local.md` returns exit 0
  - [ ] Running `git check-ignore .claude/settings.local.json` returns exit 0

#### Task 1.2: Create the gitignore enforcement hook script
- **files**: [`plugin/ralph-hero/hooks/scripts/gitignore-enforcement.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/gitignore-enforcement.sh) (create), [`plugin/ralph-hero/hooks/scripts/hook-utils.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/hook-utils.sh) (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/hooks/scripts/gitignore-enforcement.sh`
  - [ ] File is executable (`chmod +x`)
  - [ ] Script sources `hook-utils.sh` using the standard `SCRIPT_DIR` pattern: `source "$(dirname "$0")/hook-utils.sh"`
  - [ ] Script reads JSON input via `read_input > /dev/null`
  - [ ] Script extracts `file_path` from `.tool_input.file_path`
  - [ ] Script checks the file path against these patterns (using bash glob/case matching):
    - `*.local.md` (any file ending in `.local.md`)
    - `*.local.json` (any file ending in `.local.json`)
    - `*/.env` or `*/.env.*` (any `.env` or `.env.*` file)
  - [ ] If the path does NOT match any pattern, the script calls `allow` and exits
  - [ ] If the path matches, the script runs `git check-ignore -q "$file_path"` from `CLAUDE_PROJECT_DIR`
  - [ ] If `git check-ignore` returns 0 (file IS ignored), the script calls `allow`
  - [ ] If `git check-ignore` returns non-zero (file is NOT ignored), the script calls `block` with a message that includes:
    - The file path being written
    - Why it was blocked (file matches local-only pattern but is not gitignored)
    - The specific `.gitignore` entry to add (e.g., `*.local.md` or the exact filename)
    - Instructions to add the entry to the project root `.gitignore` before retrying the write
  - [ ] `bash -n plugin/ralph-hero/hooks/scripts/gitignore-enforcement.sh` exits 0 (valid syntax)
  - [ ] Script follows the header comment convention: tool type, hook event, purpose, exit codes

#### Task 1.3: Register the hook in hooks.json
- **files**: [`plugin/ralph-hero/hooks/hooks.json`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/hooks.json) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] The existing PreToolUse Write matcher block at line 71-78 includes a second hook entry for the new script
  - [ ] The hook command path is `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/gitignore-enforcement.sh`
  - [ ] The new hook appears BEFORE `pre-artifact-validator.sh` in the hooks array (gitignore check should fire first since it is a security gate)
  - [ ] `hooks.json` remains valid JSON (parseable by `jq .`)
  - [ ] No other hook registrations are modified

### Phase Success Criteria

#### Automated Verification:
- [ ] `bash -n plugin/ralph-hero/hooks/scripts/gitignore-enforcement.sh` -- valid syntax
- [ ] `jq . plugin/ralph-hero/hooks/hooks.json > /dev/null` -- valid JSON
- [ ] `git check-ignore .claude/ralph-hero.local.md` -- returns exit 0 (covered by root .gitignore)
- [ ] `git check-ignore .claude/settings.local.json` -- returns exit 0 (covered by root .gitignore)

#### Manual Verification:
- [ ] In a test repo WITHOUT `*.local.md` in `.gitignore`, attempting to write `.claude/test.local.md` via Claude Code triggers the hook block message
- [ ] In THIS repo (with the updated `.gitignore`), writing `.claude/ralph-hero.local.md` is allowed because the file IS gitignored
- [ ] The hook does NOT fire for normal file writes (e.g., writing to `src/index.ts` or `thoughts/shared/research/foo.md`)

---

## Integration Testing
- [ ] Verify the new hook does not interfere with the existing `pre-artifact-validator.sh` Write hook (both should fire in sequence)
- [ ] Verify the `superpowers-bridge.sh` PostToolUse Write hook continues to function (different hook event, should be independent)
- [ ] Verify that `git check-ignore` works correctly from within worktree directories (the hook uses `CLAUDE_PROJECT_DIR` which is set by Claude Code)

## References
- Research: [thoughts/shared/research/2026-03-21-secret-protection-gitignore-enforcement.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-21-secret-protection-gitignore-enforcement.md)
- Issue: [GH-649](https://github.com/cdubiel08/ralph-hero/issues/649)
- Hook utils: [plugin/ralph-hero/hooks/scripts/hook-utils.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/hook-utils.sh)
- Hooks registry: [plugin/ralph-hero/hooks/hooks.json](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/hooks.json)
- Existing Write hook: [plugin/ralph-hero/hooks/scripts/pre-artifact-validator.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/pre-artifact-validator.sh)
- Staging gate (pattern reference): [plugin/ralph-hero/hooks/scripts/impl-staging-gate.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/impl-staging-gate.sh)
