---
date: 2026-02-22
github_issue: 354
github_url: https://github.com/cdubiel08/ralph-hero/issues/354
status: complete
type: research
---

# GH-354: V4 Phase 2 — Upfront Task List Model in ralph-team

## Problem Statement

The current `ralph-team` skill uses the **bough model**: tasks are created one phase at a time, and the lead must actively detect phase convergence (via `detect_pipeline_position`) after each `TaskCompleted` hook to manually unlock the next phase. This creates several problems:

1. **Lead becomes a bottleneck**: Every phase transition requires the lead to wake up, call `detect_pipeline_position`, and create new tasks. Workers cannot see what comes next.
2. **No pipeline visibility**: Workers only see their current task; the full pipeline is opaque.
3. **Complex convergence logic**: `team-task-completed.sh` contains multi-step orchestration guidance, mixing hook concerns with lead logic.
4. **Resumability gap**: Re-invocation has no clear protocol for discovering and continuing from an interrupted session.

Phase 2 replaces this with an **upfront task list model**: all pipeline tasks created at session start with `blockedBy` dependency chains, so workers self-navigate the pipeline without lead intervention.

## Current State Analysis

### ralph-team/SKILL.md — Bough Model (Section 4.2, 4.4)

**Section 4.2** (`SKILL.md:161`): titled "Create Tasks for Current Phase Only (Bough Model)". The lead calls `detect_pipeline_position` to determine the active phase, then creates tasks ONLY for that phase using per-phase templates (RESEARCH, PLAN, REVIEW, IMPLEMENT, COMPLETE).

The only use of `blockedBy` in the current model is the XS fast-track exception (`SKILL.md:200`): "Merge PR blocked by Create PR" — a single within-phase dependency for the COMPLETE phase.

**Section 4.4** (`SKILL.md:251-268`): Bough advancement logic. After `TaskCompleted` fires, the lead:
1. Calls `detect_pipeline_position` to check `convergence.met`
2. If `true`: creates next-phase tasks (Section 4.2 templates)
3. Reads `artifact_path` from completed task metadata and carries it into next-phase task descriptions

Stream-aware dispatch (`SKILL.md:253-261`): lead calls `detect_pipeline_position(number=stream_primary)` per stream, checks convergence per stream subset, advances streams independently.

**Worker self-claim** (`SKILL.md:227-229`): workers match tasks by subject pattern (`"Research GH-NNN"`, `"Plan GH-NNN"`, etc.). The pull model already works — workers self-claim unowned tasks in their role. The lead only creates tasks at phase boundaries, not assigns them.

### hooks/scripts/team-task-completed.sh

Fires on `TaskCompleted` event. Current behavior:
- For review tasks: outputs guidance to check `verdict` metadata field for `APPROVED` vs `NEEDS_ITERATION`
- For all other tasks: outputs guidance to call `detect_pipeline_position` and create next-bough tasks if `convergence.met`
- Always exits 0 (guidance-only, never blocks)

This hook contains orchestration guidance that belongs in `SKILL.md`, not in a hook. Phase 2 simplifies it to a factual one-liner.

### hooks/scripts/worker-stop-gate.sh

Maps worker role to task subject keywords and blocks the Stop event until the worker has checked `TaskList` for unclaimed tasks matching their role. Currently does not filter by `blockedBy` status — it counts ALL pending tasks for the role, even those that are blocked.

With the upfront model, blocked tasks will exist from session start. The gate must only count **unblocked** pending tasks to avoid preventing workers from stopping when all remaining tasks are legitimately waiting on dependencies.

### conventions.md — Pipeline Handoff Protocol

`conventions.md:78-96` describes the pipeline handoff: workers check `TaskList` after completion, self-claim if more work exists, otherwise notify team-lead. This remains largely intact but references to "bough advancement" should be removed and the self-claim loop clarified in the context of `blockedBy`-filtered tasks.

## Key Discoveries

### Reference Implementations

Two reference implementations exist that already solve this pattern:

