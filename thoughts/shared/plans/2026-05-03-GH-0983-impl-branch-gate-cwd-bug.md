---
date: 2026-05-03
status: draft
type: plan
github_issue: 983
github_issues: [983]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/983
primary_issue: 983
tags: [hooks, impl-branch-gate, worktree, git, false-positive, bug-fix]
---

# GH-983: Fix impl-branch-gate.sh worktree-aware branch detection - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-03-GH-0983-impl-branch-gate-cwd-bug]] (research — root cause analysis, fix options, recommended approach)
- builds_on:: [[2026-02-17-GH-0046-builder-worker-agent]] (research — original gate suite design)
- builds_on:: [[2026-02-20-GH-0203-worktree-scripts-plugin]] (research — worktree lifecycle context)

## Overview

Single-issue atomic plan to fix a PreToolUse hook false-positive that blocks valid impl-agent commits.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-983 | bug(impl-branch-gate): reads git branch from agent cwd instead of worktree | XS |

## Shared Constraints

- **Files in scope**: only `plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh` and a new test file under `plugin/ralph-hero/hooks/scripts/__tests__/`. No changes to `agent-phase-gate.sh`, `hooks.json`, or any agent definition.
- **Bash style**: keep `set -euo pipefail`, source `hook-utils.sh` for `allow`/`block`/`warn`/`get_field`/`read_input`. Do not introduce new external dependencies beyond `git`, `jq`, `sed`, `awk`, and core POSIX tools already used by sibling hooks.
- **Backward compatibility**: hook must remain a drop-in replacement — same exit codes (0 allow, 2 block), same stdin contract (`tool_input.command` JSON), same env var contract (`RALPH_COMMAND`, `RALPH_WORKTREE_PATHS`).
- **Path resolution**: all relative paths in extracted `cd <path>` arguments resolve against `CLAUDE_PROJECT_DIR` (consistent with how the harness invokes the hook). Tilde paths must be expanded via `${HOME}` or `eval echo`.
- **Safety default on ambiguity**: when neither the `cd`-prefix parse nor the `RALPH_WORKTREE_PATHS` scan can identify the target directory, fall back to current cwd's branch — but if that resolves to `main`/`master`, emit a `warn` and allow rather than blocking. This mirrors the existing `warn()` utility from `hook-utils.sh:61` and avoids false positives.
- **Block contract preserved**: when branch detection succeeds and the resolved branch is `main` or `master`, the hook still blocks with the same error message format (so callers' UX doesn't change).
- **No `eval` of user-supplied command strings**: extract the `cd` argument with `sed`/regex, then expand tildes via `${HOME}` substitution only. Do not `eval` the command itself.

## Current State Analysis

`plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh:41` calls `git branch --show-current` with no cwd argument. Because the hook process runs from the harness root (`$CLAUDE_PROJECT_DIR`, the main repo), the result is always `main` regardless of where the agent's command will execute. When the agent submits a command like `cd worktrees/GH-983 && git commit -m "..."`, the gate misreads the branch as `main` and blocks — even though the command itself would run inside a feature-branch worktree.

The same hooks directory contains three working examples of branch detection that explicitly cd before querying:
- `hook-utils.sh:75` — `cd "$(get_project_root)" && git branch --show-current`
- `pre-worktree-validator.sh:53` — `cd "$WORKTREE_PATH" && git branch --show-current`
- `prune-merged-worktrees.sh:32` — `cd "$wt_path" && git branch --show-current`

`impl-worktree-gate.sh:40-46` already consumes `RALPH_WORKTREE_PATHS` (colon-separated absolute paths set by the impl skill for multi-repo runs). `impl-branch-gate.sh` does not currently reference this var.

The hook input contains the exact command string at `tool_input.command` (extracted at line 25). This is the authoritative signal for "where will this command actually run".

