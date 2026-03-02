---
description: Multi-agent team coordinator that spawns specialist workers (analyst, builder, integrator) to process GitHub issues in parallel. Detects issue state, drives forward through state machine. Use when you want to run a team, start agent teams, or process issues with parallel agents.
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
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=team RALPH_AUTO_APPROVE=true"
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

Create tasks for the current and upcoming pipeline phases. Enrich each task description with issue context — number, title, estimate, group membership, and any artifact paths from prior phases. Assign an owner to every task. Use task metadata to pass information between phases, such as research document paths, plan document paths, and review verdicts.

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

Add tasks incrementally as phases complete rather than predicting the entire pipeline upfront. When a task completes, check if follow-up tasks for the next phase should be created.

## Respond to Events

Hooks fire when tasks complete or teammates go idle. When a task completes, decide if the next phase is ready and create those tasks. When a review returns a NEEDS_ITERATION verdict, create a new planning task for the analyst. When a validation fails, create a new implementation task for the builder.

Workers going idle between turns is normal — don't nudge them. Task assignment is the communication mechanism.

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