**1. `.claude/commands/ralph_hero.md` (lines 170-263)** — Full upfront task list pattern for the workspace ralph-hero orchestrator:
- Creates all tasks (split → research → plan → implement → PR) upfront before executing any
- Uses `TaskCreate` then `TaskUpdate(addBlockedBy=[...])` as two-step pattern (blockedBy cannot be set at creation time)
- Resumability: calls `TaskList()` first; if incomplete tasks exist, resumes from first incomplete
- Execution: loop calling `TaskList()`, filter `status=pending AND blockedBy=[]`, execute all unblocked tasks

**2. `.claude/commands/ralph_team.md` (lines 212-265)** — Group task creation with blocking for the Linear-integrated team coordinator:
- Per-ticket research tasks (unblocked, parallel)
- Single group plan task blocked by ALL research tasks (fan-in convergence gate)
- Sequential review → implement → PR via chained `blockedBy`
- Metadata carried in task descriptions: `group_primary`, `group_members`, `artifact_path`

### TaskCreate + blockedBy Two-Step Pattern

`blockedBy` cannot be set at `TaskCreate` time. The pattern is:

```
T1 = TaskCreate(subject="Research GH-354", metadata={...})
T2 = TaskCreate(subject="Plan GH-354", metadata={...})
TaskUpdate(taskId=T2, addBlockedBy=[T1])  # add blocking after creation
```

All `TaskCreate` calls can be issued in parallel (no interdependencies at creation time). `TaskUpdate(addBlockedBy)` calls follow.

### Upfront Pipeline Shape for ralph-team

For a single issue (non-group):
```
[T-1] Research GH-NNN       → unblocked         → analyst
[T-2] Plan GH-NNN           → blockedBy: T-1    → builder
[T-3] Review plan GH-NNN    → blockedBy: T-2    → validator
[T-4] Implement GH-NNN      → blockedBy: T-3    → builder
[T-5] Create PR GH-NNN      → blockedBy: T-4    → integrator
[T-6] Merge PR GH-NNN       → blockedBy: T-5    → integrator
```

For a group of N issues:
```
[T-1..N] Research GH-AAA … GH-ZZZ  → unblocked (parallel)     → analyst(s)
[T-N+1]  Plan group GH-AAA          → blockedBy: T-1..N        → builder
[T-N+2]  Review plan GH-AAA         → blockedBy: T-N+1         → validator
[T-N+3]  Implement GH-AAA           → blockedBy: T-N+2         → builder
[T-N+4]  Create PR GH-AAA           → blockedBy: T-N+3         → integrator
[T-N+5]  Merge PR GH-AAA            → blockedBy: T-N+4         → integrator
```

For streams (groups >= 3 members split into parallel streams):
- Each stream gets its own research tasks (unblocked, parallel across streams)
- Each stream gets its own plan/review/implement chain
- Stream PRs may be independent or merged at integrator discretion
- Stream detection logic mirrors existing `detect_stream_positions` in ralph-hero

### Resumability Protocol

Before creating any tasks, the lead must call `TaskList()`. If incomplete tasks exist for the target issue(s), resume from the first incomplete task rather than creating a duplicate graph. Key metadata field: `issue_number` in task metadata identifies which issue a task belongs to.

```
existing = TaskList()
if any task in existing has metadata.issue_number == NNN and status != completed:
    # Resume: find first non-completed task, mark in_progress, continue
else:
    # Fresh: create full upfront task graph
```

### Phase 0 Dependency

Phase 2 has a hard dependency on Phase 0 (GH-352) investigation findings:
- **0a (TaskList Visibility)**: Confirms workers in a team can see tasks created by the lead — foundational assumption for the entire upfront model
- **0b (Self-Claim Atomicity)**: Confirms `TaskUpdate(owner=...)` race window is safe enough for multiple workers self-claiming from the same unblocked task list

If either assumption fails, Phase 2 design must be revised before implementation.

## Potential Approaches

### Approach A: Pure Upfront (Recommended)

Create ALL pipeline tasks at session start with full `blockedBy` chains. Lead's dispatch loop (Section 4.4) becomes: check for unblocked+unowned tasks → ensure workers exist for each → done. No convergence detection needed.

