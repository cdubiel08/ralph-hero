---
type: eval-scenarios
skill: ralph-merge
date: 2026-04-25
status: defined
---

# Ralph-Merge Eval Scenarios

Three scenarios used to grade the ralph-merge skill on its primary code-review-gate paths: APPROVED merge, auto-mode CHANGES_REQUESTED → CODE_REVIEW_FEEDBACK, and interactive prompt for unreviewed PR. Manual or future-automated execution should produce structured outputs that can be checked against the assertions below.

> **Execution note**: These scenarios are written but **not executed** by this audit. Manual eval runs are tracked outside the audit plan (see #566). When grading, dispatch the `merge-agent` against a test issue matching the Input column and compare the actual output blocks (`MERGED`, `CODE_REVIEW_FEEDBACK`, `MERGE BLOCKED`) and the issue comments to the Assertions.

---

## Scenario A: APPROVED → merge

### Input

An "In Review" issue with the following shape:

- **Title**: "Add `--json` flag to `pipeline_dashboard`"
- **Estimate**: S
- **PR**: An open PR exists at `feature/GH-NNN`, `mergeable: MERGEABLE`, `reviewDecision: APPROVED` (a reviewer has explicitly approved on GitHub).
- **Worktree**: `worktrees/GH-NNN` exists.
- **Review mode**: any (review is already approved, so mode does not matter).

### Expected Behavior

1. Skill parses args, fetches issue, confirms state is "In Review".
2. Skill finds the PR via `gh pr list --head feature/GH-NNN`.
3. Skill enters Step 4 Code Review Gate — `reviewDecision == APPROVED` — proceeds immediately to Step 5.
4. Step 5 single `gh pr view` call returns `state: OPEN`, `mergeable: MERGEABLE`, `mergedAt: null`. Branch B (readiness) routes to Step 6.
5. Skill runs `./scripts/merge-pr.sh PR_NUMBER GH-NNN` to merge and clean up the worktree.
6. Skill calls `save_issue(number=NNN, workflowState="Done", command="ralph_merge")` to advance the standalone issue.
7. Skill posts `## Merged` comment on the issue.
8. Skill runs Step 9a cross-repo unblock check (informational; no cross-repo dependents in this scenario).
9. Skill outputs `MERGED` block with PR URL.

### Assertions

- [ ] PR merged on GitHub (`gh pr view --json state` returns `MERGED`)
- [ ] Worktree directory removed (cleanup ran)
- [ ] Issue workflow state advanced to "Done" via `save_issue`
- [ ] State gate hook (`merge-state-gate.sh`) does NOT block the Done transition
- [ ] `## Merged` comment posted on issue
- [ ] `MERGED` output block emitted with PR URL
- [ ] No `CODE_REVIEW_FEEDBACK` or `MERGE BLOCKED` output (PR was already approved)
- [ ] No `Skill("code-review:code-review", ...)` invocation (review already exists)
- [ ] Single `gh pr view` call in Step 5 (Step 9b detection consolidated per Phase 4 audit)

---

## Scenario B: Auto-mode CHANGES_REQUESTED → CODE_REVIEW_FEEDBACK

### Input

An "In Review" issue with the following shape:

- **Title**: "Add cross-project dashboard aggregation to `pipeline_dashboard`"
- **Estimate**: S
- **PR**: An open PR at `feature/GH-NNN`, `mergeable: MERGEABLE`, `reviewDecision: null` (no human review yet).
- **Worktree**: `worktrees/GH-NNN` exists.
- **Review mode**: `RALPH_REVIEW_MODE=auto`.
- **`code-review:code-review` skill**: available.
- **Code-review outcome**: When invoked, the skill posts a CHANGES_REQUESTED review on the PR (it found a missing null-check that would crash on empty input).

### Expected Behavior

1. Skill parses args, fetches issue, confirms state is "In Review".
2. Skill finds PR via `gh pr list`.
3. Step 4: `reviewDecision == null`. Mode is `auto`, skill is available. Skill invokes `Skill("code-review:code-review", "PR_NUMBER")` without prompting (PR_NUMBER, not issue number).
4. After review completes, skill re-checks `gh pr view --json reviewDecision` — now `CHANGES_REQUESTED`.
5. Skill outputs `CODE_REVIEW_FEEDBACK` status block (NOT `MERGE BLOCKED`) with the PR number and "Automated code review flagged issues — impl-agent fix cycle available" reason.
6. Skill stops — does NOT proceed to Step 5/6/7 (no merge, no Done transition).
7. The contract block at the top of Step 4 documents this output for the orchestrator (ralph-finish/ralph-hero).

### Assertions

- [ ] `Skill("code-review:code-review", "PR_NUMBER")` invoked exactly once (PR number, not issue number)
- [ ] After invocation, `gh pr view --json reviewDecision` re-checked
- [ ] Output block begins with `CODE_REVIEW_FEEDBACK` (NOT `MERGE BLOCKED`)
- [ ] Reason text mentions "impl-agent fix cycle available" (or equivalent)
- [ ] PR NOT merged (`gh pr view --json state` still `OPEN`)
- [ ] Issue workflow state NOT changed (still "In Review")
- [ ] No `## Merged` comment posted
- [ ] Caller-facing contract table at the top of Step 4 lists `CODE_REVIEW_FEEDBACK` as a distinct status from `MERGE BLOCKED` (Phase 4 audit fix)
- [ ] State gate hook does NOT block (no `save_issue` call to gate)

---

## Scenario C: Interactive prompt for unreviewed PR

### Input

An "In Review" issue with the following shape:

- **Title**: "Add markdown linter pre-commit hook to ralph-hero"
- **Estimate**: S
- **PR**: An open PR at `feature/GH-NNN`, `mergeable: MERGEABLE`, `reviewDecision: null` (no review yet).
- **Worktree**: `worktrees/GH-NNN` exists.
- **Review mode**: `RALPH_REVIEW_MODE=interactive` (default).
- **`code-review:code-review` skill**: available.

### Expected Behavior

1. Skill detects no review and `interactive` mode.
2. Step 4 case 3 fires: skill presents `AskUserQuestion` with three options:
   - "Run code review" — invoke `Skill("code-review:code-review", "PR_NUMBER")`.
   - "Merge without review" — skip review, proceed to Step 5.
   - (default "Other" stop option provided by AskUserQuestion).
3. **Test variant 1 — user picks "Run code review"**: skill invokes the code-review skill. If approved, flow continues to Step 5 → merge → Done. If changes requested, output stops the merge and surfaces the review (note: in INTERACTIVE this is a manual stop, not `CODE_REVIEW_FEEDBACK`).
4. **Test variant 2 — user picks "Merge without review"**: skill skips Step 4 review, proceeds to Step 5 → merge → Done.
5. **Test variant 3 — user picks "Other"**: skill stops with no merge.

### Assertions

- [ ] `AskUserQuestion` invoked at least once with the three documented options
- [ ] Question header is "Code Review"
- [ ] Question text includes "This PR has no code review yet"
- [ ] **Variant 1 (run review)**: `Skill("code-review:code-review", "PR_NUMBER")` invoked with the PR number (not issue number)
- [ ] **Variant 2 (merge without review)**: PR merged, issue → Done, `## Merged` comment posted
- [ ] **Variant 3 (other/stop)**: PR NOT merged, issue stays in "In Review", no comment posted
- [ ] Skill does NOT auto-invoke `Skill("code-review:code-review", ...)` without prompting (interactive mode contract)
- [ ] State gate hook does NOT block any valid Done transition (Variant 2)
- [ ] No `advance_parent` carve-out exercised (Phase 4 audit removed dead code from `merge-state-gate.sh`)

---

## Grading Rubric

| Dimension | A (APPROVED) | B (auto CHANGES_REQUESTED) | C (interactive) |
|-----------|--------------|----------------------------|-----------------|
| Review present | Yes (APPROVED) | None initially | None initially |
| Mode | any | auto | interactive |
| `code-review` skill invoked | No | Yes (auto, no prompt) | Variant 1 only |
| AskUserQuestion invoked | No | No | Yes |
| Output status | MERGED | CODE_REVIEW_FEEDBACK | MERGED (V1 approved, V2) / nothing (V1 reject, V3) |
| PR merged | Yes | No | Variant-dependent |
| Issue → Done | Yes | No | Variant-dependent |
| Step 5 single gh pr view | Yes | N/A (stops at Step 4) | Variant-dependent |
| Description match | Yes (post-Phase-4 desc covers approved PRs) | Yes (post-Phase-4 desc covers unapproved too) | Yes |

A run is graded **PASS** if all `[ ]` assertions for its scenario hold. **FAIL** otherwise. Variant-specific assertions in Scenario C are graded independently per variant.

## Anti-Patterns to Watch For

1. **`CODE_REVIEW_FEEDBACK` reported as `MERGE BLOCKED`**: Skill outputs the wrong status in auto mode + CHANGES_REQUESTED (Scenario B). Orchestrators handling only `MERGE BLOCKED` lose the auto-fix routing.
2. **Issue-number passed instead of PR-number**: `Skill("code-review:code-review", "ISSUE_NUMBER")` invoked. Should always pass PR number.
3. **Stale `advance_issue` invocation**: Skill body or agent attempts `advance_issue(...)` instead of `save_issue(workflowState=..., command="ralph_merge")`. Phase 4 removed `advance_issue` from `allowed-tools`.
4. **Description misleads caller**: Description still says "Merge an approved pull request" implying pre-approval (Phase 4 audit fix replaced with "Merge a pull request after code review").
5. **Duplicate `gh pr view` calls in Step 5 + Step 9b**: Phase 4 consolidated rejection detection into Step 5 single call. Multiple identical `gh pr view --json state,mergedAt` calls indicate the consolidation regressed.
6. **`advance_parent` carve-out exercised**: Hook script branches on `tool_name == *advance_parent*`. Phase 4 removed this dead code from `merge-state-gate.sh` — any reference indicates the audit fix regressed.
7. **Auto mode prompts user**: In auto mode, skill MUST NOT call `AskUserQuestion`. Any prompt invocation in auto + skill-available is a violation.
