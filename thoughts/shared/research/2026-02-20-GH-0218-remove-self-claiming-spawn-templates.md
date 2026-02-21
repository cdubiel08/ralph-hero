---
date: 2026-02-20
github_issue: 218
github_url: https://github.com/cdubiel08/ralph-hero/issues/218
status: complete
type: research
---

# GH-218: Remove Self-Claiming from Spawn Templates

## Problem Statement

Workers spawned by the ralph-team orchestrator currently contain trailing instructions that tell them to "check TaskList for more work" after completing their assigned task. This creates a self-claiming / pull-based continuation pattern where workers autonomously loop, scanning TaskList for unowned tasks matching their role's subject keywords.

The desired behavior is simpler: workers should complete their assigned task, report results via TaskUpdate, and stop. The orchestrator (team lead) is responsible for all dispatch decisions, including assigning follow-up work to idle workers.

### Why This Matters

Self-claiming causes several observable problems:

1. **Race conditions**: Multiple workers scanning TaskList simultaneously can claim the same task, wasting cycles.
2. **Dispatch incoherence**: The orchestrator's dispatch loop and the workers' self-claim loops operate independently, leading to conflicting assignment decisions.
3. **Unbounded worker lifetimes**: Workers that keep looping consume context window and tokens even when the orchestrator intends to shut them down.
4. **Violated single-responsibility**: Workers should execute skills; the orchestrator should manage task routing.

## Current State Analysis

### Affected Files - Complete Blast Radius

14 files contain self-claiming or pull-based claiming references:

#### 1. Spawn Templates (7 files) - Primary targets

All at [`plugin/ralph-hero/templates/spawn/`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/):

| Template | Self-claiming line | Current trailing instruction |
|----------|-------------------|----------------------------|
| [`triager.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/triager.md) | Line 7 | `Then check TaskList for more triage tasks.` |
| [`splitter.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/splitter.md) | Line 7 | `Then check TaskList for more split tasks.` |
| [`researcher.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/researcher.md) | Line 6 | `Then check TaskList for more research tasks. If none, hand off per shared/conventions.md.` |
| [`planner.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/planner.md) | Line 7 | `Then check TaskList for more plan tasks. If none, hand off per shared/conventions.md.` |
| [`reviewer.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/reviewer.md) | Line 7 | `Then check TaskList for more review tasks. If none, hand off per shared/conventions.md.` |
| [`implementer.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/implementer.md) | Line 8 | `Then check TaskList for more implementation tasks. If none, notify team-lead.` |
| [`integrator.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/integrator.md) | Line 5 | `Report results. Then check TaskList for more integration tasks.` |

#### 2. Agent Definitions (4 files) - Task loop redesign needed

All at [`plugin/ralph-hero/agents/`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/):

| Agent | Self-claiming lines | Pattern |
|-------|-------------------|---------|
| [`ralph-analyst.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-analyst.md) | Lines 13-14, 25 | Step 1: self-claim fallback. Step 7: "Repeat from step 1" loop + SendMessage builder |
| [`ralph-builder.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-builder.md) | Lines 13-14, 22 | Step 1: self-claim fallback. Step 6: "Repeat from step 1" loop |
| [`ralph-validator.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-validator.md) | Lines 13-14, 19 | Step 1: self-claim fallback. Step 7: "Repeat from step 1" loop |
| [`ralph-integrator.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-integrator.md) | Lines 13-14, 53 | Step 1: self-claim fallback. Step 6 (after merge): "Return to task loop" |

**Note on agent definitions**: The spawn templates now use `general-purpose` subagent type (per GH-134), so custom agent definitions are only loaded when agents are spawned with their custom type. However, the agent files still exist and are referenced by the conventions. They encode the "task loop" pattern that needs to change from loop-and-self-claim to execute-and-stop.

#### 3. Conventions (1 file) - Handoff protocol rewrite

[`plugin/ralph-hero/skills/shared/conventions.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md):

| Section | Lines | Self-claiming content |
|---------|-------|----------------------|
| Pipeline Handoff Protocol - Handoff Procedure | 107-108 | Step 1-2: "Check TaskList for more tasks matching your role / If found: self-claim" |
| Handoff Procedure - SendMessage | 117 | `content="Pipeline handoff: check TaskList for newly unblocked work"` |
| Rules | 133 | "After spawn, workers self-claim subsequent tasks" |
| Rules | 134 | "SendMessage is fire-and-forget... they self-claim from TaskList" |
| Rules | 136 | "builder wakes 3 times and claims one task each time" |

#### 4. Team Orchestrator SKILL.md (1 file) - Dispatch model rewrite

