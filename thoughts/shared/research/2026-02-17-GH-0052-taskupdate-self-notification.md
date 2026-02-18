---
date: 2026-02-17
github_issue: 52
github_url: https://github.com/cdubiel08/ralph-hero/issues/52
status: complete
type: research
---

# Research: GH-52 - TaskUpdate Self-Notification Bug

## Problem Statement

When teammates complete work, they call `TaskUpdate(taskId, status="completed", description="...")` which triggers a self-notification, causing an unnecessary extra turn. This wastes tokens and adds latency to the pipeline.

## Current State Analysis

### How Teammates Complete Tasks

All five agent definitions follow the same pattern:

1. **Claim** (step 2): `TaskUpdate(taskId, status="in_progress", owner="[role-name]")`
2. **Do work** (steps 3-4): invoke the skill
3. **Complete** (step 5): `TaskUpdate(taskId, status="completed", description="...")`
4. **Loop** (step 6): check TaskList for more work, or hand off to next peer

Affected files:
- [agents/ralph-researcher.md:14-17](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-researcher.md#L14-L17)
- [agents/ralph-planner.md:14-17](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-planner.md#L14-L17)
- [agents/ralph-advocate.md:14-17](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-advocate.md#L14-L17)
- [agents/ralph-implementer.md:14-18](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-implementer.md#L14-L18)
- [agents/ralph-triager.md:14-18](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-triager.md#L14-L18)

### Root Cause Analysis

The self-notification occurs through the Claude Code SDK's task ownership notification system. The sequence is:

1. Teammate claims task with `TaskUpdate(taskId, status="in_progress", owner="researcher")` -- this sets the teammate as the task's **owner**.
2. Teammate completes work and calls `TaskUpdate(taskId, status="completed", description="...")`.
3. The Claude Code SDK's `TaskCompleted` event fires. This event is designed to notify the **team lead** (via the lead's `TaskCompleted` hook), but the SDK also delivers a notification to the **task's owner** when the task status changes.
4. Since the task's owner IS the teammate that just completed it, the teammate receives a notification about its own completion.
5. This notification triggers an extra turn in the teammate's context, wasting tokens.

### Why This Is a Claude Code SDK Behavior, Not Teammate Misuse

The agent definitions do NOT explicitly page themselves -- the completion call at step 5 only passes `taskId`, `status`, and `description`. There is no `owner` parameter in the completion call. However, the task already has an owner from step 2 (the claim). The SDK auto-notifies the owner on status changes, which creates the self-targeting loop.

The existing convention in [shared/conventions.md:132](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md#L132) warns:
> "Never use TaskUpdate with `owner` parameter to assign tasks to other teammates."

This prohibition addresses cross-assignment but does not address the self-notification that occurs when a teammate IS the owner and marks its own task complete.

### Evidence of the Problem

The pattern is consistent across all five agent types. Each one:
1. Self-claims by setting `owner` to their own name (step 2)
2. Completes by changing status (step 5)
3. Receives an SDK-triggered notification about their own completion

The extra turn is visible as an additional idle-like cycle where the teammate processes the completion notification and then either goes idle or repeats TaskList (which it was already going to do in step 6).

## Potential Approaches

### Approach A: Remove `owner` from the Claim Call

**Change**: Replace `TaskUpdate(taskId, status="in_progress", owner="researcher")` with `TaskUpdate(taskId, status="in_progress")` across all agent definitions.

**Pros:**
- Eliminates the root cause -- no owner means no owner-targeted notification
- Simplest change (remove one parameter from 5 files)
- TaskList already shows which tasks are `in_progress` vs `pending`, so the lead can still see task status

**Cons:**
- Loses ownership tracking -- if two teammates of the same role exist (e.g., `researcher` and `researcher-2`), both might try to claim the same task
- The SDK uses file locking for task claims, which prevents actual race conditions, but without `owner` the lead cannot see WHO is working on what
- Breaks the pull-based claiming model described in the official Claude Code docs: "Self-claim: after finishing a task, a teammate picks up the next unassigned, unblocked task on its own"

**Verdict**: Not recommended. Ownership serves an important coordination purpose.

### Approach B: Unset Owner Before Completing

**Change**: Add an explicit owner-clearing step before completion. Replace step 5 with:
```
TaskUpdate(taskId, owner="")
TaskUpdate(taskId, status="completed", description="...")
```

**Pros:**
- Owner is cleared before completion fires, so no self-notification
- Still preserves ownership during active work

**Cons:**
- Adds an extra API call per task completion
- Two-step operation creates a window where the task has no owner but is still in_progress
- Fragile -- if the agent forgets the first call, the bug returns
- The SDK might not support setting owner to empty string

**Verdict**: Not recommended. Fragile and adds complexity.

### Approach C: Instruct Teammates to Ignore Self-Notifications

**Change**: Add instruction to agent definitions telling teammates to ignore/discard any notification about their own task completions.

Example addition to each agent:
```
**Note**: You may receive a notification about your own task completion after calling TaskUpdate. This is expected SDK behavior. Ignore it and continue to step 6 (TaskList).
```

**Pros:**
- No change to TaskUpdate calls
- Directly addresses the symptom
- Easy to add to all agent definitions

**Cons:**
- The notification still triggers an extra turn (the teammate must process it to decide to ignore it)
- Token cost is reduced but not eliminated -- the extra turn still happens, it just terminates quickly
- Relies on the LLM following the instruction correctly every time

**Verdict**: Partially effective. Reduces the wasted-work aspect but does not eliminate the extra turn.

### Approach D: Combine Completion and Loop into a Single Instruction Block

**Change**: Restructure the agent definitions so that TaskUpdate completion and the subsequent TaskList check are described as an atomic sequence, making it clear that no intermediate processing should occur.

Currently:
```
5. TaskUpdate(taskId, status="completed", description="...")
6. Repeat from step 1.
```

Changed to:
```
5. TaskUpdate(taskId, status="completed", description="...") then IMMEDIATELY proceed to step 1 without waiting for any notifications.
```

Combined with Approach C's awareness note.

**Pros:**
- Strengthens the instruction to continue without processing notifications
- Works with the existing TaskUpdate pattern

**Cons:**
- Same limitation as Approach C -- the SDK still delivers the notification and triggers a turn
- Prompt engineering is probabilistic, not deterministic

**Verdict**: Better than C alone, but still a mitigation rather than a fix.

### Approach E: Move Ownership to Task Metadata Instead of `owner` Field

**Change**: Stop using the `owner` parameter entirely. Instead, track who's working on a task via the `metadata` field:
```
TaskUpdate(taskId, status="in_progress", metadata={"claimed_by": "researcher"})
```

**Pros:**
- Metadata changes likely don't trigger owner-targeted notifications
- Still allows the lead to see who's working on what (via TaskGet)
- Clean separation of "coordination info" from "notification target"

**Cons:**
- TaskList output shows `owner` natively but may not surface metadata
- The lead's TaskList-based dispatch would need to inspect metadata instead of owner
- Teammates checking "no owner" in step 1 would need to check metadata instead
- Unproven whether this actually avoids the notification (SDK might still fire TaskCompleted)

**Verdict**: Promising but unproven. Needs testing.

### Approach F (Recommended): Awareness Note + Explicit "Continue" Instruction

**Change**: A pragmatic combination:

1. Add a note to each agent definition explaining the self-notification:
   ```
   **SDK note**: Completing a task you own may trigger a self-notification. This is expected. Continue your task loop without processing it.
   ```

2. Add "do not wait" language to the completion step:
   ```
   5. `TaskUpdate(taskId, status="completed", description="...")` -- continue immediately, do not process any resulting notification.
   6. Repeat from step 1.
   ```

3. Add this as a known behavior in [shared/conventions.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md) so future agent definitions inherit the guidance.

**Pros:**
- Minimal change to existing architecture
- Documents the SDK behavior for future reference
- Gives agents clear instruction to handle the situation
- Does not break ownership tracking or claim semantics

**Cons:**
- Does not eliminate the extra turn at the SDK level
- Relies on LLM compliance

**Verdict**: Best practical fix given that the notification is an SDK behavior we cannot control. If Claude Code updates to allow suppressing owner-notifications on self-updates, the awareness notes become unnecessary documentation.

## Risks and Considerations

1. **SDK evolution**: Claude Code Agent Teams is experimental. The self-notification behavior may change in future releases. The fix should be designed to degrade gracefully -- awareness notes are harmless if the behavior changes.

2. **Multiple instances**: Researchers can have up to 3 parallel instances (`researcher`, `researcher-2`, `researcher-3`). The self-notification affects each independently. The fix must work for all named instances.

3. **Related bug**: GH-53 (Teammate agents perform work in primary context instead of invoking skills) touches the same agent definition files. Coordinate changes to avoid merge conflicts.

4. **Token cost**: Each self-notification turn costs a small amount of tokens (the teammate processes the notification, finds nothing to do, and returns to its loop). For a 5-task pipeline with 5 completions, this is approximately 5 extra turns of overhead.

## Recommended Next Steps

1. **Implement Approach F**: Update all 5 agent definitions with the awareness note and explicit continue instruction.
2. **Update shared/conventions.md**: Add a "Known SDK Behaviors" section documenting the TaskUpdate self-notification.
3. **Test**: Run a `/ralph-team` session and verify teammates process completions cleanly without visible extra turns.
4. **Long-term**: Monitor Claude Code SDK releases for changes to TaskCompleted notification routing. If the SDK adds an option to suppress owner-notifications on self-updates, adopt it.

## Files Requiring Changes

| File | Change |
|------|--------|
| `plugin/ralph-hero/agents/ralph-researcher.md` | Add awareness note, update step 5 |
| `plugin/ralph-hero/agents/ralph-planner.md` | Add awareness note, update step 5 |
| `plugin/ralph-hero/agents/ralph-advocate.md` | Add awareness note, update step 5 |
| `plugin/ralph-hero/agents/ralph-implementer.md` | Add awareness note, update step 6 |
| `plugin/ralph-hero/agents/ralph-triager.md` | Add awareness note, update step 5 |
| `plugin/ralph-hero/skills/shared/conventions.md` | Add "Known SDK Behaviors" section |
