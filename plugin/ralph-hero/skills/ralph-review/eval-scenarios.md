---
type: eval-scenarios
skill: ralph-review
date: 2026-04-25
status: defined
---

# Ralph-Review Eval Scenarios

Three scenarios used to grade the ralph-review skill on its primary verdict paths across both AUTO and INTERACTIVE modes. Manual or future-automated execution should produce structured outputs that can be checked against the assertions below.

> **Execution note**: These scenarios are written but **not executed** by this audit. Manual eval runs are tracked outside the audit plan (see #566). When grading, dispatch the `review-agent` against a test issue matching the Input column and compare actual output to the Assertions.

---

## Scenario A: AUTO mode approves a well-formed plan

### Input

A "Plan in Review" issue with the following shape:

- **Title**: "Add `--json` output to `pipeline_dashboard`"
- **Body**: Describes adding a `--json` flag that returns the dashboard as JSON instead of markdown. Implementation has clear scope and a single code path.
- **Estimate**: S
- **Plan document attached**: `thoughts/shared/plans/2026-04-NN-GH-NNNN-pipeline-dashboard-json.md` with:
  - Clear `## Overview` section.
  - 2 phases, each with `### Tasks` blocks.
  - Each task has `files`, `tdd`, `complexity`, `depends_on`, and `acceptance` fields populated.
  - `## Success Criteria` with `- [ ] Automated:` and `- [ ] Manual:` checkboxes.
  - `## What we're NOT doing` enumerates excluded scope.
  - All referenced files exist in the codebase.

The plan satisfies all five quality dimensions.

### Expected Behavior

1. Skill detects AUTO mode (`--review-plan auto` or default).
2. Skill picks the issue from "Plan in Review" via `list_issues` (profile: review-queue).
3. Skill fetches plan document via Artifact Comment Protocol.
4. Skill spawns the `general-purpose` critique subagent with the inline-criteria prompt (Step 4B).
5. Critique subagent assesses plan against five dimensions including **Dispatchability** and the Task Metadata Requirements table.
6. Critique subagent verifies referenced files exist (via `codebase-analyzer`).
7. Critique subagent writes critique document at `thoughts/shared/reviews/YYYY-MM-DD-GH-NNNN-critique.md` with status `approved`, body containing PASS for all five dimensions.
8. Critique subagent commits and pushes (commit message has closing quote — bug from research Discovery 10 fixed).
9. Critique subagent returns JSON with `result: "APPROVED"`, `issues: []`.
10. Skill routes to approval flow (Step 5): moves issue to "In Progress" via `save_issue` (workflowState `__COMPLETE__`).
11. Skill posts `## Plan Review` comment with `VERDICT: APPROVED` and a link to the critique document.

### Assertions

- [ ] Critique document created at `thoughts/shared/reviews/YYYY-MM-DD-GH-NNNN-critique.md`
- [ ] Critique frontmatter includes `status: approved`
- [ ] Critique body has one section per dimension (Completeness, Feasibility, Clarity, Scope, **Dispatchability**) — verifies the audit fix landed
- [ ] Returned JSON has `result: "APPROVED"`, `issues: []`
- [ ] Commit message in critique commit has matching open and close single quotes (no shell-syntax bug)
- [ ] Issue `workflowState` becomes "In Progress"
- [ ] Approval comment posted with `VERDICT: APPROVED`
- [ ] No `needs-iteration` label added
- [ ] Postcondition hook does NOT block

---

## Scenario B: AUTO mode flags an undispatchable plan

### Input

A "Plan in Review" issue with the following shape:

- **Title**: "Refactor MCP server tool registration for per-project filtering"
- **Body**: Describes a multi-file refactor. The attached plan is "well-written" by the four pre-Phase-3 dimensions (Completeness, Feasibility, Clarity, Scope) but **fails Dispatchability**:
  - Tasks list **only** the file paths and one-sentence descriptions.
  - **No `files` field with create/modify/read tags** — a free-text paragraph is used instead.
  - **No `tdd` flag**.
  - **No `complexity` field**.
  - **No `depends_on` declarations**.
  - **No `acceptance` checkboxes** — descriptions blend rationale and verification into prose.
- **Estimate**: S
- **Plan document attached**: A plan that pre-audit would have been APPROVED because the four legacy dimensions all pass.

This is the regression scenario for research Discovery 1.

### Expected Behavior

1. Skill detects AUTO mode and picks the issue.
2. Critique subagent reads the plan and assesses all FIVE dimensions per the inlined criteria.
3. Critique subagent finds Completeness/Feasibility/Clarity/Scope = PASS.
4. Critique subagent finds **Dispatchability = FAIL** because tasks are missing required metadata fields (the Task Metadata Requirements table in the prompt enumerates each field).
5. Critique subagent writes critique with `status: needs-iteration` and a Dispatchability section listing the specific missing fields per task.
6. Critique subagent returns JSON with `result: "NEEDS_ITERATION"`, `issues: ["Tasks lack files/tdd/complexity/depends_on/acceptance metadata", ...]`.
7. Skill routes to rejection flow (Step 5):
   - Adds `needs-iteration` label (preserving existing labels).
   - Moves issue to "Ready for Plan" via `save_issue`.
   - Posts `## Plan Review` comment with `VERDICT: NEEDS_ITERATION`, listing the dispatchability gaps.

### Assertions

- [ ] Critique document created with `status: needs-iteration`
- [ ] Critique body's Dispatchability section is **FAIL** with specific missing-field references (file path or task name + which field is missing)
- [ ] Returned JSON has `result: "NEEDS_ITERATION"` and a non-empty `issues` array
- [ ] At least one `issues[]` entry mentions task metadata (files/tdd/complexity/depends_on/acceptance)
- [ ] Issue `workflowState` becomes "Ready for Plan"
- [ ] `needs-iteration` label added (existing labels preserved)
- [ ] Comment posted with `VERDICT: NEEDS_ITERATION`
- [ ] **Pre-Phase-3 regression check**: Without the audit fix, this plan would have been APPROVED. With the fix, it must be NEEDS_ITERATION.

---

## Scenario C: INTERACTIVE mode captures rich rejection feedback with free-text

### Input

A "Plan in Review" issue with the following shape:

- **Title**: "Add Postgres backend option to ralph-knowledge"
- **Body**: Describes adding a Postgres adapter alongside the existing SQLite layer.
- **Estimate**: S
- **Plan document attached**: A plan that the human reviewer judges to have the WRONG APPROACH (e.g., proposes a parallel-storage migration instead of a behind-a-flag adapter pattern that would let users opt in).

The reviewer has read the plan, has specific feedback ("the plan should follow the storage-adapter pattern from `landcrawler-ai`'s queue layer; see `queue-adapter.ts` for the pattern"), and wants to capture this richer-than-categories context.

### Expected Behavior

1. Skill detects INTERACTIVE mode (`--interactive` flag or `RALPH_REVIEW_PLAN=interactive`).
2. Skill picks the issue.
3. Skill fetches plan document.
4. Skill **displays the plan summary block** (title, phase count, estimate, plan path, top-level Success Criteria, What we're NOT doing) — verifies the audit fix from research Discovery 4.
5. Skill presents the verdict picker (`AskUserQuestion` with 5 options).
6. Reviewer selects "Major Changes".
7. Skill presents the Issues multi-select picker.
8. Reviewer selects "Wrong approach".
9. Skill presents the **free-text follow-up picker** ("Type details" / "Skip") — verifies the audit fix from research Discovery 5.
10. Reviewer chooses "Type details" and provides:
    > "Plan should follow the storage-adapter pattern from landcrawler-ai (`src/queue/queue-adapter.ts`). Wrap the SQLite layer behind an interface and add a Postgres implementation as a sibling. Avoids parallel migration risk."
11. Skill writes a comment combining category + free text:
    ```markdown
    ## Plan Review

    VERDICT: NEEDS_ITERATION

    Categories: Wrong approach

    **Reviewer notes**:
    Plan should follow the storage-adapter pattern from landcrawler-ai (`src/queue/queue-adapter.ts`). Wrap the SQLite layer behind an interface and add a Postgres implementation as a sibling. Avoids parallel migration risk.

    [INTERACTIVE]: Based on human feedback.

    Label `needs-iteration` added.

    Run `/ralph-plan NNN` to address these issues and update the plan.
    ```
12. Skill adds `needs-iteration` label and moves issue to "Ready for Plan".

### Assertions

- [ ] Plan summary block printed before the verdict picker (contains plan title, phase count, plan path, Success Criteria preview)
- [ ] `AskUserQuestion` invoked at least 3 times: verdict picker, issues multi-select, free-text follow-up picker
- [ ] Free-text picker presents "Type details" and "Skip" options
- [ ] Final GitHub comment includes a `**Reviewer notes**` (or equivalent free-text) section with the actual reviewer text — not just category labels
- [ ] Free-text content is NOT silently dropped if reviewer chose "Type details"
- [ ] Issue `workflowState` becomes "Ready for Plan"
- [ ] `needs-iteration` label added (existing labels preserved)
- [ ] **Pre-Phase-3 regression check**: Without the audit fix, the comment would only contain "Wrong approach" with no specific guidance. With the fix, the storage-adapter rationale must be in the comment body.

---

## Grading Rubric

| Dimension | A (AUTO approve) | B (AUTO reject — dispatchability) | C (INTERACTIVE rich reject) |
|-----------|------------------|-----------------------------------|-----------------------------|
| Mode detection | AUTO via default | AUTO via default | INTERACTIVE via flag |
| Five-dimension assessment | All PASS | Dispatchability = FAIL | N/A (human judgment) |
| Plan summary display | N/A | N/A | Block printed before picker |
| Free-text capture | N/A | N/A | Reviewer notes in comment |
| Verdict routing | APPROVED -> In Progress | NEEDS_ITERATION -> Ready for Plan | NEEDS_ITERATION -> Ready for Plan |
| Comment quality | Critique link included | Specific missing fields listed | Free-text rationale present |
| Commit syntax | Closing quote present | Closing quote present | N/A (no critique commit in INTERACTIVE) |
| Hook contracts | Postcondition passes | Postcondition passes | Postcondition passes |
| Label discipline | No new label | needs-iteration added | needs-iteration added |

A run is graded **PASS** if all `[ ]` assertions for its scenario hold. **FAIL** otherwise. Partial credit can be given for noting which assertions failed.

The **Dispatchability assertion in Scenario B** and the **free-text capture assertion in Scenario C** are the highest-priority post-Phase-3 regression tests — failing either means the audit fix did not stick.

## Anti-Patterns to Watch For

1. **Four-dimension regression**: Critique subagent reverts to the legacy four dimensions and approves a plan with missing task metadata (Scenario B fails silently).
2. **Commit-syntax bug returns**: AUTO commit fails because the inline `git commit -m '...'` lacks a closing quote (research Discovery 10).
3. **Plan-summary skipped**: INTERACTIVE picker appears without the summary block, leaving the reviewer to guess (Scenario C step 4).
4. **Free-text dropped**: Reviewer types details but the comment still only contains category labels.
5. **ESCALATE silently treated as NEEDS_ITERATION**: Critique subagent encounters a contradiction-grade issue but routes to NEEDS_ITERATION instead of using the new ESCALATE verdict path. Verify by inspecting whether `Human Needed` workflow state is ever exercised.
6. **Task tool used after removal**: Skill body or agent attempts to call `Task(...)` instead of `Agent(...)`. Phase 3 removed `Task` from `allowed-tools`; any usage should fail at the runtime allowlist.
