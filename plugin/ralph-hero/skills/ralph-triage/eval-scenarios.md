---
type: eval-scenarios
skill: ralph-triage
date: 2026-04-25
status: defined
---

# Ralph-Triage Eval Scenarios

Three scenarios used to grade the ralph-triage skill on its primary action branches. Manual or future-automated execution should produce structured outputs that can be checked against the assertions below.

> **Execution note**: These scenarios are written but **not executed** by this audit. Manual eval runs are tracked outside the audit plan (see #566). When grading, dispatch the `triage-agent` against a test issue matching the Input column and compare actual output to the Assertions.

---

## Scenario A: Duplicate detection — CLOSE

### Input

A Backlog issue with the following shape:

- **Title**: "Add markdown table support to project_hygiene tool output"
- **Body**: A request to render the `project_hygiene` MCP tool response as a markdown table with columns for category, count, and items. Issue references no prior work and has no parent.
- **Labels**: none
- **Estimate**: unset

The codebase already implements markdown table rendering for `project_hygiene` (verifiable via `Grep` for "project_hygiene" + "markdown" in `plugin/ralph-hero/mcp-server/src/tools/hygiene-tools.ts`). A search of recent issues finds a closed PR (#XYZ) that delivered the feature.

### Expected Behavior

1. Skill dispatches `codebase-locator` for "project_hygiene markdown table" and finds the existing implementation.
2. Skill searches GitHub issues by title keywords and finds the closed delivery PR.
3. Skill chooses **CLOSE** with destination state **Done** (already implemented), not Canceled.
4. Skill adds a comment explaining what was found and links the closed PR.
5. Skill applies `ralph-triage` label.
6. Skill sets `RALPH_TRIAGE_ACTION=CLOSE` via Bash.
7. Skill issues `save_issue` with `workflowState: "Done"` and `issueState: "CLOSED"` (reason: completed).

### Assertions

- [ ] `workflowState` becomes "Done" (not "Canceled")
- [ ] Comment present, mentions specific file path or PR number found
- [ ] Label `ralph-triage` present (existing labels preserved)
- [ ] Postcondition hook does NOT block (RALPH_TRIAGE_ACTION=CLOSE accepted)
- [ ] No sub-issues created
- [ ] No estimate change (CLOSE branch does not re-estimate)

---

## Scenario B: Valid new feature — RESEARCH

### Input

A Backlog issue with the following shape:

- **Title**: "Add SQLite WAL-mode auto-checkpoint configuration to ralph-knowledge"
- **Body**: Describes a feature request to expose a `WAL_AUTOCHECKPOINT_PAGES` env var that controls SQLite WAL checkpoint frequency. Notes that current default may cause WAL file growth on long-running sessions. Requests investigation of optimal defaults and whether this should be a runtime tunable.
- **Labels**: none
- **Estimate**: unset

The codebase has the SQLite layer in `plugin/ralph-knowledge/src/` but does not currently expose any WAL tuning. No similar issues exist in GitHub. The feature is plausible, scoped, and not a duplicate.

### Expected Behavior

1. Skill dispatches `codebase-locator` and confirms no existing implementation.
2. Skill searches GitHub for similar issues, finds none.
3. Skill assesses scope as needing investigation (not a simple known-good change).
4. Skill chooses **RESEARCH**.
5. Skill adds a comment indicating what specifically needs to be researched (e.g., "Investigate SQLite WAL checkpoint defaults; determine whether WAL_AUTOCHECKPOINT_PAGES should be runtime-tunable or compile-time fixed").
6. Skill applies `ralph-triage` label.
7. Skill sets `RALPH_TRIAGE_ACTION=RESEARCH` via Bash.
8. Skill issues `save_issue` with `workflowState: "Research Needed"`.

### Assertions

- [ ] `workflowState` becomes "Research Needed"
- [ ] Comment present, names the specific investigation topic
- [ ] Label `ralph-triage` present (existing labels preserved)
- [ ] Postcondition hook does NOT block (RALPH_TRIAGE_ACTION=RESEARCH accepted)
- [ ] Issue stays open (not closed)
- [ ] No sub-issues created (RESEARCH branch does not split)

---

## Scenario C: Large scope — SPLIT

### Input

A Backlog issue with the following shape:

- **Title**: "Refactor MCP server tool registration to support per-project tool filtering"
- **Body**: Describes a multi-part change covering: (1) new `tool-filter.ts` lib with allowlist/denylist parsing, (2) modifications to each `register*Tools()` call in `index.ts` to consume the filter, (3) new env var `RALPH_TOOL_FILTER`, (4) updated docs in CLAUDE.md, (5) tests for filter parsing edge cases.
- **Labels**: none
- **Estimate**: M (already estimated as M by submitter)

Codebase search confirms no existing tool filter mechanism. The scope clearly covers 3-4 distinct concerns that map to natural sub-issues.

### Expected Behavior

1. Skill confirms no existing implementation.
2. Skill identifies natural decomposition: (a) `tool-filter.ts` lib + tests, (b) `index.ts` integration, (c) env var + docs.
3. Skill calls `list_sub_issues` on the parent — confirms no existing children.
4. Skill chooses **SPLIT** and creates 3 sub-issues using the three-step pattern (create, link as sub-issue, set estimate=XS or S, workflow state Backlog).
5. Skill adds a summary comment to the parent listing the new sub-issues with brief titles.
6. Skill applies `ralph-triage` label to the parent.
7. Skill sets `RALPH_TRIAGE_ACTION=SPLIT` via Bash.
8. Parent issue remains in Backlog (NOT closed).

### Assertions

- [ ] At least 2 sub-issues created and linked under the parent (verify via `list_sub_issues`)
- [ ] Each sub-issue has estimate XS or S
- [ ] Each sub-issue has workflowState "Backlog"
- [ ] Parent's `workflowState` remains "Backlog" (not closed)
- [ ] Parent has summary comment listing the new children
- [ ] Label `ralph-triage` present on parent
- [ ] Postcondition hook does NOT block (RALPH_TRIAGE_ACTION=SPLIT accepted)
- [ ] If `create_issue` returns an error mid-split, skill retries with corrected parameters per the error-handling pattern in Step 5

---

## Grading Rubric

| Dimension | A | B | C |
|-----------|---|---|---|
| Action correctness | CLOSE chosen, Done destination | RESEARCH chosen | SPLIT chosen, parent unchanged |
| Reasoning quality | Comment cites specific evidence | Comment names research topic | Decomposition is natural, not forced |
| Hook contract | RALPH_TRIAGE_ACTION set | RALPH_TRIAGE_ACTION set | RALPH_TRIAGE_ACTION set |
| Side-effect hygiene | No sub-issues, no estimate churn | No sub-issues, no closure | Parent state preserved |
| Label discipline | Existing labels preserved | Existing labels preserved | Existing labels preserved |

A run is graded **PASS** if all `[ ]` assertions for its scenario hold. **FAIL** otherwise. Partial credit can be given for noting which assertions failed.