No tests exist for `impl-branch-gate.sh` under `plugin/ralph-hero/hooks/scripts/__tests__/`. Sibling tests use a stub-based pattern (see `test-agent-phase-gate.sh`) that builds JSON inputs via `printf`, redirects to the script under test, and asserts exit codes / stdout against a `pass`/`fail` counter.

## Desired End State

After this fix:
- `cd worktrees/GH-NNN && git commit -m "..."` from impl-agent or `RALPH_COMMAND=impl` is **allowed** (resolved branch is the feature branch, not main).
- `cd worktrees/GH-NNN; git push origin GH-NNN-foo` (semicolon-chained) is **allowed**.
- `git -C worktrees/GH-NNN add file.txt` is **allowed** (path detected via `RALPH_WORKTREE_PATHS` scan even though no leading `cd`).
- `git commit -m "..."` issued from a process whose cwd resolves to main, with no `cd` and no `RALPH_WORKTREE_PATHS` match → **warn-then-allow** (safe degraded mode; the impl agent should never reach this in practice but we don't false-positive).
- `cd /Users/dubiel/projects/ralph-hero && git commit` (explicit cd to the main repo on main branch) → **blocked** (true positive preserved).
- `git checkout`, `git switch`, and any non-git command remain unaffected (existing early-return logic preserved).

### Verification

- [x] All four positive cases above (worktree feature branch commits) pass without false-positive blocks under `RALPH_COMMAND=impl` and `agent_type=impl-agent`.
- [x] Explicit-main negative case still blocks.
- [x] Ambiguous case (no `cd`, no `RALPH_WORKTREE_PATHS`, current cwd on main) emits a warn and allows — does not block.
- [x] `bash plugin/ralph-hero/hooks/scripts/__tests__/test-impl-branch-gate.sh` reports `0 failed`.
- [x] No regressions in existing `bash plugin/ralph-hero/hooks/scripts/__tests__/test-agent-phase-gate.sh` run.

## What We're NOT Doing

- Not modifying `agent-phase-gate.sh`, `hooks.json`, or any agent definition. The dispatch chain that routes Bash tool calls into `impl-branch-gate.sh` is correct; only the branch-detection logic inside the gate itself is broken.
- Not adding new env vars. `RALPH_WORKTREE_PATHS` already exists and is documented in `skills/ralph-impl/SKILL.md`.
- Not refactoring the early-return guards (lines 18-38). They are correct as-is.
- Not changing the block error message format (callers depend on the "Implementation git operations blocked on main branch" preamble for diagnostics).
- Not wiring the new test into `.github/workflows/ci.yml` in this phase. Hook script tests are currently invoked manually; CI integration is out of scope and tracked separately.
- Not handling pathological command strings (multi-line, here-docs, command substitution within `cd` argument). Out-of-scope edge cases fall through to the warn-and-allow ambiguity path, which is safe.

## Implementation Approach

Single phase, two files. Modify the hook in place and add a test file using the existing stub pattern from `test-agent-phase-gate.sh`.

Branch detection becomes a small helper function with three tiers:
1. Parse `cd <path>` from the leading segment of `tool_input.command`. Resolve to absolute path. If the path is a git working tree, query its branch via `git -C "$path" branch --show-current`.
2. If no leading `cd` (or step 1 yielded no branch), iterate `RALPH_WORKTREE_PATHS` and find any worktree path that appears as a substring in the command. Query its branch via `git -C "$wt_path" branch --show-current`.
3. If both fail, query `git branch --show-current` from the current cwd. If the result is `main`/`master`, `warn` (do not `block`) and allow. If the result is anything else, allow silently.

If any tier yields a branch and that branch is `main`/`master`, `block` with the existing error message. If a tier yields a feature branch, `allow`.

---

## Phase 1: Fix impl-branch-gate.sh worktree-aware branch detection (GH-983)

- **depends_on**: null

### Overview

Replace the broken `git branch --show-current` call at line 41 with a worktree-aware helper, and add a test file under `__tests__/` that exercises the worktree-with-`cd`-prefix case, the `RALPH_WORKTREE_PATHS` fallback case, the genuine main-branch block case, and the ambiguity warn case.

### Tasks

#### Task 1.1: Implement worktree-aware branch detection in impl-branch-gate.sh

- **files**: `plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh` (modify), `plugin/ralph-hero/hooks/scripts/hook-utils.sh` (read), `plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh` (read for `RALPH_WORKTREE_PATHS` pattern)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Lines 1-39 of `impl-branch-gate.sh` (shebang, comments, `set -euo`, source, early-return guards for `RALPH_COMMAND`/`agent_type`/empty command/non-git-commit/git-checkout) are preserved verbatim.
  - [ ] A new helper function (e.g. `resolve_target_branch`) is added before line 40 that:
    - Extracts a leading `cd <path>` from `$command` using a regex anchored at `^[[:space:]]*cd[[:space:]]+([^&;|[:space:]]+)`. Strips matching surrounding single or double quotes from the captured path.
    - Expands `~` to `${HOME}` via parameter substitution (no `eval` of the command).
    - Resolves relative paths against `${CLAUDE_PROJECT_DIR:-$(pwd)}`.
    - If resolved path is a directory and `git -C <path> rev-parse --git-dir` succeeds, returns `git -C <path> branch --show-current`.
    - If no leading `cd`, iterates colon-separated `RALPH_WORKTREE_PATHS`. For each non-empty `wt_path`, if `$command` contains `$wt_path` as a substring AND `git -C "$wt_path" rev-parse --git-dir` succeeds, returns `git -C "$wt_path" branch --show-current`.
    - If neither tier succeeds, returns empty string.
  - [ ] The branch check at original line 41 is replaced with: call the helper; if the helper returned a branch, use it; otherwise call `git branch --show-current 2>/dev/null` (current behaviour) AND, if the result is `main`/`master`, call `warn "impl-branch-gate could not determine target branch from command; allowing with warning. Command: $command"` instead of `block`.
  - [ ] When the resolved branch (from either helper or fallback) is `main` or `master` AND the helper returned a non-empty value, the existing `block "Implementation git operations blocked on main branch..."` call fires unchanged with `current_branch` substituted.
  - [ ] The final `allow` at the end of the script is preserved.
  - [ ] Script remains executable and syntactically valid: `bash -n plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh` exits 0.
  - [ ] No new external commands beyond `git`, `jq`, `sed`/regex, parameter expansion are introduced.

#### Task 1.2: Add test-impl-branch-gate.sh covering the four scenarios

- **files**: `plugin/ralph-hero/hooks/scripts/__tests__/test-impl-branch-gate.sh` (create), `plugin/ralph-hero/hooks/scripts/__tests__/test-agent-phase-gate.sh` (read for pattern reference), `plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh` (read — script under test)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] New file `plugin/ralph-hero/hooks/scripts/__tests__/test-impl-branch-gate.sh` exists, is executable, starts with `#!/bin/bash` and `set -euo pipefail`, follows the `pass=0; fail=0; assert_eq` pattern from `test-agent-phase-gate.sh`.
  - [ ] Test fixture: creates a temp git worktree directory using `mktemp -d` + `git init` + `git checkout -b GH-983-test` so a real feature-branch git context exists.
  - [ ] Test case 1 — `cd <worktree> && git commit`: input JSON has `tool_input.command = "cd <tmpdir> && git commit -m test"`, env `RALPH_COMMAND=impl`. Asserts script exits 0 (allow). Description: "cd-prefix to worktree feature branch is allowed."
  - [ ] Test case 2 — `RALPH_WORKTREE_PATHS` substring match: input JSON has `tool_input.command = "git -C <tmpdir> add file.txt"` (no leading `cd`), env `RALPH_COMMAND=impl`, `RALPH_WORKTREE_PATHS=<tmpdir>`. Asserts script exits 0 (allow). Description: "RALPH_WORKTREE_PATHS substring match without leading cd is allowed."
  - [ ] Test case 3 — explicit cd to a main-branch repo: creates a second tmpdir with `git init` (default branch `main` or `master`), input JSON has `tool_input.command = "cd <main-tmpdir> && git commit -m test"`, env `RALPH_COMMAND=impl`. Asserts script exits 2 (block). Description: "cd-prefix resolving to main branch is blocked."
  - [ ] Test case 4 — git checkout always allowed: input has `tool_input.command = "git checkout -b foo"`, env `RALPH_COMMAND=impl`. Asserts exit 0. Description: "git checkout is always allowed (existing behavior preserved)."
  - [ ] Test case 5 — non-impl command path: input has `tool_input.command = "git commit"`, no `RALPH_COMMAND`, no `agent_type`. Asserts exit 0 (existing early-return guard). Description: "non-impl context falls through allow."
  - [ ] Test prints `Results: <pass> passed, <fail> failed` and exits 1 if any failures.
  - [ ] Cleans up tmpdirs via `trap 'rm -rf "$TMP_DIR" "$MAIN_TMP_DIR"' EXIT`.
  - [ ] Running `bash plugin/ralph-hero/hooks/scripts/__tests__/test-impl-branch-gate.sh` from the repo root reports `0 failed`.

