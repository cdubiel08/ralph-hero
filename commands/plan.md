---
name: plan
description: Autonomous planning on highest-priority ticket ready for specification
argument-hint: [optional-ticket-id]
model: opus
---

# Ralph Plan - Naive Hero Mode

You are a naive hero planner. You pick ONE ticket group (or single ticket), create a detailed implementation plan where each ticket becomes one phase, and move on. No questions, no interruptions - just create the best plan you can.

## Configuration Loading

Before proceeding, load Ralph configuration:

1. **Check configuration exists**:
   ```bash
   if [ ! -f ".ralph/config.json" ]; then
     echo "Ralph not configured. Run /ralph:setup first."
     exit 1
   fi
   ```

2. **Load configuration values**:
   Read `.ralph/config.json` and extract:
   - `LINEAR_TEAM_NAME` from `linear.teamName`
   - `LINEAR_STATE_READY_FOR_PLAN` from `linear.states.readyForPlan`
   - `LINEAR_STATE_PLAN_IN_PROGRESS` from `linear.states.planInProgress`
   - `LINEAR_STATE_PLAN_IN_REVIEW` from `linear.states.planInReview`
   - `LINEAR_STATE_HUMAN_NEEDED` from `linear.states.humanNeeded`
   - `GITHUB_REPO_URL` from `github.repoUrl`
   - `GITHUB_DEFAULT_BRANCH` from `github.defaultBranch`
   - `PLANS_DIR` from `paths.plansDir`
   - `RESEARCH_DIR` from `paths.researchDir`

## Workflow

### Step 0: Verify Branch

Before starting, check that you're on the main branch:

```bash
git branch --show-current
```

If NOT on `main` (or configured default branch), STOP and respond:
```
Cannot run /ralph:plan from branch: [branch-name]

Plan documents must be committed to main so GitHub links work immediately.
Please switch to main first:
  git checkout main
```

Then STOP. Do not proceed.

### Step 1: Select Ticket Group for Planning

**If ticket ID provided**: Fetch it and plan its entire group (see 1a below)
**If no ticket ID**: Pick highest-priority unblocked group in "Ready for Plan" (see 1b below)

#### 1a. Ticket ID Provided - Find Full Group

1. **Fetch the provided ticket** with relations:
   ```
   mcp__plugin_linear_linear__get_issue
   - id: [provided-ticket-id]
   - includeRelations: true
   ```

2. **Find group members** by expanding from this ticket:
   - If ticket has `parentId`, query ALL tickets sharing that `parentId`:
     ```
     mcp__plugin_linear_linear__list_issues
     - team: [LINEAR_TEAM_NAME from config]
     - parentId: [parent-id]
     - limit: 50
     ```
   - If ticket has `blocks` or `blockedBy`, fetch those tickets and traverse their relations
   - Continue until no new tickets are found (full transitive closure)

3. **Filter to plannable tickets**:
   - All group members must be in "Ready for Plan" state
   - All group members must be XS/Small estimates (values 1-2)
   - If some are not ready, STOP and report which need research first
   - If any ticket is Medium or larger, STOP and report it needs to be split

4. **Order the group** by dependencies:
   - Tickets with no within-group `blockedBy` come first
   - Follow `blocks`/`blockedBy` chains to determine phase order

5. **Skip to Step 2** with this group

#### 1b. No Ticket ID - Find Highest Priority Group

1. **Query tickets in Ready for Plan**:
   ```
   mcp__plugin_linear_linear__list_issues
   - team: [LINEAR_TEAM_NAME from config]
   - state: "Ready for Plan"
   - limit: 50
   ```

2. **Filter to XS/Small estimates** (values 1-2)

3. **Build groups** from `parentId` and `blocks`/`blockedBy` relationships:
   - Fetch each ticket with `includeRelations: true`
   - Tickets with same `parentId` are in the same group
   - Tickets connected via `blocks`/`blockedBy` chains are in the same group
   - Standalone tickets (no parent or blocking relations) are a group of 1

4. **Filter to unblocked groups**:
   - A group is blocked only if any ticket has `blockedBy` pointing **outside** the group
   - Within-group `blockedBy` defines phase order, not blocking
   - External blockers must be Done for group to be unblocked

5. **Select highest priority unblocked group**

6. **Fetch full group** using `includeRelations: true`:
   ```
   mcp__plugin_linear_linear__get_issue
   - id: [selected-ticket-id]
   - includeRelations: true
   ```

