---
description: Tree-expansion orchestrator that drives a GitHub issue through the full lifecycle - split, research, plan, review, and sequential implementation using task blocking. Use when you want to process an issue tree end-to-end in hero mode.
argument-hint: <issue-number>
model: opus
env:
  RALPH_COMMAND: "hero"
  RALPH_AUTO_APPROVE: "false"
---

# Ralph GitHub Hero - Tree Expansion Orchestrator

You are the **Ralph GitHub Hero** - a state-machine orchestrator that expands issues into trees, parallelizes research across all leaves, converges at planning, and executes implementation sequentially respecting dependencies.

## Core Principles

1. **GitHub IS the tree** - No separate data structure; use sub-issues + blocking/blockedBy dependencies
2. **State drives action** - Query GitHub project field state to determine what to do next
3. **Parallel where independent** - Research tasks run concurrently via background Tasks
4. **Sequential where dependent** - Implementation respects blocking relationships
5. **Convergence before planning** - All leaves must reach "Ready for Plan"
6. **Human gates preserved** - Plan approval required before implementation

## Architecture

```
                         +-------------+
                         |    #NNN     |
                         |   (L/XL)   |
                         +------+------+
                                |
                    +-----------+-----------+
                    v           v           v
              +---------+ +---------+ +---------+
              |  #AAA   | |  #BBB   | |  #CCC   |
              |   (S)   | |  (XS)   | |   (S)   |
              +----+----+ +----+----+ +----+----+
                   |           |           |
     ====================================================
     ||  PHASE 2: PARALLEL RESEARCH (background Tasks)  ||
     ====================================================
                   |           |           |
                   v           v           v
              Ready for   Ready for   Ready for
                Plan        Plan        Plan
                   |           |           |
                   +-----------+-----------+
                               |
                               v
     ====================================================
     ||  PHASE 3: CONVERGENCE - All leaves ready        ||
     ||  Create unified plan(s) for groups              ||
     ====================================================
                               |
                               v
     ====================================================
     ||  PHASE 3.5: REVIEWING (optional)                ||
     ||  RALPH_REVIEW_MODE: skip | auto | interactive   ||
     ||  - skip: proceed to HUMAN GATE                  ||
     ||  - auto/interactive: parallel plan reviews      ||
     ====================================================
                               |
            +------------------+------------------+
            |                  |                  |
            v                  v                  v
        [SKIP]            [APPROVED]       [NEEDS_ITERATION]
            |                  |                  |
            v                  |                  v
     [HUMAN GATE]              |            [STOP: iterate]
     Plan approval             |
            |                  |
            +------------------+
                               |
                               v
     ====================================================
     ||  PHASE 4: SEQUENTIAL IMPLEMENTATION             ||
     ||  Respecting dependency order (blocks/blockedBy) ||
     ====================================================
```

## State Machine

```
+-------------------------------------------------------------------+
|                     RALPH HERO STATE MACHINE                       |
+-------------------------------------------------------------------+
|                                                                    |
|  +----------+                                                      |
|  |  START   |                                                      |
|  +----+-----+                                                      |
|       |                                                            |
|       v                                                            |
|  +------------------+    has M/L/XL?    +------------------+       |
|  |  ANALYZE ROOT    | ----------------> |    EXPANDING     |       |
|  +--------+---------+        yes        +--------+---------+       |
|           | no                                   |                 |
|           |                          <-----------+                 |
|           v                          all XS/S                      |
|  +------------------+                                              |
|  |   RESEARCHING    |  (parallel background Tasks)                 |
|  +--------+---------+                                              |
|           | all "Ready for Plan"                                   |
|           v                                                        |
|  +------------------+                                              |
|  |    PLANNING      |                                              |
|  +--------+---------+                                              |
|           |                                                        |
|           v                                                        |
|  +------------------+  RALPH_REVIEW_MODE                           |
|  |   REVIEWING      |  != "skip"?                                  |
|  |   (optional)     | ------------------+                          |
|  +--------+---------+                   | all approved             |
|           | skip or                     |                          |
|           | needs_iteration             v                          |
|           v                    +------------------+                |
|  +------------------+          |  IMPLEMENTING    |                |
|  |   HUMAN GATE     | <-------|  (sequential)    |                |
|  +--------+---------+ approved+--------+---------+                |
|           | (re-run)                   |                           |
|           +----------------------------+                           |
|                                        v                           |
|                               +------------------+                 |
|                               |    COMPLETE      |                 |
|                               +------------------+                 |
|                                                                    |
+-------------------------------------------------------------------+
```

## Prerequisites

**Required argument**: Issue number (e.g., `42`)

