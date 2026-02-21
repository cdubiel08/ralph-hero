---
date: 2026-02-21
github_issue: 257
github_url: https://github.com/cdubiel08/ralph-hero/issues/257
status: complete
type: research
---

# GH-257: Implement Bough Model in SKILL.md

## Problem Statement

SKILL.md Section 4.2 currently creates tasks for ALL remaining pipeline phases upfront with sequential blocking (Research -> Plan -> Review -> Implement -> PR -> Merge). This "full pipeline upfront" approach causes:
- Workers see blocked tasks they cannot yet claim, adding noise to TaskList scans
- The lead cannot dynamically adjust the pipeline based on intermediate results (e.g., research reveals the issue should be split, but Plan/Implement tasks already exist)
- Task list grows proportionally to `phases x issues`, not `current_phase x issues`

The bough model creates tasks only for the **current pipeline phase**, then advances to the next phase after convergence is detected.

## Current State Analysis

### Prerequisites (All Satisfied)

| Predecessor | Status | What it delivered |
|---|---|---|
| #231 (sub-agent isolation) | CLOSED | Internal `Task()` calls omit `team_name` |
| #255 (consolidate templates) | CLOSED | Single `worker.md` template |
| #256 (typed agents + Stop hook) | CLOSED | `subagent_type="ralph-analyst"` etc., `worker-stop-gate.sh` |

GH-257 builds directly on #256: the Stop hook enables workers to discover new work without inline template instructions. Without the Stop hook, the bough model would require the lead to explicitly notify workers of new tasks -- defeating the purpose.

### SKILL.md Section 4.2 (Lines 126-143) -- Current "Full Pipeline Upfront"

Current behavior at [`SKILL.md:128`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L128):
```
Based on pipeline position (Section 3), create tasks with sequential blocking:
Research -> Plan -> Review -> Implement -> PR.
```

This creates the entire task chain at once. For a group of 3 issues, this means 3 Research + 1 Plan + 1 Review + 1 Implement + 1 PR + 1 Merge = **8 tasks** upfront. The bough model creates only 3 Research tasks initially.

### SKILL.md Section 4.4 (Lines 156-167) -- Current Dispatch Loop

The dispatch loop handles exceptions and intake but has no convergence-triggered bough advancement. Routine progression relies on peer-to-peer handoffs (conventions.md lines 92-136), which assumes the next-phase tasks already exist. Under the bough model, the lead must create next-phase tasks before peer handoff can work.

### SKILL.md Section 5 (Lines 173-180) -- Assignment Prohibition

Line 177: "Do NOT assign tasks mid-pipeline via TaskUpdate or SendMessage." This contradicts the bough model, where the lead creates AND assigns new bough tasks when idle workers exist. **This line must be removed** (GH-257 scope for the SKILL.md reference; line 133 in conventions.md is GH-258 scope).

### Pipeline Detection (pipeline-detection.ts)

The `detectPipelinePosition()` function already returns convergence data:
- `phase`: Current phase (SPLIT/TRIAGE/RESEARCH/PLAN/REVIEW/IMPLEMENT/COMPLETE/TERMINAL)
- `convergence.met`: Boolean -- whether all group members have reached the gate state
- `convergence.blocking`: List of issues still behind the gate
- `convergence.recommendation`: "proceed" / "wait" / "escalate"

This is the mechanism the lead uses to detect when to advance to the next bough. The function is already implemented and tested -- no MCP server changes needed.

### Gate States (workflow-states.ts)

Parent advancement gates: `Ready for Plan`, `In Review`, `Done`. These are the convergence targets:
- Research phase converges at `Ready for Plan`
- Plan/Review phase converges at `In Review` (for the issue, not the plan review state)
- Implementation converges at `In Review` (PR created)

### team-task-completed.sh (Current State)

The hook ([team-task-completed.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/team-task-completed.sh)) is guidance-only (exit 0). It handles two cases:
1. Review task completed -> check verdict (APPROVED/NEEDS_ITERATION)
2. Other task completed -> "Peer handoff handles routine pipeline progression"

