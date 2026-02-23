---
date: 2026-02-23
github_issue: 352
github_url: https://github.com/cdubiel08/ralph-hero/issues/352
status: complete
type: research
---

# V4 Phase 0: Investigation & Primitive Behavior Validation

## Problem Statement

Before committing to the V4 architecture changes (Phases 1–7), five assumptions about Claude Code primitive behavior need validation. This document records findings for each investigation area (0a–0e) based on prior research docs and direct codebase analysis. Any failed assumptions are flagged for spec revision.

## Investigation Areas

---

### 0a. TaskList Visibility in Team Context

**Question**: When the lead creates tasks in a team scope, can teammates see them via `TaskList`?

**Finding**: CONFIRMED — with critical ordering constraint.

**Mechanism** (from `GH-0231-skill-subagent-team-context-pollution.md`):
- Team context propagates via `team_name` parameter in `Task()` spawn calls
- Workers spawned with `team_name` read from `~/.claude/tasks/{team-name}/` directory
- Tasks created by the lead with `TeamCreate` active go to that same directory

**Critical constraint** (spec Section 3.1, GH-322 root cause):
- Tasks created **before** `TeamCreate` go into the session default scope (`~/.claude/tasks/default/` or similar)
- Workers spawned with `team_name` cannot see those tasks
- **Fix already known**: `TeamCreate` must execute before any `TaskCreate` calls — strict ordering required

**`blockedBy` advisory vs enforced**:
- The task system does NOT prevent a worker from claiming a blocked task
- `blockedBy` is **advisory** — visible in `TaskGet` output but not enforced
- Workers must actively check `blockedBy` and skip blocked tasks; the system won't stop them
- `worker-stop-gate.sh` does NOT check `blockedBy` — it only emits guidance to check TaskList

**Spec assumption validated**: ✅ TaskList works when team_name and TeamCreate ordering are correct
**Spec assumption corrected**: ⚠️ `blockedBy` is advisory, not enforced — worker Stop hook needs explicit `blockedBy` checking logic (currently absent from `worker-stop-gate.sh`)

---

### 0b. Self-Claim Atomicity

**Question**: If two workers both attempt `TaskUpdate(owner="me")` simultaneously, what happens?

**Finding**: LAST-WRITE-WINS — no atomic claim. Race window is real but manageable.

**Mechanism** (from `GH-0200-task-self-assignment-race-condition.md`):
```
Worker A: TaskList() -> sees T-5 pending, owner=""
Worker B: TaskList() -> sees T-5 pending, owner=""
Worker A: TaskUpdate(T-5, owner="analyst")    ← succeeds
Worker B: TaskUpdate(T-5, owner="analyst-2")  ← last write wins, silently overwrites
```
- `TaskList` read and `TaskUpdate` write are separate operations with no transaction boundary
- File-lock serialization makes individual writes consistent but doesn't prevent the read-modify-write race
- Neither worker gets an error — the loser simply has their write overwritten

**Claim-then-verify mitigation**:
- Worker calls `TaskUpdate(owner="me")` then immediately `TaskGet` to verify owner field
- If `owner != "me"`, the worker lost the race and skips to next unclaimed task
- This is effective because the verification is cheap and the race window is short

**Pre-assign-then-spawn eliminates race for first task**:
- Lead calls `TaskUpdate(taskId, owner="analyst")` BEFORE spawning the worker
- Worker spawns already owning the task — no claim race needed
- Subsequent tasks (self-claim via Stop hook) still use claim-then-verify

**At typical team sizes** (1 worker per role): same-role races are extremely uncommon (workers complete sequentially). At 2+ same-role workers, claim-then-verify is essential.

**Spec assumption validated**: ✅ Pre-assign-before-spawn eliminates first-task race
**Spec assumption refined**: ⚠️ Claim-then-verify is mandatory for Stop hook self-claim, not optional

---

### 0c. Spawn-Before-Tasks Viability