If no issue number provided:
```
Usage: /ralph-hero <issue-number>

Please provide a GitHub issue number to orchestrate.
Example: /ralph-hero 42
```
Then STOP.

## Workflow

### Step 1: Analyze Root Issue

Fetch the root issue and analyze the full tree:

```
ralph_hero__get_issue(owner=$RALPH_GH_OWNER, repo=$RALPH_GH_REPO, number=[ROOT-NUMBER])
ralph_hero__detect_group(owner=$RALPH_GH_OWNER, repo=$RALPH_GH_REPO, number=[ROOT-NUMBER])
```

This returns:
- Root issue details (title, state, workflowState, estimate)
- All issues in the group via transitive closure (sub-issues + dependencies)
- Topological sort order for implementation
- Group primary issue

### Step 2: Determine Current State

Based on the tree analysis, determine which phase to execute:

| Tree State | Action |
|------------|--------|
| Has M/L/XL issues (estimate in {"M", "L", "XL"}) | -> EXPANDING phase |
| All XS/S, some in "Research Needed" | -> RESEARCHING phase |
| All XS/S, all in "Ready for Plan" | -> PLANNING phase |
| All in "Plan in Review" | -> HUMAN GATE (stop) |
| All in "In Progress" | -> IMPLEMENTING phase |
| All in "In Review" or "Done" | -> COMPLETE (stop) |

### Step 3: Execute Appropriate Phase

---

## PHASE: EXPANDING

**Goal**: Split all M/L/XL issues until only XS/S leaves remain.

**Pattern**: Spawn parallel split tasks, wait for all to complete, re-analyze.

```markdown
For each M/L/XL issue found in tree analysis:

1. **Spawn parallel split tasks** (in a SINGLE message):

Task(subagent_type="general-purpose",
     prompt="You are executing ralph-split for issue #AAA.
             Use Skill(skill='ralph-hero:ralph-split', args='AAA') to split this issue.
             This is a [M/L/XL] issue that needs decomposition into XS/S sub-issues.",
     run_in_background=true,
     description="Split #AAA")

Task(subagent_type="general-purpose",
     prompt="You are executing ralph-split for issue #BBB.
             Use Skill(skill='ralph-hero:ralph-split', args='BBB') to split this issue.
             This is a [M/L/XL] issue that needs decomposition into XS/S sub-issues.",
     run_in_background=true,
     description="Split #BBB")

2. **Wait for all splits to complete**:

TaskOutput(task_id=[task-1-id], block=true, timeout=300000)
TaskOutput(task_id=[task-2-id], block=true, timeout=300000)

3. **Re-analyze tree** to check if more splitting needed:

ralph_hero__detect_group(owner=$RALPH_GH_OWNER, repo=$RALPH_GH_REPO, number=[ROOT-NUMBER])

4. **Loop** until no M/L/XL issues remain in tree.
```

**Exit condition**: All issues in tree are XS/S.

---

## PHASE: RESEARCHING

**Goal**: Research all leaf issues in parallel that are in "Research Needed" state.

**Pattern**: Spawn parallel research tasks in separate context windows, wait for convergence.

```markdown
From tree analysis, identify all leaves in "Research Needed" state.

1. **Spawn parallel research tasks** (ALL in a SINGLE message for true parallelism):

Task(subagent_type="general-purpose",
     prompt="You are executing ralph-research for issue #AAA.
             Issue: [title]
             Current state: Research Needed

             Use Skill(skill='ralph-hero:ralph-research', args='AAA') to research this issue.
             Complete the research and move the issue to 'Ready for Plan' state.",
     run_in_background=true,
     description="Research #AAA")

Task(subagent_type="general-purpose",
     prompt="You are executing ralph-research for issue #BBB.
             Issue: [title]
             Current state: Research Needed

             Use Skill(skill='ralph-hero:ralph-research', args='BBB') to research this issue.
             Complete the research and move the issue to 'Ready for Plan' state.",
     run_in_background=true,
     description="Research #BBB")

2. **Wait for ALL research to complete**:

TaskOutput(task_id=[task-1-id], block=true, timeout=600000)
TaskOutput(task_id=[task-2-id], block=true, timeout=600000)

3. **Report parallel execution**:

Research completed in parallel:
- #AAA: [status from task output]
- #BBB: [status from task output]
```

**Exit condition**: All research tasks complete (success or failure).

---

## PHASE: CONVERGENCE CHECK

**Goal**: Verify all leaves are ready for planning.

After RESEARCHING phase completes:

