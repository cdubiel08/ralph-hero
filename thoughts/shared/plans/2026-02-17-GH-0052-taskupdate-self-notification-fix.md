---
date: 2026-02-17
status: draft
github_issue: 52
github_url: https://github.com/cdubiel08/ralph-hero/issues/52
---

# Fix TaskUpdate Self-Notification in Agent Definitions

## Overview

When teammates complete a task they own, the Claude Code SDK auto-notifies the task owner -- which is the teammate itself. This triggers a wasted extra turn per task completion. The fix adds awareness notes and explicit "continue immediately" instructions to all 5 agent definitions and documents the behavior in shared conventions.

## Current State Analysis

All 5 agent definitions ([ralph-researcher.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-researcher.md), [ralph-planner.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-planner.md), [ralph-advocate.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-advocate.md), [ralph-implementer.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-implementer.md), [ralph-triager.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-triager.md)) follow this pattern:

1. Claim: `TaskUpdate(taskId, status="in_progress", owner="[role]")` -- sets self as owner
2. Do work: invoke skill
3. Complete: `TaskUpdate(taskId, status="completed", description="...")` -- SDK notifies owner (self)
4. Loop: check TaskList

The SDK's `TaskCompleted` event fires on step 3 and auto-notifies the task owner set in step 1. Since the owner IS the teammate, it receives a notification about its own completion, triggering an extra wasted turn.

