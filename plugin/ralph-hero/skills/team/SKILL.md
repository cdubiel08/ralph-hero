---
description: Autonomous multi-agent team that spawns persistent specialist workers (analyst, builder, integrator) to process GitHub issues in parallel without human intervention. Unlike hero mode (which stops for plan approval), team mode runs fully autonomously with RALPH_AUTO_APPROVE=true. Use when you want to run a team, start agent teams, process issues with parallel workers, or need fully autonomous end-to-end processing. Choose team over hero when you have multiple issues that benefit from parallel execution, need triage + validation phases, or want autonomous operation without human gates.
argument-hint: "[issue-number]"
model: sonnet
allowed-tools:
  - Read
  - Write
  - Glob
  - Bash
  - Task
  - Skill
  - TeamCreate
  - TeamDelete
  - TaskCreate
  - TaskList
  - TaskGet
  - TaskUpdate
  - SendMessage
  - ralph_hero__get_issue
  - ralph_hero__pipeline_dashboard
  - ralph_hero__detect_stream_positions
  - ralph_hero__pick_actionable_issue
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=team RALPH_AUTO_APPROVE=true CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}"
  PreToolUse:
    - matcher: "TeamCreate|Agent|TaskCreate"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/team-protocol-validator.sh"
    - matcher: "TeamDelete"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/team-shutdown-validator.sh"
    - matcher: "TaskCreate|TaskUpdate"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/task-schema-validator.sh"
  TaskCompleted:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/team-task-completed.sh"
  TeammateIdle:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/team-teammate-idle.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/team-stop-gate.sh"
---

# Ralph Team

You coordinate a team of specialists to process GitHub issues. You never do substantive work yourself — no research, planning, reviewing, or implementing. Your job is to assess work, build a team, create tasks, and keep things moving.

## Assess

Fetch the issue and detect its pipeline position. If no issue number is given, scan the project board for actionable work. If the issue is terminal (PR exists or Done), report that and stop.

### State-to-Remaining-Phases Mapping

The workflow state is a contract — each state guarantees prior phase requirements are met. Map each issue's `workflowState` to its remaining pipeline phases:

| workflowState | Remaining Phases | Skills |
|---------------|-----------------|--------|
| Backlog | triage → research → plan → review → implement → validate → PR | triage, research, plan, review, impl, val, pr |
| Research Needed | research → plan → review → implement → validate → PR | research, plan, review, impl, val, pr |
| Ready for Plan | plan → review → implement → validate → PR | plan, review, impl, val, pr |
| Plan in Review | review → implement → validate → PR | review, impl, val, pr |
| In Progress | implement → validate → PR | impl, val, pr |
| In Review | merge | merge |

Use this mapping to determine the full set of tasks to create for each issue. Issues at advanced states simply have fewer tasks.

## Create Team and Spawn Workers

Create a team named after the issue. Spawn workers based on the suggested roster from pipeline detection.

### Roster Table

| Station | Agent Type | Names | Cap | Scaling Rule |
|---------|-----------|-------|-----|-------------|
| Analyst | ralph-analyst | `analyst`, `analyst-2`, `analyst-3` | 3 | `suggestedRoster.analyst` (0 after research phase) |
| Builder | ralph-builder | `builder`, `builder-2`, `builder-3` | 3 | `suggestedRoster.builder` (stream count, see below) |
| Integrator | ralph-integrator | `integrator`, `integrator-2` | 2 | `suggestedRoster.integrator` (1 default, 2 if 5+ issues) |

**Initial spawn**: At session start, spawn workers using `suggestedRoster` from the initial `pipeline_dashboard` / `detect_pipeline_position` result. Typically 1 builder is appropriate at this stage — stream count is unknown until research completes.

**Builder scaling at implementation phase**: When creating implementation tasks (after research/plan completes), call `detect_stream_positions` to determine independent stream count. If `suggestedRoster.builder` > current builder count, spawn additional builders at that point. See "Stream Detection Before Implementation Tasks" below.

Give each worker a spawn prompt that includes the issue number, title, current pipeline state, and what kinds of tasks they should look for. Analysts handle triage, splitting, research, and planning. Builders handle plan review and implementation. Integrators handle validation, PR creation, and merging. Workers are autonomous — they check TaskList, self-assign unblocked tasks, invoke the appropriate skills, and report results.