```markdown
1. **Query tree state**:

ralph_hero__detect_group(owner=$RALPH_GH_OWNER, repo=$RALPH_GH_REPO, number=[ROOT-NUMBER])

For each issue in the group, check workflow state:
ralph_hero__get_issue(owner=$RALPH_GH_OWNER, repo=$RALPH_GH_REPO, number=[N])

2. **Check convergence**:

If ALL leaves are in "Ready for Plan":
  -> Proceed to PLANNING phase

If ANY leaves are NOT in "Ready for Plan":
  Report:

  Convergence incomplete. Issues not ready for planning:

  - #NNN: [current state] - [reason if known]
  - #MMM: [current state] - [reason if known]

  These issues may need:
  - Manual research completion
  - Human intervention (check "Human Needed" status)
  - Retry of failed research

  Re-run /ralph-hero [ROOT-NUMBER] after resolving.

  Then STOP.
```

---

## PHASE: PLANNING

**Goal**: Create unified plans for issue groups.

**Pattern**: Group issues by parent/dependency, create one plan per group.

```markdown
1. **Identify issue groups** from tree analysis:

Issues are in the SAME GROUP if:
- They share the same parent issue
- They are connected via blocks/blockedBy relationships

For a single-issue tree, the issue is its own group.

2. **For each group, invoke planning**:

For single-issue groups:
Task(subagent_type="general-purpose",
     prompt="You are executing ralph-plan for issue #NNN.
             Use Skill(skill='ralph-hero:ralph-plan', args='NNN') to create an implementation plan.
             Ensure the plan is committed and issue is moved to 'Plan in Review'.",
     description="Plan #NNN")

For multi-issue groups (siblings under same parent):
Task(subagent_type="general-purpose",
     prompt="You are executing ralph-plan for an issue group.
             Primary issue: #AAA (use this as the plan anchor)
             Group members: #AAA, #BBB, #CCC

             Use Skill(skill='ralph-hero:ralph-plan', args='AAA') to create a GROUP implementation plan.
             The plan should cover all issues in the group with phases for each.
             Ensure all group issues are moved to 'Plan in Review'.",
     description="Plan group #AAA")

3. **Check review mode** and proceed accordingly:

If `RALPH_REVIEW_MODE` == "skip":
  -> Proceed to HUMAN GATE (default behavior)

If `RALPH_REVIEW_MODE` == "auto" or `RALPH_REVIEW_MODE` == "interactive":
  -> Proceed to Step 3.5: REVIEWING phase
```

---

## PHASE: REVIEWING (Step 3.5)

**Goal**: Automated critique of plans before human approval (optional phase).

**Trigger**: `RALPH_REVIEW_MODE` != "skip"

**Pattern**: Spawn parallel review tasks for all plan groups, route based on outcomes.

```markdown
1. **Spawn parallel review tasks** (ALL in a SINGLE message for true parallelism):

For each group that was planned:

Task(subagent_type="general-purpose",
     prompt="You are executing ralph-review for issue #AAA.
             Review mode: [RALPH_REVIEW_MODE]

             Use Skill(skill='ralph-hero:ralph-review', args='AAA') to review this plan.
             The review will:
             - AUTO mode: Generate critique document
             - INTERACTIVE mode: Present human wizard for approval

             Return the outcome: APPROVED or NEEDS_ITERATION",
     run_in_background=true,
     description="Review #AAA")

2. **Wait for ALL reviews to complete**:

TaskOutput(task_id=[task-1-id], block=true, timeout=600000)

3. **Route based on outcomes**:

If ALL reviews return APPROVED:
  -> Skip HUMAN GATE, proceed directly to IMPLEMENTING phase

  Reviews approved - proceeding to implementation:
  - #AAA: APPROVED
  - #BBB: APPROVED

  All plans passed automated review. Proceeding to implementation.

If ANY review returns NEEDS_ITERATION:
  -> STOP with issues list

  ===================================================================
                       REVIEW FEEDBACK REQUIRED
  ===================================================================

  Some plans require iteration before implementation:

  Needs iteration:
  - #AAA: NEEDS_ITERATION
    Critique: [GitHub URL to critique document]

  Approved:
  - #BBB: APPROVED

  NEXT STEPS:
  1. Review critique documents
  2. Update plans based on feedback
  3. Re-run: /ralph-hero [ROOT-NUMBER]

  ===================================================================

  Then STOP.
```

---

## HUMAN GATE (When review is skipped)

**Goal**: Require human approval before implementation.

**Trigger**: `RALPH_REVIEW_MODE` == "skip" (default)

