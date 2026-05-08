---
date: 2026-05-07
status: draft
type: plan
github_issue: 1119
github_issues: [1119]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1119
primary_issue: 1119
parent_plan: thoughts/shared/plans/2026-05-07-GH-1118-test-coverage-hardening-epic.md
tags: [ci, testing, hooks, bash]
---

# Wire hook .test.sh suite into CI - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-07-GH-1118-test-coverage-hardening-epic]]

The parent epic plan-of-plans (#1118) decomposes test-coverage hardening into 8 phases. This plan executes **Phase 1** in isolation: it unblocks subsequent hook-gate test work (Phase 5, #1123) by making the existing hook tests visible to CI. No prior research document exists for this specific issue — context is inherited from the parent epic body and the existing test files on disk.

## Overview

Single atomic issue producing one focused PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1119 | Wire hook .test.sh suite into CI | XS |

**Why this is one phase**: Add a `test-hooks` job to `.github/workflows/ci.yml` that runs every `*.test.sh` and `test-*.sh` file under `plugin/ralph-hero/hooks/scripts/__tests__/`. Self-contained CI plumbing — no production code changes.

## Shared Constraints

Inherited from parent epic plan (#1118):

- **No production code refactors** while adding tests. Test additions only.
- **No new coverage tooling** beyond what is already in the repo (bash for hook tests, vitest for Node).
- **No skipping hooks** in commits (`--no-verify` etc.) — pre-commit must remain green.
- **Pinned third-party actions**: every `uses:` in CI must reference a commit SHA (matches existing `ci.yml` style), per `lint-workflows` zizmor rule for `unpinned-uses` (currently disabled at the rule level but the project still pins manually).

Feature-specific constraints discovered during planning:

- **Naming inconsistency in `__tests__/`**: 3 files use `*.test.sh` and 3 use `test-*.sh`. The runner must match both globs to reach the "6 existing test files" count quoted in the issue body. Do **not** rename files in this PR (out of scope per issue acceptance criteria).
- **Two assertion styles coexist**: some tests use `set -uo pipefail` and exit `[ "$FAIL" -eq 0 ]` (val-postcondition pattern); others use `set -euo pipefail` (test-tier-detection pattern). The runner must execute each file in a subshell so a `set -e` exit in one file does not abort the suite.
- **Bash 4+ required**: existing tests use `mapfile`/associative arrays in helpers (record-activity.test.sh fixture). GitHub `ubuntu-latest` ships bash 5.x — adequate. Do not add macOS bash 3.2 compatibility (CI is Linux-only).

## Current State Analysis

**Existing CI** (`.github/workflows/ci.yml`):
- 6 jobs total: `build-and-test-hero` (matrix Node 18/20/22), `build-and-test-demo`, `build-and-test-knowledge`, `test-cli` (bats), `lint-workflows` (actionlint+zizmor), `shellcheck-hooks`.
- `test-cli` (lines 112–129) is the closest analog: a single-purpose job running shell-based tests via `bats-core/bats-action`.
- `shellcheck-hooks` (lines 182–193) already scans `plugin/ralph-hero/hooks` with ShellCheck — confirms hooks dir is already a recognized CI target.

**Existing hook tests** (`plugin/ralph-hero/hooks/scripts/__tests__/`):
- `cursor-advance-catch-up.test.sh` — `set -uo pipefail`, `[ "$FAIL" -eq 0 ]` exit
- `record-activity.test.sh` — same pattern
- `val-postcondition.test.sh` — same pattern, uses `jq` heredocs
- `test-impl-branch-gate.sh` — different naming, uses `set -uo pipefail` in body
- `test-tier-detection.sh` — `set -euo pipefail`, sources `tier-detection.sh`
- `test-agent-phase-gate.sh` — `set -euo pipefail`

All 6 files exit non-zero on any assertion failure, so an aggregating runner can rely on per-file exit codes alone.

**Observed gap**: None of these are run by CI today. Local-only execution means regressions in hook scripts only surface during impl-agent runs.

## Desired End State

A new `test-hooks` job appears in CI, listed alongside `test-cli`. It checks out the repo, runs every `*.test.sh` and `test-*.sh` file in `plugin/ralph-hero/hooks/scripts/__tests__/`, prints per-file results, and exits non-zero if any test file exits non-zero.

### Verification

- [ ] `.github/workflows/ci.yml` defines a `test-hooks` job after `test-cli`
- [ ] On a PR that doesn't touch hook tests, `test-hooks` runs and passes
- [ ] Locally introducing a failing assertion in any of the 6 test files causes the job to exit non-zero on the next push
- [ ] The CI summary view shows `test-hooks` as a distinct job (not folded into another)
- [ ] `actionlint` (run by `lint-workflows`) accepts the new job

## What We're NOT Doing

- Writing any new hook tests (deferred to Phase 5 / #1123)
- Renaming `test-*.sh` files to `*.test.sh` for naming consistency (separate hygiene PR)
- Adding bats wrapper or shunit2 — keep raw bash to match existing pattern
- Touching the existing 6 test files
- Creating `_runner.sh` helper unless the inline loop proves unwieldy (prefer simplicity)
- Adding test runs to `pre-commit` hooks (CI-only this round)
- Hook-script ShellCheck changes (already covered by `shellcheck-hooks`)

## Implementation Approach

Single phase, single CI workflow file edit. The job is structurally similar to `test-cli` but uses a plain bash loop instead of `bats-action` since hook tests are plain bash scripts, not bats files.

The key design choice: an **inline `for` loop** over a `find` glob, executed in subshells. Captures each file's exit code, prints a summary, exits with the count of failing files. This matches the simplicity of the existing test files and avoids introducing a new harness file in scope.

---

## Phase 1: GH-1119 — Wire hook .test.sh suite into CI

- **depends_on**: null

### Overview

Add a `test-hooks` GitHub Actions job to `.github/workflows/ci.yml` that runs all hook test files under `plugin/ralph-hero/hooks/scripts/__tests__/` on every PR and push to main. The job must fail if any test file exits non-zero.

### Tasks

#### Task 1.1: Add `test-hooks` job to ci.yml

- **files**: `.github/workflows/ci.yml` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] New `test-hooks` job inserted after the `test-cli` job (after line 129) and before `lint-workflows`
  - [x] Job runs on `ubuntu-latest` with `permissions: contents: read` (or inherits the workflow-level `contents: read`)
  - [x] Step 1: `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5` (v4.3.1, matching existing pinned SHA in the same file)
  - [x] Step 2: "Run hook tests" step uses `bash` shell, contained inline (not a separate script file)
  - [x] Step 2 logic: `find plugin/ralph-hero/hooks/scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \) -type f -print0 | sort -z | xargs -0 -n1 bash -c 'echo "=== $0 ==="; bash "$0"; rc=$?; if [ $rc -ne 0 ]; then echo "FAIL: $0 exited $rc"; exit $rc; fi'`
    - Subshell-per-file isolation prevents `set -e` in one test from aborting the suite
    - `sort -z` ensures deterministic ordering across platforms
    - First non-zero exit propagates (xargs default behavior with `-n1` + `bash -c` returning rc)
  - [x] Step prints `=== <path> ===` header before each file so CI logs make per-file failure attribution trivial
  - [x] No `cd` into a subdirectory at the job level — paths are absolute relative to repo root (matches `shellcheck-hooks` pattern)
  - [x] No `node-version` / `cache` setup steps — bash + jq + find are pre-installed on `ubuntu-latest`

#### Task 1.2: Verify actionlint passes

- **files**: `.github/workflows/ci.yml` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [x] Running `actionlint .github/workflows/ci.yml` locally (or via the `lint-workflows` job) reports zero new errors
  - [x] No new `unpinned-uses` zizmor findings (confirmed by reusing the same pinned SHA already in the file)

### Phase Success Criteria

#### Automated Verification:

- [x] Open a draft PR; the `test-hooks` job appears in the CI status checks list
- [x] On that PR, `test-hooks` exits 0 with all 6 test files reporting their internal pass counts
- [x] `lint-workflows` job exits 0 (actionlint + zizmor accept the new job)
- [x] Locally simulate failure: temporarily change one assertion in `val-postcondition.test.sh` to `assert_eq "0" "1" "force fail"`, push, observe `test-hooks` exits non-zero with the failing file path printed. Revert before merging.

#### Manual Verification:

- [ ] CI summary on the PR shows `test-hooks` as its own check, alongside `test-cli`, `build-and-test-hero (18/20/22)`, etc.
- [ ] Job runtime is reasonable (< 30s) — the 6 test files combined run in ~2-3s locally; CI overhead is mostly checkout + runner spin-up.

**Creates for next phase**: A green CI signal for hook-gate regressions, which Phase 5 (#1123) builds on by adding 8 new hook gate tests.

---

## Integration Testing

- [ ] After merge, a routine PR that touches only docs (e.g., a `README.md` typo) still runs `test-hooks` and passes
- [ ] After merge, a PR that intentionally breaks one hook script (e.g., remove a function that a test asserts on) is caught by `test-hooks` before merge

## References

- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1118
- This issue: https://github.com/cdubiel08/ralph-hero/issues/1119
- Parent epic plan (forthcoming on main): `thoughts/shared/plans/2026-05-07-GH-1118-test-coverage-hardening-epic.md`
- Existing CI workflow: `.github/workflows/ci.yml:112-129` (test-cli pattern), `.github/workflows/ci.yml:182-193` (shellcheck-hooks pattern)
- Existing test pattern: `plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh`
- Existing test files (6 total):
  - `plugin/ralph-hero/hooks/scripts/__tests__/cursor-advance-catch-up.test.sh`
  - `plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh`
  - `plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh`
  - `plugin/ralph-hero/hooks/scripts/__tests__/test-impl-branch-gate.sh`
  - `plugin/ralph-hero/hooks/scripts/__tests__/test-tier-detection.sh`
  - `plugin/ralph-hero/hooks/scripts/__tests__/test-agent-phase-gate.sh`