**Question**: If workers are spawned before tasks exist, do their Stop hooks fire when tasks appear? Do idle workers notice pre-assigned tasks?

**Finding**: SPAWN-BEFORE-TASKS REQUIRES EXPLICIT WAKE — idle workers do not self-detect task creation.

**Current `worker-stop-gate.sh` behavior** (`hooks/scripts/worker-stop-gate.sh`):

```bash
# Re-entry guard (lines 20-23)
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then exit 0; fi

# Role-based keyword mapping (lines 26-33)
case "$TEAMMATE_NAME" in
  analyst*)    KEYWORDS="Triage, Split, or Research" ;;
  builder*)    KEYWORDS="Plan or Implement" ;;
  validator*)  KEYWORDS="Review or Validate" ;;
  integrator*) KEYWORDS="Create PR, Merge, or Integrate" ;;
  *)           exit 0 ;;
done

# Always block with guidance (lines 35-40)
cat >&2 <<EOF
Before stopping, check TaskList for pending tasks matching your role ($KEYWORDS).
If matching tasks exist, try claiming and processing them.
If none are available, you may stop.
EOF
exit 2
```

**Spawn-before-tasks execution path**:
1. Worker spawned, gets prompt, first turn ends
2. Stop hook fires → blocks (exit 2) → guidance emitted
3. Worker checks TaskList → **empty** (tasks not yet created)
4. Worker tries to stop again
5. Stop hook fires again → **re-entry guard fires** (`stop_hook_active=true`) → exit 0
6. Worker goes **IDLE**

**Critical implication**: Idle workers have no mechanism to detect that tasks were subsequently created. The Stop hook only fires on stop attempts, not on task creation events. There are no TaskList change hooks in the Claude Code primitive set (confirmed in spec Section 1.5).

**Consequence for startup sequence**: After creating tasks and pre-assigning, the lead **MUST** call `SendMessage` to wake idle workers — this is the only channel for waking an idle agent.

**Recommended startup sequence** (validated against primitive behavior):
```
1. TeamCreate              ← task namespace first
2. detect_pipeline_position ← determine phase and suggestedRoster
3. Spawn full roster        ← workers go idle (stop hook fires, TaskList empty, re-entry exits)
4. Create ALL pipeline tasks with blockedBy chains
5. Pre-assign first unblocked tasks: TaskUpdate(owner="analyst"), etc.
6. SendMessage wake         ← REQUIRED: one message per idle worker to notify of assignment
```

The `SendMessage` at step 6 is NOT a nudge violation — it is the only way to wake an idle worker after task assignment. The Communication Discipline rule (Phase 1) should explicitly carve out this exception.

**Spec assumption corrected**: ❌ "Workers go idle until tasks are created and self-claim" — idle workers cannot self-detect task creation. Lead must SendMessage to wake after pre-assignment.
**Spec section to revise**: Section 5.3 startup sequence step 5 should add explicit SendMessage wake after pre-assignment.

---

### 0d. Worker Template Effectiveness

**Question**: Does the current minimal spawn template work for the roster-first model? Does the agent definition + template + TaskGet composition work?

**Finding**: CURRENT TEMPLATE REQUIRES TASK-SPECIFIC DATA AT SPAWN TIME — incompatible with roster-first model as-is.

**Current `worker.md` template** (`templates/spawn/worker.md`):
```
{TASK_VERB} GH-{ISSUE_NUMBER}: {TITLE}.
{TASK_CONTEXT}

Invoke: {SKILL_INVOCATION}

Report via TaskUpdate: "{REPORT_FORMAT}"
```

**Problem for roster-first model**:
- Placeholders `{ISSUE_NUMBER}`, `{TITLE}`, `{SKILL_INVOCATION}` require task-specific data
- In roster-first model, workers are spawned **before** tasks are created — this data doesn't exist yet
- The template as written cannot be filled for pre-task spawning

