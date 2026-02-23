---
date: 2026-02-22
github_issue: 356
github_url: https://github.com/cdubiel08/ralph-hero/issues/356
status: complete
type: research
---

# GH-356: V4 Phase 4 — Agent Definitions & Self-Claim Task Loop

## Problem Statement

Phase 4 ensures all four typed worker agents (`ralph-analyst`, `ralph-builder`, `ralph-validator`, `ralph-integrator`) correctly implement the V4 self-claim task loop, including the **claim-then-verify** pattern required for safe concurrent task acquisition from an upfront task list. Currently, agent definitions describe a generic "check TaskList before stopping" step with no atomic claim or ownership verification.

## Current State Analysis

### What Is Already Implemented

| Acceptance Criterion | Status | Location |
|---|---|---|
| All 4 agents have `worker-stop-gate.sh` Stop hook | ✅ Done | Each agent `.md:7-11` |
| All 4 agents have a 4-step task loop | ✅ Done | Each agent `.md:17-24` |
| SKILL.md Section 6 uses typed `subagent_type` names | ✅ Done | `SKILL.md:348-353` |
| Lead pre-assigns task ownership before spawning | ✅ Done | `SKILL.md:239-244` |
| Claim-then-verify in agent definitions | ❌ Missing | All 4 agents |
| worker-stop-gate.sh filters unblocked tasks only | ❌ Missing | `worker-stop-gate.sh:35-40` |

### Current Agent Task Loop (All Four Agents)

All four agents share an identical 4-step loop structure:

```
1. Read task via TaskGet
2. Invoke [matching skill]
3. Report results via TaskUpdate with structured metadata
4. Check TaskList for more matching tasks before stopping
```

**Gap**: Step 4 says "check TaskList and claim" but specifies no atomic claim step, no `TaskUpdate(owner="me")` call, no `TaskGet` to verify ownership after claiming, and no handling of the case where another worker claimed the same task simultaneously.

### Lead Pre-Assignment (Already Correct)

`SKILL.md:239-244` documents the lead's half of the hybrid claiming model:
1. `TaskUpdate(taskId, owner="[role]")` — set owner BEFORE spawning
2. `Task(subagent_type="[agent-type]", ...)` — spawn after assignment

This is atomic: the task is owned before the worker's first turn begins. No race window for the first task.

### worker-stop-gate.sh (Partial — Missing Unblocked Filter)

`hooks/scripts/worker-stop-gate.sh:35-40`: maps worker name to role keywords, blocks stop with "check TaskList for pending tasks matching your role." The hook does NOT filter for `blockedBy=[]` (unblocked only). With Phase 2's upfront task list, blocked downstream tasks will exist from session start — workers will always see "pending tasks" even when all remaining work is legitimately blocked. This prevents any worker from ever stopping until the full pipeline completes.

### Prior Research

GH-200 race condition research (`thoughts/shared/research/2026-02-20-GH-0200-task-self-assignment-race-condition.md`) documented two root causes:

1. **First-turn bypass**: Spawn template contains a direct `Invoke: Skill(...)` instruction; workers skip TaskList → TaskUpdate → TaskGet and jump straight to skill invocation.
2. **No atomicity in read-then-claim**: Multiple workers can see the same unclaimed task in TaskList and both call `TaskUpdate(owner=...)` — last-write-wins, creating a duplicate execution window.

GH-200 implementation plan (`thoughts/shared/plans/2026-02-20-GH-0200-task-ownership-push-pull-hybrid.md`) proposed the hybrid model (lead pre-assigns first task; workers self-claim subsequent tasks with claim-then-verify). The lead side was implemented in SKILL.md; the worker side (agent definitions) was not updated.

## Key Discoveries

### The Claim-Then-Verify Pattern (from V4 spec)

V4 spec Section 5.9 defines the complete self-claim atomicity protocol:

```
Worker completes task
  ↓
TaskUpdate(status="completed", metadata={...})
  ↓
Stop hook fires (worker-stop-gate.sh)
  ↓
TaskList() → find unblocked, unclaimed tasks matching role
  ├── FOUND → exit 2: "Pending tasks exist for your role"
  │   ↓
  │   Worker: TaskUpdate(owner="analyst")  ← atomic claim attempt
  │   Worker: TaskGet → check owner field  ← verify claim succeeded
  │   If owner != "analyst": skip, find next unclaimed task
  │   If owner == "analyst": execute skill, report, loop
  └── NOT FOUND → exit 0 (allow stop)
```

