---
description: "[DEPRECATED] Use /ralph-hero:hero instead. Team skill uses the old wrapper-agent architecture which is superseded by per-phase agents."
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
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__detect_stream_positions
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__next_actions
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_issue
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=team RALPH_REVIEW_PLAN=auto CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}"
  PreToolUse:
    - matcher: "TeamCreate|Agent|TaskCreate"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/team-protocol-validator.sh"
    - matcher: "TeamDelete"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/team-shutdown-validator.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/team-postmortem-completeness.sh"
    - matcher: "TaskCreate|TaskUpdate"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/task-schema-validator.sh"
  TaskCompleted:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/team-task-completed.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/outcome-collector.sh"
  TeammateIdle:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/team-teammate-idle.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/team-stop-gate.sh"
---

> **DEPRECATED**: This skill uses the old wrapper-agent architecture.
> Use `/ralph-hero:hero` for orchestrated pipeline execution.

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
| Analyst | research-agent / plan-agent | `analyst`, `analyst-2`, `analyst-3` | 3 | `suggestedRoster.analyst` (0 after research phase) |
| Builder | review-agent / impl-agent | `builder`, `builder-2`, `builder-3` | 3 | `suggestedRoster.builder` (stream count, see below) |
| Integrator | pr-agent / merge-agent / val-agent | `integrator`, `integrator-2` | 2 | `suggestedRoster.integrator` (1 default, 2 if 5+ issues) |

**Initial spawn**: At session start, spawn workers using `suggestedRoster` from the initial `pipeline_dashboard` / `detect_pipeline_position` result. Typically 1 builder is appropriate at this stage — stream count is unknown until research completes.

**Builder scaling at implementation phase**: When creating implementation tasks (after research/plan completes), call `detect_stream_positions` to determine independent stream count. If `suggestedRoster.builder` > current builder count, spawn additional builders at that point. See "Stream Detection Before Implementation Tasks" below.

Give each worker a spawn prompt that includes the issue number, title, current pipeline state, and what kinds of tasks they should look for. Analysts handle triage, splitting, research, and planning. Builders handle plan review and implementation. Integrators handle validation, PR creation, and merging. Workers are autonomous — they check TaskList, self-assign unblocked tasks, invoke the appropriate skills, and report results.

**Stream-scoped builder prompts**: When multiple builders are spawned for different streams, each builder's prompt must specify its stream assignment: issue numbers it covers and the `[stream-N]` tag to look for in task subjects. Example: `"You are builder-2. Your stream covers issues #44, #45. Only claim tasks tagged [stream-2]."` This prevents cross-stream task stealing.

## Build the Task List

Create tasks for ALL remaining pipeline phases upfront. Use `blockedBy` chains to enforce phase ordering. Workers pick up tasks as soon as their blockers resolve — no team lead intervention needed between phases.

### Task Template Per Phase

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/task-template.md

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

### Implementation Task Ordering (Dependency-Graph-Aware)

**Priority for task ordering**:
1. **Plan dependency graph** (`depends_on` annotations) — if present in the plan document
2. **Stream detection** (`detect_stream_positions`) — fallback when no annotations
3. **Sequential by default** — fallback when no stream data

After all plans are written, read each plan's `## Phase N:` headings and their `- **depends_on**:` annotations:
- If Phase 2 has `depends_on: [phase-1]`, the Phase 2 impl task is `blockedBy` the Phase 1 impl task.
- If Phase 3 has `depends_on: null`, the Phase 3 impl task has no `blockedBy` — it can execute in parallel.
- If a plan has NO `depends_on` annotations, fall back to stream detection or sequential ordering below.

### Stream Detection Before Implementation Tasks — Fallback

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/stream-detection.md

## Respond to Events

Normal phase progression is handled by `blockedBy` chains — no team lead action needed. Workers going idle between turns is normal — don't nudge them.

The team lead intervenes only for error recovery:

- **NEEDS_ITERATION review**: Create a new Plan task for the analyst (blockedBy: none, since the review is complete). Create a new Review task for the builder (blockedBy: new Plan task). Update the corresponding Implement task's `blockedBy` to include the new Review task. Reworked plans must go through review again before implementation.
- **Failed validation**: Create a new Implement task for the builder (blockedBy: none). Create a new Validate task for the integrator (blockedBy: new Implement task). The original Validate task already completed with a failure — it cannot be reopened by adding blockers.
- **Escalation (Human Needed)**: Report to the user and stop. Do not create corrective tasks — a human must decide next steps.

## Shut Down

When all tasks are complete:

### 1. Write Post-Mortem

Invoke the `ralph-hero:ralph-postmortem` skill. It handles:
- Data collection from TaskList/TaskGet
- Blocker vs. impediment classification
- Writing the Obsidian-ready report with full frontmatter
- Patching plan documents with `post_mortem::` edges
- Auto-creating GitHub issues for blockers
- Committing and pushing the report

### 2. Shut Down Teammates

Send shutdown to each teammate. Wait for all to confirm.

### 3. Delete Team

Call `TeamDelete()`. This removes the task list and team config.
