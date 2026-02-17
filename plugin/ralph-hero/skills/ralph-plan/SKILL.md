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
    - matcher: "ralph_hero__handoff_ticket"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/convergence-gate.sh"
  PostToolUse:
    - matcher: "ralph_hero__handoff_ticket"
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

**If issue number provided**: Fetch it and plan its entire group (1a)
**If no issue number**: Pick highest-priority unblocked group in "Ready for Plan" (1b)

#### 1a. Issue Number Provided

1. **Fetch the issue** (response includes group members with workflow states):
   ```
   ralph_hero__get_issue(owner, repo, number)
   ```

2. **Filter to plannable issues**:
   - All group members must be in "Ready for Plan" workflow state
   - All must be XS/Small estimates ("XS" or "S")
   - If some not ready, STOP and report which need research first
   - If any is Medium+, STOP and report it needs splitting

3. **Order the group** by topological order from the response, then **skip to Step 2**

#### 1b. No Issue Number

1. **Query issues in Ready for Plan**:
   ```
   ralph_hero__list_issues(owner, repo, workflowState="Ready for Plan", limit=50)
   ```

2. **Filter to XS/Small** estimates ("XS" or "S")

3. **Build groups**: For each candidate, call `ralph_hero__get_issue(number=N)`. The response includes group members with their workflow states. Standalone issues (no parent/blocking) are groups of 1.

4. **Filter to unblocked groups**:
   - Blocked = any issue has `blockedBy` pointing **outside** the group with state != "Done"
   - Within-group `blockedBy` defines phase order, not blocking
   - The `get_issue` response includes `blockedBy` with workflow states -- no need to re-fetch blockers

5. **Select highest priority unblocked group**

6. **Verify group is ready**: All must be "Ready for Plan". If not, STOP:
   ```
   Group #NNN not ready for planning.
   Waiting on research: #YY (Research in Progress), #ZZ (Research Needed)
   Run /ralph-research first.
   ```

If no eligible groups: respond "No XS/Small issues ready for planning. Queue empty." then STOP.

### Step 2: Gather Group Context

1. **For each issue** (dependency order): read details, comments, and linked research doc (look for `## Research Document` in comments)
2. **Build unified understanding**: shared patterns, data flow between phases, integration points
3. **Spawn sub-tasks** for research gaps:
   - `Task(subagent_type="codebase-pattern-finder", prompt="Find patterns for [feature] in [dir]")`
   - `Task(subagent_type="codebase-analyzer", prompt="Analyze [component] details. Return file:line refs.")`
4. **Wait for sub-tasks** before proceeding

### Step 3: Transition to Plan in Progress

Update **all group issues**: `ralph_hero__handoff_ticket(number, command="plan", intent="lock", reason="Starting planning phase")`

See shared/conventions.md for error handling.

### Step 4: Create Implementation Plan

**Filename**: `thoughts/shared/plans/YYYY-MM-DD-group-GH-NNN-description.md` (use primary issue number; for single issues: `YYYY-MM-DD-GH-NNN-description.md`)

**Template** (works for both single issues and groups; for N=1 omit "Why grouped" and simplify):

```markdown
---
date: YYYY-MM-DD
status: draft
github_issues: [123, 124, 125]
github_urls:
  - https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/123
primary_issue: 123
---

# [Description] - Atomic Implementation Plan

## Overview
[N] related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | #123 | [Title] | XS |

**Why grouped**: [Explanation]

## Current State Analysis
[Combined analysis from research docs]

## Desired End State
### Verification
- [ ] [Success criterion per issue]

## What We're NOT Doing
- [Scope exclusions]

## Implementation Approach
[How phases build on each other]

---

## Phase 1: [#123 Title]
> **Issue**: [URL] | **Research**: [URL] | **Depends on**: (if applicable)

### Changes Required
#### 1. [Change]
**File**: `path/to/file`
**Changes**: [Specific changes]

### Success Criteria
- [ ] Automated: [test command]
- [ ] Manual: [human check]

**Creates for next phase**: [What Phase 2 uses]

---

## Integration Testing
- [ ] [End-to-end tests]

## References
- Research: [URLs]
- Related issues: [URLs]
```

### Step 4.5: Commit and Push

```bash
git add thoughts/shared/plans/YYYY-MM-DD-*.md
git commit -m "docs(plan): GH-NNN implementation plan"  # or "#123, #124, #125 group plan"
git push origin main
```

### Step 5: Update All Group Issues

For **each issue in the group**:

1. **Add plan link comment**: `ralph_hero__create_comment` with body:
   ```
   ## Implementation Plan
   [Plan (Phase N of M)](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/plans/[filename].md)
   ```

2. **Add phase summary comment**:
   ```
   ## Plan Created (Phase N of M)
   - Phase 1: #XX - [title]
   - Phase 2: #YY - [title] <-- This issue
   Full plan: [URL]
   ```
   For single issues, omit "Phase N of M" and just list phases.

3. **Move to Plan in Review**: `ralph_hero__handoff_ticket(number, command="plan", intent="complete", reason="Plan created and committed")`

### Step 6: Report Completion

```
Plan complete for [N] issue(s):
Plan: thoughts/shared/plans/[filename].md
Phases: 1. #XX [Title] (XS), 2. #YY [Title] (S), ...
All issues: Plan in Review
Ready for human review.
```

## Escalation Protocol

See shared/conventions.md for full escalation protocol. Use `command="ralph_plan"` in state transitions.

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

See shared/conventions.md for GitHub link formatting patterns.

## Edge Cases

1. **Single issue with no parent or blocking relations**: Works as today (1 issue = 1 phase plan)
2. **Partial group ready**: Block planning until all group issues are in "Ready for Plan"
3. **Circular dependencies within group**: Detect and report error (shouldn't happen with proper triage)
4. **Group spans multiple states**: Only include issues in "Ready for Plan" workflow state
5. **External blocker**: Group waits until external blocker issue is Done
6. **Mixed internal/external blockers**: Internal = phase order, external = group blocking