**Critical detail**: After `TaskUpdate(owner="analyst")`, the worker calls `TaskGet` to confirm it is the actual owner. If another worker claimed it first, skip and find the next unclaimed task. This handles the concurrent-stop edge case (two same-role workers stopping simultaneously and racing to claim the same task).

### Agent-by-Agent Gap Analysis

#### ralph-analyst (`agents/ralph-analyst.md`)
- **Role**: Triage, Split, Research tasks
- **Subject patterns**: `"Triage GH-NNN"`, `"Split GH-NNN"`, `"Research GH-NNN"`
- **Stop hook keywords**: `"Triage, Split, or Research"` (`worker-stop-gate.sh:28`)
- **Missing**: claim-then-verify in step 4; priority ordering (prefer pre-assigned tasks over unclaimed)

#### ralph-builder (`agents/ralph-builder.md`)
- **Role**: Plan, Implement tasks
- **Subject patterns**: `"Plan GH-NNN"`, `"Plan group GH-NNN"`, `"Implement GH-NNN"`, stream variants
- **Stop hook keywords**: `"Plan or Implement"` (`worker-stop-gate.sh:29`)
- **Missing**: claim-then-verify; revision request handling already present at `builder.md:26-27` (keep)

#### ralph-validator (`agents/ralph-validator.md`)
- **Role**: Review tasks
- **Subject patterns**: `"Review plan for GH-NNN"`, stream variants
- **Stop hook keywords**: `"Review or Validate"` (`worker-stop-gate.sh:30`)
- **Missing**: claim-then-verify; note at `validator.md:17` ("full verdict in task description") must be preserved
- **Special case**: Only spawned when `RALPH_REVIEW_MODE=interactive` (`validator.md:28-30`)

#### ralph-integrator (`agents/ralph-integrator.md`)
- **Role**: Create PR, Merge PR tasks
- **Subject patterns**: `"Create PR for GH-NNN"`, `"Merge PR for GH-NNN"`, stream variants
- **Stop hook keywords**: `"Create PR, Merge, or Integrate"` (`worker-stop-gate.sh:31`)
- **Model**: haiku (only non-sonnet worker)
- **Missing**: claim-then-verify; multi-procedure dispatch at `integrator.md:25-54` must be preserved
- **Special case**: Serialized — only one integrator runs at a time (`integrator.md:57-58`)

### Proposed Task Loop (V4 Spec Section 5.5)

The V4 spec defines the standard task loop for all agents:

```
1. Check TaskList for tasks owned by me OR unclaimed unblocked tasks matching my role
2. Prefer pre-assigned (owner == "my-name"): flip status to in_progress, skip claim-then-verify
   Unclaimed (owner == ""): TaskUpdate(owner="my-name") → TaskGet → verify owner == "my-name"
   If claim lost: find next unclaimed task
3. Read task via TaskGet — descriptions have GitHub URLs, artifact paths, group context
4. Invoke matching skill
5. Report results via TaskUpdate with structured metadata
6. Loop back to step 1 (Stop hook drives the cycle)
```

### worker-stop-gate.sh Update Required

The hook must filter to unblocked tasks only. With Phase 2's upfront task list, blocked downstream tasks exist from session start. The hook's guidance must direct workers to check for `status=pending AND blockedBy=[]` — not just any pending task matching their role keywords.

This is a small bash change: update the guidance text emitted on exit 2 to explicitly say "unblocked" tasks, and optionally add a note that blocked tasks do not count.

## Potential Approaches

### Approach A: Update Agent Definitions Only (Recommended)

Add claim-then-verify to step 4 of all four agent definitions. The loop becomes:

