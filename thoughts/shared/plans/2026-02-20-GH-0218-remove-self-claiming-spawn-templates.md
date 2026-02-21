---
date: 2026-02-20
status: draft
github_issues: [218]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/218
primary_issue: 218
---

# Remove Self-Claiming from Spawn Templates - Implementation Plan

## Overview

Single issue (#218) to transition the worker dispatch model from "hybrid claiming" (lead pre-assigns first task, workers self-claim thereafter) to "lead-dispatched" (lead assigns all tasks, workers execute and stop). Touches 14 files across spawn templates, agent definitions, conventions, SKILL.md, and hooks.

## Current State Analysis

The current model has workers autonomously looping after their first task, scanning TaskList for work matching their role. This causes race conditions, dispatch incoherence, and unbounded worker lifetimes. The research document (GH-0218) mapped the complete blast radius: 7 spawn templates, 4 agent definitions, 1 conventions file, 1 SKILL.md, and 1 hook script.

Since GH-134 moved to `general-purpose` subagent spawning, the spawn templates are the behavioral source of truth -- agent definitions serve as documentation only. However, all files need updating for consistency.

## Desired End State

### Verification
- [ ] No spawn template contains "check TaskList" or "hand off" trailing instructions
- [ ] No agent definition contains "self-claim", "Repeat from step 1", or task loop scanning
- [ ] Conventions Pipeline Handoff Protocol describes lead-dispatched model
- [ ] SKILL.md contains no references to "self-claim", "pull-based", or "workers match on these"
- [ ] Hook script guidance mentions assigning to idle workers (not just spawning)
- [ ] All existing tests still pass (`npm test` in mcp-server)

## What We're NOT Doing

- Not changing the lead's dispatch logic (how the lead decides which worker gets which task)
- Not changing the TaskCompleted/TeammateIdle hook scripts (they already support lead-dispatched)
- Not changing the spawn template format or placeholder system
- Not removing the Pipeline Order table from conventions (it's useful for the lead's routing decisions)
- Not changing ralph-hero solo mode (it already uses lead-dispatched)

## Implementation Approach

Three phases organized by file group, ordered from highest behavioral impact to documentation-only:

1. **Phase 1**: Spawn templates (behavioral fix -- these are what workers actually see)
2. **Phase 2**: Agent definitions and conventions (documentation consistency)
3. **Phase 3**: SKILL.md and hook script (orchestrator documentation)

---

## Phase 1: Spawn Templates - Remove Trailing Self-Claim Instructions
> **Issue**: [GH-218](https://github.com/cdubiel08/ralph-hero/issues/218) | **Research**: [GH-0218 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0218-remove-self-claiming-spawn-templates.md)

### Changes Required

#### 1. Remove trailing self-claim line from all 7 spawn templates

**Files**: All at `plugin/ralph-hero/templates/spawn/`

| Template | Line to remove | Replacement |
|----------|---------------|-------------|
| `triager.md` (line 7) | `Then check TaskList for more triage tasks.` | Delete line entirely |
| `splitter.md` (line 7) | `Then check TaskList for more split tasks.` | Delete line entirely |
| `researcher.md` (line 6) | `Then check TaskList for more research tasks. If none, hand off per shared/conventions.md.` | Delete line entirely |
| `planner.md` (line 7) | `Then check TaskList for more plan tasks. If none, hand off per shared/conventions.md.` | Delete line entirely |
| `reviewer.md` (line 7) | `Then check TaskList for more review tasks. If none, hand off per shared/conventions.md.` | Delete line entirely |
| `implementer.md` (line 8) | `Then check TaskList for more implementation tasks. If none, notify team-lead.` | Delete line entirely |
| `integrator.md` (line 5) | `Report results. Then check TaskList for more integration tasks.` | `Report results.` |

**Note**: For `integrator.md`, the line starts with "Report results" which must be preserved -- only the "Then check TaskList..." part is removed.

### Success Criteria
- [ ] Automated: `grep -r "check TaskList" plugin/ralph-hero/templates/spawn/` returns no results
- [ ] Automated: `grep -r "hand off per" plugin/ralph-hero/templates/spawn/` returns no results
- [ ] Manual: Each template is 5-7 lines (within template authoring rules)

**Creates for next phase**: Clean behavioral model; documentation still references old model

---

## Phase 2: Agent Definitions and Conventions - Remove Self-Claim Loops and Peer Handoffs
> **Issue**: [GH-218](https://github.com/cdubiel08/ralph-hero/issues/218) | **Depends on**: Phase 1

### Changes Required

#### 1. Restructure agent definition task loops (4 files)

**Files**: All at `plugin/ralph-hero/agents/`

For each agent (`ralph-analyst.md`, `ralph-builder.md`, `ralph-validator.md`, `ralph-integrator.md`), replace the "Task Loop" section. The current pattern is:

```
1. TaskList() -- find matching tasks, self-claim if no owner
2. Claim: TaskUpdate (flips status + optionally sets owner)
3. TaskGet -- extract context
4. Dispatch skill
5. TaskUpdate completed
6/7. Repeat from step 1 / SendMessage peer
```

Replace with:

```
1. TaskGet(assigned task) -- task is pre-assigned by lead
2. TaskUpdate(in_progress)
3. Dispatch skill
4. TaskUpdate(completed, description="results")
5. Stop (go idle -- lead assigns next task if available)
```

**Specific changes per file**:

**`ralph-analyst.md`** (lines 13-14, 25):
- Line 13-14: Replace self-claim step with "Your task is pre-assigned by the lead. `TaskGet(taskId)` to get context."
- Line 25: Replace "Repeat from step 1. If no tasks, read team config to find `ralph-builder` teammate and SendMessage them to check TaskList." with "Stop. The lead will assign your next task if work remains."

**`ralph-builder.md`** (lines 13-14, 22):
- Line 13-14: Replace self-claim step with pre-assigned model
- Line 22: Replace "Repeat from step 1. If no tasks, SendMessage `team-lead` that implementation is complete (integrator handles PR creation)." with "Stop. The lead will assign your next task if work remains."

**`ralph-validator.md`** (lines 13-14, 19):
- Line 13-14: Replace self-claim step with pre-assigned model
- Line 19: Replace "Repeat from step 1. If no tasks, go idle." with "Stop. The lead will assign your next task if work remains."

**`ralph-integrator.md`** (lines 13-14, 53):
- Line 13-14: Replace self-claim step with pre-assigned model
- Line 35 ("Return to task loop (step 1)."): Replace with "Stop. The lead will assign your next task if work remains."
- Line 53 ("Return to task loop (step 1). If no tasks, go idle."): Replace with "Stop. The lead will assign your next task if work remains."

#### 2. Rewrite Pipeline Handoff Protocol in conventions.md

**File**: `plugin/ralph-hero/skills/shared/conventions.md` (lines 91-136)

Replace the entire "Pipeline Handoff Protocol" section (lines 91-136) with a lead-dispatched model:

**Current** (lines 91-136):
```markdown
## Pipeline Handoff Protocol

Workers hand off to the next pipeline stage via peer-to-peer SendMessage...

### Pipeline Order
[table]

### Handoff Procedure (after completing a task)
1. Check TaskList for more tasks matching your role
2. If found: self-claim and continue
3. If none: hand off to next-stage peer via SendMessage
4. If peer not found: message lead

### Rules
- Lead pre-assigns at spawn only...
- SendMessage is fire-and-forget...
- Multiple handoffs are fine...
```

**Replace with**:
```markdown
## Worker Completion Protocol

Workers complete their assigned task, report results via TaskUpdate, and stop. The lead assigns all subsequent work.

### Pipeline Order (Lead Dispatch Reference)

| Stage | Next Stage | Lead Action |
|---|---|---|
| Triage/Split/Research complete | Plan | Assign plan task to builder |
| Plan complete | Review (if interactive) or Implement | Assign to validator or builder |
| Review complete (approved) | Implement | Assign implement task to builder |
| Review complete (rejected) | Re-plan | Assign revision task to builder |
| Implement complete | Create PR | Assign PR task to integrator |
| PR created | Merge | Assign merge task to integrator |

### Worker Procedure (after completing a task)

1. `TaskUpdate(taskId, status="completed", description="[results]")` with full results
2. Stop (go idle)
3. The lead receives an idle notification and assigns the next task if work remains

### Rules

- **Lead assigns all tasks**: The lead sets `owner` via `TaskUpdate` before spawning or messaging a worker. Workers never self-claim.
- **Workers execute one task and stop**: No looping, no scanning TaskList, no peer-to-peer handoffs.
- **Lead gets visibility** via TaskCompleted and TeammateIdle hooks -- automatic, no worker action needed.
- **Idle is normal**: Workers going idle after task completion is expected behavior, not an error.
```

### Success Criteria
- [ ] Automated: `grep -r "self-claim" plugin/ralph-hero/agents/` returns no results
- [ ] Automated: `grep -r "Repeat from step 1" plugin/ralph-hero/agents/` returns no results
- [ ] Automated: `grep -r "self-claim" plugin/ralph-hero/skills/shared/conventions.md` returns no results
- [ ] Manual: Each agent definition has a linear 5-step task execution (no loop)
- [ ] Manual: Conventions Pipeline Handoff section describes lead-dispatched model

**Creates for next phase**: Consistent documentation; SKILL.md still references old model

---

## Phase 3: SKILL.md and Hook Script - Update Orchestrator Documentation
> **Issue**: [GH-218](https://github.com/cdubiel08/ralph-hero/issues/218) | **Depends on**: Phase 2

### Changes Required

#### 1. Update SKILL.md self-claiming references (8 locations)

**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`

| Line(s) | Current | Replacement |
|---------|---------|-------------|
| 115 | `**Subject patterns** (workers match on these to self-claim):` | `**Subject patterns** (used for task routing):` |
| 122 | `Integrator will self-claim.` | `Lead assigns to integrator.` |
| 143 | `**Routine pipeline progression is handled by peer-to-peer handoffs** -- workers SendMessage the next-stage teammate when they complete a task and have no more work of their type. You do NOT need to route every completion.` | `**You route all pipeline progression.** When a worker completes a task, you receive a TaskCompleted hook notification. Check TaskList for newly unblocked tasks and assign them to idle workers.` |
| 147 | `The builder will self-claim.` | `Assign the revision task to the builder.` |
| 148 | `Workers self-claim.` | `Assign the task to the appropriate worker.` |
| 159 | `**Workers are autonomous**: After their initial pre-assigned task, workers self-claim from TaskList. Your job is ensuring workers exist and pre-assigning their first task at spawn.` | `**Workers execute and stop**: Workers complete their assigned task, report results, and go idle. Your job is assigning all tasks -- both initial and follow-up.` |
| 160 | `**Pre-assign at spawn, pull-based thereafter**: Call \`TaskUpdate(taskId, owner="[role]")\` immediately before spawning each worker. Do NOT assign tasks mid-pipeline or via SendMessage. Pipeline handoffs are peer-to-peer (see shared/conventions.md).` | `**Lead assigns all tasks**: Call \`TaskUpdate(taskId, owner="[role]")\` before spawning a worker or sending them a new assignment. Workers never self-claim. Dispatch follow-up work when TaskCompleted or TeammateIdle hooks fire.` |
| 229 | `Idle workers auto-claim new tasks from TaskList` | `Idle workers wait for lead assignment via TaskUpdate + SendMessage` |
| 230 | `Nudge idle workers via SendMessage only if idle >2 minutes with unclaimed tasks` | `Assign tasks to idle workers when TaskCompleted or TeammateIdle hooks fire` |
| 265 | `**Hybrid claiming**: Initial tasks are pre-assigned by the lead before spawning. Subsequent tasks use pull-based self-claim with consistent subjects ("Research", "Plan", "Review", "Implement", "Triage", "Split", "Merge"). Workers match on these for self-claim.` | `**Lead-dispatched**: All tasks are assigned by the lead via TaskUpdate. Workers execute their assigned task and stop. The lead assigns follow-up work when hooks fire.` |

#### 2. Update hook script guidance text

**File**: `plugin/ralph-hero/hooks/scripts/team-stop-gate.sh` (line 45)

**Current** (line 45):
```
Run the dispatch loop: check TaskList for unblocked tasks, spawn workers
```

**Replace with**:
```
Run the dispatch loop: check TaskList for unblocked tasks, assign to idle workers or spawn new ones
```

### Success Criteria
- [ ] Automated: `grep -r "self-claim" plugin/ralph-hero/skills/ralph-team/SKILL.md` returns no results
- [ ] Automated: `grep -r "pull-based" plugin/ralph-hero/skills/ralph-team/SKILL.md` returns no results
- [ ] Automated: `grep "auto-claim" plugin/ralph-hero/skills/ralph-team/SKILL.md` returns no results
- [ ] Manual: SKILL.md Section 5 describes lead-dispatched model
- [ ] Manual: SKILL.md Section 9 no longer lists "Hybrid claiming"

---

## Integration Testing

- [ ] `grep -rn "self-claim" plugin/ralph-hero/` returns no results (across all plugin files)
- [ ] `grep -rn "check TaskList for more" plugin/ralph-hero/` returns no results
- [ ] `grep -rn "Repeat from step 1" plugin/ralph-hero/` returns no results
- [ ] `grep -rn "pull-based" plugin/ralph-hero/` returns no results
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes (no MCP server code changed, but verify no regressions)
- [ ] Each spawn template is <= 8 lines (template authoring rules)

## References

- Research: [GH-0218 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0218-remove-self-claiming-spawn-templates.md)
- Issue: [GH-218](https://github.com/cdubiel08/ralph-hero/issues/218)
- Related: GH-134 (general-purpose subagent migration -- established spawn templates as behavioral source of truth)
