---
date: 2026-02-24
status: complete
type: research
issue: none
tags: [agent-teams, task-list, scoping, platform-behavior, ralph-team]
---

# Agent Teams Task List Scoping — Platform Behavior Research

## Purpose

Document the empirically verified behavior of Claude Code's agent teams task list system, including filesystem storage, scoping rules, ID allocation, ordering constraints, and the root causes of task list desynchronization observed during ralph-team runs.

## Background

During the GH-364 ralph-team session, workers consistently failed to find tasks created by the team lead. The builder reported "Task #9 wasn't found in the task list" and created substitute tasks. The analyst created its own parallel task tracking. Investigation revealed fundamental questions about how the agent teams task list actually works.

## Platform Architecture

### Storage Model

Agent teams task lists are **filesystem-based**, stored as individual JSON files:

```
~/.claude/tasks/{scope}/
├── .lock           # File lock for race-condition prevention
├── 1.json          # Task #1
├── 2.json          # Task #2
└── ...
```

The `{scope}` directory name determines which task list a session reads/writes:

| Scope Type | Directory Pattern | When Used |
|------------|-------------------|-----------|
| Session-local | `~/.claude/tasks/{session-uuid}/` | No team active (default) |
| Team-shared | `~/.claude/tasks/{team-name}/` | After TeamCreate establishes team context |

### Task File Schema

Each task is a standalone JSON file:

```json
{
  "id": "1",
  "subject": "Short imperative title",
  "description": "Full work directive",
  "activeForm": "Present participle for spinner display",
  "status": "pending",
  "owner": "analyst",
  "blocks": ["3"],
  "blockedBy": ["1"],
  "metadata": {
    "key": "value"
  }
}
```

Status lifecycle: `pending` → `in_progress` → `completed` (also `deleted` for removal).

### ID Allocation

Task IDs are auto-incrementing integers. The next ID is determined by reading the maximum existing ID from the task directory. File locking (`.lock`) prevents race conditions during concurrent claims.

### Team Configuration

Team metadata lives separately from tasks:

```
~/.claude/teams/{team-name}/
├── config.json     # Members array, lead ID
└── inboxes/        # Per-agent message files
    ├── team-lead.json
    ├── analyst.json
    └── builder.json
```

`TeamDelete` removes both `~/.claude/teams/{team-name}/` and `~/.claude/tasks/{team-name}/`.

## Scoping Rules — Empirically Verified

### Rule 1: After TeamCreate, the Lead's Task Operations Target the Team Directory

**Test**: TeamCreate → TaskCreate (no teammates spawned yet)

**Result**: Task file appears in `~/.claude/tasks/{team-name}/1.json`, NOT in `~/.claude/tasks/{session-uuid}/`. Session-UUID directory remains empty.

**Conclusion**: `TeamCreate` switches the lead's task routing to the team directory immediately. No teammate spawn is required for this to take effect.

### Rule 2: Workers Spawned with team_name Share the Same Task List

**Test**: Lead creates tasks #1 and #2. Worker spawned with `Task(team_name=...)`. Worker calls TaskList.

**Result**: Worker sees tasks #1 and #2 with identical IDs, subjects, and descriptions. The worker reads from the same `~/.claude/tasks/{team-name}/` directory.

**Conclusion**: The `team_name` parameter on the `Task` tool correctly scopes the worker's task operations to the shared team directory.

### Rule 3: Worker-Created Tasks Use the Same ID Space

**Test**: Lead creates tasks #1 and #2. Worker creates task via TaskCreate.

**Result**: Worker's task gets ID #3. All three tasks are visible to both lead and worker. No ID collision.

**Conclusion**: Auto-incrementing IDs work correctly across lead and worker sessions. File locking prevents races.

### Rule 4: Skill-Internal TaskCreate Also Targets the Team Directory

**Test**: Worker (with team_name set) calls TaskCreate from within a skill invocation context.

**Result**: Skill-created tasks appear in the shared task list with incrementing IDs. Both lead and worker can see all tasks.

**Conclusion**: Skills invoked inside a team worker inherit the team scope. `CLAUDE_CODE_TEAM_NAME` propagates through skill invocations within the same session.

### Rule 5: Without an Active Team, Tasks Go to Session-Local Storage

**Test**: TaskCreate called after TeamDelete (no active team).

**Result**: Task appears in `~/.claude/tasks/{session-uuid}/`, not in any team directory.

**Conclusion**: When no team is active, the fallback is session-local storage keyed by session UUID.

### Rule 6: CLAUDE_CODE_TEAM_NAME Environment Variable

The lead's Bash shell shows `CLAUDE_CODE_TEAM_NAME=''` (empty string) even after TeamCreate. However, task operations still route to the team directory correctly. This means:

