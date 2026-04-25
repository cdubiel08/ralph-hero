---
type: eval-scenarios
skill: ralph-val
date: 2026-04-25
status: defined
---

# Ralph-Val Eval Scenarios

Three scenarios used to grade the ralph-val skill on its three verdict outcomes (PASS, FIX, FAIL). Manual or future-automated execution should produce structured outputs that can be checked against the assertions below.

> **Execution note**: These scenarios are written but **not executed** by this audit. Manual eval runs are tracked outside the audit plan (see #566). When grading, dispatch the `val-agent` against a test issue matching the Input column and compare the actual `## Validation` comment + emitted verdict to the Assertions.

---

## Scenario A: PASS — all checks satisfied

### Input

An "In Progress" issue with the following shape:

- **Title**: "Add `--json` flag to `pipeline_dashboard`"
- **Estimate**: S
- **Plan document**: `thoughts/shared/plans/2026-04-NN-GH-NNN-pipeline-dashboard-json.md` with:
  - `## Desired End State` listing two outcomes (JSON output renders, default markdown unchanged).
  - Two phases each with `### Success Criteria > Automated Verification` checklists:
    - Phase 1: `- [ ] test -f plugin/ralph-hero/mcp-server/src/lib/dashboard-json.ts`, `- [ ] npm run build` (in `mcp-server/`).
    - Phase 2: `- [ ] npm test -- dashboard-json.test.ts`, `- [ ] grep -c "format: 'json'" plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` returns >= 1.
  - `## Drift Log — Phase 1` and `## Drift Log — Phase 2` comments on the issue noting one minor adaptation each (commit messages contain `DRIFT:` prefix).
- **Worktree**: `worktrees/GH-NNN` exists, branch `feature/GH-NNN`, fast-forward-pulls cleanly from `origin/main`.
- **Implementation state**: All four automated checks pass when run in the worktree. Drift commits exist with matching `DRIFT:` prefixes.

### Expected Behavior

1. Skill parses args, exports `RALPH_TICKET_ID="NNN"`.
2. Skill fetches issue via `get_issue` and locates the plan via Artifact Comment Protocol.
3. Skill enters worktree at `worktrees/GH-NNN` and runs `git fetch origin main && git pull --ff-only` — succeeds (worktree is fresh).
4. Skill extracts the four `Automated Verification` checks from the plan.
5. Skill runs each check from the worktree directory and records PASS for all four.
6. Skill runs Step 6.5 drift verification: parses `## Drift Log — Phase N` comments, matches each entry to a `DRIFT:` commit in the worktree git log.
7. Skill runs Step 6.6 cross-phase integration check (multi-phase plan): confirms Phase 1 outputs are imported by Phase 2 code.
8. Skill produces `VALIDATION PASS` verdict with the per-check breakdown and the drift summary.
9. Skill posts the verdict as a `## Validation` comment on the issue.

### Assertions

- [ ] Verdict line begins with `VALIDATION PASS`
- [ ] All four automated checks listed with `- [x]` and pass status
- [ ] Drift Analysis section present, lists phases with documented drift counts
- [ ] Cross-Phase Integration section present (multi-phase plan)
- [ ] `## Validation` comment posted on issue
- [ ] Workflow state NOT changed (val is read-only)
- [ ] No issues opened, no children advanced
- [ ] Worktree freshness check ran (git pull --ff-only succeeded)

---

## Scenario B: FIX — auto-fix command output

### Input

An "In Progress" issue with the following shape:

- **Title**: "Add markdown linter pre-commit hook to ralph-hero"
- **Estimate**: S
- **Plan document**: Single-phase plan with `Automated Verification` items including:
  - `- [ ] test -f .pre-commit-hooks/markdown-lint.sh`
  - `- [ ] bash -n .pre-commit-hooks/markdown-lint.sh`
  - `- [ ] prettier --check .pre-commit-hooks/markdown-lint.sh`
- **Worktree**: `worktrees/GH-NNN` exists, fresh.
- **Implementation state**: First two checks pass. `prettier --check` fails because the script has trailing whitespace and a missing final newline. The fix is purely mechanical (`prettier --write .pre-commit-hooks/markdown-lint.sh`).

### Expected Behavior

1. Skill runs all three automated checks.
2. Skill records `prettier --check` failure with command output captured.
3. Skill classifies the failure as **mechanical** (prettier provides a deterministic auto-fix).
4. Skill produces `VALIDATION FIX` verdict listing the auto-fix command (`prettier --write .pre-commit-hooks/markdown-lint.sh`).
5. Skill posts verdict comment with explicit fix-command guidance.

### Assertions

- [ ] Verdict line begins with `VALIDATION FIX`
- [ ] Failed check listed with `- [ ]` and the prettier command output
- [ ] Auto-fix command (`prettier --write ...`) explicitly named in the verdict body
- [ ] Failure classified as mechanical (not substantive)
- [ ] No substantive issues raised (no missing files, no failing functionality tests)
- [ ] `## Validation` comment posted with FIX in the header line
- [ ] Workflow state NOT changed

---

## Scenario C: FAIL — substantive criteria gap

### Input

An "In Progress" issue with the following shape:

- **Title**: "Add cross-project dashboard aggregation to `pipeline_dashboard`"
- **Estimate**: S
- **Plan document**: Two-phase plan. Phase 2 has an `Automated Verification` section with:
  - `- [ ] test -f plugin/ralph-hero/mcp-server/src/lib/cross-project-aggregation.ts`
  - `- [ ] npm test -- cross-project.test.ts`
  - `- [ ] grep "aggregateAcrossProjects" plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts` returns >= 1
- **Worktree**: `worktrees/GH-NNN` exists, fresh. Phase 1 fully implemented. Phase 2 partially implemented:
  - The `cross-project-aggregation.ts` file exists.
  - `cross-project.test.ts` has 5 tests; 2 fail because the aggregation function returns wrong data when given >2 projects.
  - The grep check passes.

### Expected Behavior

1. Skill runs all checks.
2. Skill records `npm test -- cross-project.test.ts` failure with the failing test names captured.
3. Skill classifies the failure as **substantive** (tests fail; not a deterministic auto-fix).
4. Skill produces `VALIDATION FAIL` verdict listing the substantive failure with specific failing test names.
5. Skill posts the verdict comment.

### Assertions

- [ ] Verdict line begins with `VALIDATION FAIL`
- [ ] Failing checks listed with `- [ ]` and captured test failure output
- [ ] Failure classified as substantive (named explicitly, NOT routed to FIX)
- [ ] Failing test names appear in the verdict body
- [ ] `## Validation` comment posted with FAIL in the header line
- [ ] Workflow state NOT changed (caller routes FAIL back to impl)
- [ ] No auto-fix command suggested (substantive failures require code changes)

---

## Grading Rubric

| Dimension | A (PASS) | B (FIX) | C (FAIL) |
|-----------|----------|---------|----------|
| Verdict | PASS | FIX | FAIL |
| Worktree freshness | git pull ran | git pull ran | git pull ran |
| Failure classification | N/A | Mechanical | Substantive |
| Auto-fix command surfaced | N/A | Yes | No (correctly absent) |
| Drift verification | Ran (multi-phase) | Optional | Optional |
| Cross-phase integration | Ran | Optional | Optional |
| Comment header | `## Validation` PASS | `## Validation` FIX | `## Validation` FAIL |
| Workflow state mutation | None | None | None |

A run is graded **PASS** if all `[ ]` assertions for its scenario hold. **FAIL** otherwise.

## Anti-Patterns to Watch For

1. **Stale worktree silently passes**: Validation runs against an outdated base because `git pull` was skipped (Phase 4 audit fix landed `git fetch && git pull --ff-only` — verify it ran).
2. **Missing-section silent skip**: A phase with no `Automated Verification` section is silently skipped instead of recorded as PASS-with-warning (Phase 4 audit fix).
3. **Mechanical/substantive misclassification**: `prettier --check` failure routed to FAIL instead of FIX, or a failing functional test routed to FIX instead of FAIL.
4. **Workflow state mutation**: Val is read-only. Any `save_issue` call with a new `workflowState` is a violation.
5. **Vestigial Task tool**: The skill body must NOT call `Task(...)` — Phase 4 removed `Task` from `allowed-tools`.