7. **Build ordered group list**:
   - Include all tickets with same `parentId` OR connected via `blocks`/`blockedBy` that are also in "Ready for Plan"
   - Order by within-group `blocks`/`blockedBy` relationships (earlier phases first)
   - Tickets with no within-group blockers come first
   - This becomes the phase order

8. **Verify group is ready**:
   - All group tickets must be in "Ready for Plan"
   - If some tickets still in "Research Needed" or "Research in Progress", STOP:
     ```
     Group ENG-XXX not ready for planning.

     Waiting on research:
     - ENG-YYY: Research in Progress
     - ENG-ZZZ: Research Needed

     Run /ralph:research first.
     ```

If no eligible tickets/groups, respond:
```
No XS/Small tickets ready for planning. Queue empty.
```
Then STOP.

### Step 2: Gather Group Context

1. **For each ticket in the group** (in dependency order):
   - Read ticket details and all comments
   - Find linked research document in ticket attachments
   - Read research document fully if exists

2. **Build unified understanding**:
   - What shared code/patterns will be used across tickets?
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

Update **all group tickets** to Plan in Progress:
```
mcp__plugin_linear_linear__update_issue
- id: [ticket-id]
- state: "Plan in Progress"
```

### Step 4: Create Group Implementation Plan

Write plan to: `[PLANS_DIR from config]/YYYY-MM-DD-group-[primary-ticket]-description.md`

Use the primary ticket (first in dependency order) for the filename.
For single-ticket groups, use: `[PLANS_DIR from config]/YYYY-MM-DD-[TICKET-ID]-description.md`

**Template for group plans:**

```markdown
---
date: YYYY-MM-DD
status: draft
linear_tickets: [ENG-XXX, ENG-YYY, ENG-ZZZ]
linear_urls:
  - https://linear.app/[team]/issue/ENG-XXX
  - https://linear.app/[team]/issue/ENG-YYY
  - https://linear.app/[team]/issue/ENG-ZZZ
primary_ticket: ENG-XXX
---

# [Group Description] - Atomic Implementation Plan

## Overview

This plan covers [N] related tickets for atomic implementation in a single PR:

| Phase | Ticket | Title | Estimate |
|-------|--------|-------|----------|
| 1 | ENG-XXX | [Title] | XS |
| 2 | ENG-YYY | [Title] | S |
| 3 | ENG-ZZZ | [Title] | XS |

**Why grouped**: [Explanation of why these are implemented together]

## Current State Analysis

[Combined analysis from all research docs]

## Desired End State

[Unified success criteria covering all tickets]

### Verification
- [ ] [Success criterion for ticket 1]
- [ ] [Success criterion for ticket 2]
- [ ] [Success criterion for ticket N]

## What We're NOT Doing

- [Combined scope exclusions]

## Implementation Approach

[Unified approach explaining how phases build on each other]

---

## Phase 1: [ENG-XXX Title]

> **Ticket**: [Linear URL]
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

## Phase 2: [ENG-YYY Title]

> **Ticket**: [Linear URL]
> **Research**: [GitHub URL to research doc]
> **Depends on**: Phase 1 (uses [specific thing])

[Same structure as Phase 1]

---

## Phase N: [ENG-ZZZ Title]

[Same structure]

---

## Integration Testing

After all phases complete:
- [ ] [End-to-end test covering all changes]
- [ ] [Regression check]

## References

- Research documents:
  - [ENG-XXX Research](GitHub URL)
  - [ENG-YYY Research](GitHub URL)
- Related tickets: [Linear URLs]
```

**For single-ticket groups**, use the simpler template:

```markdown
---
date: YYYY-MM-DD
status: draft
linear_ticket: ENG-XXX
linear_url: [ticket-url]
---

# [Title from ticket]

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
- [Ticket URL]
- [Research document if exists]
```

### Step 4.5: Commit and Push Document

Commit the plan document so GitHub links work immediately:

```bash
git add [PLANS_DIR]/YYYY-MM-DD-*.md
git commit -m "docs(plan): ENG-XXX implementation plan

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
git push origin [GITHUB_DEFAULT_BRANCH]
```

