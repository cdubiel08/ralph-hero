---
date: 2026-02-23
github_issue: 355
github_url: https://github.com/cdubiel08/ralph-hero/issues/355
status: complete
type: research
---

# GH-355: V4 Phase 3 — Roster-First Spawning & suggestedRoster Heuristic

## Problem Statement

The current ralph-team lead spawns workers on-demand as pipeline phases progress (bough model). Workers only exist when a task is ready for them. Phase 3 replaces this with **roster-first spawning**: spawn the full expected team at session start using a heuristic from `detect_pipeline_position`, then create all tasks upfront (Phase 2), then pre-assign and wake workers. This reduces startup latency, ensures a validator is always present, and enables the self-claim task loop (Phase 4).

## Current State Analysis

### Current Spawn Model (`SKILL.md` Section 4.2–4.3)

The current flow is strictly task-first:
1. `detect_pipeline_position` → determine current phase
2. Create tasks for **current phase only** (bough model)
3. `TaskUpdate(owner=role)` pre-assign
4. `Task(subagent_type=...)` spawn worker

Workers are spawned only when a task exists for them. The prime directive in SKILL.md (lines 52–55) states "No prescribed roster — spawn what's needed." There is no upfront roster calculation.

### `PipelinePosition` Interface (`pipeline-detection.ts:42–50`)

```typescript
export interface PipelinePosition {
  phase: PipelinePhase;
  reason: string;
  remainingPhases: string[];
  issues: IssueState[];
  convergence: ConvergenceInfo;
  isGroup: boolean;
  groupPrimary: number | null;
}
```

**`suggestedRoster` does not exist.** This is entirely net-new. All seven current fields are unrelated to roster sizing.

### `buildResult()` function (`pipeline-detection.ts:365–392`)

This internal helper constructs the `PipelinePosition` return value. It has access to:
- `phase` — current pipeline phase
- `issues[]` — all `IssueState` objects with `estimate`, `workflowState`, `subIssueCount`
- `isGroup` — boolean
- `groupPrimary` — primary issue number
- `convergence` — blocking/met/recommendation

All inputs needed for the heuristic are available here.

### `detect_pipeline_position` MCP Tool (`issue-tools.ts:1332–1418`)

Tool registration at line 1332. Returns `toolSuccess(position)` directly — the raw `PipelinePosition` object. Adding `suggestedRoster` to the interface automatically includes it in the MCP response with no additional tool changes needed.

### Worker Template (`templates/spawn/worker.md`)

Current template uses task-specific placeholders: `{TASK_VERB}`, `{ISSUE_NUMBER}`, `{TITLE}`, `{SKILL_INVOCATION}`. In roster-first mode, workers are spawned before tasks exist — the template needs to handle a generic "check TaskList for your first assignment" first-turn prompt.

## Key Discoveries

### Critical Phase 0c Finding: Spawn-Before-Tasks Requires Explicit Wake

Phase 0c investigation (`GH-0352-v4-primitive-investigation.md`) validated the spawn-before-tasks path and found a **critical behavior gap**:

When workers are spawned before tasks exist:
1. Worker spawned → prompt executed → turn ends
2. Stop hook fires → checks TaskList → **empty** (tasks not yet created)
3. Stop hook emits guidance, exits 2 → worker gets guidance, tries to stop again
4. Stop hook fires again → **re-entry guard** (`stop_hook_active=true`) → exits 0
5. Worker goes **IDLE**

Idle workers have **no mechanism to detect that tasks were subsequently created**. The Stop hook only fires on stop attempts, not on TaskList changes. Claude Code has no task-creation event hook.

**Consequence**: After creating tasks and pre-assigning via `TaskUpdate(owner=...)`, the lead **MUST** send a `SendMessage` wake to each idle worker. This is not a Communication Discipline violation — Phase 1's Assignment Rule explicitly permits `SendMessage` for waking idle workers with newly assigned tasks.

**Corrected startup sequence** (validated against primitive behavior):
```
1. TeamCreate                  ← task namespace first
2. detect_pipeline_position    ← phase + suggestedRoster
3. Spawn full roster           ← workers go idle (Stop fires, TaskList empty, re-entry exits)
4. Create ALL pipeline tasks   ← blockedBy chains (Phase 2)
5. Pre-assign first unblocked  ← TaskUpdate(owner="analyst"), etc.
6. SendMessage wake            ← REQUIRED: one message per idle worker to notify of assignment
```

**Spec Section 5.3 correction needed**: The spec's step 5 says "Workers discover their assignment via TaskList (Stop hook wakes them)" — this is incorrect. Workers cannot self-detect task creation. The startup sequence must include explicit wake messages after pre-assignment.

### Phase 0e Finding: suggestedRoster Heuristic Feasibility

Phase 0e confirmed `suggestedRoster` is **feasible** with available inputs. Key constraint: `totalStreams` (from `detect_work_streams`) is NOT available in `detect_pipeline_position` without an additional API call. The heuristic must therefore use a simpler proxy.

**Validated heuristic formula** (from Phase 0 research):

| Role | Formula | Max |
|------|---------|-----|
| `analyst` | 1 for 1 issue; 2 for 2–5 issues needing research; 3 for 6+ | 3 |
| `builder` | 1 default; 2 if group has 5+ issues with M/L estimates | 2 |
| `validator` | Always 1 (automated review, serialized) | 1 |
| `integrator` | Always 1 (git ops serialized on main) | 1 |

**Phase-aware adjustment**: If `phase` is PLAN or later, analyst count drops to 0 (no research left). If phase is IMPLEMENT or later, builder count should reflect remaining streams.

**Proposed TypeScript interface**:
```typescript
interface SuggestedRoster {
  analyst: number;    // 0–3
  builder: number;    // 1–2
  validator: number;  // always 1
  integrator: number; // always 1
}
```

