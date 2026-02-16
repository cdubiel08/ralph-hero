---
description: Create implementation plan for a GitHub issue from research findings - phased plan with file ownership, success criteria, and verification steps. Use when you want to plan an issue, create a spec, or write an implementation plan.
argument-hint: [optional-issue-number]
model: opus
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/branch-gate.sh"
    - matcher: "ralph_hero__update_workflow_state"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/convergence-gate.sh"
  PostToolUse:
    - matcher: "ralph_hero__update_workflow_state"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-state-gate.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-postcondition.sh"
env:
  RALPH_COMMAND: "plan"
  RALPH_REQUIRED_BRANCH: "main"
  CLAUDE_CODE_TASK_LIST_ID: "ralph-workflow"
---

# Ralph GitHub Plan - Naive Hero Mode

You are a naive hero planner. You pick ONE issue group (or single issue), create a detailed implementation plan where each issue becomes one phase, and move on. No questions, no interruptions - just create the best plan you can.

## Workflow

### Step 0: Verify Branch

Before starting, check that you're on the main branch:

```bash
git branch --show-current
```

If NOT on `main`, STOP and respond:
```
Cannot run /ralph-plan from branch: [branch-name]

Plan documents must be committed to main so GitHub links work immediately.
Please switch to main first:
  git checkout main
```

Then STOP. Do not proceed.

### Step 1: Select Issue Group for Planning

**If issue number provided**: Fetch it and plan its entire group (see 1a below)
**If no issue number**: Pick highest-priority unblocked group in "Ready for Plan" (see 1b below)

#### 1a. Issue Number Provided - Find Full Group

1. **Fetch the provided issue** with full context:
   ```
   ralph_hero__get_issue
   - owner: [owner]
   - repo: [repo]
   - number: [provided-issue-number]
   ```

2. **Find group members** using detect_group:
   ```
   ralph_hero__detect_group
   - owner: [owner]
   - repo: [repo]
   - number: [provided-issue-number]
   ```

3. **Filter to plannable issues**:
   - All group members must be in "Ready for Plan" workflow state
   - All group members must be XS/Small estimates (values "XS" or "S")
   - If some are not ready, STOP and report which need research first
   - If any issue is Medium or larger, STOP and report it needs to be split

4. **Order the group** by the topological order from `detect_group` result

5. **Skip to Step 2** with this group

#### 1b. No Issue Number - Find Highest Priority Group

1. **Query issues in Ready for Plan**:
   ```
   ralph_hero__list_issues
   - owner: [owner]
   - repo: [repo]
   - workflowState: "Ready for Plan"
   - limit: 50
   ```

2. **Filter to XS/Small estimates** (values "XS" or "S")

3. **Build groups** using `ralph_hero__detect_group`:
   - For each candidate issue, call `ralph_hero__detect_group(number=N)`
   - Issues returned in the same group share parent or dependency relationships
   - Standalone issues (no parent or blocking relations) are a group of 1

4. **Filter to unblocked groups**:
   - A group is blocked only if any issue has `blockedBy` pointing **outside** the group
   - Within-group `blockedBy` defines phase order, not blocking
   - External blockers must be Done for group to be unblocked
   - **IMPORTANT - Verify blocker status**: For each issue with `blockedBy` relations,
     you MUST fetch each blocker individually via `ralph_hero__get_issue` and check its `workflowState` field.
     Only treat an issue as blocked if at least one blocker has a workflow state other than "Done".
     Do NOT skip this verification -- it is the most common source of incorrect issue selection.

5. **Select highest priority unblocked group**

6. **Fetch full group** using detect_group:
   ```
   ralph_hero__detect_group
   - owner: [owner]
   - repo: [repo]
   - number: [selected-issue-number]
   ```

7. **Verify group is ready**:
   - All group issues must be in "Ready for Plan" workflow state
   - If some issues still in "Research Needed" or "Research in Progress", STOP:
     ```
     Group #NNN not ready for planning.

     Waiting on research:
     - #YY: Research in Progress
     - #ZZ: Research Needed

     Run /ralph-research first.
     ```

If no eligible issues/groups, respond:
```
No XS/Small issues ready for planning. Queue empty.
```
Then STOP.

### Step 2: Gather Group Context

1. **For each issue in the group** (in dependency order):
   - Read issue details and all comments
   - Find linked research document in issue comments (look for comments containing `## Research Document`)
   - Read research document fully if exists

2. **Build unified understanding**:
   - What shared code/patterns will be used across issues?
   - What's the data flow between phases?
   - What are the integration points?

3. **Spawn targeted sub-tasks** for any gaps in research:
   - **codebase-pattern-finder** - Find similar implementations to model after
   - **codebase-analyzer** - Deep dive on specific components

   ```
   Task(subagent_type="codebase-pattern-finder", prompt="Find existing patterns for [feature type] in [directory]")
   Task(subagent_type="codebase-analyzer", prompt="Analyze [component] implementation details. Return file:line references.")
   ```

4. **Wait for sub-tasks to complete** before proceeding to planning

