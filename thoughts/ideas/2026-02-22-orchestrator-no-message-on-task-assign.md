---
date: 2026-02-22
status: closed
reason: Handled by existing epic (team worker redesign)
---

# Orchestrator should not message teammates when assigning tasks

## Problem

Two related failures observed in the GH-321 epic team session:

### 1. Lead sends redundant messages on every task assignment

The ralph-team orchestrator calls `SendMessage` immediately after every `TaskUpdate(owner=...)`. This is an anti-pattern:

- **Redundant**: The task assignment IS the communication. Workers should discover tasks via `TaskList` — that's the pull-based model. The SKILL.md says "Don't nudge after assigning."
- **Counterproductive**: `SendMessage` consumes a worker turn processing the message instead of checking `TaskList` and executing the skill. The worker reads the message, acknowledges it, goes idle — and never runs the actual task.
- **Escalating**: When the worker goes idle, the lead sends another message (nudge), consuming another turn. This session saw 3-4 messages per task before workers picked them up.

### 2. Workers can't see tasks in TaskList (team context mismatch)

Workers reported TaskList was empty or showed stale tasks from earlier sessions. Tasks created by the lead were invisible to workers. This is the root cause — even if the lead stopped messaging, workers would still fail to discover tasks.

## Observed Behavior (GH-321 session)

- Lead sent 30+ messages across 14 issues — nearly all were task assignments that should have been silent
- Workers went idle without picking up assigned tasks on almost every assignment
- Lead nudged 2-4 times per task before workers responded
- Some tasks required reassigning to a fresh worker
- Workers that received full context in `SendMessage` content were more reliable than those expected to check `TaskList` — confirming TaskList was broken

## Root Cause Analysis

**Problem 1 (lead messaging):** The SKILL.md Section 5 says "Don't nudge after assigning" but Section 6 spawn procedure and Section 4.4 dispatch loop don't enforce this. The lead has no event-driven signal that a worker picked up a task — so it falls back to messaging as a "just in case" pattern.

**Problem 2 (TaskList invisibility):** Team tasks are scoped to `~/.claude/tasks/{team-name}/`. Workers may be reading from a different task directory, or the team context isn't propagating correctly to spawned agents. This needs investigation — the fix may be in how `team_name` is threaded through to the Task tools.

## Proposed Fix

### Fix 1: Hook-based task routing (replaces messaging)

Instead of the lead calling `SendMessage` after `TaskUpdate(owner=...)`, use **hooks on Team/Task tools** to ensure tasks are correctly routed and visible:

- **PostToolUse hook on `TaskUpdate`**: When `owner` changes, the hook ensures the task file is written to the correct team-scoped directory and the worker's agent context includes that directory.
- **PostToolUse hook on `TaskCreate`**: Validates the task is created in the active team's task directory (not a stale/default one).
- **PreToolUse hook on `TaskList`**: Ensures the calling agent reads from the correct team-scoped directory based on their `team_name` context.

This is event-driven — no polling, no sleep timers, no "wait 2 minutes then nudge." The hook fires on the tool call itself.

### Fix 2: Lead behavior change in SKILL.md

Update Section 4.4 (Dispatch Loop) and Section 6 (Teammate Spawning) to enforce:

```
After TaskUpdate(owner=...), do NOT call SendMessage.
The task assignment is the only communication needed.

Only SendMessage if:
- Responding to a direct question from a teammate
- Conveying context that cannot fit in the task description
- Redirecting a worker from a completed/duplicate task

NEVER SendMessage for:
- Task assignments (TaskUpdate handles this)
- Nudges (if worker is idle, check TaskList visibility first)
- Status confirmations ("task confirmed done" — TaskUpdate handles this)
```

### Fix 3: Worker spawn template change

Update `templates/spawn/worker.md` to include a `TaskList` check as the FIRST action before skill invocation. Workers should always verify their task assignment exists before proceeding.

### Anti-patterns to avoid

- **Sleep/timer-based nudging**: "Wait 2 minutes then message" is an anti-pattern in an event-driven system. Use hooks that fire on tool calls, not arbitrary timeouts.
- **Message-as-task-assignment**: `SendMessage` with task details in the content body bypasses the task system entirely. All task context belongs in `TaskCreate` description and metadata.
- **Duplicate channels**: If a task is assigned via `TaskUpdate(owner=...)`, sending the same information via `SendMessage` creates two sources of truth that can diverge.

## Investigation Needed

1. **Why is TaskList invisible to workers?** Check how `team_name` propagates to spawned agents and whether their `TaskList` calls resolve to the correct `~/.claude/tasks/{team-name}/` directory.
2. **Hook feasibility**: Can PostToolUse hooks on `TaskUpdate` and `TaskCreate` reliably intercept and validate team-scoped task routing? What are the hook event fields available for these tools?
3. **Worker wake mechanism**: When a task is assigned to an idle worker, what triggers them to check `TaskList`? If nothing does, we need a hook-based wake signal (not a message).

## Impact

- Eliminates 30+ wasted messages per epic session
- Faster pipeline throughput (no turn-consuming acknowledgment cycles)
- Workers reliably discover tasks via TaskList instead of parsing message content
- Event-driven architecture — no polling or timer anti-patterns
