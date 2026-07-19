---
date: 2026-07-19
status: draft
type: plan
tags: [hooks, hook-utils, path-resolution]
github_issue: 1556
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1556
primary_issue: 1556
estimate: XS
---

# Plan: plan-research-required.sh mis-roots to session CWD

## Prior Work

- builds_on:: [[2026-07-19-GH-1556-plan-research-required-cwd-misroot]] (research — primary evidence; confirms the defect chain, proposes `resolve_root_from_path()`, and enumerates sibling exposure)
- builds_on:: [[2026-05-03-GH-0983-impl-branch-gate-cwd-bug]] (research/plan — established repo precedent: prefer path-derived context over session-derived CWD, with a CWD fallback; `resolve_target_branch()` in `impl-branch-gate.sh` is the model this plan's helper follows)

## Overview

`ralph/hooks/scripts/plan-research-required.sh` blocks a plan `Write` when no research document exists for the linked ticket. It computes the search directory via `get_project_root()` (`hook-utils.sh:43-45`), which resolves to `${CLAUDE_PROJECT_DIR:-$(pwd)}` — a value derived from the *session's* CWD, not from the file actually being written. In a multi-repo workspace session (CWD `~/projects`, not itself a git repo), this computes `~/projects/thoughts/shared/research` instead of `~/projects/ralph-hero/thoughts/shared/research/`, so the hook can't see a research doc that genuinely exists, and false-blocks the plan Write (observed on GH-1550).

The fix adds a small path-derived resolver, `resolve_root_from_path()`, to `hook-utils.sh` that walks up from the target file's directory to the nearest ancestor containing a `.git` marker, falling back to the existing `get_project_root()` behavior when no repo boundary is found. `plan-research-required.sh` is updated to use it. This is a single-file-plus-helper, behavior-preserving fix (CWD == repo root sessions see no change) scoped to XS size; sibling hooks with the same exposure are explicitly deferred to a follow-up issue.

## Current State Analysis

`plan-research-required.sh` already extracts the Write target's absolute `file_path` at line 37, but only uses it for a `/plans/` substring check (line 39) and a `GH-NNNN` regex extraction (line 47). The research-directory computation at line 52 ignores it entirely and calls `get_project_root()`, which has no file-path input and no upward-walk logic — it is a one-line env/CWD passthrough.

No shared helper exists today that resolves a repo root from an arbitrary file path. The closest analog, `impl-worktree-gate.sh:30-36`, uses `git rev-parse --path-format=absolute --git-common-dir`, but that call is still relative to the *session's* CWD (it doesn't accept a target path), so it doesn't solve this class of bug either. The actual precedent for "derive context from the tool call's own path, fall back to session/env" is GH-983's `resolve_target_branch()` in `impl-branch-gate.sh`, which established this repo's tiered-fallback pattern for exactly this class of session-CWD-vs-target-path bug.

### Key Discoveries

- `ralph/hooks/scripts/hook-utils.sh:43-45` — `get_project_root()` is `echo "${CLAUDE_PROJECT_DIR:-$(pwd)}"`; no file-path input, no upward walk.
- `ralph/hooks/scripts/plan-research-required.sh:37` — `file_path=$(get_field '.tool_input.file_path')` already extracts the absolute target path; unused for rooting.
- `ralph/hooks/scripts/plan-research-required.sh:52` — `research_dir="$(get_project_root)/thoughts/shared/research"` is the mis-rooted computation; this is the one line this plan changes.
- `ralph/hooks/scripts/plan-research-required.sh:53` — `find_existing_artifact "$research_dir" "$ticket_id"` searches whatever root it's handed; no change needed here, it just needs the right `research_dir`.
- `ralph/hooks/scripts/plan-research-required.sh:90-102` — the block message embeds `$research_dir` directly, so a correct root also fixes the diagnostic text seen by the human/agent.
- `ralph/hooks/scripts/impl-worktree-gate.sh:30-36` — inline git-based root resolution; CWD-relative, not path-derived, not reusable as-is.
- `ralph/hooks/scripts/__tests__/plan-research-required.test.sh:22-43` — sandbox harness forces `CLAUDE_PROJECT_DIR="$SBX"` for every case; today there's no case where the target file lives in a *different* tree than `CLAUDE_PROJECT_DIR`, so the bug has no regression coverage.
- Sibling exposure (`impl-plan-required.sh:43,72-73`, `plan-postcondition.sh:58`, `research-postcondition.sh:19`, `review-no-dup.sh:26`) is real but out of scope for this XS fix — see What We're NOT Doing.

