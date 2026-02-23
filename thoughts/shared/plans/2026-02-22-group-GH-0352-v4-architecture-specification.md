---
date: 2026-02-22
status: draft
github_issues: [352, 353, 354, 355, 356, 357, 358, 359, 360, 361]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/352
  - https://github.com/cdubiel08/ralph-hero/issues/353
  - https://github.com/cdubiel08/ralph-hero/issues/354
  - https://github.com/cdubiel08/ralph-hero/issues/355
  - https://github.com/cdubiel08/ralph-hero/issues/356
  - https://github.com/cdubiel08/ralph-hero/issues/357
  - https://github.com/cdubiel08/ralph-hero/issues/358
  - https://github.com/cdubiel08/ralph-hero/issues/359
  - https://github.com/cdubiel08/ralph-hero/issues/360
  - https://github.com/cdubiel08/ralph-hero/issues/361
primary_issue: 352
---

# V4 Architecture Specification — Atomic Implementation Plan

## Overview
10 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-352 | V4 Phase 0: Investigation & Primitive Behavior Validation | S |
| 2 | GH-353 | V4 Phase 1: Communication Discipline | XS |
| 3 | GH-354 | V4 Phase 2: Upfront Task List Model in ralph-team | S |
| 4 | GH-355 | V4 Phase 3: Roster-First Spawning & suggestedRoster Heuristic | S |
| 5 | GH-356 | V4 Phase 4: Agent Definitions & Self-Claim Task Loop | S |
| 6 | GH-357 | V4 Phase 5: Hero Mode Upfront Task List | XS |
| 7 | GH-358 | V4 Phase 6a: Interactive Skills — draft-idea, form-idea, research-codebase | S |
| 8 | GH-359 | V4 Phase 6b: Interactive Skills — create-plan, iterate-plan, implement-plan | S |
| 9 | GH-360 | V4 Phase 7: Observability Layer — Debug Logging & Hook Capture | S |
| 10 | GH-361 | V4 Phase 7b: Observability Layer — Collation & Stats MCP Tools | S |

