---
date: 2026-02-20
status: draft
github_issues: [200]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/200
primary_issue: 200
---

# Fix Task Ownership Race Condition - Atomic Implementation Plan

## Overview

1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-200 | fix(ralph-team): tasks not self-assigned on first iteration causing race conditions | S |

## Current State Analysis

The ralph-team system uses a **pull-based** task ownership model where the lead creates tasks with `owner=""` and workers must self-claim via `TaskList -> TaskUpdate`. This fails reliably on the first worker turn because:

1. **Spawn templates instruct skill invocation before task claiming** - The template says `Invoke: Skill(...)` then `check TaskList`, but the agent definition says `TaskList` first. The spawn prompt wins because it's the immediate context.
2. **No atomicity in read-then-claim** - Between `TaskList` (read) and `TaskUpdate` (write), another worker can claim the same task.
3. **Lead is prohibited from pre-assigning** - `SKILL.md:155` says "Never assign tasks" and `conventions.md:133` says "Never use TaskUpdate with `owner` parameter".
4. **Subject keyword matching is fragile** - Workers filter by keywords like "Research", "Plan", etc. Slight mismatches cause missed claims.

## Desired End State

### Verification
- [ ] Lead pre-assigns `owner` on each task before spawning the corresponding worker
- [ ] Workers find tasks by `owner == "[my-role]"` instead of `owner == ""`
- [ ] The "never assign from lead" prohibition is replaced with "pre-assign at spawn, pull-based thereafter"
- [ ] Peer-to-peer handoffs for subsequent tasks remain pull-based (unchanged)
- [ ] All 4 agent definitions handle both pre-assigned (first task) and self-claimed (subsequent tasks) discovery

## What We're NOT Doing

- NOT changing spawn templates -- the template reordering (putting claim before Invoke) is insufficient alone and is not part of this fix
- NOT adding hook-based enforcement -- hooks cannot force the right action, only block wrong ones, and catch-all matcher overhead is prohibitive
- NOT changing the peer-to-peer handoff protocol -- only the initial spawn assignment changes
- NOT changing the ralph-hero (non-team) skill -- it uses ephemeral subagents without the task system

## Implementation Approach

This is a coordinated documentation change across 6 files. The lead's spawn procedure gains a pre-assignment step, the prohibition against lead assignment is scoped to allow pre-assignment, and all 4 worker agent definitions update their claim logic to support both pre-assigned and self-claimed task discovery.

---

## Phase 1: GH-200 - Hybrid Push/Pull Task Ownership

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/200 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0200-task-self-assignment-race-condition.md

### Changes Required

#### 1. Update lead spawn procedure to pre-assign before spawning
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Lines**: 128-132 (Section 4.3 "Spawn Workers for Available Tasks")

**Current** (line 130):
```
Check TaskList for pending, unblocked tasks. Spawn one worker per role with available work (see Section 6 for spawn template). Workers self-claim -- no assignment messages needed.
```

**Change to**:
```
Check TaskList for pending, unblocked tasks. For each available task:

1. **Pre-assign ownership**: `TaskUpdate(taskId, owner="[role]")` -- sets owner BEFORE spawning
2. **Spawn worker**: See Section 6 for spawn template

Pre-assignment is atomic -- the task is owned before the worker's first turn begins. No race window exists.
```

#### 2. Replace "never assign" prohibition with scoped pre-assignment rule
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Lines**: 154-155 (Section 5 "Behavioral Principles")

**Current** (lines 154-155):
```
- **Workers are autonomous**: They self-claim from TaskList. Your job is ensuring workers exist, not assigning work.
- **Never assign tasks**: Do NOT call TaskUpdate with `owner` to assign work. Do NOT send assignment messages via SendMessage. Pipeline handoffs are peer-to-peer (see shared/conventions.md).
```

**Change to**:
```
- **Workers are autonomous**: After their initial pre-assigned task, workers self-claim from TaskList. Your job is ensuring workers exist and pre-assigning their first task at spawn.
- **Pre-assign at spawn, pull-based thereafter**: Call `TaskUpdate(taskId, owner="[role]")` immediately before spawning each worker. Do NOT assign tasks mid-pipeline or via SendMessage. Pipeline handoffs are peer-to-peer (see shared/conventions.md).
```

#### 3. Update "Pull-based claiming" known limitation
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Line**: 260 (Section 9 "Known Limitations")

**Current**:
```
- **Pull-based claiming**: Tasks MUST use consistent subjects ("Research", "Plan", "Review", "Implement", "Triage", "Split", "Merge"). Workers match on these.
```

**Change to**:
```
- **Hybrid claiming**: Initial tasks are pre-assigned by the lead before spawning. Subsequent tasks use pull-based self-claim with consistent subjects ("Research", "Plan", "Review", "Implement", "Triage", "Split", "Merge"). Workers match on these for self-claim.
```

#### 4. Update conventions.md handoff rules to allow lead pre-assignment
**File**: `plugin/ralph-hero/skills/shared/conventions.md`
**Line**: 133 (Pipeline Handoff Protocol > Rules)

**Current**:
```
- **Never use TaskUpdate with `owner` parameter** to assign tasks to other teammates. Workers self-claim only.
```

**Change to**:
```
- **Lead pre-assigns at spawn only**: The lead sets `owner` via `TaskUpdate` immediately before spawning a worker. After spawn, workers self-claim subsequent tasks. Do NOT assign tasks mid-pipeline via TaskUpdate or SendMessage.
```

#### 5. Update analyst agent claim logic
**File**: `plugin/ralph-hero/agents/ralph-analyst.md`
**Lines**: 13-14 (Task Loop steps 1-2)