[`plugin/ralph-hero/skills/ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md):

| Section | Lines | Self-claiming content |
|---------|-------|----------------------|
| 4.2 Task Creation | 115 | "Subject patterns (workers match on these to self-claim)" |
| 4.2 Task Creation | 122 | "Integrator will self-claim" |
| 4.4 Dispatch Loop | 147 | "builder will self-claim" (NEEDS_ITERATION case) |
| 4.4 Dispatch Loop | 148 | "Workers self-claim" (worker gaps) |
| 5 Behavioral Principles | 159 | "workers self-claim from TaskList" |
| 5 Behavioral Principles | 160 | "Pre-assign at spawn, pull-based thereafter" |
| 6 Worker Lifecycle | 229 | "Idle workers auto-claim new tasks from TaskList" |
| 9 Known Limitations | 265 | "Hybrid claiming... pull-based self-claim" |

#### 5. Hooks (1 file) - Minor wording adjustment

[`plugin/ralph-hero/hooks/scripts/team-stop-gate.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/team-stop-gate.sh):

| Line | Content |
|------|---------|
| 45 | `Run the dispatch loop: check TaskList for unblocked tasks, spawn workers` |

This is guidance text for the lead, not worker self-claiming, but it mentions "check TaskList" in the context of the old dispatch model. It should be updated to reflect that the lead now also assigns tasks to existing idle workers (not just spawns new ones).

### Current Dispatch Model (Before Change)

The current model is "hybrid claiming":

1. **At spawn**: Lead pre-assigns task via `TaskUpdate(taskId, owner="[role]")` before `Task()` call.
2. **After first task**: Worker autonomously loops, scanning `TaskList()` for pending, unblocked tasks matching its role's subject keywords. Worker self-claims by setting owner + in_progress.
3. **Peer handoffs**: When a worker finishes and finds no same-role work, it `SendMessage`s the next-stage peer to wake them up for self-claiming.

### Desired Dispatch Model (After Change)

The desired model is "lead-dispatched":

1. **At spawn**: Same as before -- lead pre-assigns task via `TaskUpdate` before `Task()`.
2. **After task completion**: Worker marks task completed via `TaskUpdate`, stops (goes idle). The idle notification reaches the lead automatically.
3. **Lead dispatches**: Lead checks `TaskList` for unblocked tasks, assigns them to idle workers via `TaskUpdate(taskId, owner="[role]")`, and `SendMessage`s the worker with the task assignment.
4. **Peer handoffs eliminated**: Workers do not message each other. All routing flows through the lead.

## Key Discoveries

### 1. The Spawn Templates Are Trivial to Fix

Each template has exactly one trailing line to remove. The templates are 5-8 lines each. The fix is purely subtractive -- delete the self-claiming line from each template. No replacement text needed because the worker's behavior after completing a task is simply "stop" (the natural behavior of a `general-purpose` subagent that has completed its prompt).

### 2. Agent Definitions Need Task Loop Restructuring

The 4 agent definitions (`ralph-analyst.md`, `ralph-builder.md`, `ralph-validator.md`, `ralph-integrator.md`) encode a "task loop" pattern:

```
1. TaskList() -- find matching tasks, self-claim if no owner
2. Claim via TaskUpdate
3. TaskGet -- extract context
4. Dispatch skill
5. TaskUpdate completed
6/7. Repeat from step 1
```

This must become:

```
1. TaskGet(assigned task) -- task is pre-assigned, just get context
2. TaskUpdate(in_progress)
3. Dispatch skill
4. TaskUpdate(completed, description="results")
5. Stop
```

The self-claim fallback in step 1 ("If none pre-assigned, find tasks with no owner") and the loop in the final step must both be removed.

**Important nuance**: With `general-purpose` subagent spawning (GH-134), these agent definitions are not loaded into spawned workers. They serve as documentation and as the agent definition for manual `Task(subagent_type="ralph-analyst", ...)` invocations. They should still be updated for consistency and to prevent confusion if someone reads them.

### 3. Conventions Handoff Protocol Needs Replacement

The "Pipeline Handoff Protocol" section in `conventions.md` (lines 92-136) is built entirely around peer-to-peer handoffs and self-claiming. The entire section needs rewriting. Key changes:

- **Remove "Handoff Procedure" (lines 105-129)**: This 4-step procedure of "check TaskList -> self-claim -> else SendMessage peer -> else message lead" is replaced by a single rule: "mark task completed, stop."
- **Remove "Rules" (lines 131-136)**: These 4 rules all reference self-claiming or peer handoffs.
- **Replace with lead-dispatch rules**: Workers complete tasks and stop. The lead routes all work. Workers can still receive `SendMessage` from the lead to receive new assignments.

The "Pipeline Order" table (lines 96-103) can be preserved as documentation for the lead's dispatch decisions, but the framing changes from "workers hand off to peers" to "lead dispatches to the next-stage worker."

### 4. SKILL.md Requires Surgical Edits, Not a Rewrite

The SKILL.md changes are scattered across multiple sections but are mostly wording adjustments:

- **Section 4.2**: Remove "workers match on these to self-claim" comment. Subject patterns are still useful for the lead's dispatch logic.
- **Section 4.4**: Change "builder will self-claim" / "Workers self-claim" to "lead assigns task to builder" / "lead assigns task to available worker."
- **Section 5**: Replace "workers self-claim from TaskList" with "workers complete assigned tasks and stop. Lead assigns follow-up work."
- **Section 6 (Worker Lifecycle)**: Replace "Idle workers auto-claim new tasks" with "Idle workers wait for lead assignment."
- **Section 9**: Replace "Hybrid claiming" with "Lead-dispatched: All tasks are assigned by the lead via TaskUpdate before worker processes them."