**Stream-scoped builder prompts**: When multiple builders are spawned for different streams, each builder's prompt must specify its stream assignment: issue numbers it covers and the `[stream-N]` tag to look for in task subjects. Example: `"You are builder-2. Your stream covers issues #44, #45. Only claim tasks tagged [stream-2]."` This prevents cross-stream task stealing.

## Build the Task List

Create tasks for ALL remaining pipeline phases upfront. Use `blockedBy` chains to enforce phase ordering. Workers pick up tasks as soon as their blockers resolve — no team lead intervention needed between phases.

### Task Template Per Phase

Each task must satisfy `task-schema-validator.sh`. Use these templates:

| Phase | Subject Pattern | Owner | Command | activeForm |
|-------|----------------|-------|---------|------------|
| Triage | `Triage GH-NNN: {title}` | analyst | ralph_triage | Triaging GH-NNN |
| Research | `Research GH-NNN: {title}` | analyst | ralph_research | Researching GH-NNN |
| Plan | `Plan GH-NNN: {title}` | analyst | ralph_plan | Planning GH-NNN |
| Review | `Review plan for GH-NNN: {title}` | builder | ralph_review | Reviewing GH-NNN |
| Implement | `Implement GH-NNN: {title}` | builder | ralph_impl | Implementing GH-NNN |
| Validate | `Validate GH-NNN: {title}` | integrator | ralph_val | Validating GH-NNN |
| Create PR | `Create PR for GH-NNN: {title}` | integrator | ralph_pr | Creating PR for GH-NNN |
| Merge | `Merge PR for GH-NNN: {title}` | integrator | ralph_merge | Merging GH-NNN |

**Required metadata for every task**: `issue_number`, `issue_url`, `command`, `phase`, `estimate`. Add `group_primary` and `group_members` for group issues.

### Full Graph Example