**Pros**:
- Full pipeline visibility from session start
- Lead is purely reactive (no bough advancement logic)
- Resumability is trivial (check existing TaskList)
- `team-task-completed.sh` becomes a one-liner
- Matches reference implementations in `.claude/commands/`

**Cons**:
- Creates N+5 tasks upfront even if plan/implement phases are far away
- If early phases fail, downstream tasks exist but are permanently blocked
- Requires Phase 0 validation of TaskList visibility

### Approach B: Hybrid — Upfront Research, Bough for Plan+

Create all research tasks upfront (parallel), then switch to bough model for plan → review → implement → PR when research converges.

**Pros**: Smaller task graph upfront; bough model already validated

**Cons**: Two mental models coexist; partial benefit; still requires convergence detection for plan phase

### Approach C: Keep Bough, Add Resume Only

Keep Section 4.2/4.4 intact but add resumability check at session start.

**Pros**: Minimal change; no Phase 0 dependency

**Cons**: Does not fix the lead-as-bottleneck problem; does not simplify hooks

**Recommendation**: Approach A. The upfront model matches the V4 architecture spec intent and the workspace reference implementations. Phase 0 validation gates this — if TaskList visibility fails, fall back to Approach B.

## Risks

1. **TaskList visibility not confirmed**: Phase 0/0a must pass before implementing. If tasks created by lead are not visible to teammates, the pull model breaks entirely.
2. **Self-claim race with multiple workers**: Multiple analysts claiming from the same research task pool. Phase 0/0b must confirm claim-then-verify is safe.
3. **Blocked task accumulation**: With full upfront task lists, `worker-stop-gate.sh` must filter to unblocked tasks only — otherwise workers never stop (always see blocked downstream tasks).
4. **Task graph duplication on re-invocation**: Without resumability check, re-invoking the lead creates a second task graph for the same issue. Must check `TaskList()` first.
5. **Stream detection complexity**: Groups >= 3 need stream splitting logic. `detect_stream_positions` MCP tool provides this, but the upfront model must create stream-scoped tasks (not group-scoped) when streams are detected.

## Recommended Next Steps

1. **Gate on Phase 0**: Do not implement Phase 2 until GH-352 investigation confirms TaskList visibility (0a) and self-claim atomicity (0b).
2. **Rewrite Section 4.2** of `ralph-team/SKILL.md`:
   - Remove "Bough Model" language
   - Add resumability check at top: `TaskList()` → resume if incomplete tasks exist
   - Replace per-phase templates with full upfront graph creation pattern
   - Two-step pattern: `TaskCreate` (all tasks) → `TaskUpdate(addBlockedBy)` (all dependencies)
3. **Rewrite Section 4.4**: Remove bough advancement logic; replace with simple dispatch loop checking for unblocked+unowned tasks and ensuring workers exist
4. **Simplify `team-task-completed.sh`**: Replace orchestration guidance with one-line factual output (task name + role)
5. **Update `worker-stop-gate.sh`**: Filter available task check to `status=pending AND blockedBy=[]` only
6. **Update `conventions.md`** Pipeline Handoff Protocol: remove bough references, clarify self-claim loop with blockedBy filter

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/ralph-team/SKILL.md` — Rewrite Sections 4.2 (task creation) and 4.4 (dispatch loop); remove bough model, add upfront graph + resumability
- `plugin/ralph-hero/skills/shared/conventions.md` — Update Pipeline Handoff Protocol; remove bough references
- `plugin/ralph-hero/hooks/scripts/team-task-completed.sh` — Simplify to factual one-liner; remove orchestration guidance
- `plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh` — Filter available task check to unblocked tasks only

### Will Read (Dependencies)
- `thoughts/shared/plans/2026-02-22-ralph-workflow-v4-architecture-spec.md` — Section 5 (Multi-Agent Mode), Section 9 (Phase 2 spec)
- `plugin/ralph-hero/skills/ralph-hero/SKILL.md` — Reference for upfront task list pattern (if already ported in Phase 5)
- `plugin/ralph-hero/hooks/scripts/team-stop-gate.sh` — Understand lead Stop hook interaction with task list state
