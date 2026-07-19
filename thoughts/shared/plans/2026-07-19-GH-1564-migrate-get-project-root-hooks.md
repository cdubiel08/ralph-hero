---
date: 2026-07-19
status: draft
type: plan
tags: [hooks, hook-utils, path-resolution]
github_issue: 1564
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1564
primary_issue: 1564
estimate: S
---

# Plan: Migrate remaining get_project_root artifact-lookup hooks to resolve_root_from_path

## Prior Work

- builds_on:: [[2026-07-19-GH-1556-plan-research-required-file-path-rooting]] (plan — established `resolve_root_from_path()`, migrated its single call site in `plan-research-required.sh`, and explicitly deferred the sibling call sites this plan now migrates)
- builds_on:: [[2026-07-19-GH-1556-plan-research-required-cwd-misroot]] (research — original defect chain: `get_project_root()` resolves from session CWD/`CLAUDE_PROJECT_DIR`, not from the file actually being operated on; enumerates the sibling exposure list this plan works through)

## Overview

GH-1556 added `resolve_root_from_path()` to `ralph/hooks/scripts/hook-utils.sh` (`hook-utils.sh:55-68`): given an absolute file path, it walks up to the nearest ancestor containing a `.git` entry (file or directory — linked worktrees use a `.git` file), falling back to `get_project_root()` when the path is relative/empty or no `.git` ancestor exists. It migrated one call site (`plan-research-required.sh`) and explicitly deferred the rest.

This issue migrates the two remaining call sites that use `get_project_root()` to find a repo root **from which to look up an artifact keyed on the tool call's own `file_path`** — the same mis-rooting exposure `plan-research-required.sh` had:

1. `impl-plan-required.sh` — computes `plans_dir` and checks a `## Plan Reference` path, both currently rooted via `get_project_root()` instead of the `file_path` already in scope.
2. `review-no-dup.sh` — computes `project_root` to search for an existing critique, also currently rooted via `get_project_root()` instead of the `file_path` already in scope.

Two other candidate call sites (`artifact-write-tracker.sh`, `drift-tracker.sh`) were investigated and are **excluded** from scope: they use `get_project_root()` to *normalize* `file_path` (prepend or strip the root as a prefix), not to *resolve* a root from which to search for a different artifact — see Design Decisions. Two more (`plan-postcondition.sh`, `research-postcondition.sh`) are Stop hooks with no `tool_input.file_path` access at all, confirmed out of scope by the issue's own triage.

This is a mechanical migration of a proven, already-tested pattern: no changes to `hook-utils.sh` itself, no schema changes, two independent single-call-site edits plus new regression test files modeled on `plan-research-required.test.sh`.

## Current State Analysis

`hook-utils.sh` already exposes both `get_project_root()` (env/CWD passthrough, no file-path input) and `resolve_root_from_path()` (path-derived, falls back to `get_project_root()`). Both target hooks already extract `file_path` from `tool_input.file_path` early — the fix is purely swapping which root-resolution function consumes it, with no new extraction logic needed.

`impl-plan-required.sh` has two `get_project_root()` call sites feeding two different lookups (a directory to search, and a specific referenced file's existence check) but only one `file_path` value in scope — a single resolved-root variable can serve both. `review-no-dup.sh` has one call site. Neither hook currently has a dedicated test file; `impl-plan-required.sh` and `review-no-dup.sh` are exercised only implicitly (or not at all) by the existing hook test suite, so this plan adds new test files for both, following the `plan-research-required.test.sh` sandbox-harness pattern (SBX/REPO/NOGIT dirs, `run_case` helper, `CLAUDE_PROJECT_DIR` override).

`artifact-write-tracker.sh` and `drift-tracker.sh` both call `get_project_root()` too, but for a structurally different job: `artifact-write-tracker.sh:30-32` prepends the root to a *relative* `file_path` so a Stop hook can later `-f` check it from any CWD; `drift-tracker.sh:33-34` strips the root as a *prefix* from an *absolute* `file_path` to get a path relative to the declared task-files list. Neither is searching for an artifact that lives under a repo root derived from `file_path` — they're both using the root to reshape `file_path` itself. Migrating them to `resolve_root_from_path()` would not fix a real mis-rooting bug (there's no second lookup that could be searching the wrong tree) and risks changing which root gets prepended/stripped in linked-worktree sessions with no corresponding bug to justify it. Confirmed by the existing `artifact-write-tracker.test.sh:62-68` case ("relative path normalized against CLAUDE_PROJECT_DIR"), which locks in the current normalize-direction behavior.