**Agent definition task loops are correct** (from `ralph-analyst.md` and `ralph-builder.md`):
```
1. Read task via TaskGet
2. Invoke your skill
3. Report results via TaskUpdate with structured metadata
4. Check TaskList for more matching tasks before stopping
```
The loops handle self-discovery correctly. The issue is only the spawn-time template.

**Two viable solutions**:

**Option A — Interleaved startup** (pre-assign before spawn):
- Lead creates first batch of tasks and pre-assigns before spawning workers
- Template is filled with real task data at spawn time
- Workers spawn with their assignment already waiting in TaskList
- After `TaskGet`, worker has full context including `{ISSUE_NUMBER}` etc.
- **Drawback**: Lead must interleave create/assign/spawn rather than spawn-all-then-create-all

**Option B — Generic first-turn template** (roster-first):
- Replace template content with: `Check TaskList for your first assignment and begin.`
- Worker spawns, checks TaskList (may be empty), goes idle
- Lead creates tasks, pre-assigns, SendMessage wake
- Worker wakes, checks TaskList, finds owned task, calls `TaskGet` for full context
- **Drawback**: Requires SendMessage wake (already established as necessary in 0c)

**Recommendation**: **Option A (interleaved)** is simpler and avoids the wake step. Spawn sequence:
```
For each role in suggestedRoster:
  1. Create role's first task(s)
  2. TaskUpdate(owner="role-name")    ← pre-assign
  3. Task(subagent_type="ralph-role", team_name=..., prompt=filled_template)  ← spawn
```
This keeps the existing template, eliminates the SendMessage wake, and is fully compatible with the current `worker-stop-gate.sh` logic.

**Spec assumption corrected**: ⚠️ Roster-first with generic template requires SendMessage wake (Option B). Interleaved create-assign-spawn (Option A) is simpler and avoids the extra round-trip.
**Spec section to revise**: Section 5.3 startup sequence — recommend interleaved model (Option A) unless parallel spawning performance is critical.

---

### 0e. suggestedRoster Heuristic Feasibility

**Question**: Is `detect_pipeline_position` response shape suitable for adding `suggestedRoster`? Are the inputs sufficient?

**Finding**: FEASIBLE — all required inputs are available. Response shape is clean to extend.

**Current `PipelinePosition` interface** (`mcp-server/src/lib/pipeline-detection.ts:42-50`):
```typescript
export interface PipelinePosition {
  phase: PipelinePhase;
  reason: string;
  remainingPhases: string[];
  issues: IssueState[];          // includes: number, title, workflowState, estimate, subIssueCount
  convergence: ConvergenceInfo;  // includes: required, met, blocking[], recommendation
  isGroup: boolean;
  groupPrimary: number | null;
}
```
`suggestedRoster` does NOT exist — this is a net-new addition.

**`IssueState` fields available** (`pipeline-detection.ts:27-33`):
```typescript
export interface IssueState {
  number: number;
  title: string;
  workflowState: string;
  estimate: string | null;    ← key input for builder scaling
  subIssueCount: number;
}
```

**Heuristic inputs available vs required**:

| Heuristic Input | Available? | Source |
|----------------|-----------|--------|
| `issues.length` | ✅ | `issues[]` array length |
| `isGroup` | ✅ | top-level field |
| per-issue `estimate` | ✅ | `IssueState.estimate` |
| `totalStreams` | ❌ | requires separate `detect_work_streams` call |
| phase / remaining work | ✅ | `phase`, `remainingPhases` |

**Proposed `suggestedRoster` implementation**:

```typescript
interface SuggestedRoster {
  analyst: number;    // 1 + floor(issues.length / 3), max 3
  builder: number;    // 1 (streams data unavailable without extra call), max 2
  validator: number;  // always 1
  integrator: number; // always 1
}
```

**Analyst scaling formula**:
- 1 issue or no group: analyst = 1
- 2-5 issues in group: analyst = 2
- 6+ issues in group: analyst = 3

**Builder scaling** (without `detect_work_streams`):
- Default: builder = 1
- If group has 5+ issues with M/L estimates: builder = 2
- `detect_work_streams` can be called separately post-research for finer-grained builder scaling

