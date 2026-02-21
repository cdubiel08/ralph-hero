---
date: 2026-02-21
status: draft
github_issues: [257]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/257
primary_issue: 257
---

# Bough Model in SKILL.md - Atomic Implementation Plan

## Overview
1 issue implementing the bough model: current-phase-only task creation with convergence-driven advancement in `ralph-team/SKILL.md` and updated hook guidance in `team-task-completed.sh`.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-257 | Implement bough model in SKILL.md: current-phase-only task creation | S |

## Current State Analysis

SKILL.md Section 4.2 (lines 126-143) creates tasks for ALL remaining pipeline phases upfront with sequential blocking (Research -> Plan -> Review -> Implement -> PR -> Merge). This front-loads the entire task chain, making TaskList noisy and preventing dynamic pipeline adjustment.

The `detect_pipeline_position` MCP tool already returns convergence data (`convergence.met`, `convergence.blocking`, `convergence.recommendation`), so no MCP server changes are needed. The worker Stop hook from GH-256 enables workers to discover new tasks automatically.

Section 4.4 (lines 156-167) delegates routine progression to peer-to-peer handoffs, which assume next-phase tasks already exist. Section 5 line 177 prohibits mid-pipeline assignment, conflicting with the bough model's lead-driven advancement.

## Desired End State
### Verification
- [ ] Section 4.2 creates tasks ONLY for the current pipeline phase (bough)
- [ ] Section 4.4 includes convergence-driven bough advancement as a dispatch responsibility
- [ ] Section 5 allows mid-pipeline assignment for bough advancement
- [ ] `team-task-completed.sh` guides the lead to check pipeline convergence
- [ ] Section 3.1 (XS fast-track) remains coherent with the bough model
- [ ] Build succeeds: `cd plugin/ralph-hero/mcp-server && npm run build`
- [ ] Tests pass: `cd plugin/ralph-hero/mcp-server && npm test`

## What We're NOT Doing
- Modifying `conventions.md` (that is GH-258 scope)
- Changing the MCP server or pipeline detection tool
- Modifying `team-teammate-idle.sh`
- Changing the Stop hook (`worker-stop-gate.sh`)
- Changing spawn templates or agent definitions

## Implementation Approach
A single phase with 4 localized changes across 2 files. Changes are documentation/guidance only -- no runtime code changes, no MCP tool changes. The changes are all within the ralph-team skill and its associated hook.

---

## Phase 1: Bough Model Implementation
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/257 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0257-bough-model-skill-md.md

### Changes Required

#### 1. Rewrite Section 4.2 -- Current-Phase-Only Task Creation
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Lines**: 126-143
**Changes**: Replace the current "create tasks with sequential blocking" approach with bough model rules:

1. Call `detect_pipeline_position` to determine the current phase
2. Create tasks ONLY for the current phase:
   - SPLIT: `"Split GH-NNN"` per oversized issue (only if `subIssueCount === 0`)
   - TRIAGE: `"Triage GH-NNN"` per untriaged issue
   - RESEARCH: `"Research GH-NNN"` per issue (for groups: per-member)
   - PLAN: `"Plan GH-NNN"` per group (using GROUP_PRIMARY)
   - REVIEW: `"Review plan for GH-NNN"` (only if `RALPH_REVIEW_MODE=interactive`)
   - IMPLEMENT: `"Implement GH-NNN"`
   - COMPLETE: `"Create PR for GH-NNN"` + `"Merge PR for GH-NNN"` (coupled pair)
3. Do NOT create downstream tasks -- they will be created at convergence
4. Retain existing subject patterns (workers match on these for self-claim)
5. Retain SPLIT safety check, Review mode logic, and group handling rules

#### 2. Add Convergence-Driven Bough Advancement to Section 4.4
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Lines**: 156-167
**Changes**: Replace the current "peer handoff handles routine progression" with lead-driven bough advancement:

1. Add bough advancement as the PRIMARY dispatch responsibility:
   - When a phase's tasks complete, call `detect_pipeline_position` to check convergence
   - If `convergence.met === true` and phase advances: create next-bough tasks per Section 4.2
   - Assign to idle workers if available; otherwise workers discover via Stop hook
   - For groups: wait for ALL group members to converge before creating next-bough tasks
2. Keep existing responsibilities: exception handling (review rejections), worker gaps, intake

#### 3. Update Section 5 -- Allow Mid-Pipeline Assignment
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Line**: 177
**Changes**: Replace:
> "Pre-assign at spawn, pull-based thereafter. Do NOT assign tasks mid-pipeline or via SendMessage. Pipeline handoffs are peer-to-peer (see shared/conventions.md)."

With:
> "Pre-assign at spawn. Lead creates and assigns new-bough tasks when convergence is detected. Workers also self-claim unclaimed tasks via Stop hook."

#### 4. Update `team-task-completed.sh` Hook Guidance
**File**: `plugin/ralph-hero/hooks/scripts/team-task-completed.sh`
**Lines**: 28-33
**Changes**: Replace the non-review case guidance to include bough advancement:

Current:
```bash
cat >&2 <<EOF
Task completed by $TEAMMATE: "$TASK_SUBJECT"
Peer handoff handles routine pipeline progression.
CHECK: Are there idle workers with no unblocked tasks? If so, pull new GitHub issues.
EOF
```

New:
```bash
cat >&2 <<EOF
Task completed by $TEAMMATE: "$TASK_SUBJECT"
ACTION: Check pipeline convergence via detect_pipeline_position.
If phase converged: create next-bough tasks (Section 4.2) and assign to idle workers.
If not converged: wait for remaining tasks to complete. No lead action needed.
CHECK: Are there idle workers with no unblocked tasks? If so, pull new GitHub issues.
EOF
```

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build && npm test` passes
- [ ] Manual: Section 4.2 describes current-phase-only task creation (no sequential blocking of future phases)
- [ ] Manual: Section 4.4 lists bough advancement as primary dispatch responsibility
- [ ] Manual: Section 5 no longer prohibits mid-pipeline assignment
- [ ] Manual: `team-task-completed.sh` guides lead to check `detect_pipeline_position` convergence
- [ ] Manual: Section 3.1 (XS fast-track) still coherently creates Implement + PR + Merge as a single bough exception

---

## Integration Testing
- [ ] Verify SKILL.md renders correctly with no broken markdown
- [ ] Verify `team-task-completed.sh` exits 0 (guidance only, never blocks)
- [ ] Verify no references to removed concepts ("sequential blocking: Research -> Plan -> Review -> Implement -> PR")
- [ ] Verify Section 9 (Known Limitations) "Hybrid claiming" bullet remains accurate after Section 5 changes

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0257-bough-model-skill-md.md
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/230
- Design doc: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-20-ralph-team-worker-redesign.md
- Pipeline detection: `plugin/ralph-hero/mcp-server/src/tools/pipeline-detection.ts`
- Workflow states: `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts`
