---
date: 2026-02-23
github_issue: 357
github_url: https://github.com/cdubiel08/ralph-hero/issues/357
status: complete
type: research
---

# V4 Phase 5: Hero Mode Upfront Task List

## Problem Statement

The plugin `ralph-hero` skill (`skills/ralph-hero/SKILL.md`) uses a dynamic phase-detection loop: each phase spawns subagents, then re-calls `detect_pipeline_position` to discover the next phase. This model has two weaknesses:

1. **No progress visibility** — there is no task list showing what has been done and what remains
2. **No structured resumability** — re-invocation re-detects from GitHub state but cannot resume a partially-completed phase gracefully

Phase 5 ports the upfront task list pattern (used by the workspace `ralph_hero.md` v2 command and now adopted for `ralph-team` in Phase 2) into the plugin hero skill. The result: all pipeline tasks are created at session start with `blockedBy` chains, progress is tracked in `TaskList`, and resumability is clean.

## Current State Analysis

### `plugin/ralph-hero/skills/ralph-hero/SKILL.md` (252 lines)

**Pipeline detection** (lines 79-94): Correct and stays. `detect_pipeline_position` MCP tool returns `phase`, `convergence`, `isGroup`, `groupPrimary`, `issues[]`. Plugin skill correctly trusts this tool.

**No task list**: The skill never calls `TaskCreate` or `TaskUpdate`. Phases are driven by the MCP tool's state-machine output.

**Parallel execution** (lines 111-116, 126-133): `run_in_background=true` with a single message containing multiple `Task()` calls. This achieves concurrency but provides no progress visibility.

**Sequential execution** (lines 186-199): Foreground `Task()` calls — one completes, then the next starts. Order enforced by the orchestrator, not by `blockedBy` relationships.

**Resumability** (lines 222-228): GitHub project field state IS the store. Re-invocation calls `detect_pipeline_position` again. This works but cannot detect a partially-started phase (e.g., 2 of 3 research tasks complete).

**Stream detection**: Groups handled via `isGroup`/`groupPrimary` fields. No separate stream detection for groups >= 3. The skill dispatches a single group plan task without breaking into independent work streams.

### Workspace `~/.claude/commands/ralph_hero.md` (v2 reference)

The workspace command is the reference implementation for the upfront task list pattern:

- **Step 2**: Creates ALL tasks upfront via `TaskCreate` + `TaskUpdate(addBlockedBy=[...])` before executing any work
- **Execution loop**: `TaskList()` → find pending tasks with empty `blockedBy` → execute all simultaneously → mark completed → repeat
- **Sequential ordering**: `blockedBy` chains on implementation tasks (impl-2 blockedBy impl-1)
- **Resumability**: On re-invocation, `TaskList()` shows completed/in_progress/pending — skip completed, continue from pending
- **Key difference from plugin**: Uses Linear analyzer for detection; plugin must keep `detect_pipeline_position`

### Related Research

`thoughts/shared/research/2026-02-22-GH-0354-v4-upfront-task-list-ralph-team.md` — Phase 2 research for `ralph-team`. Confirms the `TaskCreate` + `TaskUpdate(addBlockedBy)` two-step pattern and the execution loop design. Hero mode adapts the same model without `TeamCreate` (no typed workers, no team task list scoping).

`thoughts/shared/research/2026-02-22-GH-0327-work-stream-detection-lib.md` — Work stream detection library (union-find algorithm). For groups >= 3, post-research stream detection clusters issues by file overlap and `blockedBy` relationships. Deterministic stream IDs (`stream-42-44`).

`thoughts/shared/plans/2026-02-22-ralph-workflow-v4-architecture-spec.md` Section 4.5 — Exact diff table for hero mode v4 changes:

| Aspect | Current | v4 |
|--------|---------|-----|
| Task creation | Per-phase, no upfront list | Upfront task list with blockedBy |
| Parallel research | `run_in_background=true` | Unblocked tasks executed simultaneously (no `run_in_background`) |
| Sequential impl | Manual foreground ordering | `blockedBy` chain in task list |
| Resumability | Re-detect pipeline position | Re-detect + check existing TaskList |
| Stream detection | Not in current hero | Add post-research for groups >= 3 |

## Key Discoveries

### 1. `detect_pipeline_position` is kept — not replaced

The workspace v2 uses a Linear analyzer to understand the tree. The plugin must use `detect_pipeline_position` (already does this correctly). Phase 5 does NOT change how the skill detects current state — it only changes what the skill does AFTER detection: build a task list instead of executing phases directly.

### 2. Session-scoped task list (no TeamCreate needed)

