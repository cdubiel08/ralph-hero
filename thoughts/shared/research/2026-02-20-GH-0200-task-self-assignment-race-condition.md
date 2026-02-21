---
date: 2026-02-20
github_issue: 200
github_url: https://github.com/cdubiel08/ralph-hero/issues/200
status: complete
type: research
---

# Research: GH-200 - Tasks Not Self-Assigned on First Iteration Causing Race Conditions

## Problem Statement

When `ralph-team` spawns workers, tasks are not self-assigned on the first iteration loop. Tasks remain with `owner: ""` long enough for multiple agents to begin processing them concurrently, causing race conditions, wasted tokens, and potential state corruption. This is a P0 issue affecting every `ralph-team` invocation.

## Relationship to Parent Issue

GH-200 is a sub-issue of [GH-209](https://github.com/cdubiel08/ralph-hero/issues/209) ("fix(ralph-team): task ownership unreliable -- push vs pull assignment race on first worker turn"). GH-209 provides extensive root cause analysis and proposes a hybrid push/pull fix. This research focuses specifically on the GH-200 symptom -- first-turn self-assignment failure -- and validates the parent's analysis against the current codebase.

## Current State Analysis

### Architecture: Pull-Based Self-Claim Model

The ralph-team system uses a **pull-based** task ownership model:

1. **Lead creates tasks** with blocking relationships ([SKILL.md:112-126](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L112-L126))
2. **Lead spawns workers** via template-resolved prompts ([SKILL.md:162-198](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L162-L198))
3. **Workers self-claim** from TaskList by matching subject keywords ([agents/ralph-analyst.md:13-14](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-analyst.md#L13-L14))
4. **Lead is prohibited from assigning** -- [SKILL.md:155](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L155) and [conventions.md:133](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md#L133) explicitly say "Never assign tasks" and "Never use TaskUpdate with `owner` parameter"

### Worker Self-Claim Procedure (All 4 Agents)

Each agent definition follows the same task loop pattern:

| Agent | File | Self-claim steps |
|-------|------|-----------------|
| Analyst | [ralph-analyst.md:13-14](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-analyst.md#L13-L14) | `TaskList()` -> find matching, `TaskUpdate(taskId, status="in_progress", owner="analyst")` |
| Builder | [ralph-builder.md:13-14](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-builder.md#L13-L14) | `TaskList()` -> find matching, `TaskUpdate(taskId, status="in_progress", owner="builder")` |
| Validator | [ralph-validator.md:13-14](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-validator.md#L13-L14) | `TaskList()` -> find matching, `TaskUpdate(taskId, status="in_progress", owner="validator")` |
| Integrator | [ralph-integrator.md:13-14](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-integrator.md#L13-L14) | `TaskList()` -> find matching, `TaskUpdate(taskId, status="in_progress", owner="integrator")` |

### Spawn Template Content

Spawn templates (e.g., [researcher.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/researcher.md)) contain:
```
Research GH-{ISSUE_NUMBER}: {TITLE}.

Invoke: Skill(skill="ralph-hero:ralph-research", args="{ISSUE_NUMBER}")

Report via TaskUpdate: "RESEARCH COMPLETE: ..."
Then check TaskList for more research tasks. If none, hand off per shared/conventions.md.
```

The template already contains the issue number and a direct `Invoke: Skill(...)` instruction. The `TaskList -> TaskUpdate` self-claim step from the agent definition is NOT reinforced in the template.

## Root Cause Analysis

### Root Cause 1: First-Turn Bypass of Self-Claim

When a worker is spawned, it receives the template prompt which already contains the issue context and a direct `Invoke: Skill(...)` instruction. The worker's agent definition specifies `TaskList -> TaskUpdate` as steps 1-2, but the spawn prompt's `Invoke: Skill(...)` is more immediately actionable. The LLM may decide it already knows what to do and skip directly to skill invocation without claiming the task first.

**Evidence**: The spawn template says "Invoke: Skill(..." before "Then check TaskList..." -- the claim instruction appears AFTER the work instruction, not before. The agent definition says to do TaskList first, but the spawn prompt creates competing instructions.

### Root Cause 2: No Atomicity in Read-Then-Claim

Even when workers do attempt self-claim, there is an inherent race window:

```
Worker A: TaskList() -> sees T-5 pending, owner=""
Worker B: TaskList() -> sees T-5 pending, owner=""
Worker A: TaskUpdate(T-5, in_progress, owner="analyst")   -- succeeds
Worker B: TaskUpdate(T-5, in_progress, owner="analyst-2") -- last-write-wins
```

The task system uses file-lock serialization for writes, but there is no read-modify-write transaction. Both workers see the same empty-owner state and both attempt to claim.

### Root Cause 3: Subject Keyword Matching is Advisory

Workers filter `TaskList` results by subject keywords like "Research", "Plan", "Implement". This filtering is LLM-discretionary -- there is no enforcement that a worker only claims tasks matching its role. If the orchestrator creates a task with a slightly different subject, the worker may fail to find a match and go idle, or may claim an incorrect task.

### Root Cause 4: Prohibition Against Lead Assignment Creates the Race

[SKILL.md:155](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L155) states: "Never assign tasks: Do NOT call TaskUpdate with `owner` to assign work."
[conventions.md:133](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md#L133) states: "Never use TaskUpdate with `owner` parameter to assign tasks to other teammates."

This prohibition means the lead creates a task with `owner=""` and spawns a worker, creating a window where the task is unowned. If the worker's first action is not `TaskUpdate(owner=...)`, the task stays unowned indefinitely during execution.

## Key Discoveries

### 1. The Spawn Template Instruction Order Conflicts with Agent Definition

The agent definition says: step 1 = TaskList, step 2 = TaskUpdate(claim), step 3 = TaskGet, step 4 = Skill.
The spawn template says: "Invoke: Skill(...)" then "check TaskList for more."

These are contradictory signals. The spawn template's instruction to invoke the skill immediately encourages skipping the self-claim dance entirely on the first iteration.

### 2. The Parent Issue (#209) Proposes a Hybrid Fix That Addresses Root Causes

GH-209's proposed fix eliminates the race window by having the lead pre-assign before spawning:
```
Lead: TaskUpdate(T-5, owner="analyst")   <- atomic, no race
Lead: Task(prompt=analyst_template)      <- worker spawned already owning the task
```

This addresses root causes 1, 2, and 4 simultaneously. The worker's first `TaskList` call returns a task already owned by them -- they just flip status to `in_progress`.

### 3. Hooks Cannot Enforce First-Turn Claiming

As documented in the [GH-209 comment](https://github.com/cdubiel08/ralph-hero/issues/209#issuecomment-IC_kwDORABwmc7qhAeH), a PreToolUse hook could block non-claim tool calls, but it cannot force the agent to call TaskList. Hooks are reactive (blocking wrong actions) not prescriptive (injecting right actions). The overhead of a catch-all matcher on every tool call is also prohibitive.

### 4. Six Files Need Coordinated Changes

The fix touches the lead prohibition, the worker claim logic, and optionally the spawn templates:

| File | Change needed |
|------|--------------|
| [SKILL.md:155](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L155) | Remove "never assign" prohibition; add pre-assign step to spawn procedure |
| [conventions.md:133](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md#L133) | Update "Never use TaskUpdate with `owner`" rule to allow lead pre-assignment |
| [agents/ralph-analyst.md:13-14](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-analyst.md#L13-L14) | Change claim step to find `owner == "analyst"` instead of `owner == ""` |
| [agents/ralph-builder.md:13-14](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-builder.md#L13-L14) | Same pattern as analyst |
| [agents/ralph-validator.md:13-14](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-validator.md#L13-L14) | Same pattern as analyst |
| [agents/ralph-integrator.md:13-14](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-integrator.md#L13-L14) | Same pattern as analyst |

### 5. Peer-to-Peer Handoffs Still Work Under Hybrid Model

The peer-to-peer handoff protocol ([conventions.md:93-136](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md#L93-L136)) does not depend on the claim model. Workers still SendMessage the next-stage teammate when they complete. The receiving worker still calls TaskList to find unblocked work. The only change is that the initial task for the first spawned worker is pre-assigned; subsequent tasks from peer handoffs are still pull-based self-claimed.

This means the fix is additive -- it only changes the initial assignment at spawn time, not the ongoing pipeline.

## Potential Approaches

### Approach A: Lead Pre-Assignment Before Spawn (Recommended)

Implement the hybrid model from GH-209:

1. Lead creates task with `TaskCreate(...)` -- returns task ID
2. Lead pre-assigns: `TaskUpdate(taskId, owner="analyst")`
3. Lead spawns worker: `Task(prompt=template)`
4. Worker finds task via `TaskList()` where `owner == "analyst"` and `status == "pending"`
5. Worker flips status: `TaskUpdate(taskId, status="in_progress")`

**Pros**: Eliminates the race window completely. Deterministic -- no LLM-discretionary self-claim step. Compatible with peer handoffs for subsequent tasks. Minimal change footprint.

**Cons**: Requires lifting the "never assign from lead" prohibition. Slightly increases lead turn count (one extra TaskUpdate per spawn).

### Approach B: Spawn Template Reordering Only

Reorder spawn templates to put claim instructions before skill invocation:
```
Claim a task from TaskList matching "Research" in subject. Then:
Invoke: Skill(skill="ralph-hero:ralph-research", args="{ISSUE_NUMBER}")
```

**Pros**: No protocol changes needed. Simple text edit.

**Cons**: Still LLM-discretionary. Does not address the read-then-claim race between parallel workers. Does not address the case where the worker already has all context from the template.

### Approach C: Hooks-Based Enforcement

Add a PreToolUse catch-all hook that blocks non-TaskList/TaskUpdate tools until the agent has claimed a task.

**Pros**: Hard enforcement.

**Cons**: High latency overhead on every tool call. Cannot force the right action, only block wrong ones. Task file format is not publicly specified. Fragile -- requires env var injection per spawn. Already analyzed and rejected in GH-209 comment.

## Risks and Considerations

1. **Approach A changes a design principle**: The "never assign from lead" rule was intentional -- it keeps the lead as a pure coordinator. Lifting this for pre-assignment is a targeted exception, but it weakens the principle. Mitigation: Document clearly that pre-assignment is ONLY for the initial spawn, not for ongoing pipeline management.

2. **Worker self-claim for subsequent tasks**: After the initial pre-assigned task completes, the worker returns to pure pull-based self-claim for any subsequent tasks. The agent definitions need to support BOTH patterns: finding `owner == "[role]"` tasks (pre-assigned) AND `owner == ""` tasks (self-claim).

3. **Multiple workers of the same role**: When 3 analysts are spawned for group research, each needs a distinct pre-assignment. The lead must create 3 tasks and pre-assign each to `analyst`, `analyst-2`, `analyst-3` respectively before spawning each worker.

4. **Interaction with ralph-hero (non-team)**: The ralph-hero skill ([skills/ralph-hero/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-hero/SKILL.md)) uses `Task(subagent_type="general-purpose", ...)` with `run_in_background=true` for parallel work. It does NOT use the task system for ownership -- workers are ephemeral subagents. This fix is scoped to ralph-team only.

## Recommended Next Steps

1. **Implement Approach A** (Lead Pre-Assignment Before Spawn) as the primary fix
2. **Update SKILL.md Section 4.3** to add pre-assignment step before each spawn call
3. **Update SKILL.md Section 5** to replace the "never assign" principle with "pre-assign at spawn, pull-based thereafter"
4. **Update conventions.md** to document the hybrid model -- lead pre-assigns initial tasks, workers self-claim subsequent tasks
5. **Update all 4 agent definitions** to handle both pre-assigned and self-claimed task discovery
6. **Do NOT change spawn templates** -- the template reordering (Approach B) is insufficient alone but could be a secondary reinforcement if desired