### 5. The Stop Gate Hook Is Already Correct

The stop gate hook (`team-stop-gate.sh`) guidance on line 45 says "check TaskList for unblocked tasks, spawn workers." This is addressed to the lead, not workers. The wording could be tightened to include "or assign to idle workers" but the behavior is already correct. This is a low-priority cosmetic change.

### 6. No Impact on Ralph Hero (Solo Orchestrator)

The ralph-hero SKILL.md (solo mode) already uses a purely lead-dispatched model -- it spawns `Task()` subagents per-phase and waits for results. There is no self-claiming in ralph-hero mode. This change is scoped entirely to the ralph-team orchestrator and its worker ecosystem.

## Potential Approaches

### Approach A: Minimal Template-Only Fix (Recommended)

**Scope**: 7 spawn templates + 1 conventions section + scattered SKILL.md wording.

1. Delete the trailing "check TaskList" line from all 7 spawn templates.
2. Rewrite the Pipeline Handoff Protocol section in `conventions.md` to reflect lead-dispatched model.
3. Update self-claiming references in `ralph-team/SKILL.md` (Sections 4.2, 4.4, 5, 6, 9).
4. Update agent definitions to remove task loops and self-claim fallbacks.
5. Update stop gate hook guidance text.

**Pros**: Complete fix. All 14 files addressed. Consistent model across all documentation.
**Cons**: Touches many files, though most changes are small wording edits.

### Approach B: Templates-Only (Incomplete)

**Scope**: 7 spawn templates only.

1. Delete the trailing "check TaskList" line from all 7 spawn templates.

**Pros**: Smallest possible change. Fixes the immediate behavioral issue since `general-purpose` agents only see the spawn template.
**Cons**: Leaves inconsistent documentation. Agent definitions, conventions, and SKILL.md still describe the old model. Anyone reading those docs will implement the wrong pattern.

### Approach C: Phased (Templates First, Docs Follow-Up)

**Scope**: Templates in this ticket; docs in a follow-up.

1. This ticket: Delete trailing lines from 7 spawn templates.
2. Follow-up ticket: Update conventions, SKILL.md, agent definitions.

**Pros**: Quick behavioral fix, deferred documentation update.
**Cons**: Creates a period of documentation-code mismatch. The follow-up may be deprioritized.

## Risks and Edge Cases

### 1. Workers That Are Mid-Task When Model Changes

If a worker was spawned with the old template (containing "check TaskList"), it will still try to self-claim after its first task. This is a non-issue in practice because worker lifetimes are per-session -- they cannot outlive the deployment of new templates.

### 2. Lead Dispatch Latency

With self-claiming, workers immediately grab the next task. With lead-dispatched, there is a latency gap: worker completes -> idle notification -> lead processes -> assigns new task -> worker wakes. This gap is bounded by the `TeammateIdle` hook which fires immediately when a worker goes idle, so the lead is prompted to act right away. The practical delay is one lead turn (seconds).

### 3. Agent Definitions May Still Be Used

While `general-purpose` spawning is the current pattern (GH-134), the agent definitions (`ralph-analyst.md`, etc.) still exist and could be used if someone spawns with `subagent_type="ralph-analyst"`. Leaving the old task loop in these files creates an inconsistency. Approach A addresses this; Approach B does not.

### 4. Conventions as Shared Reference

The `shared/conventions.md` file is referenced by multiple skills and spawn templates (several templates say "hand off per shared/conventions.md"). If the conventions still describe self-claiming, new skills or templates could inadvertently adopt the old pattern.

## Estimate Assessment

The triage comment flagged that S may be tight. After thorough analysis:

- **Template changes**: 7 files, one line deletion each -- trivial.
- **Agent definition changes**: 4 files, restructure task loop (5-10 lines each) -- straightforward.
- **Conventions rewrite**: 1 file, rewrite ~30 lines of handoff protocol -- moderate.
- **SKILL.md updates**: 1 file, ~10 scattered wording changes -- straightforward.
- **Hook update**: 1 file, 1 line wording tweak -- trivial.

**Total: 14 files, mostly small edits. Estimate S is appropriate** for Approach A. The changes are mechanical and well-scoped -- no new logic, just removing self-claiming references and adjusting wording. The conventions section is the largest single change but is still bounded.

## Recommended Next Steps

1. **Use Approach A** (full fix across all 14 files). The documentation consistency is worth the modest additional effort.
2. **Start with spawn templates** (the behavioral fix), then agent definitions, then conventions, then SKILL.md, then hook. This order ensures the highest-impact changes land first.
3. **Maintain the "Pipeline Order" table** in conventions as a reference for the lead's dispatch logic. Just reframe it from "peer handoff routing" to "lead dispatch routing."
4. **Preserve TaskUpdate result reporting format** in templates and agent definitions. The change is about post-completion behavior (stop vs. loop), not about how results are reported.