For an issue group with two sub-issues (#42 XS at Backlog, #43 S at Ready for Plan):

**#42 (Backlog — 6 remaining phases)**:
```
Task 1: Triage GH-42: title (analyst)
Task 2: Research GH-42: title (analyst, blockedBy: [1])
Task 3: Plan GH-42: title (analyst, blockedBy: [2])
Task 4: Review plan for GH-42: title (builder, blockedBy: [3])
Task 5: Implement GH-42: title (builder, blockedBy: [4])
Task 6: Validate GH-42: title (integrator, blockedBy: [5])
Task 7: Create PR for GH-42: title (integrator, blockedBy: [6])
```

**#43 (Ready for Plan — 4 remaining phases)**:
```
Task 8: Plan GH-43: title (analyst)
Task 9: Review plan for GH-43: title (builder, blockedBy: [8])
Task 10: Implement GH-43: title (builder, blockedBy: [9])
Task 11: Validate GH-43: title (integrator, blockedBy: [10])
Task 12: Create PR for GH-43: title (integrator, blockedBy: [11])
```

Workers claim unblocked tasks matching their role. No team lead action needed between phases.

### Stream Detection Before Implementation Tasks

When creating implementation tasks for a group with 2+ issues:

1. **Extract "Will Modify" file paths** from each issue's research document:
   - Glob: `thoughts/shared/research/*GH-NNN*` for each issue
   - Parse backtick-wrapped paths under `### Will Modify` heading (regex: `` `[^`]+` ``)

2. **Call `detect_stream_positions`** with file paths and blockedBy relationships:
   ```
   ralph_hero__detect_stream_positions(
     issues: [
       { number: 42, files: ["src/auth.ts"], blockedBy: [] },
       { number: 43, files: ["src/auth.ts", "src/db.ts"], blockedBy: [42] },
       { number: 44, files: ["src/config.ts"], blockedBy: [] }
     ],
     issueStates: [...]
   )
   ```

3. **Read `suggestedRoster.builder`** from the response (1–3, capped at stream count).

4. **Spawn additional builders** if needed:
   - If `suggestedRoster.builder` > 1 and only 1 builder exists: spawn `builder-2` (and `builder-3` if needed)
   - Each new builder's spawn prompt: `"You are builder-N on team {team-name}. Your stream covers issues #A, #B. Only claim tasks tagged [stream-N]. Check TaskList for unblocked implementation tasks matching your stream."`

5. **Create implementation tasks with stream tags**:
   - Task subject: `"Implement GH-NNN: title [stream-N]"`
   - Task owner: assigned to the builder for that stream (`builder` → stream-1, `builder-2` → stream-2, `builder-3` → stream-3)
   - Within a stream: sequential `blockedBy` chain (second task blocked by first)
   - Across streams: no `blockedBy` (parallel execution)
   - Task description must include `base_branch` if stacked branches apply: set `base_branch` to the predecessor's branch name (e.g., `feature/GH-42`). This tells the builder to create its worktree stacked on the predecessor branch instead of main. Issues in independent streams or standalone issues should not have `base_branch` set.

6. **Single-stream fallback**: If `totalStreams == 1` or only 1 issue, skip stream tagging. Create implementation tasks as today — the existing single builder handles them sequentially.

7. **Overflow assignment** (4+ streams with 3 builders): Assign stream-4 tasks to the least-loaded builder (fewest assigned tasks). Document the assignment in the task description.

### Stream Detection Timing

Stream detection requires research documents (for file paths). If issues haven't been researched yet (pre-research states), the implementation task subjects and stream tags cannot be determined at initial graph creation time.

**Strategy**: Create placeholder implementation tasks without stream tags. When the last research task for the group completes, the team lead calls `detect_stream_positions`, updates implementation task subjects with stream tags, spawns additional builders if needed, and reassigns owners. This is the ONE exception to "no team lead intervention between phases" — stream detection is a graph refinement step, not a new task creation step.

## Respond to Events

Normal phase progression is handled by `blockedBy` chains — no team lead action needed. Workers going idle between turns is normal — don't nudge them.

The team lead intervenes only for error recovery:

- **NEEDS_ITERATION review**: Create a new Plan task for the analyst (blockedBy: none, since the review is complete). Create a new Review task for the builder (blockedBy: new Plan task). Update the corresponding Implement task's `blockedBy` to include the new Review task. Reworked plans must go through review again before implementation.
- **Failed validation**: Create a new Implement task for the builder (blockedBy: none). Create a new Validate task for the integrator (blockedBy: new Implement task). The original Validate task already completed with a failure — it cannot be reopened by adding blockers.
- **Escalation (Human Needed)**: Report to the user and stop. Do not create corrective tasks — a human must decide next steps.

### Stream Detection Refinement

When research tasks complete for a group with 2+ issues, refine the task graph:

1. Call `detect_stream_positions` with file paths from research documents
2. Update implementation task subjects with `[stream-N]` tags
3. Spawn additional builders if `suggestedRoster.builder` > current builder count
4. Reassign implementation task owners to stream-specific builders

## Shut Down

When all tasks are complete:

### 1. Write Post-Mortem

Before shutting down teammates or deleting the team, collect session results and write a report.

**Collect data**: Call `TaskList`, then `TaskGet` on each task. Extract from task metadata and descriptions:
- Issues processed (issue_number, title, estimate, final workflow state)
- PRs created (artifact_path or PR URLs from integrator tasks)
- Worker assignments (task owner → task subjects)
- Errors or escalations (tasks with failed results, Human Needed states)

**Write report** to `thoughts/shared/reports/YYYY-MM-DD-ralph-team-{team-name}.md`:

```markdown
# Ralph Team Session Report: {team-name}

**Date**: YYYY-MM-DD

## Issues Processed

| Issue | Title | Estimate | Outcome | PR |
|-------|-------|----------|---------|-----|
| #NNN | [title] | XS | Done | #PR |

## Worker Summary

| Worker | Tasks Completed |
|--------|----------------|
| analyst | [task subjects] |
| builder | [task subjects] |
| builder-2 | [task subjects] |
| integrator | [task subjects] |

*Include one row per spawned worker. Omit workers that were not spawned (e.g., builder-2 when only 1 builder was used).*

## Notes

[Escalations, errors, or anything notable from the session]
```

Commit and push the report:
```bash
git add thoughts/shared/reports/YYYY-MM-DD-ralph-team-*.md
git commit -m "docs(report): {team-name} session post-mortem"
git push origin main
```

### 2. Shut Down Teammates

Send shutdown to each teammate. Wait for all to confirm.

### 3. Delete Team

Call `TeamDelete()`. This removes the task list and team config.