### Key Discoveries

- `ralph/hooks/scripts/hook-utils.sh:43-45` — `get_project_root()`: `echo "${CLAUDE_PROJECT_DIR:-$(pwd)}"`, no file-path input, no upward walk.
- `ralph/hooks/scripts/hook-utils.sh:55-68` — `resolve_root_from_path()`: walks up from `${target%/*}` while `-e "$dir/.git"`, requires `$target` to start with `/` (relative paths fall back immediately — the infinite-loop guard from GH-1556's code review), falls back to `get_project_root()` otherwise.
- `ralph/hooks/scripts/impl-plan-required.sh:22` — `file_path=$(get_field '.tool_input.file_path')` already extracted early; unused for rooting today.
- `ralph/hooks/scripts/impl-plan-required.sh:43` — `plans_dir="$(get_project_root)/thoughts/shared/plans"` — the directory searched for a matching plan doc; mis-roots exactly like `plan-research-required.sh` did pre-GH-1556.
- `ralph/hooks/scripts/impl-plan-required.sh:72-73` — `if [[ -f "$(get_project_root)/$local_path" ]]; then plan_doc="$(get_project_root)/$local_path"; fi` — the `## Plan Reference` existence check, called twice, same mis-rooting exposure.
- `ralph/hooks/scripts/review-no-dup.sh:14` — `file_path=$(get_field '.tool_input.file_path')` already extracted early; unused for rooting today.
- `ralph/hooks/scripts/review-no-dup.sh:26` — `project_root=$(get_project_root)` — the directory searched for an existing critique doc; same exposure class.
- `ralph/hooks/scripts/artifact-write-tracker.sh:21,30-32` — `file_path` already extracted; `get_project_root()` used only to *prepend* to a relative `file_path` (normalize direction, not root-from-path lookup) — excluded from scope, see Design Decisions.
- `ralph/hooks/scripts/drift-tracker.sh:21,33-34` — `file_path` already extracted; `get_project_root()` used only to *strip as a prefix* from an absolute `file_path` (normalize direction) — excluded from scope, see Design Decisions.
- `ralph/hooks/scripts/plan-postcondition.sh` and `ralph/hooks/scripts/research-postcondition.sh` — Stop hooks, no `tool_input.file_path` access at all (confirmed by the issue's own triage) — helper cannot apply, out of scope entirely.
- `ralph/hooks/scripts/__tests__/plan-research-required.test.sh` — the GH-1556 regression-test pattern to model new test files after: `SBX`/`REPO`/`NOGIT` sandbox dirs, a `run_case` helper that feeds crafted JSON on stdin and asserts exit code, three path-derived-rooting cases (workspace-root repro, fallback-preserved, fallback-positive) plus a relative-`file_path` no-hang case.
- `ralph/hooks/scripts/__tests__/artifact-write-tracker.test.sh:62-68` — existing coverage of `artifact-write-tracker.sh`'s normalize-direction behavior, confirming it is a different operation than root-from-path resolution.
- No existing test files for `impl-plan-required.sh` or `review-no-dup.sh` — this plan creates both (`impl-plan-required.test.sh`, `review-no-dup.test.sh`).
- `.github/workflows/ci.yml:112-127` (`test-hooks` job) — runs every `*.test.sh`/`test-*.sh` file under `ralph/hooks/scripts/__tests__` via `find | sort -z | xargs -0 -n1 bash`; new test files are picked up automatically, no workflow edit needed.
- `.github/workflows/ci.yml:263-274` (`shellcheck-hooks` job) — `ludeeus/action-shellcheck`, `scandir: ralph/hooks`, `severity: error`, `format: gcc`.

## Desired End State

1. `impl-plan-required.sh` computes both its plan-search directory and its `## Plan Reference` existence check from a single `resolve_root_from_path "$file_path"` call, not `get_project_root()`.
2. `review-no-dup.sh` computes its critique-search directory from `resolve_root_from_path "$file_path"`, not `get_project_root()`.
3. `artifact-write-tracker.sh` and `drift-tracker.sh` are unchanged — confirmed out of scope (different operation: normalizing `file_path`, not resolving a root to search from).
4. `plan-postcondition.sh` and `research-postcondition.sh` are unchanged — confirmed out of scope (Stop hooks, no `tool_input.file_path`).
5. New regression test files (`impl-plan-required.test.sh`, `review-no-dup.test.sh`) reproduce the workspace-root mis-rooting scenario for each hook (target file's repo root wins over an unrelated `CLAUDE_PROJECT_DIR`) and prove the fallback tier still works when no `.git` ancestor exists.
6. No behavior change for any session where CWD/`CLAUDE_PROJECT_DIR` already equals the repo containing the target file — the common case today.

### Verification

- `bash ralph/hooks/scripts/__tests__/impl-plan-required.test.sh` and `bash ralph/hooks/scripts/__tests__/review-no-dup.test.sh` each report `0 failed`.
- `find ralph/hooks/scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \) -type f -print0 | sort -z | xargs -0 -n1 bash -c 'echo "=== $0 ==="; bash "$0"'` (CI's `test-hooks` invocation) passes for the full hook-test suite, including the two new files.
- `shellcheck` at `severity: error` (CI's `shellcheck-hooks` job, `scandir: ralph/hooks`) passes on both modified hook scripts.
- Manual: a session with CWD outside any repo, `CLAUDE_PROJECT_DIR` unset or pointed elsewhere, invoking each hook with a `file_path` under a real repo checkout that has a matching plan/critique doc — hook allows (previously would have false-blocked or false-allowed depending on which unrelated tree `get_project_root()` landed on).

## What We're NOT Doing

- Not migrating `artifact-write-tracker.sh` or `drift-tracker.sh`. Both use `get_project_root()` to *normalize* `file_path` (prepend the root to a relative path, or strip the root as a prefix from an absolute path) rather than to *resolve a root to search from* for a separate artifact. There is no second, file-path-keyed lookup in either hook that could be mis-rooted the way `plan-research-required.sh`'s research-doc search was — migrating them would change which root gets prepended/stripped with no corresponding bug to fix, and would risk altering `artifact-write-tracker.test.sh`'s already-passing "relative path normalized against CLAUDE_PROJECT_DIR" case for no benefit.
- Not touching `plan-postcondition.sh` or `research-postcondition.sh` — confirmed Stop hooks with no `tool_input.file_path` access; `resolve_root_from_path()` cannot apply.
- Not changing `resolve_root_from_path()` or `get_project_root()` themselves — both are correct and tested as of GH-1556; this issue is purely call-site migration.
- Not adding new shared helpers, schema changes, or workflow-file edits — the `test-hooks` CI job already globs all `__tests__/*.test.sh` files.
- Not revisiting the GH-1556 relative-path-guard or `.git`-marker-walk design decisions — both are settled and reused verbatim.

## Design Decisions & Open Ambiguities

- **`artifact-write-tracker.sh` / `drift-tracker.sh` scope** — options: (a) migrate speculatively for consistency; (b) exclude, since they normalize `file_path` rather than resolve-root-then-search. **Decided: exclude (b).** Confirmed by reading both hooks in full: `artifact-write-tracker.sh:30-32` prepends root to a relative `file_path` so a later Stop hook can `-f` check it from any CWD; `drift-tracker.sh:33-34` strips root as a prefix from an absolute `file_path` to compare against `RALPH_TASK_FILES`. Neither performs a directory search rooted away from `file_path`'s own tree — there is no mis-rooting bug to fix, only a superficial `get_project_root()` textual match. Moved to What We're NOT Doing above.
- **Single resolved-root variable vs. two calls in `impl-plan-required.sh`** — options: (a) call `resolve_root_from_path "$file_path"` twice (once per site), mirroring the literal line-for-line diff style; (b) compute it once into a variable and reuse it for both the `plans_dir` computation and the `## Plan Reference` check. **Decided: (b), compute once.** Both sites need the same root for the same `file_path`; computing once avoids a redundant walk and matches the existing local-variable style already used in the file (`plans_dir`, `alt_ticket_id`).

None — no open design decisions.

## Implementation Approach

Two independent phases, each touching a disjoint hook script plus its own new test file. Both can run in parallel — no shared files, no ordering dependency. Each phase: swap the call site(s) to `resolve_root_from_path "$file_path"`, add a new `__tests__` file modeled on `plan-research-required.test.sh`'s sandbox harness, run the full hook-test suite plus shellcheck.

## Phase 1: Migrate impl-plan-required.sh

depends_on: null

### Overview

Root `impl-plan-required.sh`'s plan-search directory and `## Plan Reference` existence check off the Write/Edit target's own `file_path` instead of session CWD/`CLAUDE_PROJECT_DIR`, and add regression test coverage.

### Changes Required

#### 1. Rewire the plans-dir and plan-reference lookups
**File**: `ralph/hooks/scripts/impl-plan-required.sh`
**Changes**: Introduce one resolved-root variable and use it at both existing `get_project_root()` call sites. Replace line 43:

```bash
plans_dir="$(get_project_root)/thoughts/shared/plans"
```

with:

```bash
project_root="$(resolve_root_from_path "$file_path")"
plans_dir="$project_root/thoughts/shared/plans"
```

and replace lines 72-73:

```bash
    if [[ -f "$(get_project_root)/$local_path" ]]; then
      plan_doc="$(get_project_root)/$local_path"
    fi
```

with:

```bash
    if [[ -f "$project_root/$local_path" ]]; then
      plan_doc="$project_root/$local_path"
    fi
```

No other lines change — `file_path` is already extracted at line 22 (well before both use sites), and every consumer of `plans_dir`/`plan_doc` (the `find_existing_artifact` calls, the block message) is untouched.

#### 2. Regression test coverage
**File**: `ralph/hooks/scripts/__tests__/impl-plan-required.test.sh` (new)
**Changes**: Model on `plan-research-required.test.sh`'s sandbox harness (`SBX`/`REPO`/`NOGIT` dirs, `run_case` helper feeding crafted PreToolUse JSON, `CLAUDE_PROJECT_DIR` env override). Since this hook gates on `RALPH_COMMAND=impl` and requires a code file (not a `/thoughts/` or `/docs/` path) plus a ticket ID, every `run_case` invocation needs `RALPH_COMMAND=impl` and an explicit `RALPH_TICKET_ID` (to avoid CWD-derived ticket flakiness). Cases:
1. **Workspace-root repro**: `file_path` = `$REPO/src/foo.ts` (`$REPO/.git` present), a plan doc fixture at `$REPO/thoughts/shared/plans/2026-0X-GH-9-plan.md`, `CLAUDE_PROJECT_DIR="$SBX"` (unrelated, no matching plan under `$SBX`), `RALPH_TICKET_ID=GH-9` — expect allow (exit 0). Proves the plan lookup roots off the file's own repo, not the session env.
2. **Fallback-preserved control**: `file_path` = `$NOGIT/src/foo.ts` (no `.git` ancestor anywhere on its path), `RALPH_TICKET_ID=GH-1` where a plan doc fixture exists under `$SBX/thoughts/shared/plans/2026-0X-GH-1-plan.md`, `CLAUDE_PROJECT_DIR="$SBX"` — expect allow (exit 0). Proves the walk exhausts and falls back to `get_project_root()` (`$SBX`), preserving pre-migration behavior.
3. **Fallback negative control**: same `$NOGIT` file_path, `RALPH_TICKET_ID=GH-404` with no matching plan doc anywhere — expect block (exit 2).
4. **`## Plan Reference` path**: `file_path` = `$REPO/src/foo.ts`, no direct/group/stream plan doc, `RALPH_PLAN_REFERENCE` set to a GitHub blob URL whose `local_path` resolves under `$REPO/thoughts/shared/plans/...` (fixture present), `CLAUDE_PROJECT_DIR="$SBX"` (unrelated) — expect allow (exit 0). Proves the plan-reference existence check also roots off `$REPO`, not `$SBX`.

### Success Criteria

#### Automated Verification
- [x] `bash ralph/hooks/scripts/__tests__/impl-plan-required.test.sh` exits 0, all cases pass — 8 passed, 0 failed
- [x] `find ralph/hooks/scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \) -type f -print0 | sort -z | xargs -0 -n1 bash -c 'echo "=== $0 ==="; bash "$0"'` (CI's `test-hooks` job invocation) passes for the full hook-test suite — 15 files, 201 cases, 0 failed
- [x] `shellcheck` at `severity: error` (CI's `shellcheck-hooks` job, `scandir: ralph/hooks`) passes on `ralph/hooks/scripts/impl-plan-required.sh`

**Deviation found during implementation**: a "no ticket_id resolvable anywhere" case was not covered — the hook's CWD-grep ticket_id fallback (`grep -oE 'GH-[0-9]+' | head -1` with no `|| true`, when `RALPH_TICKET_ID` is unset) crashes under `set -euo pipefail` when no match is found, rather than falling through to `allow`. Pre-existing bug, unrelated to this migration's root-resolution scope — filed as a follow-up rather than fixed inline here.

#### Manual Verification
- [x] From a shell CWD'd outside any repo with `CLAUDE_PROJECT_DIR` unset, invoke the hook directly with a crafted PreToolUse JSON whose `file_path` points into a real repo checkout's source tree for a ticket with an existing plan doc under that repo's `thoughts/shared/plans/` — confirm exit 0

## Phase 2: Migrate review-no-dup.sh

depends_on: null

### Overview

Root `review-no-dup.sh`'s critique-search directory off the Write target's own `file_path` instead of session CWD/`CLAUDE_PROJECT_DIR`, and add regression test coverage.

### Changes Required

#### 1. Rewire the critique-dir lookup
**File**: `ralph/hooks/scripts/review-no-dup.sh`
**Changes**: Replace line 26:

```bash
project_root=$(get_project_root)
```

with:

```bash
project_root=$(resolve_root_from_path "$file_path")
```

No other lines change — `file_path` is already extracted at line 14, and the existing-critique search plus block message (lines 27-38) consume `$project_root` unchanged.

#### 2. Regression test coverage
**File**: `ralph/hooks/scripts/__tests__/review-no-dup.test.sh` (new)
**Changes**: Model on `plan-research-required.test.sh`'s sandbox harness. This hook early-allows any `file_path` not matching `thoughts/shared/reviews/` and any path with no `GH-NNN` token, so cases only need those two dimensions plus the rooting scenarios:
1. **Early-allow paths**: non-`reviews/` path allows; `reviews/` path with no `GH-NNN` token allows.
2. **Workspace-root repro**: `file_path` = `$REPO/thoughts/shared/reviews/2026-0X-GH-9-critique.md` (`$REPO/.git` present), no existing critique fixture under `$REPO`, `CLAUDE_PROJECT_DIR="$SBX"` (unrelated, and `$SBX` happens to already have a stray `GH-9` critique fixture) — expect allow (exit 0), proving the duplicate search happens against `$REPO` (empty) and not `$SBX` (which would have false-blocked).
2b. Companion true-duplicate case: same `$REPO` setup but with a matching critique fixture already under `$REPO/thoughts/shared/reviews/` — expect block (exit 2), proving the search does look in the right (file-path-derived) tree, not just always allowing.
3. **Fallback-preserved control**: `file_path` = `$NOGIT/thoughts/shared/reviews/2026-0X-GH-1-critique.md` (no `.git` ancestor), a critique fixture already exists under `$SBX/thoughts/shared/reviews/` for `GH-1`, `CLAUDE_PROJECT_DIR="$SBX"` — expect block (exit 2), proving the walk falls back to `get_project_root()` (`$SBX`) and finds the existing fixture, matching pre-migration behavior.

### Success Criteria

#### Automated Verification
- [x] `bash ralph/hooks/scripts/__tests__/review-no-dup.test.sh` exits 0, all cases pass — 4 passed, 0 failed
- [x] `find ralph/hooks/scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \) -type f -print0 | sort -z | xargs -0 -n1 bash -c 'echo "=== $0 ==="; bash "$0"'` (CI's `test-hooks` job invocation) passes for the full hook-test suite — 15 files, 201 cases, 0 failed
- [x] `shellcheck` at `severity: error` (CI's `shellcheck-hooks` job, `scandir: ralph/hooks`) passes on `ralph/hooks/scripts/review-no-dup.sh`

**Deviation found during implementation**: the "reviews/ path with no GH-NNN token allows" early-allow case was not covered — the hook's ticket_id regex extraction (`grep -oE 'GH-[0-9]+' | head -1` with no `|| true`) crashes the same way under `set -euo pipefail` when no match is found. Same class of pre-existing bug as Phase 1's finding, unrelated to this migration's root-resolution scope — filed as the same follow-up.

#### Manual Verification
- [x] From a shell CWD'd outside any repo with `CLAUDE_PROJECT_DIR` unset, invoke the hook directly with a crafted PreToolUse JSON whose `file_path` points into a real repo checkout's `thoughts/shared/reviews/` tree for a ticket with no existing critique there (even if an unrelated stray critique for the same ticket number exists elsewhere) — confirm exit 0

## Testing Strategy

### Unit Tests
Two new sandbox-harness test files (`impl-plan-required.test.sh`, `review-no-dup.test.sh`), each following the `plan-research-required.test.sh` pattern: `SBX`/`REPO`/`NOGIT` temp dirs, a `run_case` helper piping crafted JSON on stdin with `CLAUDE_PROJECT_DIR` and any needed env vars, asserting exit codes. Each file covers (a) the workspace-root repro proving `file_path`'s own repo wins over an unrelated `CLAUDE_PROJECT_DIR`, and (b) a fallback-preserved control proving the no-`.git`-ancestor case still resolves to `get_project_root()` exactly as before the migration. `impl-plan-required.test.sh` additionally covers the `## Plan Reference` path since it's a second, independent call site in the same file.

### Integration Tests
None — these are pure bash hook fixes; the sandbox-harness test files are both the unit and integration test surface, matching the GH-1556 precedent.

### Manual Testing Steps
1. Reproduce the workspace-root scenario for each hook per the Manual Verification checkboxes above.
2. Confirm each hook's block message (when it does fire) still embeds a sensible, file-path-rooted directory rather than a session-CWD-rooted one.

## Migration Notes

None needed. Both changes are additive and behavior-preserving: for any session where `CLAUDE_PROJECT_DIR`/CWD already equals the repo containing the target file — the common case today — `resolve_root_from_path()` returns the same value `get_project_root()` would have. The fallback branch (no `.git` ancestor found) reproduces the exact pre-migration behavior. No data migration, no config changes, no coordinated rollout with other hooks — Phase 1 and Phase 2 can land in either order or the same PR.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1564
- Prior issue/plan: https://github.com/cdubiel08/ralph-hero/issues/1556, `thoughts/shared/plans/2026-07-19-GH-1556-plan-research-required-file-path-rooting.md`
- Prior research: `thoughts/shared/research/2026-07-19-GH-1556-plan-research-required-cwd-misroot.md`
- `ralph/hooks/scripts/hook-utils.sh:43-45` (`get_project_root`), `:55-68` (`resolve_root_from_path`)
- `ralph/hooks/scripts/impl-plan-required.sh:22,43,72-73`
- `ralph/hooks/scripts/review-no-dup.sh:14,26`
- `ralph/hooks/scripts/artifact-write-tracker.sh:21,30-32` (excluded — normalize direction)
- `ralph/hooks/scripts/drift-tracker.sh:21,33-34` (excluded — normalize direction)
- `ralph/hooks/scripts/__tests__/plan-research-required.test.sh` (pattern to model new test files after)
- `ralph/hooks/scripts/__tests__/artifact-write-tracker.test.sh:62-68` (confirms artifact-write-tracker.sh's normalize-direction behavior)
- `.github/workflows/ci.yml:112-127` (`test-hooks` job), `:263-274` (`shellcheck-hooks` job)