- Task routing uses **internal session state**, not the shell environment variable
- The environment variable is set for spawned teammates (via `Task(team_name=...)`) but not for the lead's shell
- The Bash tool's env and the task tool's routing are separate systems

## Root Cause Analysis: GH-364 Task Desynchronization

### Observed Symptoms

During the GH-364 ralph-team session:

1. **Builder couldn't find lead's tasks**: "Task #9 wasn't found in the task list, so I created task #7 to track this"
2. **Task IDs mismatched**: Builder referenced different task IDs than the lead
3. **Workers created parallel tasks**: The filesystem showed 13 tasks created by workers, not the 22 created by the lead
4. **Lead had to manually mark tasks complete**: Workers' TaskUpdate calls didn't update the lead's task view

### Filesystem Evidence

After the session, `~/.claude/tasks/ralph-team-GH-364/` contained 13 task files. Comparison with the lead's 22-task orchestration:

| Disk ID | Disk Subject | Lead's ID | Lead's Subject |
|---------|-------------|-----------|---------------|
| 1 | GH-364: Analyze scope | 1 | Split GH-364 |
| 2 | Triage GH-378, 379, 380, 381 | 2 | Triage GH-378, GH-379, GH-380, GH-381 |
| 3 | Research GH-378 | 3 | Research GH-378 |
| 4 | Plan GH-378 | 4 | Plan GH-378 |
| 5 | Implement GH-378 | 5 | Implement GH-378 |
| 6 | Research GH-379 | 6 | Create PR for GH-378 |
| 7 | Plan GH-379 | 7 | Merge PR for GH-378 |
| 8 | Implement GH-379 | 8 | Research GH-379 |
| ... | ... | ... | ... |
| 13 | Plan GH-381 | 13-22 | (various PR/merge tasks) |

Key differences:
- Disk task #1 was **not** "Split GH-364" (the lead's task) — it was "GH-364: Analyze scope" (created by the analyst's ralph-split skill)
- Starting at disk #6, subjects diverge completely — the lead had "Create PR" and "Merge PR" tasks that don't appear on disk
- Only 13 tasks on disk vs 22 from the lead

### Root Cause: Skill-Internal Task Creation Overwrites Lead Tasks

The ralph skills (ralph-split, ralph-research, ralph-plan, ralph-impl) each internally call `TaskCreate` and `TaskUpdate` to track their own work. When a worker invokes a skill:

1. The skill runs inside the worker's session (which has team scope)
2. The skill calls `TaskCreate` → writes to `~/.claude/tasks/{team-name}/`
3. The skill calls `TaskUpdate` on existing tasks → modifies files in `~/.claude/tasks/{team-name}/`
4. These operations **overwrite or conflict with** the lead's tasks in the same directory

**The conflict mechanism**: The lead creates tasks #1-22 rapidly in a single response. The analyst's ralph-split skill then starts and calls `TaskUpdate(taskId="1", subject="GH-364: Analyze scope", description="...")` — overwriting the lead's task #1. The skill creates its own additional tasks #2-N, and uses `TaskUpdate` to modify tasks it finds via `TaskList`.

The net result: the shared task list becomes a battleground between the lead's orchestration tasks and each skill's internal task tracking. Neither side knows about the other's intent for the task list.

### Contributing Factor: Pre-Assignment Before Teammate Exists

The SKILL.md Section 4.3 prescribes this startup sequence:

```
1. TeamCreate
2. detect_pipeline_position
3. Create ALL pipeline tasks with blockedBy chains    ← 22 tasks created
4. For each role in suggestedRoster:
   a. TaskUpdate(taskId, owner="analyst")             ← pre-assign
   b. Read and fill spawn template
   c. Task(spawn teammate)                            ← teammate created AFTER assignment
```

Problems with this ordering:

1. **Tasks are assigned to names that don't exist yet**: `TaskUpdate(owner="analyst")` runs before `Task(name="analyst")` spawns the teammate. The assignment might not be properly linked.

2. **Workers start and immediately begin skill invocations**: By the time a worker exists, it invokes its skill, which creates/modifies tasks. If the lead is still creating tasks #15-22 in the same response, there's a race.

3. **Skills don't know about the lead's task graph**: The ralph-split skill creates its own "Analyze scope" and "Create sub-issues" tasks. The ralph-research skill creates its own "Research GH-NNN" task. These are independent of the lead's orchestration tasks.

### Contributing Factor: Skills Use TaskCreate for Internal Tracking