### Step 3: Transition to Plan in Progress

Update **all group issues** to Plan in Progress:
```
ralph_hero__update_workflow_state
- owner: [owner]
- repo: [repo]
- number: [issue-number]
- state: "__LOCK__"
- command: "ralph_plan"
```

**Error handling**: If `update_workflow_state` returns an error, read the error message — it contains valid states/intents and a specific Recovery action. Retry with the corrected parameters.

### Step 4: Create Group Implementation Plan

Write plan to: `thoughts/shared/plans/YYYY-MM-DD-group-GH-NNN-description.md`

Use the primary issue (first in dependency order) for the filename.
For single-issue groups, use: `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md`

**Template:**

```markdown
---
date: YYYY-MM-DD
status: draft
github_issues: [123, 124, 125]
github_urls:
  - https://github.com/[owner]/[repo]/issues/123
  - https://github.com/[owner]/[repo]/issues/124
  - https://github.com/[owner]/[repo]/issues/125
primary_issue: 123
---

# [Group Description] - Atomic Implementation Plan

## Overview

This plan covers [N] related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | #123 | [Title] | XS |
| 2 | #124 | [Title] | S |
| 3 | #125 | [Title] | XS |

**Why grouped**: [Explanation of why these are implemented together]

## Current State Analysis

[Combined analysis from all research docs]

## Desired End State

[Unified success criteria covering all issues]

### Verification
- [ ] [Success criterion for issue 1]
- [ ] [Success criterion for issue 2]
- [ ] [Success criterion for issue N]

## What We're NOT Doing

- [Combined scope exclusions]

## Implementation Approach

[Unified approach explaining how phases build on each other]

---

## Phase 1: [#123 Title]

> **Issue**: [GitHub Issue URL]
> **Research**: [GitHub URL to research doc]

### Overview
[What this phase accomplishes]

### Changes Required

#### 1. [Change description]
**File**: `path/to/file`
**Changes**: [Specific changes]

### Success Criteria

#### Automated Verification
- [ ] [Test command]

#### Manual Verification
- [ ] [Human check]

**Dependencies created for next phase**: [What Phase 2 will use from this phase]

---

## Phase 2: [#124 Title]

> **Issue**: [GitHub Issue URL]
> **Research**: [GitHub URL to research doc]
> **Depends on**: Phase 1 (uses [specific thing])

[Same structure as Phase 1]

---

## Phase N: [#125 Title]

[Same structure]

---

## Integration Testing

After all phases complete:
- [ ] [End-to-end test covering all changes]
- [ ] [Regression check]

## References

- Research documents:
  - [#123 Research](GitHub URL)
  - [#124 Research](GitHub URL)
- Related issues: [GitHub Issue URLs]
```

**For single-issue groups**, use the simpler template:

```markdown
---
date: YYYY-MM-DD
status: draft
github_issue: NNN
github_url: https://github.com/[owner]/[repo]/issues/NNN
---

# [Title from issue]

## Overview
[Brief description of what we're building and why]

## Current State Analysis
[What exists today, key dependencies]

## Desired End State
[Clear description of success]

### Verification
- [ ] [Specific verification item 1]
- [ ] [Specific verification item 2]

## What We're NOT Doing
- [Explicit scope exclusion 1]
- [Explicit scope exclusion 2]

## Implementation Approach
[High-level strategy]

---

## Phase 1: [Phase Name]

### Overview
[What this phase accomplishes]

### Changes Required

#### 1. [Change description]
**File**: `path/to/file`
**Changes**: [Specific changes to make]

### Success Criteria

#### Automated Verification
- [ ] [Test or check that can run automatically]

#### Manual Verification
- [ ] [Human verification step]

---

## Testing Strategy
[How to verify the implementation]

## References
- [Issue URL]
- [Research document if exists]
```

### Step 4.5: Commit and Push Document

Commit the plan document so GitHub links work immediately:

```bash
git add thoughts/shared/plans/YYYY-MM-DD-*.md
git commit -m "docs(plan): GH-NNN implementation plan

git push origin main
```

For group plans with multiple issues:
```bash
git commit -m "docs(plan): #123, #124, #125 group implementation plan

```

This ensures the GitHub link in the issue comment resolves correctly.

### Step 5: Update All Group Issues in GitHub

For **each issue in the group**:

1. **Add plan document link** as a comment:
   ```
   ralph_hero__create_comment
   - owner: [owner]
   - repo: [repo]
   - number: [issue-number]
   - body: "## Implementation Plan\n\n[Group Implementation Plan (Phase N of M)](https://github.com/[owner]/[repo]/blob/main/thoughts/shared/plans/[filename].md)"
   ```

   For single-issue groups, use title "Implementation Plan" instead of "Group Implementation Plan".

