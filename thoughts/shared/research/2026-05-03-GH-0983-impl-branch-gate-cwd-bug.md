---
date: 2026-05-03
github_issue: 983
github_url: https://github.com/cdubiel08/ralph-hero/issues/983
status: complete
type: research
tags: [hooks, impl-branch-gate, worktree, git, false-positive]
---

# GH-983: impl-branch-gate reads git branch from hook cwd instead of worktree

## Prior Work

- builds_on:: [[2026-02-17-GH-0046-builder-worker-agent]] (research — primary evidence; documents impl-branch-gate role in the gate suite)
- builds_on:: [[2026-02-20-GH-0203-worktree-scripts-plugin]] (research — describes worktree lifecycle, lists impl-branch-gate in hook table)
- builds_on:: [[2026-04-04-GH-0732-hero-skill-dispatch-migration]] (plan — describes RALPH_COMMAND=impl and agent_type dispatch paths for impl-branch-gate)
- builds_on:: [[2026-03-01-GH-0465-stacked-branch-strategy]] (research — notes impl-branch-gate may need updating for feature branch variants; corroborates known gap)

## Problem Statement

`impl-branch-gate.sh` is a PreToolUse hook that blocks `git commit`, `git push`, and `git add` commands when the current git branch is `main` or `master`. Its intent is to prevent impl-agents from accidentally committing to the main branch.

The bug: line 41 runs `git branch --show-current` with no directory argument, so it queries the branch from wherever the hook process starts — which is the harness cwd (`$CLAUDE_PROJECT_DIR`, the main repo root). When the agent issues a command like `cd worktrees/GH-983 && git commit -m "..."`, the hook fires from the main repo context, reports `main`, and blocks a perfectly valid commit on a feature branch.

This causes false-positive blocks on every standard impl-agent commit workflow. Agents have had to work around it manually.

## Current State Analysis

### Hook invocation paths

`impl-branch-gate.sh` is reached via two paths:

1. **Skill context** (`ralph-impl`): Registered in `skills/ralph-impl/SKILL.md` frontmatter at `PreToolUse[Bash]`. The skill's SessionStart hook sets `RALPH_COMMAND=impl`.

2. **Agent context** (`impl-agent`): Dispatched by `agent-phase-gate.sh` line 31 when `agent_type == "impl-agent"` and `tool_name == "Bash"`. This path does NOT set `RALPH_COMMAND`; the check at line 18-23 of `impl-branch-gate.sh` falls through to the `agent_type` check.

In both paths, the hook process cwd is the harness root, not the worktree. The hook has no awareness of where the command will actually execute.

### The broken line

`plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh:41`:

```bash
current_branch=$(git branch --show-current 2>/dev/null || echo "unknown")
```

This always reads the branch of the process's cwd — the main repo — not the directory the agent's command will run in.

### Correct patterns already in the codebase

Three other scripts demonstrate the correct approach:

- `hook-utils.sh:75` (`check_branch` function): `cd "$(get_project_root)" && git branch --show-current` — explicit cd before query.
- `pre-worktree-validator.sh:53`: `cd "$WORKTREE_PATH" && git branch --show-current` — cd into the worktree before querying.
- `prune-merged-worktrees.sh:32`: `cd "$wt_path" && git branch --show-current` — same pattern.

None of these parse the command string to infer the target directory, but they all demonstrate that an explicit `cd` is required.

### RALPH_WORKTREE_PATHS availability

`impl-worktree-gate.sh` (lines 40-46) already consumes `RALPH_WORKTREE_PATHS` — a colon-separated list of absolute worktree paths set by the impl skill for multi-repo scenarios. The ralph-impl skill SKILL.md (line 258-261) documents how callers set this env var. `impl-branch-gate.sh` does not currently reference it at all.

### Hook input available

The hook receives `tool_input.command` from stdin (read via `hook-utils.sh::read_input()`). The command is already extracted at line 25:

```bash
command=$(get_field '.tool_input.command')
```

This value is the exact Bash command string the agent submitted, e.g. `cd worktrees/GH-983 && git commit -m "feat: ..."`.

## Key Discoveries

### Discovery 1: Leading `cd <path>` is the standard agent pattern

Reviewing the ralph-impl SKILL.md (lines 363-372), every multi-step git commit block uses the pattern:

```bash
cd ~/projects/ralph-hero/worktrees/GH-601
git add path/to/file.ts
git commit -m "..."
git push -u origin feature/GH-601
```

The `&&`-chained form is also common: `cd worktrees/GH-983 && git commit -m "..."`. Parsing the leading `cd <path>` from `tool_input.command` is both reliable and directly mirrors what the agent actually runs.

### Discovery 2: `git -C <path>` is the correct non-cd approach

`git -C <directory>` runs git as if it were started in `<directory>`. This is more robust than `cd && git` because it does not change the shell's working directory or affect subsequent commands in the same script. Pattern: `git -C "$target_dir" branch --show-current`.

### Discovery 3: Compound command parsing is bounded

The leading `cd` parse only needs to handle the first segment of a `&&`-chained command. A regex like `^[[:space:]]*cd[[:space:]]+([^&;[:space:]]+)` or using `sed`/`awk` to extract the path argument from the first `cd` is sufficient. Edge cases:

- Tilde paths (`cd ~/projects/...`): need `eval echo` or `${HOME}` substitution to expand.
- Relative paths (`cd worktrees/GH-983`): need to be resolved against `CLAUDE_PROJECT_DIR`.
- No leading `cd`: fall through to RALPH_WORKTREE_PATHS scan.
- `cd` with quotes: uncommon in hook input but should be handled.