Added to `PipelinePosition` and computed in `buildResult()` with access to `issues[]`, `isGroup`, and `phase`.

### Agent Definition "No Task Yet" Gap

Currently all four worker agent definitions assume a task is assigned before the first turn. With roster-first spawning, a worker's first turn may find TaskList empty (tasks not yet created). The task loop in each agent definition needs to handle this gracefully:
- First TaskList call returns empty → OK, go idle (Stop hook will re-fire when lead wakes with SendMessage)
- Do NOT treat empty TaskList as an error

The worker-stop-gate.sh already handles this via re-entry guard (exits 0 on second attempt). The agent instruction layer just needs to not emit an error state when TaskList is initially empty.

### SKILL.md Section 6 Spawn Template Update

The current spawn template has task-specific placeholders. For roster-first spawning, the lead spawns workers before tasks exist. Two approaches:
1. **Generic template path**: Template says "Check TaskList for your first assignment" — worker goes idle, lead wakes with specific task assignment later
2. **Delayed spawn**: Spawn workers after first task batch is created (hybrid approach) — avoids generic template but delays roster

Phase 0 finding supports **approach 1** (generic template for roster-first), combined with the `SendMessage` wake after pre-assignment. This preserves the "full roster at session start" benefit.

## Potential Approaches

### Option A: Full roster-first as specified (recommended)

Implement all Phase 3 changes:
1. Add `SuggestedRoster` interface + `suggestedRoster` field to `PipelinePosition`
2. Compute heuristic in `buildResult()` using `issues[]`, `isGroup`, `phase`
3. Update SKILL.md Section 4.3: spawn full roster using `suggestedRoster` before task creation
4. Update SKILL.md Section 6: add generic first-turn template path for roster-spawned workers
5. Update agent definitions: handle empty TaskList on first check gracefully
6. Validator always in roster (min 1)
7. Add explicit `SendMessage` wake step to startup sequence (Phase 0c correction)

**Pros**: Delivers the full architectural benefit. Enables Phase 4 self-claim to work correctly.
**Cons**: More surface area; requires Phase 2 (upfront task list) to be implemented first.

### Option B: suggestedRoster only (no spawn model change)

Add `suggestedRoster` to `detect_pipeline_position` but keep the current task-first spawn model. Lead uses the roster hint for capacity planning without changing spawn timing.

**Pros**: Smaller scope, no risk to spawn ordering
**Cons**: Doesn't deliver the roster-first benefit; Phase 4 self-claim still doesn't work without upfront task list + pre-spawned workers

**Recommendation**: Option A. Phase 3 is a dependency for Phase 4 (self-claim), so the full model change is required. The startup sequence correction (SendMessage wake) is straightforward.

## Risks

1. **Phase 0c race condition**: Between task creation (step 4) and `SendMessage` wake (step 6), a worker may attempt to stop and succeed via re-entry guard before pre-assignment. Mitigation: pre-assign (`TaskUpdate`) before `SendMessage`, so the task is claimed before the wake fires.

2. **`totalStreams` unavailable**: Builder scaling defaults to 1 without stream data. This means builder may be under-allocated for large multi-stream groups. Mitigation: builder scaling can be refined after `detect_work_streams` is called post-research; `suggestedRoster` is a starting point, not a hard ceiling.

3. **Agent definition change surface**: All 4 agent definitions need updating for "no task yet" handling. Risk of regression in existing task loop behavior. Mitigation: the change is additive (handle the empty case gracefully, existing behavior unchanged).

4. **Spec Section 5.3 is wrong**: The spec says workers self-claim via Stop hook after task creation — they cannot. This must be corrected in both the spec doc and SKILL.md Section 4.3 before implementation.

## Recommended Next Steps

1. Implement Phase 2 (upfront task list, #354) first — Phase 3 roster-first spawning depends on tasks being created upfront
2. Add `SuggestedRoster` interface to `pipeline-detection.ts` and compute in `buildResult()`
3. Update SKILL.md Section 4.3 with corrected startup sequence (including SendMessage wake)
4. Update SKILL.md Section 6 spawn procedure for generic first-turn template path
5. Update all 4 agent definitions for graceful empty-TaskList handling
6. Correct spec Section 5.3 step 5 to reflect Phase 0c finding

## Files Affected

### Will Modify
- `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts` — Add `SuggestedRoster` interface; add `suggestedRoster` field to `PipelinePosition` interface; compute heuristic in `buildResult()` (lines 365–392)
- `plugin/ralph-hero/skills/ralph-team/SKILL.md` — Section 4.3: roster-first spawn sequence with SendMessage wake; Section 6: generic first-turn template path for roster-spawned workers
- `plugin/ralph-hero/agents/ralph-analyst.md` — Handle empty TaskList gracefully on first check
- `plugin/ralph-hero/agents/ralph-builder.md` — Handle empty TaskList gracefully on first check
- `plugin/ralph-hero/agents/ralph-validator.md` — Handle empty TaskList gracefully on first check; always spawned regardless of RALPH_REVIEW_MODE
- `plugin/ralph-hero/agents/ralph-integrator.md` — Handle empty TaskList gracefully on first check

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts` — Current `PipelinePosition` interface and `buildResult()` implementation (lines 42–50, 365–392)
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` — `detect_pipeline_position` MCP tool registration (line 1332)
- `plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh` — Stop hook re-entry guard behavior (lines 20–23)
- `thoughts/shared/research/2026-02-23-GH-0352-v4-primitive-investigation.md` — Phase 0c/0e findings
- `thoughts/shared/plans/2026-02-22-ralph-workflow-v4-architecture-spec.md` — Section 5.3, 5.4, Phase 3 definition