Under the bough model, case 2 needs a new action: "Check if phase convergence is met. If so, create next-bough tasks."

### Worker Stop Hook (worker-stop-gate.sh, from #256)

Workers already discover work via the Stop hook:
1. Check for owned unblocked tasks
2. Check for unclaimed unblocked tasks matching role keywords
3. Exit 2 (block stop) if found; exit 0 (allow stop) if not

This means the bough model's task creation automatically triggers worker discovery -- the lead creates tasks, workers find them via Stop hook. No explicit notification needed.

## Proposed Changes

### Change 1: Rewrite Section 4.2 -- "Create Current Bough Only"

Replace the current "create tasks with sequential blocking: Research -> Plan -> Review -> Implement -> PR" with:

**New behavior**:
1. Call `detect_pipeline_position` to determine the current phase
2. Create tasks ONLY for the current phase:
   - SPLIT phase: Create "Split GH-NNN" tasks for oversized issues
   - TRIAGE phase: Create "Triage GH-NNN" tasks for issues without state
   - RESEARCH phase: Create "Research GH-NNN" tasks (per-issue for groups)
   - PLAN phase: Create "Plan GH-NNN" task (per-group using GROUP_PRIMARY)
   - REVIEW phase: Create "Review plan for GH-NNN" task (if RALPH_REVIEW_MODE=interactive)
   - IMPLEMENT phase: Create "Implement GH-NNN" task
   - COMPLETE phase: Create "Create PR for GH-NNN" + "Merge PR for GH-NNN" tasks (PR + Merge are always created together since they are tightly coupled)
3. Do NOT create downstream tasks -- they will be created at the next convergence gate

**Subject patterns** remain unchanged (workers match on these for self-claim). The SPLIT, Review mode, and group handling rules from the current Section 4.2 also remain.

### Change 2: Add Convergence-Driven Bough Advancement to Section 4.4

Add a new dispatch responsibility to Section 4.4:

**Bough advancement** (new primary responsibility):
1. When a phase's tasks complete, call `detect_pipeline_position` to check convergence
2. If `convergence.met === true` and `phase` advances: create next-bough tasks per Section 4.2
3. Assign to idle workers if available; otherwise, workers discover via Stop hook
4. For groups: wait for ALL group members to converge before creating next-bough tasks

The existing responsibilities (exception handling, worker gaps, intake) remain unchanged.

### Change 3: Update team-task-completed.sh Hook Guidance

Add bough advancement guidance to the non-review case:

```bash
cat >&2 <<EOF
Task completed by $TEAMMATE: "$TASK_SUBJECT"
ACTION: Check pipeline convergence via detect_pipeline_position.
If phase converged: create next-bough tasks (Section 4.2) and assign to idle workers.
If not converged: peer handoff handles in-phase progression. No lead action needed.
EOF
```

### Change 4: Remove Assignment Prohibition from Section 5

Current Section 5, line 177:
> "Pre-assign at spawn, pull-based thereafter. Do NOT assign tasks mid-pipeline."

Replace with:
> "Pre-assign at spawn. Lead creates and assigns new-bough tasks when convergence is detected. Workers also self-claim unclaimed tasks via Stop hook."

This explicitly allows mid-pipeline assignment for bough advancement.

### Change 5: XS Fast-Track Integration (Section 3.1)

The XS fast-track (Section 3.1) currently says "Create implement + PR tasks directly." Under the bough model, this remains valid as an exception: fast-tracked XS issues skip research/plan and create Implement + PR + Merge tasks in one bough (since they are all in the same logical phase for trivial work).

## Phase-to-Bough Mapping