**Why grouped**: All 10 issues are sub-issues of the V4 Architecture Specification epic (#351). They represent a phased rollout of architectural improvements where each phase builds on findings/changes from prior phases. Phases 0-5 are strictly sequential (task list model, spawning, agent definitions). Phases 6a/6b and 7/7b are semi-independent but grouped for atomic delivery.

## Current State Analysis

The ralph-hero plugin has two orchestration modes:
- **Hero mode** (`ralph-hero` skill): Solo orchestrator using `run_in_background=true` for parallel work and manual ordering for sequential work. No task list, no progress tracking, limited resumability.
- **Team mode** (`ralph-team` skill): Lead-worker model using the "bough model" — tasks created one phase at a time with lead-driven convergence detection via `detect_pipeline_position`. Workers are spawned on-demand.

Both modes suffer from documented failures: redundant messaging (30+ per session), bough advancement bottleneck, no self-claim, no upfront visibility, and no observability.

**Key architecture spec**: `thoughts/shared/plans/2026-02-22-ralph-workflow-v4-architecture-spec.md` (1200 lines) defines the corrected architecture based on Claude Code primitive taxonomy analysis.

**Phase 0 investigation findings** (already complete as research):
- TaskList visibility works when `TeamCreate` ordering is correct
- `blockedBy` is advisory, not enforced — `worker-stop-gate.sh` must check explicitly
- Self-claim atomicity: last-write-wins race, mitigated by claim-then-verify pattern
- Idle workers cannot self-detect task creation — lead must `SendMessage` wake after pre-assignment
- Interleaved create-assign-spawn (Option A) is simpler than roster-first with generic template
- `suggestedRoster` heuristic is feasible with available `detect_pipeline_position` inputs

## Desired End State

### Verification
- [x] Research doc for GH-352 committed and linked (Phase 0 findings documented)
- [ ] `conventions.md` has "Communication Discipline" section with Assignment/Reporting/Nudge Rules
- [ ] `SKILL.md` Section 5 has FORBIDDEN rules for SendMessage misuse
- [ ] Hook scripts produce at most one line of stderr guidance
- [ ] `SKILL.md` Section 4.2 creates ALL pipeline tasks upfront with `blockedBy` chains
- [ ] No "bough" references remain in `SKILL.md` or `conventions.md`
- [ ] `worker-stop-gate.sh` filters to unblocked tasks only
- [ ] `detect_pipeline_position` returns `suggestedRoster` with per-role counts
- [ ] All 4 agent definitions implement claim-then-verify self-claim task loop
- [ ] Hero mode creates upfront task list with `blockedBy` and supports resumability
- [ ] `draft-idea` and `research-codebase` skills exist (verify from GH-343 worktree)
- [ ] All 3 Phase 6b interactive skills exist and are verified complete
- [ ] `DebugLogger` class captures JSONL logs when `RALPH_DEBUG=true`, zero overhead when unset
- [ ] `withLogging` wrapper threaded to all 10 `register*()` functions
- [ ] `collate_debug` and `debug_stats` MCP tools conditionally registered when `RALPH_DEBUG=true`
- [ ] All tests pass: `cd plugin/ralph-hero/mcp-server && npm test`
- [ ] Build succeeds: `cd plugin/ralph-hero/mcp-server && npm run build`

## What We're NOT Doing
- No runtime changes to Claude Code SDK (we work within primitive constraints)
- No changes to the MCP server transport layer
- No changes to Linear integration (GitHub-only)
- No changes to the state machine (`ralph-state-machine.json`)
- No multi-project changes to `RALPH_GH_PROJECT_NUMBERS` handling
- Phase 6b (#359) may close as already-done if verification confirms skills are complete

## Implementation Approach

Phases 1-5 are documentation/skill/agent changes that build a new orchestration model. Phase 6 is interactive skill verification/integration. Phases 7-7b add TypeScript MCP server code for observability. The phases build on each other: communication rules (Phase 2) → upfront task list (Phase 3) → roster spawning (Phase 4) → agent self-claim (Phase 5) → hero mode port (Phase 6).

---

## Phase 1: GH-352 — Investigation & Primitive Behavior Validation
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/352 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-23-GH-0352-v4-primitive-investigation.md | **Depends on**: none

### Changes Required

#### 1. Commit existing research document
**File**: `thoughts/shared/research/2026-02-23-GH-0352-v4-primitive-investigation.md`
**Changes**: Research is already complete (314 lines). This phase confirms the document is committed and linked to the issue. The findings inform all subsequent phases:

**Key findings to carry forward**:
- `blockedBy` is advisory → Phase 3 must update `worker-stop-gate.sh` to check explicitly
- Self-claim race → Phase 5 must implement claim-then-verify in agent definitions
- Idle workers can't self-detect tasks → Phase 4 must add `SendMessage` wake to startup sequence
- Interleaved create-assign-spawn (Option A) preferred → Phase 4 uses this model
- `suggestedRoster` feasible → Phase 4 adds to `PipelinePosition` interface

### Success Criteria
- [x] Automated: Research doc exists at expected path and is committed
- [x] Manual: Research findings cover all 5 areas (0a-0e) with status/action for each

**Creates for next phase**: Validated primitive behavior findings that inform all subsequent phase designs.

---

## Phase 2: GH-353 — Communication Discipline
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/353 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-23-GH-0353-communication-discipline.md | **Depends on**: Phase 1

### Changes Required

#### 1. Add Communication Discipline section to conventions.md
**File**: `plugin/ralph-hero/skills/shared/conventions.md`
**Changes**: Insert new `## Communication Discipline` section after the existing `## TaskUpdate Protocol` section (after line 35). Content from v4 spec Section 7.1:

```markdown
## Communication Discipline

### The Assignment Rule
After TaskUpdate(owner=...) for a worker's FIRST task (before spawn), do NOT SendMessage.
After TaskUpdate(owner=...) for a NEWLY ASSIGNED task to an IDLE worker, SendMessage to wake them.
After TaskUpdate(owner=...) in any other case, do NOT SendMessage.

### The Reporting Rule
Workers report via TaskUpdate(metadata={...}). SendMessage is for:
- Escalations (blocking discoveries, unanswerable questions)
- Responses to direct questions from teammates
Never for: acknowledgments, progress updates, task confirmations.

### The Nudge Rule
If a worker is idle with an assigned task, the problem is TaskList visibility, not communication.
Check the task exists in the team scope. Do NOT send a nudge message.
If the task is correctly scoped and the worker is still idle after 2 minutes, send ONE wake message.
```

#### 2. Add FORBIDDEN rules to SKILL.md Section 5
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**: After existing behavioral principles (around line 305), add explicit FORBIDDEN block:

```markdown
### FORBIDDEN Communication Patterns
- SendMessage immediately after TaskUpdate(owner=...) — task assignment IS the communication
- SendMessage with task details in content — put context in TaskCreate description
- broadcast for anything other than critical blocking issues
- SendMessage to acknowledge receipt of a task — just start working
- Creating tasks mid-pipeline — all tasks created upfront (see Section 4.2)
```

#### 3. Add passive-monitoring note to SKILL.md Section 4.4
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**: At the top of Section 4.4 (line 246), add a design note:

```markdown
**Design principle**: The dispatch loop is passive. The lead monitors lifecycle hooks (TaskCompleted, TeammateIdle) and responds to events. The lead does NOT actively poll workers, send progress check messages, or create tasks mid-pipeline. All tasks are created upfront (Section 4.2) and workers self-claim via the Stop hook.
```

#### 4. Trim team-task-completed.sh to one-line guidance
**File**: `plugin/ralph-hero/hooks/scripts/team-task-completed.sh`
**Changes**: Replace the multi-step review guidance (lines 22-27) and non-review guidance (lines 29-34) with single-line factual outputs:

Review path: `Task completed by $TEAMMATE: "$TASK_SUBJECT" (review task)`
Non-review path: `Task completed by $TEAMMATE: "$TASK_SUBJECT"`

#### 5. Verify team-teammate-idle.sh (no change needed)
**File**: `plugin/ralph-hero/hooks/scripts/team-teammate-idle.sh`
**Changes**: Already compliant — line 21 outputs a single line. No change.

### Success Criteria
- [x] Automated: `grep -c "FORBIDDEN" plugin/ralph-hero/skills/ralph-team/SKILL.md` returns >= 1
- [x] Automated: `grep -c "Communication Discipline" plugin/ralph-hero/skills/shared/conventions.md` returns >= 1
- [x] Manual: `team-task-completed.sh` outputs exactly one line per path (review/non-review)

**Creates for next phase**: Communication rules that Phase 3's upfront task list model and Phase 5's agent definitions reference.

---

## Phase 3: GH-354 — Upfront Task List Model in ralph-team
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/354 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0354-v4-upfront-task-list-ralph-team.md | **Depends on**: Phase 2

### Changes Required

#### 1. Rewrite SKILL.md Section 4.2 — Upfront task list
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**: Replace Section 4.2 "Create Tasks for Current Phase Only (Bough Model)" (lines 161-230) with "Create Upfront Task List". New content:

**Resumability check**: Before creating tasks, call `TaskList()`. If incomplete tasks exist for the target issue(s) (matching `metadata.issue_number`), resume from the first incomplete task.

**Task graph creation** (using `TaskCreate` + `TaskUpdate(addBlockedBy)`):

For single issue:
```
T-1: Research GH-NNN       → unblocked         → analyst
T-2: Plan GH-NNN           → blockedBy: T-1    → builder
T-3: Review plan GH-NNN    → blockedBy: T-2    → validator
T-4: Implement GH-NNN      → blockedBy: T-3    → builder
T-5: Create PR GH-NNN      → blockedBy: T-4    → integrator
T-6: Merge PR GH-NNN       → blockedBy: T-5    → integrator
```

For group of N issues:
```
T-1..N: Research GH-AAA … GH-ZZZ  → unblocked (parallel)     → analyst(s)
T-N+1:  Plan group GH-AAA          → blockedBy: T-1..N        → builder
T-N+2:  Review plan GH-AAA         → blockedBy: T-N+1         → validator
T-N+3:  Implement GH-AAA           → blockedBy: T-N+2         → builder
T-N+4:  Create PR GH-AAA           → blockedBy: T-N+3         → integrator
T-N+5:  Merge PR GH-AAA            → blockedBy: T-N+4         → integrator
```

Reference implementations: `~/.claude/commands/ralph_hero.md` (lines 170-263) and `~/.claude/commands/ralph_team.md` (lines 212-265).

#### 2. Rewrite SKILL.md Section 4.4 — Passive dispatch loop
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**: Replace bough advancement logic (lines 251-269) with passive dispatch loop:

```markdown
### 4.4 Dispatch Loop (Passive Monitoring)

The lifecycle hooks fire at natural decision points. The lead responds to events:

**On TaskCompleted**: Check if all pipeline tasks are completed. If yes, initiate shutdown sequence.
**On TeammateIdle**: Normal — workers go idle between tasks. The Stop hook handles work discovery. Do NOT nudge.
**On escalation (SendMessage from worker)**: Read the message, resolve the issue (create clarifying task, provide context), respond.

The lead does NOT:
- Call `detect_pipeline_position` for convergence checking
- Create new tasks mid-pipeline
- Send nudge messages to idle workers
- Manually advance phases
```

#### 3. Update conventions.md Pipeline Handoff Protocol
**File**: `plugin/ralph-hero/skills/shared/conventions.md`
**Changes**: Rewrite the Pipeline Handoff Protocol section (lines 78-96). Replace bough advancement language with upfront task list + self-claim model:

```markdown
## Pipeline Handoff Protocol

Workers self-navigate the pipeline via the upfront task list:

1. Worker completes task → `TaskUpdate(status="completed", metadata={...})`
2. Stop hook fires → checks TaskList for unblocked, unclaimed tasks matching role
3. If found → blocks stop (exit 2), worker self-claims and executes
4. If not found → allows stop (exit 0), worker goes idle

**Key**: `blockedBy` chains enforce phase ordering. Workers only work on unblocked tasks.
```

#### 4. Update worker-stop-gate.sh — Filter to unblocked tasks
**File**: `plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh`
**Changes**: Update the guidance text (lines 35-39) to specify "unblocked" tasks:

```bash
cat >&2 <<EOF
Before stopping, check TaskList for pending UNBLOCKED tasks matching your role ($KEYWORDS).
Only tasks with empty blockedBy count as available work.
If matching unblocked tasks exist, claim one and process it.
If none are available, you may stop.
EOF
```

### Success Criteria
- [x] Automated: `grep -c "Bough Model" plugin/ralph-hero/skills/ralph-team/SKILL.md` returns 0
- [x] Automated: `grep -c "blockedBy" plugin/ralph-hero/skills/ralph-team/SKILL.md` returns >= 3
- [x] Manual: Section 4.2 describes full upfront task graph with `TaskCreate` + `TaskUpdate(addBlockedBy)` pattern

**Creates for next phase**: Upfront task list model that Phase 4's roster spawning builds upon.

---

## Phase 4: GH-355 — Roster-First Spawning & suggestedRoster Heuristic
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/355 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-23-GH-0355-roster-first-spawning.md | **Depends on**: Phase 3

### Changes Required

#### 1. Add SuggestedRoster interface to pipeline-detection.ts
**File**: `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts`
**Changes**: After `PipelinePosition` interface (line 50), add:

```typescript
export interface SuggestedRoster {
  analyst: number;    // 0-3: 1 for single issue; 2 for 2-5 needing research; 3 for 6+
  builder: number;    // 1-2: 1 default; 2 if 5+ issues with M/L estimates
  validator: number;  // always 1
  integrator: number; // always 1
}
```

Add `suggestedRoster: SuggestedRoster` field to the `PipelinePosition` interface.

#### 2. Compute suggestedRoster in buildResult()
**File**: `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts`
**Changes**: In `buildResult()` function (lines 365-392), compute the heuristic before returning:

```typescript
function computeSuggestedRoster(
  phase: PipelinePhase,
  issues: IssueState[],
  isGroup: boolean
): SuggestedRoster {
  // Phase-aware: if past research, analyst = 0
  const needsResearch = issues.filter(i =>
    ['Research Needed', 'Research in Progress'].includes(i.workflowState)
  );
  let analyst = 0;
  if (phase === 'RESEARCH' || phase === 'SPLIT' || phase === 'TRIAGE') {
    analyst = needsResearch.length <= 1 ? 1
      : needsResearch.length <= 5 ? 2
      : 3;
  }

  // Builder scaling: default 1; 2 if 5+ issues with M/L estimates
  const largeSized = issues.filter(i =>
    i.estimate && ['M', 'L', 'XL'].includes(i.estimate)
  );
  const builder = largeSized.length >= 5 ? 2 : 1;

  return { analyst, builder, validator: 1, integrator: 1 };
}
```

Include the result in `buildResult()` return value.

#### 3. Update SKILL.md Section 4.3 — Interleaved startup sequence
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**: Rewrite Section 4.3 (lines 235-244) to use the interleaved create-assign-spawn pattern (Option A from Phase 0 findings):

```markdown
### 4.3 Startup Sequence (Interleaved Create-Assign-Spawn)

1. `TeamCreate(team_name="ralph-team-GH-NNN")`
2. `detect_pipeline_position(number=NNN)` → get `suggestedRoster`
3. Create ALL pipeline tasks with `blockedBy` chains (Section 4.2)
4. For each role in `suggestedRoster` (where count > 0):
   a. Find first unblocked task matching role
   b. `TaskUpdate(taskId, owner="role-name")` — pre-assign
   c. Read and fill spawn template
   d. `Task(subagent_type="ralph-role", team_name=..., name="role-name", prompt=filled_template)`
5. Remaining unblocked tasks without pre-assignment will be self-claimed by workers via Stop hook
```

**Why interleaved (not roster-first)**: Phase 0c investigation found that idle workers cannot self-detect task creation. The interleaved model avoids the need for `SendMessage` wake after pre-assignment.

#### 4. Update agent definitions — Handle empty TaskList gracefully
**Files**: `plugin/ralph-hero/agents/ralph-analyst.md`, `ralph-builder.md`, `ralph-validator.md`, `ralph-integrator.md`
**Changes**: Add a note to each agent's Task Loop section:

```markdown
**First turn**: If TaskList is empty or no tasks match your role, this is normal — tasks may still be
in creation. Your Stop hook will re-check. Do not treat empty TaskList as an error.
```

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` succeeds
- [ ] Automated: `grep -c "suggestedRoster" plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts` returns >= 3
- [ ] Manual: `detect_pipeline_position` response includes `suggestedRoster` with analyst/builder/validator/integrator counts

**Creates for next phase**: `suggestedRoster` heuristic that SKILL.md uses for roster sizing; agent definitions that handle empty TaskList.

---

## Phase 5: GH-356 — Agent Definitions & Self-Claim Task Loop
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/356 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0356-v4-agent-definitions-self-claim-task-loop.md | **Depends on**: Phase 4

### Changes Required

#### 1. Rewrite Task Loop in all four agent definitions
**Files**: `plugin/ralph-hero/agents/ralph-analyst.md` (lines 19-24), `ralph-builder.md` (lines 17-21), `ralph-validator.md` (lines 19-23), `ralph-integrator.md` (lines 17-21)
**Changes**: Replace the existing 4-step Task Loop with the V4 6-step self-claim loop:

```markdown
## Task Loop

1. Check TaskList for pending tasks:
   - Prefer tasks where owner == "my-name" (pre-assigned by lead)
   - Also accept unclaimed tasks (owner == "") with empty blockedBy matching your role
2. If unclaimed: TaskUpdate(taskId, owner="my-name") → TaskGet → confirm owner == "my-name"
   If claim lost to another worker: return to step 1
3. Read full task context: TaskGet for GitHub URLs, artifact paths, group context; metadata has `issue_number`, `artifact_path`, `worktree`
4. Invoke matching skill
5. Report results via TaskUpdate with structured metadata (see skill's "Team Result Reporting" section)
6. Check TaskList for more matching tasks before stopping (retry after a few seconds if not visible yet)
```

**Preserve role-specific additions**:
- `ralph-builder.md`: Keep "Handling Revision Requests" (lines 25-27) and "Implementation Notes" (lines 29-33)
- `ralph-validator.md`: Keep "full VERDICT must appear in both metadata and description" note (line 17) and review mode note (lines 27-29)
- `ralph-integrator.md`: Keep PR Creation Procedure (lines 25-38) and Merge Procedure (lines 40-54), serialization note (lines 56-58)

#### 2. Update worker-stop-gate.sh guidance text
**File**: `plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh`
**Changes**: This was partially addressed in Phase 3. Verify the guidance text at lines 35-39 explicitly mentions "unblocked" tasks and `blockedBy` checking. If not already updated, make the change described in Phase 3.

### Success Criteria
- [ ] Automated: `grep -c "claim-then-verify\|TaskUpdate.*owner.*TaskGet.*confirm" plugin/ralph-hero/agents/ralph-analyst.md` returns >= 1
- [ ] Manual: All 4 agent definitions have the same 6-step task loop structure
- [ ] Manual: Role-specific additions (builder revision handling, validator verdict, integrator procedures) preserved

**Creates for next phase**: Agent definitions that work with the upfront task list and self-claim model.

---

## Phase 6: GH-357 — Hero Mode Upfront Task List
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/357 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-23-GH-0357-v4-hero-mode-upfront-task-list.md | **Depends on**: Phase 5

### Changes Required

#### 1. Add resumability check at skill start
**File**: `plugin/ralph-hero/skills/ralph-hero/SKILL.md`
**Changes**: After pipeline detection (line 94), add:

```markdown
### Resumability Check
1. Call `TaskList()` to check if tasks already exist for this session
2. If tasks exist (non-empty TaskList with tasks matching the pipeline): skip task creation, resume from pending tasks
3. If no tasks: proceed to create upfront task list (Step 2)
```

#### 2. Replace per-phase execution with upfront task list creation
**File**: `plugin/ralph-hero/skills/ralph-hero/SKILL.md`
**Changes**: After pipeline detection and resumability check, add a new "Create Upfront Task List" section. Replace the per-phase `run_in_background=true` parallel pattern and manual sequential ordering with:

```markdown
### Create Upfront Task List
Create ALL tasks for the remaining pipeline phases with `blockedBy` dependencies:

- SPLIT phase issues (if M/L/XL): `TaskCreate("Split GH-NNN")` — unblocked
- RESEARCH phase issues: `TaskCreate("Research GH-NNN")` — blockedBy split tasks if any
- PLAN: `TaskCreate("Plan group GH-NNN")` + `TaskUpdate(addBlockedBy=[all research task IDs])`
- REVIEW (if RALPH_REVIEW_MODE=auto): `TaskCreate("Review plan GH-NNN")` + `addBlockedBy=[plan task]`
- HUMAN GATE (if RALPH_REVIEW_MODE=interactive): `TaskCreate("Human gate")` + `addBlockedBy=[plan task]`
- IMPLEMENT: one task per issue in dependency order, each `blockedBy` prior impl task
- PR: `TaskCreate("Create PR GH-NNN")` + `addBlockedBy=[last impl task]`
```

#### 3. Replace execution loop
**File**: `plugin/ralph-hero/skills/ralph-hero/SKILL.md`
**Changes**: Replace the per-phase state machine (SPLIT/RESEARCH/PLAN/IMPLEMENT/COMPLETE sections) with a unified execution loop:

```markdown
### Execution Loop
Loop:
  1. `TaskList()` → filter to `status=pending AND blockedBy=[]`
  2. If empty: check for in_progress tasks; if all done, STOP (pipeline complete)
  3. Spawn all unblocked tasks simultaneously (multiple `Task()` calls in one message, foreground)
  4. Wait for all to complete
  5. `TaskUpdate(status="completed")` for each
  6. Repeat
```

#### 4. Add post-research stream detection
**File**: `plugin/ralph-hero/skills/ralph-hero/SKILL.md`
**Changes**: After research tasks complete (detectable via the loop finding plan tasks unblocked), add:

```markdown
### Stream Detection (Groups >= 3)
After all research tasks complete, if `isGroup=true` and `issues.length >= 3`:
1. Call `ralph_hero__detect_work_streams(issues=[...])` to cluster by file overlap
2. If `totalStreams > 1`: split implementation tasks into per-stream chains (parallel impl chains)
3. If `totalStreams == 1`: single sequential implementation chain (unchanged)
```

### Success Criteria
- [x] Automated: `grep -c "TaskCreate\|TaskList\|blockedBy" plugin/ralph-hero/skills/ralph-hero/SKILL.md` returns >= 5 (27)
- [x] Automated: `grep -c "run_in_background" plugin/ralph-hero/skills/ralph-hero/SKILL.md` returns 0
- [x] Manual: Hero mode SKILL.md has resumability check, upfront task list creation, and unified execution loop

**Creates for next phase**: Hero mode using the same upfront task list pattern as team mode.

---

## Phase 7: GH-358 — Interactive Skills: draft-idea, form-idea, research-codebase
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/358 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-23-GH-0358-v4-phase-6a-interactive-skills.md | **Depends on**: Phase 6

### Changes Required

#### 1. Verify and integrate GH-343 worktree implementations
**Files**:
- `plugin/ralph-hero/skills/draft-idea/SKILL.md` — verify or create from GH-343 worktree
- `plugin/ralph-hero/skills/research-codebase/SKILL.md` — verify or create from GH-343 worktree

**Changes**: Research found all 3 skills already implemented in the GH-343 worktree. The scope is:

1. Check if GH-343 worktree branch still exists and has a PR
2. Compare GH-343 versions with any existing versions on main
3. Verify each SKILL.md against the checklist:
   - No `context: fork`, no `RALPH_COMMAND`
   - Correct model (sonnet for draft-idea, opus for form-idea/research-codebase)
   - GitHub tools (`ralph_hero__*`, not Linear), `#NNN`/`GH-NNNN` naming
   - Sub-agents spawned without `team_name`
   - Artifact Comment Protocol for doc-to-issue linking
4. Copy verified implementations to main (or merge PR)

**Note**: `form-idea/SKILL.md` already exists on main — compare with GH-343 version before overwriting.

### Success Criteria
- [x] Automated: `ls plugin/ralph-hero/skills/draft-idea/SKILL.md plugin/ralph-hero/skills/research-codebase/SKILL.md` succeeds
- [x] Manual: Each skill passes the verification checklist from the research doc (no context:fork, no RALPH_COMMAND, correct models, GitHub tools only, no Linear, team_name convention notes only)

**Creates for next phase**: Complete set of 3 interactive skills with GitHub integration.

---

## Phase 8: GH-359 — Interactive Skills: create-plan, iterate-plan, implement-plan
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/359 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-23-GH-0359-interactive-skills-6b.md | **Depends on**: Phase 7

### Changes Required

#### 1. Verify existing implementations are complete
**Files**:
- `plugin/ralph-hero/skills/create-plan/SKILL.md`
- `plugin/ralph-hero/skills/iterate-plan/SKILL.md`
- `plugin/ralph-hero/skills/implement-plan/SKILL.md`

**Changes**: Research found **all three skills already exist and are complete**. Verification checklist:
- [x] No `context: fork` — confirmed
- [x] No `RALPH_COMMAND` — confirmed
- [x] model: opus — confirmed
- [x] `ralph_hero__*` tool calls (no Linear) — confirmed
- [x] Artifact Comment Protocol — confirmed
- [x] State transitions offered to user (not automatic) — confirmed
- [x] implement-plan pauses for manual verification — confirmed

**This phase is a verification pass only.** If all checks pass, close GH-359 as Done with no code changes needed.

### Success Criteria
- [x] Automated: `ls plugin/ralph-hero/skills/create-plan/SKILL.md plugin/ralph-hero/skills/iterate-plan/SKILL.md plugin/ralph-hero/skills/implement-plan/SKILL.md` succeeds
- [x] Manual: Each skill passes acceptance criteria — no context:fork, no RALPH_COMMAND, model:opus, ralph_hero__ tools, no Linear, Artifact Comment Protocol, state transitions offered, manual verification pauses

**Creates for next phase**: Confirmed complete set of all 6 interactive skills.

---

## Phase 9: GH-360 — Observability: Debug Logging & Hook Capture
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/360 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0360-v4-observability-debug-logging-hook-capture.md | **Depends on**: Phase 8

### Changes Required

#### 1. Create DebugLogger class
**File**: `plugin/ralph-hero/mcp-server/src/lib/debug-logger.ts` (NEW)
**Changes**: Create following the `RateLimiter` pattern (`src/lib/rate-limiter.ts`):

```typescript
export interface DebugLoggerOptions {
  logDir?: string;  // defaults to ~/.ralph-hero/logs/
}

export class DebugLogger {
  private logPath: string | null = null;
  private logDir: string;

  constructor(options?: DebugLoggerOptions);
  private async getLogPath(): Promise<string>;  // lazy file creation
  private async append(event: Record<string, unknown>): Promise<void>;  // fire-and-forget JSONL
  logGraphQL(fields: GraphQLLogFields): void;
  logTool(fields: ToolLogFields): void;
}

export function createDebugLogger(): DebugLogger | null;  // null when RALPH_DEBUG unset
export function withLogging<T>(
  logger: DebugLogger | null,
  toolName: string,
  params: Record<string, unknown>,
  handler: () => Promise<T>
): Promise<T>;
```

Key details:
- `createDebugLogger()` returns `null` when `process.env.RALPH_DEBUG !== 'true'` — zero overhead
- JSONL format: `{"ts":"...","cat":"tool|graphql|hook|session","...fields}`
- `sanitize()` function strips fields matching `*token*`, `*auth*`, `*secret*`, `*key*`
- Log calls are fire-and-forget with `.catch(console.error)` — never block tool handlers
- Log path: `~/.ralph-hero/logs/session-{YYYY-MM-DD}-{HH-MM-SS}-{random4}.jsonl`

#### 2. Instrument GraphQL client
**File**: `plugin/ralph-hero/mcp-server/src/github-client.ts`
**Changes**: Accept optional `debugLogger: DebugLogger | null` in `createGitHubClient()` config (line 75). In `executeGraphQL()` (line 102), wrap the try/catch with timing:

```typescript
const t0 = Date.now();
try {
  const response = await graphqlFn<T & ...>(fullQuery, variables || {});
  // ... existing rate limit update ...
  debugLogger?.logGraphQL({
    operation: extractOperationName(fullQuery),
    variables: sanitize(variables),
    durationMs: Date.now() - t0,
    status: 200,
    rateLimitRemaining: response.rateLimit?.remaining,
    rateLimitCost: response.rateLimit?.cost,
  });
  return response as T;
} catch (error) {
  debugLogger?.logGraphQL({ /* error fields */ });
  // ... existing 403 retry ...
}
```

#### 3. Thread debugLogger through index.ts
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`
**Changes**: In `main()` (line 288):

```typescript
const debugLogger = createDebugLogger();
```

Pass `debugLogger` as optional 4th argument to all 10 `register*()` calls (lines 316-344).

#### 4. Add withLogging wrapper to all 10 tool modules
**Files**: All `plugin/ralph-hero/mcp-server/src/tools/*.ts` (10 files)
**Changes**: For each `register*()` function:
1. Accept `debugLogger?: DebugLogger | null` as optional parameter
2. Wrap each `server.tool(name, ..., async (params) => {...})` handler with `withLogging(debugLogger, name, params, handler)`

This is a mechanical change. Example for one tool in `issue-tools.ts`:

```typescript
server.tool("ralph_hero__get_issue", desc, schema, async (args) =>
  withLogging(debugLogger, "ralph_hero__get_issue", args, async () => {
    // existing handler body unchanged
  })
);
```

#### 5. Create debug-hook-counter.sh
**File**: `plugin/ralph-hero/hooks/scripts/debug-hook-counter.sh` (NEW)
**Changes**: Lightweight hook script for PostToolUse events when `RALPH_DEBUG=true`:

```bash
#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"
if [[ "${RALPH_DEBUG:-}" != "true" ]]; then exit 0; fi
# Append hook event to current session JSONL
```

#### 6. Add tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/debug-logger.test.ts` (NEW)
**Changes**: Unit tests covering:
- `createDebugLogger()` returns null when `RALPH_DEBUG` unset
- `DebugLogger` creates log file lazily on first event
- JSONL format is valid (parseable per line)
- Token sanitization works
- `withLogging` calls handler and logs timing

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes (including new tests)
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` succeeds
- [ ] Manual: `RALPH_DEBUG=true` produces `~/.ralph-hero/logs/session-*.jsonl` with valid events

**Creates for next phase**: JSONL capture infrastructure that Phase 10's collation tools read.

---

## Phase 10: GH-361 — Observability: Collation & Stats MCP Tools
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/361 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-23-GH-0361-v4-phase-7b-collation-stats-mcp-tools.md | **Depends on**: Phase 9

### Changes Required

#### 1. Create debug-tools.ts
**File**: `plugin/ralph-hero/mcp-server/src/tools/debug-tools.ts` (NEW)
**Changes**: Create `registerDebugTools(server, client)` with two MCP tools:

**`ralph_hero__collate_debug`**:
- Params: `since?: string` (ISO date, default 24h), `dryRun?: boolean` (default false), `projectNumber?: number`
- Reads `~/.ralph-hero/logs/*.jsonl`, filters to errors (`ok: false`, `blocked: true`, `exitCode !== 0`)
- Groups by signature: `{cat}:{name|operation|hook}:{errorType|exitCode}:{normalized_error_message}`
- Hashes each signature to 8-char dedup key
- Searches GitHub for open issues with `debug-auto` label matching hash
- Creates new issues or adds occurrence comments
- Issue labels: `["debug-auto", "ralph-self-report"]`
- Returns summary: issues created, updated, occurrences

**`ralph_hero__debug_stats`**:
- Params: `since?: string` (default 7 days), `groupBy?: "tool" | "category" | "day"` (default "tool")
- Reads JSONL files, aggregates `cat: "tool"` events
- Returns: `totalToolCalls`, `totalErrors`, `errorRate`, `sessionsAnalyzed`, per-group breakdown with `calls`, `errors`, `errorRate`, `avgDurationMs`

#### 2. Conditional registration in index.ts
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`
**Changes**: After existing `register*()` calls (around line 344):

```typescript
if (process.env.RALPH_DEBUG === 'true') {
  registerDebugTools(server, client);
}
```

#### 3. Add tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/debug-tools.test.ts` (NEW)
**Changes**: Unit tests covering:
- JSONL parsing with various event categories
- Error signature grouping and normalization
- Stats aggregation (by tool, category, day)
- `dryRun=true` skips GitHub writes

### Success Criteria
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm test` passes (including new tests)
- [ ] Automated: `cd plugin/ralph-hero/mcp-server && npm run build` succeeds
- [ ] Manual: `ralph_hero__debug_stats` returns valid aggregation over test JSONL data

**Creates for next phase**: Complete observability layer (capture + collation + metrics).

---

## Integration Testing
- [ ] Full `npm test` passes in `plugin/ralph-hero/mcp-server/`
- [ ] Full `npm run build` succeeds
- [ ] All 10 issues in "Plan in Review" workflow state
- [ ] No regressions in existing MCP tools (existing tests pass unchanged)
- [ ] `RALPH_DEBUG` unset: no performance regression, no log files created
- [ ] `RALPH_DEBUG=true`: JSONL logs created, `collate_debug` and `debug_stats` tools available

## References
- Architecture Spec: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-22-ralph-workflow-v4-architecture-spec.md
- Debug Mode Spec: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-21-debug-mode-observability-spec.md
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-23-GH-0352-v4-primitive-investigation.md
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-23-GH-0353-communication-discipline.md
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0354-v4-upfront-task-list-ralph-team.md
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-23-GH-0355-roster-first-spawning.md
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0356-v4-agent-definitions-self-claim-task-loop.md
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-23-GH-0357-v4-hero-mode-upfront-task-list.md
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-23-GH-0358-v4-phase-6a-interactive-skills.md
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-23-GH-0359-interactive-skills-6b.md
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0360-v4-observability-debug-logging-hook-capture.md
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-23-GH-0361-v4-phase-7b-collation-stats-mcp-tools.md