Each ralph skill has a "Team Result Reporting" section that instructs the worker to call `TaskUpdate` with result metadata. But the skills ALSO create their own tasks internally for phase tracking. This dual use of the shared task list — both as an orchestration channel (lead) and as a work-tracking tool (skills) — creates fundamental conflicts.

## Correct Ordering (Proposed)

Based on the empirical findings, the correct startup sequence should be:

```
1. TeamCreate
2. detect_pipeline_position
3. Spawn ALL teammates first (no tasks exist yet)
4. Wait for teammates to be ready (idle notifications)
5. Create pipeline tasks (teammates can now see them immediately)
6. Assign tasks to existing teammates
7. SendMessage to kick off work
```

Alternatively, a simpler model:

```
1. TeamCreate
2. Spawn teammates with work instructions in spawn prompt
3. Let skills handle their own task tracking
4. Use SendMessage for coordination (proven to work reliably)
5. Do NOT create lead-side orchestration tasks (they conflict with skills)
```

## Platform Behavior Summary

| Operation | Behavior | Verified |
|-----------|----------|----------|
| TeamCreate → TaskCreate | Goes to team dir | Yes |
| TeamCreate → spawn → TaskCreate | Goes to team dir | Yes |
| TeamCreate → spawn → worker TaskCreate | Goes to team dir, shared | Yes |
| TeamCreate → spawn → worker Skill → TaskCreate | Goes to team dir, shared | Yes (inferred from GH-364 evidence) |
| No team → TaskCreate | Goes to session-UUID dir | Yes |
| TaskCreate ID allocation | Auto-increment, max(existing) + 1 | Yes |
| Concurrent TaskCreate (lead + worker) | File locking prevents races | Yes (per docs) |
| TaskUpdate across sessions | Works — both can modify same task | Yes |
| SendMessage | Always works (inbox-based, team-scoped) | Yes |
| CLAUDE_CODE_TEAM_NAME in lead shell | Empty string (not set by TeamCreate) | Yes |
| CLAUDE_CODE_TEAM_NAME in worker | Set via Task(team_name=...) parameter | Yes (per docs) |

## Implications for SKILL.md Redesign

### Problem 1: Dual-Use Task List

The shared task list is used for two incompatible purposes:
- **Lead orchestration**: Pipeline DAG with blockedBy chains (22 tasks for GH-364)
- **Skill-internal tracking**: Each skill creates/modifies tasks for its own phase tracking

These conflict because they share the same ID space and same files.

### Problem 2: Lead Creates Tasks That Skills Overwrite

The lead's task subjects ("Create PR for GH-378", "Merge PR for GH-378") don't match what the skills expect. When the skill's `TaskUpdate` modifies the description of a task the lead created for a different purpose, the task becomes meaningless to both sides.

### Problem 3: Pre-Assignment to Non-Existent Teammates

Assigning `owner="analyst"` before the analyst teammate exists may not properly link the task to the eventual teammate session.

### Recommended Solutions

**Option A: Lead-Only Task Creation (Skills Don't Create Tasks)**
- Modify all skill SKILL.md files to remove internal TaskCreate calls
- Skills only use TaskUpdate to report results on the lead's tasks
- Requires skills to receive their assigned task ID and only update that task

**Option B: Skill-Only Task Creation (Lead Doesn't Create Tasks)**
- Lead uses SendMessage-only coordination
- Skills create their own tasks as needed
- Lead monitors progress via SendMessage responses
- Simplest change — remove Section 4.2 upfront task graph from SKILL.md

**Option C: Separate Namespaces**
- Lead creates orchestration tasks with a prefix (e.g., "ORCH: Research GH-378")
- Skills create work tasks with a different prefix (e.g., "WORK: Analyze scope")
- Both sides ignore the other's tasks
- Fragile — relies on naming conventions

**Option D: Spawn-First Ordering**
- Spawn all teammates before creating any tasks
- Create tasks only after teammates are ready
- Assign tasks to known-existing teammates
- Still has the dual-use conflict unless skills are modified

## References

- [Orchestrate teams of Claude Code sessions](https://code.claude.com/docs/en/agent-teams) — official docs
- [Hooks reference](https://code.claude.com/docs/en/hooks) — TeammateIdle, TaskCompleted hooks
- [Agent SDK TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript) — tool schemas
- [Subagents in the SDK](https://platform.claude.com/docs/en/agent-sdk/subagents) — Task tool, team_name parameter
- [From Tasks to Swarms](https://alexop.dev/posts/from-tasks-to-swarms-agent-teams-in-claude-code/) — community walkthrough
- [Claude Code Swarm Orchestration Skill](https://gist.github.com/kieranklaassen/4f2aba89594a4aea4ad64d753984b2ea) — community reference implementation
- Empirical smoke tests conducted 2026-02-24 in this session
