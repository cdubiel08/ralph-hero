# Hero Task Graph

> Consulted by `/ralph:hero` default mode Step 2. Defines the upfront `TaskCreate` + `addBlockedBy` shape per starting phase.

## Resumability check (Step 1.5 in default mode)

Before creating tasks, call `TaskList()`. If tasks already exist for this session and match the pipeline shape (subjects start with "Research GH-" / "Plan group GH-" / etc.), SKIP task creation and resume from the Execution Loop.

## Task graph by starting phase

**Starting from SPLIT:**

```
T-1..K: Split GH-NNN (for each M/L/XL issue)  → unblocked
  After splits complete, re-detect pipeline position and rebuild task list for remaining phases.
```

**Starting from RESEARCH:**

```
T-1..N: Research GH-AAA … GH-ZZZ              → unblocked (parallel)
T-N+1:  Plan group GH-[PRIMARY]               → blockedBy: [all research task IDs]
T-N+2:  Review plan GH-[PRIMARY] (if auto)     → blockedBy: [plan task]
    OR  Present decisions (if interactive)     → blockedBy: [plan task]
T-N+3..M: Implement GH-AAA … GH-ZZZ           → blockedBy: [review/gate task], each impl blockedBy prior impl
T-M+1:  Create PR GH-[PRIMARY]                → blockedBy: [last impl task]
T-M+2:  Finish GH-[PRIMARY]                   → blockedBy: [PR task]
```

**Starting from PLAN:**

```
T-1:  Plan group GH-[PRIMARY]                 → unblocked
T-2:  Review plan GH-[PRIMARY] (if auto)       → blockedBy: [plan task]
   OR Present decisions (if interactive)       → blockedBy: [plan task]
T-3..N: Implement GH-AAA … GH-ZZZ             → blockedBy: [review/gate task], each impl blockedBy prior impl
T-N+1:  Create PR GH-[PRIMARY]                → blockedBy: [last impl task]
T-N+2:  Finish GH-[PRIMARY]                   → blockedBy: [PR task]
```

**Starting from REVIEW/HUMAN_GATE:**

```
T-1:  Review plan / Present decisions         → unblocked
T-2..N: Implement GH-AAA … GH-ZZZ             → blockedBy: [review/gate task], each impl blockedBy prior impl
T-N+1:  Create PR GH-[PRIMARY]                → blockedBy: [last impl task]
T-N+2:  Finish GH-[PRIMARY]                   → blockedBy: [PR task]
```

> **Decision hold (GH-1544):** under the default `RALPH_REVIEW_PLAN=auto`, a
> "Review plan" task can terminate in `PLAN AWAITING DECISION` — the plan is
> APPROVED but holds in Plan in Review on open `#### Decision:` blocks. The
> downstream impl tasks stay `blockedBy` the review task and the pipeline
> halts for the human's reply. This is NOT an escalation: do not move the
> issue to Human Needed; report the `## Decision Request` comment URL and
> stop. The next review dispatch (after a human reply) folds the answers and
> completes the task.

**Starting from IMPLEMENT:**

```
T-1..N: Implement GH-AAA … GH-ZZZ             → each impl blockedBy prior impl (first is unblocked)
T-N+1:  Create PR GH-[PRIMARY]                → blockedBy: [last impl task]
T-N+2:  Finish GH-[PRIMARY]                   → blockedBy: [PR task]
```

## Implementation task ordering (dependency-graph-aware)

After all plans are written, read each plan's `## Phase N:` headings and their `- **depends_on**:` annotations.

1. For each phase in each plan, create an implementation task.
2. Set `blockedBy` chains from the plan's dependency graph:
   - Phase 2 `depends_on: [phase-1]` → Phase 2 impl task `blockedBy` Phase 1 impl task.
   - Phase 3 `depends_on: null` → Phase 3 impl task has no `blockedBy`, can run in parallel with Phase 1.
3. If a plan has NO `depends_on` annotations on any phase, fall back to sequential `blockedBy` chains (the per-phase shape above).

This replaces default sequential ordering with a graph-driven ordering that enables parallel dispatch of independent phases.

## PR-task cardinality (GH-1538)

Exactly ONE `Create PR GH-[PRIMARY]` task per plan group. Member issues
NEVER get their own PR task — their work ships in the group's single PR
(one `Closes #` line each). If a resumed task list contains per-member PR
tasks, collapse them to the primary's before re-entering the loop.

## Task creation pattern (two-step)

```
taskId = TaskCreate(subject="Research GH-NNN", description="...", activeForm="Researching GH-NNN")
TaskUpdate(taskId, addBlockedBy=[dependency_task_ids])
```

Include `metadata.issue_number` in each task's description for traceability.

## Cross-repo task metadata

When an issue spans repos (detected during research or split), include in each task's metadata:

- `repos`: list of repo keys involved
- `localDirs`: mapping of repo key → local directory path
- `dependencyFlow`: dependency edges (if any)

This metadata flows to builder sub-agents so they know which directories to work in.

## Execution loop

Loop until pipeline is complete:

1. `TaskList()` → filter to `status=pending` AND `blockedBy=[]`
2. If no pending unblocked tasks: check for `in_progress` tasks; if all are `completed`, STOP (pipeline complete)
3. Dispatch unblocked tasks:
   - **Multiple unblocked impl tasks**: dispatch as parallel `Agent()` calls in a single message (no inter-task deps — that's why they're all unblocked)
   - **Single unblocked task**: dispatch one agent
   - **Non-impl tasks** (research, plan, PR): use phase-specific dispatch from [dispatch.md](dispatch.md)
4. `TaskUpdate(status="completed")` for each completed task
5. Repeat from step 1