| Pipeline Phase | Bough Tasks Created | Convergence Gate | Next Bough |
|---|---|---|---|
| SPLIT | "Split GH-NNN" per oversized issue | All split tasks complete (issues now have sub-issues) | Re-detect: usually TRIAGE or RESEARCH |
| TRIAGE | "Triage GH-NNN" per untriaged issue | All triage tasks complete (issues now have workflow state) | Re-detect: usually RESEARCH |
| RESEARCH | "Research GH-NNN" per issue | All issues reach "Ready for Plan" | PLAN |
| PLAN | "Plan GH-NNN" (group: one task) | Issue reaches "Plan in Review" or "In Progress" | REVIEW or IMPLEMENT |
| REVIEW | "Review plan for GH-NNN" | Verdict: APPROVED -> IMPLEMENT; NEEDS_ITERATION -> re-PLAN | IMPLEMENT (or re-PLAN) |
| IMPLEMENT | "Implement GH-NNN" | Issue reaches "In Review" | COMPLETE |
| COMPLETE | "Create PR for GH-NNN" + "Merge PR for GH-NNN" | PR merged, issue Done | TERMINAL |

## Interaction with Existing Mechanisms

### Worker Stop Hook
Workers find new-bough tasks automatically. The lead creates tasks; the Stop hook prevents workers from exiting; workers scan TaskList and claim. No explicit SendMessage needed for routine bough advancement.

### Peer-to-Peer Handoff
Peer handoff still works for **within-phase** progression (e.g., analyst-1 finishes research, messages analyst-2 about unblocked work). Cross-phase progression is now lead-driven (bough advancement) rather than peer-driven. This simplifies the handoff protocol -- peers only hand off within their phase, not across phases.

### Pipeline Detection Tool
`detect_pipeline_position` is called:
1. At session start (Section 3): determine entry phase
2. At each bough advancement: determine next phase after convergence
3. On re-entry after crash: detect where the pipeline stalled

No changes to the MCP tool are needed. The convergence data it returns is sufficient for bough decisions.

### Group Handling
Groups still converge at gate states (Ready for Plan, In Review, Done). The bough model doesn't change group semantics -- it only changes WHEN tasks are created (on convergence, not upfront).

## Scope Boundaries

**In scope (GH-257)**:
- SKILL.md Section 4.2 rewrite (bough model)
- SKILL.md Section 4.4 update (convergence-driven advancement)
- SKILL.md Section 5 update (remove assignment prohibition)
- team-task-completed.sh guidance update

**Out of scope (GH-258)**:
- conventions.md line 133 removal ("Do NOT assign tasks mid-pipeline")
- conventions.md Pipeline Handoff Protocol simplification
- team-teammate-idle.sh "Peers will wake" messaging removal
- conventions.md Skill Invocation Convention update (`general-purpose` -> typed agents)

## Risks

1. **Lead responsiveness**: The lead must respond to TaskCompleted hooks promptly to create next-bough tasks. If the lead is context-saturated, bough advancement stalls. Mitigation: the hook guidance is explicit ("Check pipeline convergence").

2. **Crash recovery**: If the lead crashes after convergence but before creating next-bough tasks, the pipeline stalls. Mitigation: on re-entry, `detect_pipeline_position` re-detects the current phase and the new lead creates the missing bough.

3. **PR + Merge coupling**: Creating PR and Merge tasks together in the COMPLETE bough is a pragmatic exception to "one phase per bough." These are tightly coupled (Merge blocks on PR), and separating them adds no value while requiring an extra convergence check.

## File Change Matrix

| File | Change | Lines Affected |
|---|---|---|
| `skills/ralph-team/SKILL.md` | Rewrite Section 4.2, update 4.4, update Section 5 | ~40 lines changed |
| `hooks/scripts/team-task-completed.sh` | Update non-review guidance to include bough advancement | ~5 lines changed |

**Total**: 2 files, ~45 lines changed. S estimate is appropriate.

## Recommended Implementation Approach

1. Rewrite Section 4.2 with the bough model rules
2. Add bough advancement to Section 4.4 dispatch responsibilities
3. Update Section 5 to allow mid-pipeline assignment
4. Update team-task-completed.sh hook guidance
5. Verify Section 3.1 (XS fast-track) remains coherent with bough model