**Edge cases**:
- All issues already researched (phase = PLAN or later): analyst = 0, builder ≥ 1
- Single XS issue: all roles = 1 (minimum viable team)
- No estimate set on issues: fall back to `issues.length`-based formula

**Implementation location**: `mcp-server/src/lib/pipeline-detection.ts` — add `suggestedRoster` to `PipelinePosition` interface and compute in `buildResult()` function (currently lines 365-392).

**Spec assumption validated**: ✅ Feasible with available inputs
**Spec refinement**: Builder scaling defaults to 1 without a `detect_work_streams` call; optional enhancement post-research is recommended rather than making it part of `detect_pipeline_position`

---

## Summary of Findings

| Area | Assumption | Status | Action Required |
|------|-----------|--------|----------------|
| 0a TaskList Visibility | Works when team_name and TeamCreate ordering correct | ✅ Confirmed | None for core; add `blockedBy` check to `worker-stop-gate.sh` |
| 0a `blockedBy` enforcement | `blockedBy` prevents workers from claiming blocked tasks | ❌ Wrong | `worker-stop-gate.sh` must check blockedBy explicitly |
| 0b Self-Claim Atomicity | `TaskUpdate(owner)` is atomic | ❌ Wrong | Claim-then-verify is mandatory; pre-assign eliminates first-task race |
| 0c Spawn-Before-Tasks | Idle workers detect task creation | ❌ Wrong | Lead must SendMessage wake after pre-assignment |
| 0d Worker Template | Generic template works for roster-first model | ⚠️ Partial | Use interleaved create-assign-spawn (Option A) or generic template + SendMessage wake (Option B) |
| 0e suggestedRoster | Inputs sufficient in detect_pipeline_position | ✅ Confirmed | Builder defaults to 1; streams-based scaling is optional enhancement |

## Key Spec Revisions Required

1. **Section 5.3 Startup Sequence**: Change to interleaved create-assign-spawn OR add explicit SendMessage wake step after pre-assignment
2. **Section 5.6 Communication Rules**: Explicitly carve out "SendMessage to wake idle worker after pre-assignment" as a NON-violation of communication discipline
3. **Phase 2 scope**: Add `worker-stop-gate.sh` enhancement to check `blockedBy` field and skip blocked tasks (currently the hook only emits guidance, does no checking)
4. **Phase 3 scope**: Builder `suggestedRoster` defaults to 1; add note that streams-based scaling requires separate `detect_work_streams` call

## Recommended Next Steps

1. Proceed with **Phase 1 (Communication Discipline)** — no spec changes needed, findings validate the phase
2. Proceed with **Phase 2 (Upfront Task List)** — add `worker-stop-gate.sh` `blockedBy` checking to phase scope
3. Revise **Phase 3 startup sequence** in spec before implementation — clarify interleaved vs roster-first startup
4. **Phase 3 MCP change** is straightforward: add `suggestedRoster` to `PipelinePosition` interface, implement heuristic in `buildResult()`

## Files Affected

### Will Modify
- None — this is a research-only phase

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts` — PipelinePosition interface, buildResult function
- `plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh` — Stop hook logic
- `plugin/ralph-hero/templates/spawn/worker.md` — Spawn template placeholders
- `plugin/ralph-hero/agents/ralph-analyst.md` — Task loop definition
- `plugin/ralph-hero/agents/ralph-builder.md` — Task loop definition
- `thoughts/shared/research/2026-02-20-GH-0231-skill-subagent-team-context-pollution.md` — Team context research
- `thoughts/shared/research/2026-02-20-GH-0200-task-self-assignment-race-condition.md` — Self-claim race research
- `thoughts/shared/research/2026-02-19-GH-0135-spawn-templates-self-contained-general-purpose.md` — Template research
- `thoughts/shared/plans/2026-02-22-ralph-workflow-v4-architecture-spec.md` — V4 spec (primary reference)
