---
type: eval-scenarios
skill: ralph-merge
date: 2026-04-25
last_updated: 2026-05-05
status: defined
---

# Ralph-Merge Eval Scenarios

Three scenarios used to grade the ralph-merge skill on its primary review-decision-guard and merge-mechanics paths: APPROVED merge, standalone safety rejection of unreviewed PRs, and the XS-no-review exception. Manual or future-automated execution should produce structured outputs that can be checked against the assertions below.

> **Architecture note (updated 2026-05-05 per GH-895):** ralph-merge is now a leaf merge-mechanics skill. Code review is the responsibility of the orchestrating caller (`finish` or `ralph-code-review`). Step 4 in ralph-merge is a small "Review Decision Guard" that rejects unreviewed PRs to preserve safety for standalone callers. Eval scenarios that previously exercised the in-merge code-review gate (auto-mode `CODE_REVIEW_FEEDBACK`, interactive `AskUserQuestion`) have been retired — those flows are now exercised by finish's eval scenarios.

> **Execution note**: These scenarios are written but **not executed** by this audit. Manual eval runs are tracked outside the audit plan (see #566). When grading, dispatch the `merge-agent` against a test issue matching the Input column and compare the actual output blocks (`MERGED`, `MERGE BLOCKED`) and the issue comments to the Assertions.

---

## Scenario A: APPROVED → merge

### Input

An "In Review" issue with the following shape:

- **Title**: "Add `--json` flag to `pipeline_dashboard`"
- **Estimate**: S
- **PR**: An open PR exists at `feature/GH-NNN`, `mergeable: MERGEABLE`, `reviewDecision: APPROVED` (a reviewer has explicitly approved on GitHub).
- **Worktree**: `worktrees/GH-NNN` exists.

### Expected Behavior

1. Skill parses args, fetches issue, confirms state is "In Review".
2. Skill finds the PR via `gh pr list --head feature/GH-NNN`.
3. Skill enters Step 4 Review Decision Guard — `reviewDecision == APPROVED` — proceeds immediately to Step 4a.
4. Step 4a Autonomous Merge Gate is skipped (`RALPH_AUTO_MERGE` unset). Falls through to Step 5.
5. Step 5 single `gh pr view` call returns `state: OPEN`, `mergeable: MERGEABLE`, `mergedAt: null`. Branch B (readiness) routes to Step 6.
6. Skill runs `./scripts/merge-pr.sh PR_NUMBER GH-NNN` to merge and clean up the worktree.
7. Skill calls `save_issue(number=NNN, workflowState="Done", command="ralph_merge")` to advance the standalone issue.
8. Skill posts `## Merged` comment on the issue.
9. Skill runs Step 9a cross-repo unblock check (informational; no cross-repo dependents in this scenario).
10. Skill outputs `MERGED` block with PR URL.

### Assertions

- [ ] PR merged on GitHub (`gh pr view --json state` returns `MERGED`)
- [ ] Worktree directory removed (cleanup ran)
- [ ] Issue workflow state advanced to "Done" via `save_issue`
- [ ] State gate hook (`merge-state-gate.sh`) does NOT block the Done transition
- [ ] `## Merged` comment posted on issue
- [ ] `MERGED` output block emitted with PR URL
- [ ] No `MERGE BLOCKED` output (PR was approved)
- [ ] Single `gh pr view` call in Step 5 (Step 9b detection consolidated per Phase 4 audit)

---

## Scenario B: Standalone unreviewed PR → MERGE BLOCKED

### Input

An "In Review" issue with the following shape:

- **Title**: "Add cross-project dashboard aggregation to `pipeline_dashboard`"
- **Estimate**: S
- **PR**: An open PR at `feature/GH-NNN`, `mergeable: MERGEABLE`, `reviewDecision: null` (no review yet), 0 PR comments.
- **Worktree**: `worktrees/GH-NNN` exists.
- **Invocation**: standalone `just merge NNN` (NOT through finish).

### Expected Behavior

1. Skill parses args, fetches issue, confirms state is "In Review".
2. Skill finds PR via `gh pr list`.
3. Step 4 Review Decision Guard: `reviewDecision == null`. Estimate is `S` (not `XS`), so the XS exception does NOT apply.
4. Skill outputs `MERGE BLOCKED` block with reason "Code review required — invoke /ralph-hero:finish or /ralph-hero:ralph-code-review first" and stops.
5. Skill does NOT proceed to Step 4a/5/6/7 (no merge, no Done transition).

### Assertions

- [ ] No `Skill(...)` call to any code-review skill from inside ralph-merge (the skill's `allowed-tools` no longer permits `Skill`)
- [ ] Output block begins with `MERGE BLOCKED`
- [ ] Reason text mentions "Code review required" and "/ralph-hero:finish"
- [ ] PR NOT merged (`gh pr view --json state` still `OPEN`)
- [ ] Issue workflow state NOT changed (still "In Review")
- [ ] No `## Merged` comment posted
- [ ] State gate hook does NOT block (no `save_issue` call to gate)

---

## Scenario C: XS-no-review exception → merge

### Input

An "In Review" issue with the following shape:

- **Title**: "Bump octokit-graphql to 9.1.0"
- **Estimate**: XS
- **PR**: An open PR at `feature/GH-NNN`, `mergeable: MERGEABLE`, `reviewDecision: null` (no review yet), 0 PR comments.
- **Worktree**: `worktrees/GH-NNN` exists.

### Expected Behavior

1. Skill parses args, fetches issue, confirms state is "In Review".
2. Skill finds PR via `gh pr list`.
3. Step 4 Review Decision Guard: `reviewDecision == null`. Estimate is `XS` AND PR comment count is 0 — XS exception applies. Proceed to Step 4a.
4. Step 4a Autonomous Merge Gate is skipped (`RALPH_AUTO_MERGE` unset). Falls through to Step 5.
5. Step 5 readiness check passes; merge proceeds normally.
6. Skill outputs `MERGED` block with PR URL.

### Assertions

- [ ] No `MERGE BLOCKED` output (XS exception bypassed the guard)
- [ ] PR merged on GitHub
- [ ] Issue workflow state advanced to "Done"
- [ ] `## Merged` comment posted
- [ ] `MERGED` output block emitted

---

## Grading Rubric

| Dimension | A (APPROVED) | B (standalone unreviewed) | C (XS exception) |
|-----------|--------------|---------------------------|------------------|
| Review present | Yes (APPROVED) | No (null) | No (null) |
| Estimate | S | S | XS |
| PR comments | any | 0 | 0 |
| `code-review` skill invoked | No | No | No |
| AskUserQuestion invoked | No | No | No |
| Output status | MERGED | MERGE BLOCKED | MERGED |
| PR merged | Yes | No | Yes |
| Issue → Done | Yes | No | Yes |
| Step 5 single gh pr view | Yes | N/A (stops at Step 4) | Yes |

A run is graded **PASS** if all `[ ]` assertions for its scenario hold. **FAIL** otherwise.

## Anti-Patterns to Watch For

1. **Code-review skill invoked from ralph-merge**: ralph-merge no longer runs code review (per GH-895 Path B). Any `Skill(...)` invocation from inside ralph-merge is a regression — the skill's `allowed-tools` no longer permits `Skill`.
2. **AskUserQuestion in ralph-merge**: The interactive code-review prompt moved to finish. Any `AskUserQuestion` call from inside ralph-merge is a regression — the skill's `allowed-tools` no longer permits `AskUserQuestion`.
3. **Standalone PR merged without review**: Skill bypasses Step 4 guard on a non-XS unreviewed PR (Scenario B). The standalone safety guard is the only line of defense for `just merge` callers — it MUST refuse.
4. **XS exception applied to non-XS issue**: Skill applies the XS-no-review exception to an issue with estimate S/M/L/XL, allowing an unreviewed merge.
5. **Stale `advance_issue` invocation**: Skill body or agent attempts `advance_issue(...)` instead of `save_issue(workflowState=..., command="ralph_merge")`. Phase 4 removed `advance_issue` from `allowed-tools`.
6. **Duplicate `gh pr view` calls in Step 5 + Step 9b**: Phase 4 consolidated rejection detection into Step 5 single call. Multiple identical `gh pr view --json state,mergedAt` calls indicate the consolidation regressed.
7. **`advance_parent` carve-out exercised**: Hook script branches on `tool_name == *advance_parent*`. Phase 4 removed this dead code from `merge-state-gate.sh` — any reference indicates the audit fix regressed.