**Current**:
```
1. `TaskList()` — find tasks with "Triage", "Split", or "Research" in subject, `pending`, empty `blockedBy`, no `owner`
2. Claim lowest-ID match: `TaskUpdate(taskId, status="in_progress", owner="analyst")`
```

**Change to**:
```
1. `TaskList()` — find tasks with "Triage", "Split", or "Research" in subject, `pending`, empty `blockedBy`. Prefer tasks where `owner == "analyst"` (pre-assigned). If none pre-assigned, find tasks with no `owner` (self-claim).
2. Claim: `TaskUpdate(taskId, status="in_progress", owner="analyst")` — for pre-assigned tasks this flips status only; for self-claimed tasks this also sets owner.
```

#### 6. Update builder agent claim logic
**File**: `plugin/ralph-hero/agents/ralph-builder.md`
**Lines**: 13-14 (Task Loop steps 1-2)

**Current**:
```
1. `TaskList()` — find tasks with "Plan" (not "Review") or "Implement" in subject, `pending`, empty `blockedBy`, no `owner`
2. Claim lowest-ID match: `TaskUpdate(taskId, status="in_progress", owner="builder")`
```

**Change to**:
```
1. `TaskList()` — find tasks with "Plan" (not "Review") or "Implement" in subject, `pending`, empty `blockedBy`. Prefer tasks where `owner == "builder"` (pre-assigned). If none pre-assigned, find tasks with no `owner` (self-claim).
2. Claim: `TaskUpdate(taskId, status="in_progress", owner="builder")` — for pre-assigned tasks this flips status only; for self-claimed tasks this also sets owner.
```

#### 7. Update validator agent claim logic
**File**: `plugin/ralph-hero/agents/ralph-validator.md`
**Lines**: 13-14 (Task Loop steps 1-2)

**Current**:
```
1. `TaskList()` — find tasks with "Review" or "Validate" in subject, `pending`, empty `blockedBy`, no `owner`
2. Claim lowest-ID match: `TaskUpdate(taskId, status="in_progress", owner="validator")`
```

**Change to**:
```
1. `TaskList()` — find tasks with "Review" or "Validate" in subject, `pending`, empty `blockedBy`. Prefer tasks where `owner == "validator"` (pre-assigned). If none pre-assigned, find tasks with no `owner` (self-claim).
2. Claim: `TaskUpdate(taskId, status="in_progress", owner="validator")` — for pre-assigned tasks this flips status only; for self-claimed tasks this also sets owner.
```

#### 8. Update integrator agent claim logic
**File**: `plugin/ralph-hero/agents/ralph-integrator.md`
**Lines**: 13-14 (Task Loop steps 1-2)

**Current**:
```
1. `TaskList()` — find tasks with "Create PR", "Merge", or "Integrate" in subject, `pending`, empty `blockedBy`, no `owner`
2. Claim lowest-ID match: `TaskUpdate(taskId, status="in_progress", owner="integrator")`
```

**Change to**:
```
1. `TaskList()` — find tasks with "Create PR", "Merge", or "Integrate" in subject, `pending`, empty `blockedBy`. Prefer tasks where `owner == "integrator"` (pre-assigned). If none pre-assigned, find tasks with no `owner` (self-claim).
2. Claim: `TaskUpdate(taskId, status="in_progress", owner="integrator")` — for pre-assigned tasks this flips status only; for self-claimed tasks this also sets owner.
```

### Success Criteria

- [ ] Automated: `grep -c "Never assign tasks" plugin/ralph-hero/skills/ralph-team/SKILL.md` returns 0
- [ ] Automated: `grep -c "Never use TaskUpdate with .owner. parameter" plugin/ralph-hero/skills/shared/conventions.md` returns 0
- [ ] Automated: `grep -c "Pre-assign at spawn" plugin/ralph-hero/skills/ralph-team/SKILL.md` returns 1
- [ ] Automated: `grep -c "Lead pre-assigns at spawn" plugin/ralph-hero/skills/shared/conventions.md` returns 1
- [ ] Automated: `grep -c "pre-assigned" plugin/ralph-hero/agents/ralph-analyst.md` returns at least 1
- [ ] Automated: `grep -c "pre-assigned" plugin/ralph-hero/agents/ralph-builder.md` returns at least 1
- [ ] Automated: `grep -c "pre-assigned" plugin/ralph-hero/agents/ralph-validator.md` returns at least 1
- [ ] Automated: `grep -c "pre-assigned" plugin/ralph-hero/agents/ralph-integrator.md` returns at least 1
- [ ] Manual: Lead's Section 4.3 includes `TaskUpdate(taskId, owner="[role]")` step before spawning
- [ ] Manual: Agent definitions support BOTH pre-assigned (`owner == "[role]"`) and self-claimed (`no owner`) discovery
- [ ] Manual: Peer-to-peer handoff protocol in conventions.md is unchanged (fire-and-forget SendMessage, workers self-claim from TaskList)
- [ ] Manual: No spawn template files were modified (templates remain unchanged)

---

## Integration Testing

- [ ] Run `/ralph-team [issue-number]` with a fresh issue -- verify first-turn tasks are owned before worker execution begins
- [ ] Verify peer-to-peer handoff still works after the initial pre-assigned task completes (worker finds next task via self-claim)
- [ ] Verify group research with 3 analysts: each gets a unique pre-assignment (`analyst`, `analyst-2`, `analyst-3`)
- [ ] Verify no regression in the ralph-hero (non-team) skill which uses ephemeral subagents

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0200-task-self-assignment-race-condition.md
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/209
- Hook analysis comment: https://github.com/cdubiel08/ralph-hero/issues/209#issuecomment-IC_kwDORABwmc7qhAeH