## Desired End State

1. `hook-utils.sh` exposes `resolve_root_from_path()`: given an absolute file path, it walks up from that path's directory to the nearest ancestor containing a `.git` entry (file or directory — linked worktrees use a `.git` *file*) and returns that ancestor; if no such ancestor exists, it returns `get_project_root()`'s current value unchanged.
2. `plan-research-required.sh:52` computes `research_dir` from `resolve_root_from_path "$file_path"` instead of `get_project_root`.
3. A session whose CWD is a non-repo workspace root, writing a plan file that lives inside a repo checkout with an existing research doc for the ticket, is no longer false-blocked.
4. All existing test cases in `plan-research-required.test.sh` continue to pass unchanged (their `$SBX` is both the repo root and the file's ancestor, so `resolve_root_from_path` returns the same value `get_project_root` would have).
5. A new regression test case proves the fix: target file path lives under a fake repo tree containing `.git` + `thoughts/shared/research/<ticket doc>`, while `CLAUDE_PROJECT_DIR` points at an unrelated sandbox dir — the hook must allow (exit 0), not block.

### Verification

- `bash ralph/hooks/scripts/__tests__/plan-research-required.test.sh` reports `0 failed` including the new case.
- `shellcheck` (CI's `shellcheck-hooks` job, `scandir: ralph/hooks`, `severity: error`) passes on both modified files.
- Manual: reproduce the GH-1550 scenario — a session with CWD outside the repo, `CLAUDE_PROJECT_DIR` unset or pointed elsewhere, writing a plan `Write` whose absolute path is under `ralph-hero/thoughts/shared/plans/` for a ticket with an existing research doc — hook allows.

## What We're NOT Doing

- Not migrating `impl-plan-required.sh`, `plan-postcondition.sh`, `research-postcondition.sh`, `review-no-dup.sh`, `artifact-write-tracker.sh`, or `drift-tracker.sh` to the new helper — same class of exposure, deferred to a follow-up issue (Stop-hook callers `plan-postcondition.sh`/`research-postcondition.sh` can't use it at all, since Stop hooks have no `tool_input.file_path`).
- Not changing `get_project_root()`'s own behavior or signature — it stays the fallback tier, used as-is by every other caller.
- Not adding a `git rev-parse` dependency to the new helper (see Design Decisions below).
- Not touching `find_existing_artifact()` or its padding-tolerance logic — it already works correctly once given the right root.

## Design Decisions & Open Ambiguities

- **Manual `.git`-marker walk vs. `git -C <dir> rev-parse --show-toplevel`** — options: (a) manual walk checking `-e "$dir/.git"` per ancestor; (b) shell out to `git rev-parse`. **Decided: manual walk.** No git-subprocess dependency (hooks already avoid subprocess-heavy checks where a bash primitive suffices — cf. `hook-utils.sh`'s existing string/file-test helpers), identical behavior for the repro case, and it naturally resolves linked worktrees to the worktree root (desired: a worktree checkout should search its own `thoughts/` tree, not the main checkout's) since `-e` matches the `.git` *file* that linked worktrees use, not just the `.git` *directory* in a primary checkout.
- **Fallback behavior when no `.git` ancestor is found** — options: (a) fall back silently to `get_project_root()`; (b) block/warn. **Decided: silent fallback to `get_project_root()`.** Preserves current behavior exactly for any caller/context where the target path isn't inside a git checkout (e.g. synthetic paths in some test contexts), so the change is additive/behavior-preserving rather than behavior-changing in the non-buggy case.

None — no open design decisions.

## Implementation Approach

Single phase: add the helper to `hook-utils.sh`, switch the one call site in `plan-research-required.sh`, and add a regression test case (plus verify existing cases still pass) to `plan-research-required.test.sh`. No schema changes, no new files, < 100 LOC across the three files.

## Phase 1: Add path-derived root resolver and rewire plan-research-required.sh

depends_on: null

### Overview

Introduce `resolve_root_from_path()` in `hook-utils.sh`, point `plan-research-required.sh`'s research-dir computation at it, and extend the hook's test suite with a regression case that reproduces the workspace-root mis-rooting.

### Changes Required

#### 1. Path-derived root helper
**File**: `ralph/hooks/scripts/hook-utils.sh`
**Changes**: Add a new function near `get_project_root()` (after line 45):

```bash
# Walk up from a file path to the nearest ancestor containing a .git entry
# (file or directory — linked worktrees use a .git FILE, not a directory).
# Falls back to get_project_root() when no repo marker is found or the path
# is empty, so this is additive: sessions whose CWD already equals the repo
# root see identical behavior.
resolve_root_from_path() {
  local target="${1:-}"
  if [[ -n "$target" ]]; then
    local dir
    dir=$(dirname "$target")
    while [[ "$dir" != "/" && -n "$dir" ]]; do
      if [[ -e "$dir/.git" ]]; then
        echo "$dir"
        return
      fi
      dir=$(dirname "$dir")
    done
  fi
  get_project_root
}
```

#### 2. Rewire the research-dir computation
**File**: `ralph/hooks/scripts/plan-research-required.sh`
**Changes**: Replace line 52:

```bash
research_dir="$(get_project_root)/thoughts/shared/research"
```

with:

```bash
research_dir="$(resolve_root_from_path "$file_path")/thoughts/shared/research"
```

No other lines change — `file_path` is already in scope from line 37, and lines 53/90-102 (the `find_existing_artifact` call and block message) consume `$research_dir` unchanged.

#### 3. Regression test coverage
**File**: `ralph/hooks/scripts/__tests__/plan-research-required.test.sh`
**Changes**: Add a case (after the existing "Early-allow paths" block, alongside the sandbox setup) that:
1. Creates a second temp dir (`$REPO`) distinct from `$SBX`, containing `$REPO/.git` (a plain `mkdir` or `touch`, not a real git init — the helper only checks `-e`), `$REPO/thoughts/shared/plans/`, and a fixture research doc at `$REPO/thoughts/shared/research/2026-0X-GH-9-research.md`.
2. Runs the hook with `CLAUDE_PROJECT_DIR="$SBX"` (the unrelated workspace-root stand-in) but a `file_path` under `$REPO/thoughts/shared/plans/...-GH-9-....md` — this is the exact "session CWD elsewhere, target file in the real repo" shape from the bug report.
3. Asserts exit 0 (allowed) — proving the fix roots off `file_path`, not `CLAUDE_PROJECT_DIR`.

Also add one negative-control case confirming the fallback tier: a `file_path` with NO `.git` ancestor anywhere on its path, for a ticket with NO matching research doc under `$SBX` (`CLAUDE_PROJECT_DIR`), and an estimate at/above the research threshold — expected result **block (exit 2)**, with the block message embedding the `$SBX`-rooted research dir. This proves the walk exhausts to `/` and falls back to `get_project_root()` (existing behavior preserved), exercising `resolve_root_from_path`'s fallback branch rather than an early-allow path.

### Success Criteria

#### Automated Verification
- [ ] `bash ralph/hooks/scripts/__tests__/plan-research-required.test.sh` exits 0 with all cases (existing + 2 new) passing
- [ ] `find ralph/hooks/scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \) -type f -print0 | sort -z | xargs -0 -n1 bash -c 'echo "=== $0 ==="; bash "$0"'` (CI's `test-hooks` job invocation) passes for the full hook-test suite, not just this file
- [ ] ShellCheck passes on `ralph/hooks/scripts/hook-utils.sh` and `ralph/hooks/scripts/plan-research-required.sh` at `severity: error` (matches CI's `shellcheck-hooks` job)

#### Manual Verification
- [ ] From a shell CWD'd to `~/projects` (not a git repo) with `CLAUDE_PROJECT_DIR` unset, invoke the hook directly with a crafted PreToolUse JSON whose `file_path` points into `~/projects/ralph-hero/thoughts/shared/plans/...` for a ticket with an existing research doc under `~/projects/ralph-hero/thoughts/shared/research/` — confirm exit 0 (previously exit 2)

## Testing Strategy

### Unit Tests
New sandbox cases in `plan-research-required.test.sh`: (1) the workspace-root repro — target file rooted in a different tree than `CLAUDE_PROJECT_DIR`, expect allow (exit 0); (2) fallback-preserved control — target file with no `.git` ancestor anywhere on its path and no matching research doc under `CLAUDE_PROJECT_DIR`, expect block (exit 2), matching the shape defined in Phase 1 §3. All 10 existing cases must keep passing unchanged — they run with `CLAUDE_PROJECT_DIR="$SBX"` and file paths already under `$SBX`, so `resolve_root_from_path` finds `$SBX` itself as the nearest `.git`-marked ancestor only if the test setup adds a `$SBX/.git` marker; otherwise it falls through to `get_project_root()` which returns `$SBX` via `CLAUDE_PROJECT_DIR` — either way the existing cases resolve to the same `$SBX` root they do today. (Confirm during implementation whether the sandbox setup needs a `mkdir -p "$SBX/.git"` marker added for the walk to terminate at `$SBX` rather than continuing past it to `/tmp` or `/`; if no marker exists, the walk exhausts to `/` and falls back to `get_project_root()`, which is also `$SBX` — so behavior is correct either way, but adding the marker makes the intended code path explicit rather than incidental.)

CI enforcement: `shellcheck-hooks` (severity error, `scandir: ralph/hooks`) runs on every push/PR touching these files — no separate lint step needed in this plan.

### Integration Tests
None — this is a pure bash hook fix; the existing sandbox-harness test file is both the unit and integration test surface for this hook.

### Manual Testing Steps
1. Reproduce the exact GH-1550 scenario per the Manual Verification checkbox above.
2. Confirm the block message (when it does fire, e.g. for the fallback-control case) still embeds a sensible `$research_dir` path rather than a broken one.

## Migration Notes

None needed. The change is additive and behavior-preserving: for any session where `CLAUDE_PROJECT_DIR`/CWD already equals (or is an ancestor-equivalent of) the repo containing the target file — the common case today — `resolve_root_from_path()` returns the same value `get_project_root()` would have. The fallback branch (no `.git` ancestor found) reproduces the exact old behavior. No data migration, no config changes, no coordinated rollout with other hooks.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1556
- Research: `thoughts/shared/research/2026-07-19-GH-1556-plan-research-required-cwd-misroot.md`
- Precedent: `thoughts/shared/research/2026-05-03-GH-0983-impl-branch-gate-cwd-bug.md`, `thoughts/shared/plans/2026-05-03-GH-0983-impl-branch-gate-cwd-bug.md`
- `ralph/hooks/scripts/hook-utils.sh:43-45` (`get_project_root`)
- `ralph/hooks/scripts/plan-research-required.sh:37,52-53,90-102`
- `ralph/hooks/scripts/impl-worktree-gate.sh:30-36` (CWD-relative git analog, not reused)
- `ralph/hooks/scripts/__tests__/plan-research-required.test.sh`
- `.github/workflows/ci.yml` `test-hooks` and `shellcheck-hooks` jobs
