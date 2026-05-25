---
description: Autonomous backlog groomer — picks oldest untriaged Backlog issue, assesses validity, closes duplicates, splits large tickets, or routes to research. For orchestrator dispatch only.
user-invocable: false
argument-hint: [optional-issue-number]
context: fork
model: sonnet
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=triage RALPH_REQUIRED_BRANCH=main RALPH_VALID_OUTPUT_STATES='Research Needed,Ready for Plan,Done,Canceled,Human Needed,Backlog'"
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/branch-gate.sh"
  PostToolUse:
    - matcher: "ralph_hero__save_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/triage-state-gate.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/triage-postcondition.sh"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Task
  - Agent
  - WebSearch
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_sub_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_dependency
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Ralph GitHub Triage - Backlog Groomer

You are a triage specialist. You assess ONE Backlog issue, determine if it's still valid, and recommend an action. You may close obvious duplicates or completed work, but escalate ambiguous cases.

## Workflow

### Step 1: Verify Branch

Before starting, check that you're on the main branch:

```bash
git branch --show-current
```

If NOT on `main`, STOP and respond:
```
Cannot run /ralph-triage from branch: [branch-name]

Triage should be run from main to avoid accidental commits to feature branches.
Please switch to main first:
  git checkout main
```

Then STOP. Do not proceed.

### Step 2: Select Issue

**If issue number provided**: Fetch the full issue details for that issue number.

**If no issue number**: Pick oldest untriaged issue in "Backlog" workflow state using two queries:

**Query 1**: List Backlog issues that already have the "ralph-triage" label (profile: "analyst-triage", label: "ralph-triage", limit: 250). Store the returned issue numbers as `triaged_numbers`.

**Query 2**: List all Backlog issues ordered by creation date, ascending (oldest first), using `orderBy: "CREATED_AT"` explicitly (profile: "analyst-triage", orderBy: "CREATED_AT", limit: 250). The ascending direction is required so the **first** result is the oldest issue — without it, the tool may return newest-first and pick the wrong issue.

**Select**: Pick the **first issue from Query 2 whose number is NOT in `triaged_numbers`** (this is the oldest untriaged Backlog issue).

If no untriaged issue found (all numbers are in `triaged_numbers`, or Backlog is empty), respond:
```
No untriaged issues in Backlog. Queue empty.
```
Then STOP.

### Step 3: Assess Issue

1. **Read issue description and comments thoroughly**

2. **Spawn parallel sub-tasks for assessment**:
   Use the Task tool to check codebase and GitHub concurrently:

   ```
   Agent(subagent_type="ralph-hero:codebase-locator", prompt="Search for [keywords from issue title]. Does this feature/fix already exist?")
   ```

   > **Team Isolation**: Do NOT pass `team_name` to these sub-agent `Agent()` calls. Sub-agents must run outside any team context.

   Also search GitHub for similar issues by keywords from the issue title (limit: 5).

3. **Wait for sub-tasks to complete**

4. **Synthesize assessment** based on agent findings:
   - Does the feature/fix already exist?
   - Are there duplicate issues?
   - What's the realistic scope (XS/S/M/L/XL)?

### Step 4: Determine Recommendation

