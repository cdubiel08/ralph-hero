---
date: 2026-05-09
status: draft
type: plan
tags: [testing, hooks, ci, state-machine, bash]
github_issue: 1123
github_issues: [1123]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1123
primary_issue: 1123
parent_plan: thoughts/shared/plans/2026-05-07-GH-1118-test-coverage-hardening-epic.md
---

# Phase 5: Hook Gate Tests for impl/pr/merge State Machine — Implementation Plan

## Prior Work

- builds_on:: [[2026-05-07-GH-1118-test-coverage-hardening-epic]]

## Overview

Single issue (XS/S) — single phase plan. Add 8 new `.test.sh` files under `plugin/ralph-hero/hooks/scripts/__tests__/` covering the highest-leverage gates that protect the workflow state machine. Each test mirrors the structure of `val-postcondition.test.sh` (mktemp dir, JSONL stdin via heredoc/echo, hand-rolled `assert_eq`, exit-code assertions). No new helper module; no changes to the hook scripts themselves.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1123 | Phase 5: Hook gate tests for impl/pr/merge state machine | S |

## Shared Constraints

Inherited from parent plan-of-plans (GH-1118):

- Tests assert **current** behavior — no refactors of the hook scripts. If a bug surfaces, file a follow-up issue.
- Pattern reference is `plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh:1-65`. Mirror its structure exactly: bash, `set -uo pipefail`, `SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/<script>.sh"`, `mktemp -d` test dir, hand-rolled `assert_eq` helper, final `[ "$FAIL" -eq 0 ]`.
- No new helper module — every test file is self-contained, the way `val-postcondition.test.sh` is. Duplication of the `assert_eq` block is intentional and matches the existing pattern.
- All hook scripts read JSON from stdin via `read_input` (sourced from `hook-utils.sh`). Test inputs are constructed inline with `jq -nc` or as literal JSON via `printf`/`echo`.
- Exit-code contract: `0 = allow`, `2 = block`. Tests assert exit codes only — they do not parse stderr text beyond optional non-empty checks.
- Files land at `plugin/ralph-hero/hooks/scripts/__tests__/<gate-name>.test.sh` and become discoverable by Phase 1's CI runner glob `plugin/ralph-hero/hooks/scripts/__tests__/*.test.sh` once #1119 lands.
- Phase 1 (#1119) is already CLOSED — these tests will execute in CI immediately on merge.

Phase-specific constraints discovered during research:

- Each gate has env-var inputs (e.g., `RALPH_COMMAND`, `RALPH_VALID_OUTPUT_STATES`, `RALPH_CURRENT_STATE`, `RALPH_REQUIRES_PLAN`, `RALPH_TICKET_ID`, `RALPH_WORKTREE_PATHS`). Tests must set/unset these explicitly per case to avoid leakage between cases. Use `env -u VAR` or local `unset` in each case.
- `pr-state-gate.sh` and `merge-state-gate.sh` use `allow_with_context` for the happy path which writes to stdout; tests must redirect stdout to `/dev/null` and assert on exit code only.
- `lock-claim-validator.sh` reads a sibling `ralph-state-machine.json` file via `SCRIPT_DIR` — tests must invoke the script in place (not copy) so `SCRIPT_DIR` resolves to the real hooks directory.

## Current State Analysis

`plugin/ralph-hero/hooks/scripts/__tests__/` currently contains 6 files. Only `val-postcondition.test.sh`, `cursor-advance-catch-up.test.sh`, and `record-activity.test.sh` follow the `*.test.sh` glob convention. The other three (`test-agent-phase-gate.sh`, `test-impl-branch-gate.sh`, `test-tier-detection.sh`) use a `test-*.sh` prefix and pre-date the convention; they are not in scope.

The 8 hook scripts under test, with their leading-comment behaviors:

1. **`impl-staging-gate.sh`** — PreToolUse(Bash). Blocks `git add -A`, `git add .`, `git add --all` when `RALPH_COMMAND=impl`. Allows `git add <file>` and `git add -u`. Non-impl commands short-circuit to allow.
2. **`impl-plan-required.sh`** — PreToolUse(Write|Edit). Blocks edits when `RALPH_REQUIRES_PLAN=true` (default) and no plan-doc context is present. Always allows writes under `/thoughts/` or `/docs/`. Allows when `RALPH_REQUIRES_PLAN=false`.
3. **`impl-state-gate.sh`** — PreToolUse(ralph_hero__save_issue). Validates `tool_input.workflowState` against `RALPH_VALID_OUTPUT_STATES` (default `In Progress,In Review,Human Needed`). Empty workflowState → allow.
4. **`impl-postcondition.sh`** — Stop. When `RALPH_COMMAND=impl`, asserts that work happened in a worktree path matching the ticket. When `RALPH_COMMAND` is unset/different → allow.
5. **`impl-worktree-gate.sh`** — PreToolUse(Write|Edit). When `RALPH_COMMAND=impl`, blocks writes outside the active worktree (paths from `RALPH_WORKTREE_PATHS`). Always allows writes under `/thoughts/` or `/docs/`. Non-impl → allow.
6. **`pr-state-gate.sh`** — PreToolUse(ralph_hero__save_issue). Validates against `RALPH_VALID_OUTPUT_STATES` (default `In Review,Human Needed`). Empty state → allow.
7. **`merge-state-gate.sh`** — PreToolUse(ralph_hero__save_issue). Validates against `RALPH_VALID_OUTPUT_STATES` (default `Done,Human Needed`). Empty state → allow.
8. **`lock-claim-validator.sh`** — PreToolUse(ralph_hero__save_issue). When the target state is a lock state and `RALPH_CURRENT_STATE` is already a lock state, blocks. Non-save-issue tool → allow.

`val-postcondition.test.sh` (the reference) has 8 test cases and totals 105 lines. Each new test will be similar in size (~60-110 lines).

### Key Discoveries

- All hooks `source "$(dirname "$0")/hook-utils.sh"` — invoking the script directly from the test (not copying it) is essential.
- `hook-utils.sh::read_input` consumes stdin once — tests must pipe JSON input on each invocation.
- `pr-state-gate.sh` accepts both `tool_input.workflowState` and `tool_input.targetState` — the existing alternate-key fallback should get a test case.
- `lock-claim-validator.sh` depends on `ralph-state-machine.json` co-located in `SCRIPT_DIR` — already present in the repo.

## Desired End State

After this phase lands:

1. 8 new test files exist under `plugin/ralph-hero/hooks/scripts/__tests__/` matching the `*.test.sh` glob.
2. Each file passes when run directly via `bash <path>`.
3. Each file passes under the Phase-1 CI job (`test-hooks` in `.github/workflows/ci.yml`).
4. Each file has at least 3 test cases covering: (a) one happy path → exit 0, (b) one block path → exit 2, (c) one short-circuit / env-guard / alternate-key path.
5. Intentionally regressing one of the gates locally (e.g., flipping a comparison) causes its test file to exit non-zero.
6. No hook script under `plugin/ralph-hero/hooks/scripts/` is modified.

### Verification

- [ ] `for t in plugin/ralph-hero/hooks/scripts/__tests__/*.test.sh; do bash "$t" || exit 1; done` exits 0
- [ ] `ls plugin/ralph-hero/hooks/scripts/__tests__/*.test.sh | wc -l` returns at least 11 (3 existing + 8 new)
- [ ] `grep -c '^assert_eq' plugin/ralph-hero/hooks/scripts/__tests__/<each-new>.test.sh` returns ≥ 3 per file
- [ ] CI `test-hooks` job is green on the PR

## What We're NOT Doing

- No changes to any `hook-utils.sh` or any hook script under test.
- No factoring out a shared `assert_eq` / `make_input` helper. Each test file stays self-contained per the existing pattern.
- No tests for the other ~60 hook scripts in the directory — out of scope for this phase.
- No CI wiring — Phase 1 (#1119) already wired the runner.
- No changes to `.github/workflows/ci.yml`.
- No `bats` rewrite — tests stay in plain bash to match the pattern.

## Implementation Approach

Single phase, eight near-identical test files. Order tasks to write `impl-staging-gate.test.sh` first as the canonical template (it has the simplest input shape — only `tool_input.command` and an env var), then fan out to the others. Splitting into 2 PRs (impl gates / pr+merge gates) is acceptable per the issue body, but the plan scopes a single PR.

---

## Phase 1: Add 8 hook gate test files

- **depends_on**: null

### Overview

Create 8 self-contained bash test files under `plugin/ralph-hero/hooks/scripts/__tests__/`. Each clones the structure of `val-postcondition.test.sh`, exercises the target hook script directly, and asserts exit codes for happy / block / short-circuit cases.

### Tasks

#### Task 1.1: impl-staging-gate.test.sh
- **files**: `plugin/ralph-hero/hooks/scripts/__tests__/impl-staging-gate.test.sh` (create), `plugin/ralph-hero/hooks/scripts/impl-staging-gate.sh` (read), `plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists and is executable bash following `val-postcondition.test.sh` structure (shebang, `set -uo pipefail`, `SCRIPT=...`, `mktemp -d`, `assert_eq`, final `[ "$FAIL" -eq 0 ]`)
  - [ ] Case A (happy): `RALPH_COMMAND=impl` + `tool_input.command="git add path/to/file.ts"` → exit 0
  - [ ] Case B (block): `RALPH_COMMAND=impl` + `tool_input.command="git add -A"` → exit 2
  - [ ] Case C (block): `RALPH_COMMAND=impl` + `tool_input.command="git add ."` → exit 2
  - [ ] Case D (short-circuit): `RALPH_COMMAND` unset (or non-impl) + `tool_input.command="git add -A"` → exit 0
  - [ ] Case E (allow `-u`): `RALPH_COMMAND=impl` + `tool_input.command="git add -u"` → exit 0
  - [ ] Running `bash plugin/ralph-hero/hooks/scripts/__tests__/impl-staging-gate.test.sh` exits 0

#### Task 1.2: impl-plan-required.test.sh
- **files**: `plugin/ralph-hero/hooks/scripts/__tests__/impl-plan-required.test.sh` (create), `plugin/ralph-hero/hooks/scripts/impl-plan-required.sh` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Case A (allow thoughts/): `tool_input.file_path="thoughts/shared/plans/foo.md"` → exit 0 regardless of plan presence
  - [ ] Case B (allow opt-out): `RALPH_REQUIRES_PLAN=false` + `tool_input.file_path="src/foo.ts"` → exit 0
  - [ ] Case C (block): `RALPH_REQUIRES_PLAN=true` (default) + `tool_input.file_path="src/foo.ts"` and the gate's "plan attached" condition not met → exit 2
  - [ ] Running the test file exits 0

#### Task 1.3: impl-state-gate.test.sh
- **files**: `plugin/ralph-hero/hooks/scripts/__tests__/impl-state-gate.test.sh` (create), `plugin/ralph-hero/hooks/scripts/impl-state-gate.sh` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Case A (happy default): no `RALPH_VALID_OUTPUT_STATES` + `tool_input.workflowState="In Review"` → exit 0
  - [ ] Case B (block default): no `RALPH_VALID_OUTPUT_STATES` + `tool_input.workflowState="Done"` → exit 2
  - [ ] Case C (empty state): `tool_input.workflowState=""` (or absent) → exit 0
  - [ ] Case D (custom override): `RALPH_VALID_OUTPUT_STATES="Done"` + `tool_input.workflowState="Done"` → exit 0
  - [ ] Running the test file exits 0

#### Task 1.4: impl-postcondition.test.sh
- **files**: `plugin/ralph-hero/hooks/scripts/__tests__/impl-postcondition.test.sh` (create), `plugin/ralph-hero/hooks/scripts/impl-postcondition.sh` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Case A (short-circuit): `RALPH_COMMAND` unset → exit 0 with any input
  - [ ] Case B (allow when ticket undeterminable): `RALPH_COMMAND=impl`, `RALPH_TICKET_ID` unset, cwd has no `GH-NNN` → exit 0
  - [ ] Case C (block or allow per script logic when worktree work missing): `RALPH_COMMAND=impl` + `RALPH_TICKET_ID=GH-9999` with no matching worktree → asserts the documented exit code from the script (read script body to confirm whether this path is exit 2)
  - [ ] Test file uses `mktemp -d` for any synthetic worktree fixtures
  - [ ] Running the test file exits 0

#### Task 1.5: impl-worktree-gate.test.sh
- **files**: `plugin/ralph-hero/hooks/scripts/__tests__/impl-worktree-gate.test.sh` (create), `plugin/ralph-hero/hooks/scripts/impl-worktree-gate.sh` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Case A (short-circuit): `RALPH_COMMAND` unset + `tool_input.file_path="/anywhere/foo.ts"` → exit 0
  - [ ] Case B (allow thoughts/): `RALPH_COMMAND=impl` + `tool_input.file_path="thoughts/foo.md"` → exit 0
  - [ ] Case C (allow in-worktree): `RALPH_COMMAND=impl` + `RALPH_WORKTREE_PATHS=/tmp/wt-1` + `tool_input.file_path="/tmp/wt-1/src/foo.ts"` → exit 0
  - [ ] Case D (block out-of-worktree): `RALPH_COMMAND=impl` + `RALPH_WORKTREE_PATHS=/tmp/wt-1` + `tool_input.file_path="/tmp/other/foo.ts"` → exit 2
  - [ ] Running the test file exits 0

#### Task 1.6: pr-state-gate.test.sh
- **files**: `plugin/ralph-hero/hooks/scripts/__tests__/pr-state-gate.test.sh` (create), `plugin/ralph-hero/hooks/scripts/pr-state-gate.sh` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Case A (happy default): `tool_input.workflowState="In Review"` → exit 0
  - [ ] Case B (happy alternate key): `tool_input.targetState="Human Needed"` (no `workflowState`) → exit 0
  - [ ] Case C (block): `tool_input.workflowState="Done"` → exit 2
  - [ ] Case D (empty state): no `workflowState` and no `targetState` → exit 0
  - [ ] Stdout/stderr from `allow_with_context` redirected to `/dev/null` so it does not pollute test output
  - [ ] Running the test file exits 0

#### Task 1.7: merge-state-gate.test.sh
- **files**: `plugin/ralph-hero/hooks/scripts/__tests__/merge-state-gate.test.sh` (create), `plugin/ralph-hero/hooks/scripts/merge-state-gate.sh` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Case A (happy default): `tool_input.workflowState="Done"` → exit 0
  - [ ] Case B (happy default): `tool_input.workflowState="Human Needed"` → exit 0
  - [ ] Case C (block): `tool_input.workflowState="In Review"` → exit 2
  - [ ] Case D (empty state): no state field → exit 0
  - [ ] Running the test file exits 0

#### Task 1.8: lock-claim-validator.test.sh
- **files**: `plugin/ralph-hero/hooks/scripts/__tests__/lock-claim-validator.test.sh` (create), `plugin/ralph-hero/hooks/scripts/lock-claim-validator.sh` (read), `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Case A (allow non-save-issue): `tool_name="Bash"` → exit 0
  - [ ] Case B (allow non-lock target): `tool_name="ralph_hero__save_issue"` + `tool_input.workflowState="In Review"` → exit 0
  - [ ] Case C (block double-lock): `tool_name="ralph_hero__save_issue"` + `tool_input.workflowState="In Progress"` + `RALPH_CURRENT_STATE="In Progress"` → exit 2
  - [ ] Case D (allow first-claim): `tool_name="ralph_hero__save_issue"` + `tool_input.workflowState="In Progress"` + `RALPH_CURRENT_STATE="Ready for Plan"` → exit 0
  - [ ] Test invokes the script in place (does not copy) so `SCRIPT_DIR` resolves to the real `ralph-state-machine.json`
  - [ ] Running the test file exits 0

#### Task 1.9: Local sweep + regression spot-check
- **files**: (none — verification only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8]
- **acceptance**:
  - [ ] `for t in plugin/ralph-hero/hooks/scripts/__tests__/*.test.sh; do bash "$t" || exit 1; done` exits 0
  - [ ] Manually flip one comparison in one hook script (e.g., negate the regex in `impl-staging-gate.sh`), run the corresponding test, confirm it exits non-zero, then revert the hook
  - [ ] No diff to any file outside `plugin/ralph-hero/hooks/scripts/__tests__/`

### Phase Success Criteria

#### Automated Verification:

- [ ] `bash` (each new test file) exits 0
- [ ] `for t in plugin/ralph-hero/hooks/scripts/__tests__/*.test.sh; do bash "$t" || exit 1; done` exits 0
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors (sanity, no source changes expected)
- [ ] `git diff --name-only main` shows only files under `plugin/ralph-hero/hooks/scripts/__tests__/`

#### Manual Verification:

- [ ] Spot-read each test file: assertions reflect the leading comment of the corresponding hook script
- [ ] Each test file has at least 3 `assert_eq` calls
- [ ] Local regression check: flipping one gate's comparison causes exactly that gate's test to fail (and only that one)

**Creates for next phase**: N/A (terminal phase of this plan; epic GH-1118 continues with #1121, #1122, #1125, #1126).

---

## Integration Testing

- [ ] Open the PR; observe the `test-hooks` CI job (wired in #1119) executes all 11 test files (3 existing + 8 new) and reports green
- [ ] CI `shellcheck` job continues to pass — new files conform to existing shell style

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1123
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1118
- Parent plan: thoughts/shared/plans/2026-05-07-GH-1118-test-coverage-hardening-epic.md (Phase 5)
- Phase-1 CI job (already merged): https://github.com/cdubiel08/ralph-hero/issues/1119
- Pattern reference: `plugin/ralph-hero/hooks/scripts/__tests__/val-postcondition.test.sh:1-65`
- Hook scripts under test: `plugin/ralph-hero/hooks/scripts/{impl-staging-gate,impl-plan-required,impl-state-gate,impl-postcondition,impl-worktree-gate,pr-state-gate,merge-state-gate,lock-claim-validator}.sh`
- Shared utilities: `plugin/ralph-hero/hooks/scripts/hook-utils.sh`
- State machine fixture: `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json`