[shared/conventions.md:132](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md#L132) warns "Never use TaskUpdate with `owner` parameter to assign tasks to other teammates" but does not address self-notification.

## Desired End State

Teammates handle the self-notification gracefully by continuing their task loop immediately without processing the notification as new work.

### Verification
- [ ] All 5 agent definitions contain the SDK awareness note
- [ ] All 5 agent definitions have "continue immediately" language on the completion step
- [ ] `shared/conventions.md` has a "Known SDK Behaviors" section documenting TaskUpdate self-notification
- [ ] Run a `/ralph-team` session and verify teammates do not produce visible extra idle turns after task completions

## What We're NOT Doing

- Not removing the `owner` parameter from claim calls (ownership tracking is valuable)
- Not adding extra TaskUpdate calls to unset owner before completion (fragile, adds API overhead)
- Not moving ownership tracking to metadata (unproven, would require lead-side changes)
- Not modifying the MCP server or SDK (this is SDK-level behavior we cannot control)

## Implementation Approach

Add two types of changes across 6 files:

1. **Awareness note** in each agent definition explaining the SDK behavior
2. **Explicit continue instruction** on the completion step telling the agent to proceed immediately
3. **Convention documentation** in `shared/conventions.md` so future agent definitions inherit the guidance

The changes are minimal text additions -- no structural changes to the task loop or tool calls.

---

## Phase 1: Update Agent Definitions

### Overview

Add the SDK awareness note and update the completion step in all 5 agent definition files.

### Changes Required

#### 1. Add SDK awareness note to ralph-researcher.md
**File**: `plugin/ralph-hero/agents/ralph-researcher.md`
**Changes**: Add a `## SDK Note` section after the `## Shutdown` section. Update step 5 to include "continue immediately" language.

Current step 5 (line 17):
```
5. `TaskUpdate(taskId, status="completed", description="RESEARCH COMPLETE: #NNN - [Title]\nDocument: [path]\nKey findings: [summary]\nTicket moved to: Ready for Plan")`
```

New step 5:
```
5. `TaskUpdate(taskId, status="completed", description="RESEARCH COMPLETE: #NNN - [Title]\nDocument: [path]\nKey findings: [summary]\nTicket moved to: Ready for Plan")` -- continue immediately to step 6, do not process any resulting notification.
```

Add after the Shutdown section:
```markdown
## SDK Note

Completing a task you own triggers a self-notification from the Claude Code SDK. This is expected behavior -- ignore it and continue your task loop without processing it as new work.
```

#### 2. Add SDK awareness note to ralph-planner.md
**File**: `plugin/ralph-hero/agents/ralph-planner.md`
**Changes**: Same pattern as researcher. Update step 5 (line 17) to add "continue immediately" language. Add `## SDK Note` section after Shutdown.

Current step 5:
```
5. `TaskUpdate(taskId, status="completed", description="PLAN COMPLETE: [ticket/group]\nPlan: [path]\nPhases: [N]\nFile ownership: [groups]\nReady for review.")`
```

New step 5:
```
5. `TaskUpdate(taskId, status="completed", description="PLAN COMPLETE: [ticket/group]\nPlan: [path]\nPhases: [N]\nFile ownership: [groups]\nReady for review.")` -- continue immediately to step 6, do not process any resulting notification.
```

#### 3. Add SDK awareness note to ralph-advocate.md
**File**: `plugin/ralph-hero/agents/ralph-advocate.md`
**Changes**: Same pattern. Update step 5 (line 17). Add `## SDK Note` section after Shutdown.

Current step 5:
```
5. `TaskUpdate(taskId, status="completed", description="PLAN REVIEW VERDICT\nTicket: #NNN\nPlan: [path]\nVERDICT: [APPROVED/NEEDS_ITERATION]\n[blocking issues with file:line evidence]\n[warnings]\n[what's good]")`
```

New step 5:
```
5. `TaskUpdate(taskId, status="completed", description="PLAN REVIEW VERDICT\nTicket: #NNN\nPlan: [path]\nVERDICT: [APPROVED/NEEDS_ITERATION]\n[blocking issues with file:line evidence]\n[warnings]\n[what's good]")` -- continue immediately to step 6, do not process any resulting notification.
```

#### 4. Add SDK awareness note to ralph-implementer.md
**File**: `plugin/ralph-hero/agents/ralph-implementer.md`
**Changes**: Same pattern. Update step 6 (line 18) -- note the implementer's completion is step 6, not step 5, because step 5 is a file ownership check. Add `## SDK Note` section after Shutdown.

Current step 6:
```
6. `TaskUpdate(taskId, status="completed", description="IMPLEMENTATION COMPLETE\nTicket: #NNN\nPhases: [N] of [M]\nFiles: [list]\nTests: [PASSING/FAILING]\nCommit: [hash]\nWorktree: [path]")`
```

New step 6:
```
6. `TaskUpdate(taskId, status="completed", description="IMPLEMENTATION COMPLETE\nTicket: #NNN\nPhases: [N] of [M]\nFiles: [list]\nTests: [PASSING/FAILING]\nCommit: [hash]\nWorktree: [path]")` -- continue immediately to step 7, do not process any resulting notification.
```

#### 5. Add SDK awareness note to ralph-triager.md
**File**: `plugin/ralph-hero/agents/ralph-triager.md`
**Changes**: Same pattern. Update step 5 (line 18). Add `## SDK Note` section after Shutdown.

Current step 5:
```
5. `TaskUpdate(taskId, status="completed", description="TRIAGE COMPLETE: #NNN\nAction: [CLOSE/SPLIT/RESEARCH/KEEP]\n[If SPLIT]: Sub-tickets: #AAA, #BBB\nEstimates: #AAA (XS), #BBB (S)")`
```

New step 5:
```
5. `TaskUpdate(taskId, status="completed", description="TRIAGE COMPLETE: #NNN\nAction: [CLOSE/SPLIT/RESEARCH/KEEP]\n[If SPLIT]: Sub-tickets: #AAA, #BBB\nEstimates: #AAA (XS), #BBB (S)")` -- continue immediately to step 6, do not process any resulting notification.
```

### Success Criteria

#### Automated Verification
- [ ] `grep -l "SDK Note" plugin/ralph-hero/agents/ralph-*.md | wc -l` returns 5
- [ ] `grep -l "continue immediately" plugin/ralph-hero/agents/ralph-*.md | wc -l` returns 5

#### Manual Verification
- [ ] Each agent definition has the SDK Note section with consistent wording
- [ ] The "continue immediately" instruction is on the correct step number for each agent (step 5 for researcher/planner/advocate/triager, step 6 for implementer)

---

## Phase 2: Update Shared Conventions

### Overview

Add a "Known SDK Behaviors" section to `shared/conventions.md` documenting the TaskUpdate self-notification, so future agent definitions inherit the guidance.

### Changes Required

#### 1. Add Known SDK Behaviors section
**File**: `plugin/ralph-hero/skills/shared/conventions.md`
**Changes**: Add a new `## Known SDK Behaviors` section after the existing `## Pipeline Handoff Protocol` section (before `## Spawn Template Protocol`). This placement keeps it near the TaskUpdate ownership rules at line 132.

New section content:
```markdown
## Known SDK Behaviors

### TaskUpdate Self-Notification

When a teammate owns a task (via `owner` parameter at claim time) and changes its status, the Claude Code SDK auto-notifies the task owner. Since the owner is the teammate itself, this triggers a self-notification and an extra turn.

**Impact**: Each task completion causes one wasted turn where the teammate processes a notification about its own action.

**Mitigation**: Agent definitions include "continue immediately" language on completion steps. Teammates should ignore self-notifications and proceed directly to the next iteration of their task loop.

**Root cause**: The SDK's `TaskCompleted` event notifies the task owner on status changes. This is SDK-level behavior that cannot be suppressed. If a future SDK release adds an option to skip owner-notifications on self-updates, adopt it and remove the mitigation notes.
```

### Success Criteria

#### Automated Verification
- [ ] `grep "Known SDK Behaviors" plugin/ralph-hero/skills/shared/conventions.md` matches
- [ ] `grep "TaskUpdate Self-Notification" plugin/ralph-hero/skills/shared/conventions.md` matches

#### Manual Verification
- [ ] Section is placed logically near existing TaskUpdate ownership rules
- [ ] Documentation explains root cause, impact, and mitigation clearly

---

## Testing Strategy

1. **Static verification**: Grep all 6 files for the expected additions (see automated verification items above)
2. **Runtime verification**: Run a `/ralph-team` session with at least one complete task cycle and observe that teammates do not produce visible extra idle turns after completing tasks. The self-notification turn should be minimal (teammate sees it, ignores it, continues loop).

## References

- [Issue #52](https://github.com/cdubiel08/ralph-hero/issues/52)
- [Research document](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0052-taskupdate-self-notification.md)
- [Related: #53 - Teammate agents perform work in primary context](https://github.com/cdubiel08/ralph-hero/issues/53) -- touches same files, coordinate to avoid conflicts