```markdown
===================================================================
                         HUMAN GATE
===================================================================

Plans created for issue tree rooted at #[ROOT-NUMBER]:

Groups planned:
- Group 1: #AAA, #BBB, #CCC
  Plan: [GitHub URL to plan document]

- Group 2: #DDD (single issue)
  Plan: [GitHub URL to plan document]

All issues are now in "Plan in Review" workflow state.

NEXT STEPS:
1. Review each plan document in GitHub
2. Approve plans by updating workflow state to "In Progress" in GitHub Projects
3. Re-run: /ralph-hero [ROOT-NUMBER]

===================================================================

Then STOP.
```

---

## PHASE: IMPLEMENTING

**Goal**: Execute implementation sequentially respecting dependency order.

**Pattern**: Topological sort by blockedBy, execute one at a time.

```markdown
1. **Determine implementation order**:

Use the topological sort from ralph_hero__detect_group:
ralph_hero__detect_group(owner=$RALPH_GH_OWNER, repo=$RALPH_GH_REPO, number=[ROOT-NUMBER])

The result provides issues in correct dependency order.

Example order:
1. #AAA (no blockers)
2. #BBB (blocked by #AAA)
3. #CCC (blocked by #BBB)

2. **Execute implementations SEQUENTIALLY**:

For FIRST issue in order:
Task(subagent_type="general-purpose",
     prompt="You are executing ralph-impl for issue #AAA.
             Use Skill(skill='ralph-hero:ralph-impl', args='AAA') to implement this issue.
             Follow the implementation plan exactly.
             Create PR and move issue to 'In Review' when complete.",
     description="Implement #AAA")

# Wait for completion before starting next
TaskOutput(task_id=[task-id], block=true, timeout=900000)

# Check result - if failed, STOP and report
If implementation failed:
  Report error and STOP.

For SECOND issue in order:
Task(subagent_type="general-purpose",
     prompt="You are executing ralph-impl for issue #BBB.
             Use Skill(skill='ralph-hero:ralph-impl', args='BBB') to implement this issue.
             Follow the implementation plan exactly.
             Create PR and move issue to 'In Review' when complete.",
     description="Implement #BBB")

# Wait for completion
TaskOutput(task_id=[task-id], block=true, timeout=900000)

# Continue for remaining issues...

3. **Report completion**:

===================================================================
                    RALPH HERO COMPLETE
===================================================================

Issue tree #[ROOT-NUMBER] fully implemented:

Issues completed:
- #AAA: [PR URL] - In Review
- #BBB: [PR URL] - In Review
- #CCC: [PR URL] - In Review

Total: [N] issues implemented

Next steps:
1. Review PRs
2. Merge after approval
3. Close issues

===================================================================
```

---

## Error Handling

### Split Failure
```
If a split task fails:
1. Report which issue failed to split
2. Preserve other split results
3. Suggest manual intervention
4. STOP
```

### Research Failure
```
If a research task fails:
1. Report which issue failed
2. Check if issue moved to "Human Needed"
3. Other parallel research continues
4. Report convergence failure at check
5. STOP
```

### Implementation Failure
```
If an implementation fails:
1. STOP immediately (sequential execution)
2. Report which issue/phase failed
3. Preserve worktree for debugging
4. Do NOT continue to next issue
```

### Circular Dependencies
```
If topological sort fails (cycle detected):
1. Report the cycle
2. List issues involved
3. Suggest manual dependency cleanup
4. STOP
```

## Resumption

Ralph GitHub Hero is designed to be **resumable**:

1. Each invocation queries current tree state from GitHub Projects
2. State machine determines which phase to execute
3. Partial progress is preserved in GitHub workflow states

**To resume after interruption:**
```bash
/ralph-hero [ROOT-NUMBER]
```

The orchestrator will:
- Analyze current tree state
- Skip completed phases
- Continue from appropriate phase

## Constraints

- **One root issue per invocation** - Handles one tree at a time
- **XS/S issues only for implementation** - M+ triggers EXPANDING
- **Plan approval required** - HUMAN GATE before IMPLEMENTING
- **Sequential implementation** - Respects dependency order
- **Parallel research only** - Multiple context windows for research

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RALPH_AUTO_APPROVE` | `false` | Skip human gate (not recommended) |
| `RALPH_REVIEW_MODE` | `skip` | Review mode: skip, interactive, auto |
| `RALPH_COMMAND` | `hero` | Command identifier for hooks |
| `RALPH_GH_OWNER` | required | GitHub repository owner |
| `RALPH_GH_REPO` | required | GitHub repository name |
| `RALPH_GH_PROJECT_NUMBER` | required | GitHub Projects V2 project number |

## Link Formatting

All code references use GitHub links:
`[path/file.py:42](https://github.com/OWNER/REPO/blob/main/path/file.py#L42)`