Hero mode uses `Task()` subagents (not teammates). `TaskCreate` without `team_name` creates tasks in the session-default scope. The hero orchestrator is the only reader of this task list (no race conditions, no team isolation issues). This is simpler than team mode's `TeamCreate`-scoped list.

### 3. Resumability design

At skill start, before building the task list:
1. Call `detect_pipeline_position` to get current phase
2. Call `TaskList()` to check if tasks already exist for this session
3. If tasks exist (non-empty `TaskList`): skip task creation, resume from pending tasks
4. If no tasks: create full upfront task list and begin

The `detect_pipeline_position` result is still needed even on resume to verify the issue tree hasn't changed state externally.

### 4. `run_in_background=true` replacement

The current parallel research pattern (`run_in_background=true` in a single message) is replaced by:
- Create research tasks without `blockedBy` (all unblocked)
- Execute loop: find all unblocked pending tasks → spawn all simultaneously (foreground `Task()` calls in one message) → wait for all → mark completed
- This achieves the same concurrency without needing `run_in_background`

**Note from Phase 0 findings**: `run_in_background` is described as "less reliable" in the spec's primitive composition rules table. The `blockedBy`-based approach is the preferred pattern.

### 5. Stream detection for groups >= 3

After all research tasks complete, if `isGroup=true` and `issues.length >= 3`:
- Call `detect_work_streams` to cluster issues by file overlap
- If streams > 1: create per-stream implementation tasks with inter-stream independence
- If streams == 1: single sequential implementation chain (no change from current behavior)

The `detect_work_streams` MCP tool exists (based on GH-0327 research). Confirm it's registered in `issue-tools.ts` before Phase 5 implementation.

### 6. XS estimate is tight but valid

The scope is one file: `skills/ralph-hero/SKILL.md`. The V4 spec (Section 4.5) provides the exact diff table. The workspace v2 provides the reference execution loop. The changes are surgical rewrites of specific sections (task creation, execution loop, resumability check) — not a full rewrite. XS is appropriate.

## Recommended Approach

### Section changes in `SKILL.md`

**Add at start (after pipeline detection)**: Task list check for resumability
```
1. detect_pipeline_position(number=NNN)
2. TaskList() → if non-empty and all tasks match current pipeline, resume from pending
3. Else: create upfront task list (Step 2 below)
```

**New Step 2**: Create upfront task list
```
For RESEARCH phase issues: TaskCreate("Research GH-NNN") — unblocked
For each research issue: one task, no blockedBy
Plan task: TaskCreate("Plan group GH-NNN") + TaskUpdate(addBlockedBy=[all research task IDs])
Review task (if RALPH_REVIEW_MODE=auto): TaskCreate("Review plan") + addBlockedBy=[plan task]
Human gate task (if RALPH_REVIEW_MODE=interactive): TaskCreate("Human gate") + addBlockedBy=[plan task]
Implement tasks: one per issue in dependency order, each blockedBy prior impl task
PR task: TaskCreate("Create PR") + addBlockedBy=[last impl task]
```

**Replace execution loop**: `run_in_background` parallel → unblocked-tasks loop
```
Loop:
  pending = TaskList().filter(status=pending, blockedBy=[])
  if empty: check for in_progress; if all done, STOP
  spawn all pending simultaneously (Task() calls in one message, no run_in_background)
  wait for all
  mark each completed via TaskUpdate(status=completed)
  repeat
```

**Add post-research stream detection** (after all research tasks complete):
```
If isGroup and issues.length >= 3:
  detect_work_streams(issueNumbers=[...])
  If totalStreams > 1: split implementation tasks by stream (parallel impl chains)
  Else: single impl chain (unchanged)
```

## Risks

1. **`detect_work_streams` availability**: Verify this MCP tool is registered. If not available by Phase 5, stream detection must be skipped or added as conditional.
2. **Task list scoping on re-invocation**: Session-scoped tasks persist until the session ends. If a new Claude session starts, `TaskList()` will be empty — the skill falls back to `detect_pipeline_position` to rebuild. This is acceptable behavior.
3. **Partially-completed research race**: If the skill is interrupted mid-research, some tasks will be `in_progress` and some `pending`. The resumability check handles this: tasks still `pending` or `in_progress` are re-executed.

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/ralph-hero/SKILL.md` — Add upfront task list creation, replace run_in_background parallel pattern with blockedBy execution loop, add resumability check, add post-research stream detection for groups >= 3

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts` — confirm detect_pipeline_position response fields used in task creation
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` — verify detect_work_streams is registered as MCP tool
- `thoughts/shared/plans/2026-02-22-ralph-workflow-v4-architecture-spec.md` — Section 4.2, 4.4, 4.5 for exact change spec
- `thoughts/shared/research/2026-02-22-GH-0354-v4-upfront-task-list-ralph-team.md` — execution loop pattern reference