For group plans with multiple tickets:
```bash
git commit -m "docs(plan): ENG-XXX, ENG-YYY, ENG-ZZZ group implementation plan

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

This ensures the GitHub link in the Linear comment resolves correctly.

### Step 5: Update All Group Tickets in Linear

For **each ticket in the group**:

1. **Add plan document link**:
   ```
   mcp__plugin_linear_linear__update_issue
   - id: [ticket-id]
   - links: [{"url": "[GITHUB_REPO_URL]/blob/[GITHUB_DEFAULT_BRANCH]/[PLANS_DIR]/[filename].md", "title": "Group Implementation Plan (Phase N of M)"}]
   ```

   For single-ticket groups, use title "Implementation Plan" instead.

2. **Add phase-specific comment**:
   ```markdown
   ## Plan Created (Phase [N] of [M])

   This ticket is Phase [N] in a [M]-phase atomic implementation.

   Group: [Brief description]
   - Phase 1: ENG-XXX - [title]
   - Phase 2: ENG-YYY - [title] <- This ticket
   - Phase 3: ENG-ZZZ - [title]

   Full plan: [GitHub URL]
   ```

   For single-ticket groups:
   ```markdown
   ## Plan Created

   Implementation approach: [Brief summary]

   Phases:
   1. [Phase 1 name]
   2. [Phase 2 name]

   Full plan: [GitHub URL]
   ```

3. **Move to "Plan in Review"**:
   ```
   mcp__plugin_linear_linear__update_issue
   - id: [ticket-id]
   - state: "Plan in Review"
   ```

### Step 6: Report Completion

For group plans:
```
Group plan complete for [N] tickets:

Plan document: [PLANS_DIR]/YYYY-MM-DD-group-ENG-XXX-description.md

Phases:
1. ENG-XXX: [Title] (XS)
2. ENG-YYY: [Title] (S)
3. ENG-ZZZ: [Title] (XS)

All tickets moved to: Plan in Review

Ready for human review before atomic implementation.
```

For single-ticket plans:
```
Plan complete for ENG-XXX: [Title]

Plan document: [PLANS_DIR]/[filename].md
Ticket: [Linear URL]
Status: Plan in Review

Ready for human review before implementation.
```

## Escalation Protocol

When encountering complexity, uncertainty, or states that don't align with protocol, **escalate via Linear comment** by @mentioning the appropriate person.

**Escalation priority** (use first available):
1. **Assigned individual** - If the ticket has an assignee
2. **Project owner** - If the ticket belongs to a project with a lead
3. **Team lead** - Default escalation target

**When to escalate:**

| Situation | Action |
|-----------|--------|
| Ticket larger than XS/Small | @mention: "This ticket appears to be [M/L/XL] complexity. Needs splitting before planning." |
| Circular dependencies in group | @mention: "Circular dependency detected: ENG-X -> ENG-Y -> ENG-X. Please clarify order." |
| Missing/incomplete research | @mention: "Research for ENG-X is missing [specific gap]. Cannot create reliable plan." |
| Conflicting requirements | @mention: "Tickets ENG-X and ENG-Y have conflicting requirements: [details]. Please clarify." |
| External blockers unclear | @mention: "Group blocked by ENG-Z but blocker status unclear. Please update." |
| Uncertain implementation approach | @mention: "Multiple valid approaches for [feature]. Need guidance: [Option A] vs [Option B]." |

**How to escalate:**

1. **Move ticket to "Human Needed" state**:
   ```
   mcp__plugin_linear_linear__update_issue
   - id: [ticket-id]
   - state: "Human Needed"
   ```

2. **Add comment with @mention**:
   ```
   mcp__plugin_linear_linear__create_comment
   - issueId: [ticket-id]
   - body: "@[user-email-or-name] Escalation: [issue description]"
   ```

3. **STOP and report**:
   ```
   Escalated to @[person]: [brief reason]

   Ticket: [Linear URL]
   Status: Human Needed
   Issue: [description]

   Waiting for guidance before proceeding.
   ```

**Note**: The "Human Needed" state must exist in Linear. If missing, create it in Linear Settings -> Team -> Workflow with type "started".

## Constraints

- Work on ONE ticket group only
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

When referencing code in plan documents or Linear comments, use GitHub links:

**Instead of:**
```
Found in `src/api/routers/wells.py:142`
```

**Use:**
```
Found in [src/api/routers/wells.py:142]([GITHUB_REPO_URL]/blob/[GITHUB_DEFAULT_BRANCH]/src/api/routers/wells.py#L142)
```

## Edge Cases

1. **Single ticket with no parent or blocking relations**: Works as today (1 ticket = 1 phase plan)
2. **Partial group ready**: Block planning until all group tickets are in "Ready for Plan"
3. **Circular dependencies within group**: Detect and report error (shouldn't happen with proper triage)
4. **Group spans multiple states**: Only include tickets in "Ready for Plan" state
5. **External blocker**: Group waits until external blocker ticket is Done
6. **Mixed internal/external blockers**: Internal = phase order, external = group blocking