2. **Add phase-specific comment**:
   ```markdown
   ## Plan Created (Phase [N] of [M])

   This issue is Phase [N] in a [M]-phase atomic implementation.

   Group: [Brief description]
   - Phase 1: #XX - [title]
   - Phase 2: #YY - [title] <-- This issue
   - Phase 3: #ZZ - [title]

   Full plan: [GitHub URL]
   ```

   For single-issue groups:
   ```markdown
   ## Plan Created

   Implementation approach: [Brief summary]

   Phases:
   1. [Phase 1 name]
   2. [Phase 2 name]

   Full plan: [GitHub URL]
   ```

3. **Move to "Plan in Review"** workflow state:
   ```
   ralph_hero__update_workflow_state
   - owner: [owner]
   - repo: [repo]
   - number: [issue-number]
   - state: "__COMPLETE__"
   - command: "ralph_plan"
   ```

### Step 6: Report Completion

For group plans:
```
Group plan complete for [N] issues:

Plan document: thoughts/shared/plans/YYYY-MM-DD-group-GH-NNN-description.md

Phases:
1. #XX: [Title] (XS)
2. #YY: [Title] (S)
3. #ZZ: [Title] (XS)

All issues moved to: Plan in Review

Ready for human review before atomic implementation.
```

For single-issue plans:
```
Plan complete for #NNN: [Title]

Plan document: thoughts/shared/plans/[filename].md
Issue: [GitHub Issue URL]
Workflow State: Plan in Review

Ready for human review before implementation.
```

## Escalation Protocol

When encountering complexity, uncertainty, or states that don't align with protocol, **escalate via GitHub issue comment** by @mentioning the appropriate person.

**Escalation priority** (use first available):
1. **Assigned individual** - If the issue has an assignee
2. **Project owner** - If the issue belongs to a project with a lead
3. **Team lead** - Default escalation target

**When to escalate:**

| Situation | Action |
|-----------|--------|
| Issue larger than XS/Small | @mention: "This issue appears to be [M/L/XL] complexity. Needs splitting before planning." |
| Circular dependencies in group | @mention: "Circular dependency detected: #X -> #Y -> #X. Please clarify order." |
| Missing/incomplete research | @mention: "Research for #X is missing [specific gap]. Cannot create reliable plan." |
| Conflicting requirements | @mention: "Issues #X and #Y have conflicting requirements: [details]. Please clarify." |
| External blockers unclear | @mention: "Group blocked by #Z but blocker status unclear. Please update." |
| Uncertain implementation approach | @mention: "Multiple valid approaches for [feature]. Need guidance: [Option A] vs [Option B]." |

**How to escalate:**

1. **Move issue to "Human Needed" workflow state**:
   ```
   ralph_hero__update_workflow_state
   - owner: [owner]
   - repo: [repo]
   - number: [issue-number]
   - state: "__ESCALATE__"
   - command: "ralph_plan"
   ```

2. **Add comment with @mention**:
   ```
   ralph_hero__create_comment
   - owner: [owner]
   - repo: [repo]
   - number: [issue-number]
   - body: "@[username] Escalation: [issue description]"
   ```

3. **STOP and report**:
   ```
   Escalated to @[person]: [brief reason]

   Issue: [GitHub Issue URL]
   Workflow State: Human Needed
   Issue: [description]

   Waiting for guidance before proceeding.
   ```

**Note**: The "Human Needed" workflow state must exist in the GitHub Project. If missing, create it via `ralph-setup`.

## Constraints

- Work on ONE issue group only
- XS/Small estimates only
- No questions - use research findings + reasonable assumptions
- Plan only, no implementation
- Complete within 15 minutes

## Planning Quality Guidelines

Good plans have:
- Clear phases with specific file changes
- Testable success criteria for each phase
- Explicit scope boundaries (what we're NOT doing)
- References to existing code patterns to follow
- For groups: explicit dependencies between phases
- For groups: integration testing section

Avoid:
- Vague descriptions like "update the code"
- Missing success criteria
- Unbounded scope
- Ignoring existing patterns in the codebase
- For groups: unclear phase ordering or dependencies

## Link Formatting

When referencing code in plan documents or issue comments, use GitHub links:

**Instead of:**
```
Found in `src/api/routers/wells.py:142`
```

**Use:**
```
Found in [src/api/routers/wells.py:142](https://github.com/[owner]/[repo]/blob/main/src/api/routers/wells.py#L142)
```

**Pattern:**
- File only: `[path/file.py](https://github.com/[owner]/[repo]/blob/main/path/file.py)`
- With line: `[path/file.py:42](https://github.com/[owner]/[repo]/blob/main/path/file.py#L42)`
- Line range: `[path/file.py:42-50](https://github.com/[owner]/[repo]/blob/main/path/file.py#L42-L50)`

## Edge Cases

1. **Single issue with no parent or blocking relations**: Works as today (1 issue = 1 phase plan)
2. **Partial group ready**: Block planning until all group issues are in "Ready for Plan"
3. **Circular dependencies within group**: Detect and report error (shouldn't happen with proper triage)
4. **Group spans multiple states**: Only include issues in "Ready for Plan" workflow state
5. **External blocker**: Group waits until external blocker issue is Done
6. **Mixed internal/external blockers**: Internal = phase order, external = group blocking