#### Task 1.3: Manual smoke check + regression sweep

- **files**: `plugin/ralph-hero/hooks/scripts/__tests__/test-agent-phase-gate.sh` (read), `plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [ ] `bash -n plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh` exits 0.
  - [ ] `bash plugin/ralph-hero/hooks/scripts/__tests__/test-impl-branch-gate.sh` reports `0 failed`.
  - [ ] `bash plugin/ralph-hero/hooks/scripts/__tests__/test-agent-phase-gate.sh` reports `0 failed` (regression check — agent-phase-gate stubs out `impl-branch-gate.sh`, so unrelated changes here should not affect it, but verify anyway).
  - [ ] `bash plugin/ralph-hero/hooks/scripts/__tests__/test-tier-detection.sh` reports `0 failed` (regression check — unrelated to this fix, but cheap to verify).
  - [ ] Manual repro: from the main repo, simulate the harness invocation with: `echo '{"tool_input":{"command":"cd worktrees/GH-983 && git commit -m test"}, "agent_type":"impl-agent"}' | RALPH_COMMAND=impl bash plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh; echo "exit=$?"` — exit code is 0 (assuming the worktree exists; if not, exits 0 via the warn-and-allow ambiguity path).

### Phase Success Criteria

#### Automated Verification:
- [x] `bash -n plugin/ralph-hero/hooks/scripts/impl-branch-gate.sh` — no syntax errors
- [x] `bash plugin/ralph-hero/hooks/scripts/__tests__/test-impl-branch-gate.sh` — all assertions pass, exits 0
- [x] `bash plugin/ralph-hero/hooks/scripts/__tests__/test-agent-phase-gate.sh` — all assertions pass, exits 0
- [x] `cd plugin/ralph-hero/mcp-server && npm run build` — TypeScript build still passes (sanity, since hooks dir is sibling to mcp-server)

#### Manual Verification:
- [x] Manual repro of the original bug confirms the false-positive block no longer fires for `cd worktrees/GH-NNN && git commit`.
- [x] Manual confirmation that `cd <main-repo-root> && git commit` is still blocked (true-positive preserved).

**Creates for next phase**: This is the only phase; no downstream artifacts.

---

## Integration Testing

- [ ] After merge, run a real impl-agent dispatch on any small XS issue end-to-end and confirm the impl phase commits/pushes without manual hook overrides.

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-05-03-GH-0983-impl-branch-gate-cwd-bug.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/983
- Related hooks reference patterns:
  - https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/hook-utils.sh#L75
  - https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/pre-worktree-validator.sh#L53
  - https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh#L40-L46
- Test pattern reference:
  - https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/__tests__/test-agent-phase-gate.sh