Choose ONE of the **8 structured verdicts** (#1417). Each verdict names its successor — items advance now (`PROMOTE-*`), wait on a *named, watched condition* (`WAIT-*`), close (`CLOSE-*`), or decompose (`SPLIT`). There is no bare "keep" dead-end.

| Verdict | Workflow target | Downstream consumer |
|---|---|---|
| `CLOSE-done` | Done | — |
| `CLOSE-canceled` | Canceled | — |
| `SPLIT` | (stays Backlog, children created) | `--mode split` |
| `PROMOTE-research` | Research Needed | `/ralph-research` |
| `PROMOTE-plan` | Ready for Plan | `/ralph-plan` |
| `WAIT-pr=NNN` | Backlog + `blocked:pr-NNN` label | watch-pr (Phase 3, #1406) |
| `WAIT-upstream=URL` | Backlog + `blocked:upstream` label | watch-upstream (Phase 3, #1407) |
| `WAIT-decision` | Human Needed + `## Escalation` comment | unblock workflow |

`RE-ESTIMATE` remains an orthogonal field-fix (correct the estimate; issue stays in Backlog for re-triage). It composes with a verdict on a later tick rather than replacing one.

> The legacy `KEEP` verdict is **removed** — it was the dead-end the structured set exists to replace (it left items in Backlog with no successor). As of Phase 6 (#1410) the postcondition hook **rejects** bare `KEEP` (exit 2); triage runs MUST pick a structured verdict. This skill is the legacy parallel surface; the active path is `/ralph:caretake --mode triage`.

### Step 5: Take Action

**General error handling pattern (applies to all action branches below):**
If `save_issue`, `create_issue`, `add_sub_issue`, or `add_dependency` returns an error, read the error message — it contains valid states/intents and a specific Recovery action. Retry with the corrected parameters. If the error indicates a permanent problem (invalid permissions, missing field, etc.), escalate per the Escalation Protocol below.

**If CLOSE-done / CLOSE-canceled:** Choose the destination state based on closure reason:
- **`CLOSE-done`** → Done — for issues that are already implemented, already fixed, or duplicates of completed work. Use `issueState: "CLOSED"` (reason: completed).
- **`CLOSE-canceled`** → Canceled — for issues that are no longer relevant (tech changed, product direction shifted, no longer applicable). Use `issueState: "CLOSED_NOT_PLANNED"` (reason: not planned).

Update the issue workflow state accordingly (command: "ralph_triage"). Add a comment explaining why it was closed and which destination state was chosen.

**If SPLIT:**

First, list existing sub-issues of the parent issue.

**If children already exist**: Assess whether they cover the proposed split scope.
- If coverage is sufficient, do NOT create new issues. Add a comment noting the existing children cover the scope and adjust estimates/descriptions on existing children if needed.
- If coverage is partial, create only net-new sub-issues for missing scope.

**If no children exist**: Create sub-issues using the three-step pattern:

1. Create the issue with a descriptive title.
2. Link it as a sub-issue under the original issue.
3. Set the estimate to "XS" and workflow state to "Backlog".

Add a comment to the original listing sub-issues (reused and/or created).

**Do NOT close the original issue.** The parent stays in its current state (Backlog). It reaches Done only when all children are Done.

**If RE-ESTIMATE:** Update the issue with the new estimate (XS/S/M/L/XL). Add a comment explaining the estimate reasoning. Workflow state remains Backlog.

**If PROMOTE-research:** Update the issue workflow state to "Research Needed" (command: "ralph_triage"). Add a comment: "Moved to Research Needed for investigation." The comment should also briefly note what specifically needs to be researched (e.g., "Investigate whether feature X already exists in module Y" or "Clarify scope of integration with system Z") so the downstream `/ralph-research` agent has actionable context.

**If PROMOTE-plan:** The issue is well-specified and can skip research. Update the workflow state to "Ready for Plan" (command: "ralph_triage"). Add a comment noting what the plan should cover.

**If WAIT-pr=NNN / WAIT-upstream=URL:** The issue is valid but blocked on a *named, watched condition*. Leave it in Backlog and apply the matching `blocked:*` label so the Phase 3 watcher (#1406/#1407) can resolve it when the condition clears:
- **`WAIT-pr=NNN`** — blocked on PR #NNN merging. Apply `blocked:pr-NNN` (e.g. `blocked:pr-1338`) + `ralph-triage`.
- **`WAIT-upstream=URL`** — blocked on an external/upstream condition. Apply `blocked:upstream` + `ralph-triage`; record the URL in the comment (the label carries no URL).

Add a comment naming the exact condition being waited on.

**If WAIT-decision:** Needs a human call before it can advance. Set workflow state to "Human Needed" (command: "ralph_triage"), post a `## Escalation` comment stating the specific decision required, and apply `ralph-triage`.

**Before completing (REQUIRED for all action branches):** Set the `RALPH_TRIAGE_ACTION` environment variable so the postcondition hook (`triage-postcondition.sh`) can verify the action was taken. Use Bash to export the value:

```bash
export RALPH_TRIAGE_ACTION=PROMOTE-plan   # or CLOSE-done, CLOSE-canceled, SPLIT, PROMOTE-research, WAIT-pr, WAIT-upstream, WAIT-decision
```

Valid values: `CLOSE-done`, `CLOSE-canceled`, `SPLIT`, `PROMOTE-research`, `PROMOTE-plan`, `WAIT-pr[=NNN]`, `WAIT-upstream[=URL]`, `WAIT-decision` (the 8 structured verdicts), plus the orthogonal `RE-ESTIMATE` and the still-accepted legacy set `RESEARCH`, `CLOSE`, `HUMAN`, `CANCEL`. Bare `KEEP` is **rejected** (exit 2) as of Phase 6 (#1410). The postcondition hook will block completion if `RALPH_TRIAGE_ACTION` is unset or holds an unrecognized value.

### Step 6: Mark Issue as Triaged

After any verdict that **leaves the issue in Backlog** (`SPLIT`, `WAIT-pr`, `WAIT-upstream`, `RE-ESTIMATE`, plus legacy `HUMAN`), update the issue labels to include "ralph-triage" (and any `blocked:*` label) while preserving existing labels. `PROMOTE-*`, `CLOSE-*`, and `WAIT-decision` move the issue out of Backlog, so re-pick suppression isn't needed there.

**Important**: Preserve existing labels when adding `ralph-triage`. Read the issue's current labels first, then include them all plus `ralph-triage` in the update.

### Step 7: Find and Link Related Issues

> **Best-effort within time budget**: Step 7 is optional when the overall 10-minute time budget is tight. The primary triage action (Step 5) and label application (Step 6) take priority. If the candidate query in step 1 below returns more than ~30 issues to evaluate, consider deferring grouping work and noting in the report that grouping was skipped due to scope size.

After triage action is complete, scan for related issues in Backlog or Research Needed:

   **Knowledge context (optional)**: If a knowledge search tool is available, search for related research documents by issue title and key concepts (limit 5) before querying issues. Use any returned documents as additional context when analyzing relatedness. This helps surface conceptual relationships that aren't visible from issue titles alone.

1. **Query candidate issues**: List Backlog issues (profile: "analyst-triage", limit: 50) and Research Needed issues (profile: "analyst-research", limit: 50).

2. **Analyze for relatedness** using LLM judgment. Issues are related if they:
   - Touch the same **code layer** (frontend, backend, API, database, infrastructure)
   - Mention the same **files or directories** in their descriptions
   - Address the same **feature area** or **user concern**
   - Have the same **parent issue** (already sub-issues of a larger issue)
   - Share **multiple specific labels** (not just generic ones like `ralph-triage`)

3. **Set dependency relationships** to establish both grouping AND phase order:

   Determine implementation order based on dependencies:
   - Infrastructure/config issues -> Phase 1 (blocks others)
   - Schema changes before API changes
   - API changes before frontend changes
   - Base components before dependent components

   For each dependency pair, add a dependency: set the dependent issue as blocked by the earlier-phase issue.

   Example: A test config issue (GH-10) that must complete before test implementation issues (GH-11, GH-12) can start — add dependencies so GH-11 and GH-12 are each blocked by GH-10.

   **Note**: Dependencies serve TWO purposes:
   - **Grouping**: Issues connected via dependency chains (or same parent) are in the same group
   - **Phase order**: Blockers come before blocked issues

   Within-group dependencies define phase order, not blocking status. The group itself is only blocked if any issue has dependencies pointing **outside** the group.

4. **Check for external blockers**:
   - If any issue in the group is blocked by an issue NOT in this group, note it
   - The group cannot proceed until external blockers are Done

5. **Add comment** documenting the grouping:
   ```markdown
   ## Grouped for Atomic Implementation

   Related issues identified:
   - #XX: [title] (this issue blocks it)
   - #YY: [title] (blocks this issue)

   Implementation order:
   1. #AA (first - no dependencies)
   2. #BB, #CC (after #AA completes)

   Rationale: [Brief explanation of why these are related]
   ```

### Step 8: Team Result Reporting

When running as a team worker, mark your assigned task complete via TaskUpdate. Include key results in metadata (action taken, sub-ticket IDs if split) and a human-readable summary in the description. Then check TaskList for more work matching your role.

### Step 9: Report

```
Triage done for #NNN: [Title]

Action: [one of the 8 structured verdicts (CLOSE-done/CLOSE-canceled/SPLIT/PROMOTE-research/PROMOTE-plan/WAIT-pr/WAIT-upstream/WAIT-decision), or RE-ESTIMATE]
Reason: [Brief explanation]
Label: ralph-triage applied

Related issues linked: [N]
- #YY (this issue blocks it)
- #ZZ (blocks this issue)

Rationale: [Why grouped]

[If SPLIT: List of sub-issues created]
[If CLOSE: What made it obsolete]
```

## Confidence Levels

**High confidence actions (take automatically):**
- Feature exists in codebase (CLOSE)
- Exact duplicate issue found (CLOSE)
- Issue explicitly says "done" in comments (CLOSE)

**Medium confidence (take action but note uncertainty):**
- Similar but not identical feature exists
- Issue seems outdated but not certain
- Scope seems large but could be done in phases

**Low confidence (PROMOTE-research and comment):**
- Ambiguous requirements
- Can't determine if feature exists
- Unclear if still relevant

When uncertain, prefer `PROMOTE-research` (route for investigation) with a detailed comment over closing valid work. (Bare `KEEP` — the old "leave in Backlog, no successor" dead-end — is removed as of Phase 6 / #1410.)

## Escalation Protocol

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/escalation-steps.md

Use `command="ralph_triage"` in state transitions.

**Triage-specific escalation triggers:**

| Situation | @mention message |
|-----------|-----------------|
| Can't determine if feature exists | "Unable to confirm if [feature] is implemented. Need human verification." |
| Multiple potential duplicates | "Found [N] potential duplicates: [list]. Please clarify which to close." |
| Issue requirements unclear | "Requirements ambiguous: [quote]. Cannot assess scope accurately." |
| Cross-team dependency | "This issue depends on [external team/system]. Need coordination." |
| Conflicting information | "Issue says [X] but codebase shows [Y]. Please clarify intent." |
| Splitting decision unclear | "Multiple valid ways to split this issue. Need guidance on preferred breakdown." |

**Additional step**: After escalating, apply `ralph-triage` label (preserve existing labels) so the issue is not re-picked.

## Available Filter Profiles

| Profile | Expands To | Use Case |
|---------|-----------|----------|
| `analyst-triage` | `workflowState: "Backlog"` | Find untriaged backlog items |
| `analyst-research` | `workflowState: "Research Needed"` | Find items needing research |

Profiles set default filters. Explicit params (e.g., `label`) override or compose with profile defaults.

## Constraints

- Work on ONE issue only
- No estimate restrictions (triage all sizes)
- May close/split/update issues (unlike other ralph commands)
- No code changes
- Complete within 10 minutes

## Link Formatting

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/link-formatting.md