```
## Task Loop

1. Check TaskList for pending tasks:
   - Prefer tasks where owner == "my-name" (pre-assigned by lead)
   - Also accept unclaimed tasks (owner == "") with empty blockedBy matching my role keywords
2. If unclaimed: TaskUpdate(taskId, owner="my-name") → TaskGet → confirm owner == "my-name"
   If claim lost to another worker: return to step 1
3. Read full task context: TaskGet for GitHub URLs, artifact paths, group context
4. Invoke matching skill
5. Report: TaskUpdate(taskId, status="completed", metadata={...}, description="...")
6. Return to step 1 (Stop hook drives the cycle — check TaskList before stopping)
```

Update `worker-stop-gate.sh` exit 2 message to specify "unblocked" tasks.

**Pros**: Minimal surface area; agent definitions already have correct structure; preserves role-specific additions (builder revision handling, validator verdict requirement, integrator procedures)

**Cons**: Requires careful preservation of role-specific steps for builder, validator, integrator

### Approach B: Shared Include / Convention Document

Extract the claim-then-verify pattern to `conventions.md` and reference it from each agent definition.

**Pros**: Single source of truth for the pattern

**Cons**: Agent definitions are standalone `.md` files consumed at spawn — no include mechanism; each must be self-contained

**Recommendation**: Approach A. Each agent definition is a standalone system prompt; the pattern must be written into each one. Reference `conventions.md` for rationale but include the full loop inline.

## Risks

1. **Concurrent claim race (low probability)**: Only occurs when two same-role workers stop simultaneously and both see the same unclaimed task. Claim-then-verify handles this correctly.
2. **Pre-assigned task not found**: If lead pre-assigns but the worker's `TaskList()` call runs before the assignment propagates, the worker may not see the task. The "retry after a few seconds if not visible yet" note in existing agent definitions handles this.
3. **worker-stop-gate.sh not updated before Phase 4**: If Phase 2 deploys the upfront task list before this fix, workers will never stop (always see blocked downstream tasks as "pending"). Phase 4 must update the gate in the same PR or immediately after Phase 2.
4. **Role-specific logic loss**: builder, validator, and integrator have important role-specific steps (revision handling, verdict requirement, PR procedures). These must be preserved when rewriting the task loop.
5. **integrator serialization**: Only one integrator at a time. Claim-then-verify is still needed — if two integrators exist (shouldn't happen, but as a guard), the claim race is real.

## Recommended Next Steps

1. **Gate on Phase 2 (GH-354)**: The upfront task list must exist before workers self-claim from it. Phase 4 agent definitions assume an upfront graph with `blockedBy` chains.
2. **Update all four agent definitions** (Approach A):
   - Rewrite Task Loop Step 1: prefer pre-assigned, fall back to unclaimed unblocked
   - Add Step 2: claim-then-verify for unclaimed tasks
   - Renumber existing steps (invoke skill, report, loop)
   - Preserve all role-specific additions verbatim
3. **Update `worker-stop-gate.sh`**: Add "unblocked" qualifier to exit 2 guidance text
4. **Update `conventions.md`**: Add "Lead pre-assigns at spawn" section documenting the hybrid model (can be done alongside Phase 2 GH-354)

## Files Affected

### Will Modify
- `plugin/ralph-hero/agents/ralph-analyst.md` — rewrite Task Loop with claim-then-verify; add pre-assigned preference
- `plugin/ralph-hero/agents/ralph-builder.md` — same; preserve revision handling at lines 26-27
- `plugin/ralph-hero/agents/ralph-validator.md` — same; preserve verdict requirement at line 17
- `plugin/ralph-hero/agents/ralph-integrator.md` — same; preserve multi-procedure dispatch at lines 25-54
- `plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh` — update exit 2 guidance to specify "unblocked" tasks

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/ralph-team/SKILL.md` — Section 4.3 (lead pre-assignment) and Section 6 (spawn table) for correct subagent_type values
- `thoughts/shared/plans/2026-02-22-ralph-workflow-v4-architecture-spec.md` — Sections 5.5 (agent definitions), 5.9 (claim-then-verify), Phase 4 in Section 9
- `thoughts/shared/research/2026-02-20-GH-0200-task-self-assignment-race-condition.md` — prior race condition analysis
- `thoughts/shared/plans/2026-02-20-GH-0200-task-ownership-push-pull-hybrid.md` — prior hybrid model implementation plan