### Discovery 4: RALPH_WORKTREE_PATHS as fallback is robust

If no `cd` prefix is found but `RALPH_WORKTREE_PATHS` is set, the hook can check whether any worktree path appears as a substring in the command. If found, derive the branch from that worktree path using `git -C "$wt_path" branch --show-current`. This covers the case where an agent runs `git commit` from inside a worktree without an explicit `cd` in the command string (e.g., if the agent's cwd is already the worktree).

### Discovery 5: Final fallback should warn, not block

The current behavior (block on `main`) is the right safety default for production, but causes false positives when branch detection fails. A warn-then-allow fallback on detection failure is safer: it logs the ambiguity without breaking valid workflows. This matches the `warn()` utility already in `hook-utils.sh:61`.

## Potential Approaches

### Option A: Parse `cd` prefix only

**What**: Extract leading `cd <path>` from `tool_input.command`, resolve to absolute path, run `git -C <path> branch --show-current`.

**Pros**: Directly mirrors agent behavior. No env var dependency.

**Cons**: Fragile for edge cases (nested quotes, `$(...)` path substitution). Only handles commands with an explicit `cd`.

**Risk**: Low — the agent pattern is highly consistent per SKILL.md.

### Option B: RALPH_WORKTREE_PATHS scan only

**What**: Drop `cd` parsing. If the command string contains any active worktree path (from `RALPH_WORKTREE_PATHS`), allow it. Otherwise check branch.

**Pros**: Simple, no string parsing.

**Cons**: `RALPH_WORKTREE_PATHS` may not be set in all invocation paths (e.g. single-repo skill context without explicit export). Requires env var discipline.

**Risk**: Medium — env var availability is not guaranteed in all code paths.

### Option C: Combine `cd` parse + RALPH_WORKTREE_PATHS fallback + warn (recommended)

**What**:
1. Parse leading `cd <path>` from command. If found, resolve path, run `git -C <resolved_path> branch --show-current` for the branch check.
2. If no `cd` prefix: scan `RALPH_WORKTREE_PATHS` — if command contains any worktree path, infer branch from that worktree.
3. If neither applies: fall back to current `git branch --show-current` but emit a `warn()` instead of blocking when result is `main` (avoids false-positive block; logs the ambiguity for diagnosis).

**Pros**: Handles the primary case (explicit `cd`), has a belt-and-suspenders fallback (env var), and degrades safely (warn not block) instead of false-positiving.

**Cons**: More logic than the single-path options. Warn-on-main is a softer guard than block-on-main.

**Risk**: Low. The warn path is only reached when both detection strategies fail, which is a genuinely ambiguous situation.

**Recommended**: Option C. The issue body already specifies this as "Fix Option 3" and the triage comment validates it as the most robust choice.

## Risks

- **Tilde expansion**: Paths from SKILL.md or env vars may use `~`. Bash `eval echo ~` or `${HOME}` substitution is required before passing to `git -C`. Failure to expand results in `git -C ~/...` being treated as a literal path.
- **Relative path resolution**: `cd worktrees/GH-983` must be resolved against `CLAUDE_PROJECT_DIR`, not the shell's current directory (which may differ).
- **Command injection via path**: Parsing untrusted command strings requires care. Use parameter extraction (`sed`/regex), not `eval`, for path derivation from the command string.
- **Test coverage gap**: No existing test for `impl-branch-gate.sh` under `__tests__/`. The fix must be accompanied by a test that exercises the worktree-with-`cd`-prefix case.

## Recommended Next Steps

1. **Fix `impl-branch-gate.sh`**: Implement Option C (parse `cd` prefix → RALPH_WORKTREE_PATHS fallback → warn). Target lines 40-57.
2. **Add test**: Create `plugin/ralph-hero/hooks/scripts/__tests__/test-impl-branch-gate.sh` covering:
   - Command with `cd worktrees/GH-NNN && git commit`: allowed (feature branch)
   - Command with `git commit` from main (no cd, no RALPH_WORKTREE_PATHS): blocked
   - Command with `git commit` and RALPH_WORKTREE_PATHS pointing to worktree: allowed
   - `git checkout` commands: always allowed (existing behavior)
3. **No changes needed** to `agent-phase-gate.sh`, `hooks.json`, or the impl-agent agent definition — the routing is correct; only the branch detection logic inside `impl-branch-gate.sh` is broken.

## Files Affected

### Will Modify
- `plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh` — Fix branch detection logic (lines 40-57): parse `cd` prefix, RALPH_WORKTREE_PATHS fallback, warn instead of block on ambiguous case
- `plugin/ralph-hero/hooks/scripts/__tests__/test-impl-branch-gate.sh` — New test file covering worktree-with-cd-prefix case

### Will Read (Dependencies)
- `plugin/ralph-hero/hooks/scripts/hook-utils.sh` — `warn()`, `allow()`, `block()`, `get_field()` utilities used by the fixed script
- `plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh` — Pattern reference for `RALPH_WORKTREE_PATHS` consumption (lines 40-46)
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md` — Confirms `RALPH_WORKTREE_PATHS` export contract and standard commit command patterns
- `plugin/ralph-hero/hooks/scripts/__tests__/test-agent-phase-gate.sh` — Test harness pattern reference for stub-based hook testing
