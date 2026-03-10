---
date: 2026-03-01
status: draft
type: plan
github_issues: [488]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/488
primary_issue: 488
---

# Spawn N Builders from Stream Detection - Atomic Implementation Plan

## Overview
1 issue updating `ralph-team/SKILL.md` to spawn multiple builders based on stream count and pre-assign implementation tasks by stream.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-488 | spawn N builders from stream detection with stream-scoped task assignment | S |

## Current State Analysis

`ralph-team/SKILL.md` spawns exactly one builder per session ([line 48](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L48): "Spawn one worker per role needed"). There is no concept of stream-scoped task assignment — workers self-assign by matching role keywords. With multiple independent work streams, a single builder processes them sequentially, losing the parallelism that stream detection enables.

After GH-487, `detect_stream_positions` will return a top-level `suggestedRoster.builder` (1–3) based on independent stream count. After GH-465, stacked branch plumbing exists so builders can create worktrees from predecessor branches. This plan adds the orchestrator logic that connects those pieces: reading the roster, spawning N builders, and routing tasks to the right builder.

**Dependencies**: GH-487 (suggestedRoster in detect_stream_positions response) and GH-465 (stacked branch infrastructure) must be implemented before this issue.

## Desired End State

### Verification
- [x] ralph-team spawns N builders where N = `suggestedRoster.builder` from `detect_stream_positions` (1–3)
- [x] Each builder's spawn prompt includes its assigned stream issue numbers
- [x] Implementation tasks are tagged with `[stream-N]` and pre-assigned to specific builders
- [x] Single-stream sessions (N=1) produce identical behavior to current
- [x] Roster table in SKILL.md documents naming convention and per-station caps
- [x] Post-mortem worker table handles multiple builders dynamically

## What We're NOT Doing
- MCP server TypeScript changes — handled by GH-487
- Stacked branch creation / integrator rebase — handled by GH-465
- Dynamic re-scaling mid-session (builders spawned once at implementation phase)
- More than 3 builders (hard cap)
- Stream detection algorithm changes — using existing `detect_stream_positions` as-is

## Implementation Approach

All changes are to a single file: `plugin/ralph-hero/skills/ralph-team/SKILL.md`. The changes are organized into four logical sections within the SKILL: (1) roster table documentation, (2) stream detection + N-builder spawning at implementation phase, (3) stream-scoped task creation, and (4) post-mortem template update.

---

## Phase 1: GH-488 — Spawn N Builders from Stream Detection
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/488 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0488-spawn-n-builders-stream-detection.md

### Changes Required

#### 1. Add Roster Table to "Create Team and Spawn Workers"
**File**: [`plugin/ralph-hero/skills/ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md)
**Location**: After line 48 ("Spawn one worker per role needed based on the suggested roster from pipeline detection.")

**Changes**: Replace the single-sentence spawning instruction with a roster table and spawning rules:

```markdown
## Create Team and Spawn Workers

Create a team named after the issue. Spawn workers based on the suggested roster from pipeline detection.

### Roster Table

| Station | Agent Type | Names | Cap | Scaling Rule |
|---------|-----------|-------|-----|-------------|
| Analyst | ralph-analyst | `analyst`, `analyst-2`, `analyst-3` | 3 | `suggestedRoster.analyst` (0 after research phase) |
| Builder | ralph-builder | `builder`, `builder-2`, `builder-3` | 3 | `suggestedRoster.builder` (stream count, see below) |
| Integrator | ralph-integrator | `integrator`, `integrator-2` | 2 | `suggestedRoster.integrator` (1 default, 2 if 5+ issues) |

**Initial spawn**: At session start, spawn workers using `suggestedRoster` from the initial `pipeline_dashboard` / `detect_pipeline_position` result. Typically 1 builder is appropriate at this stage — stream count is unknown until research completes.

**Builder scaling at implementation phase**: When creating implementation tasks (after research/plan completes), call `detect_stream_positions` to determine independent stream count. If `suggestedRoster.builder` > current builder count, spawn additional builders at that point. See "Stream Detection Before Implementation Tasks" below.
```

#### 2. Add Stream Detection Step to "Build the Task List"
**File**: [`plugin/ralph-hero/skills/ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md)
**Location**: In the "Build the Task List" section (after line 56), add a new subsection

**Changes**: Add this subsection between the current task creation guidance and the incremental task creation paragraph:

```markdown
### Stream Detection Before Implementation Tasks

When creating implementation tasks for a group with 2+ issues:

1. **Extract "Will Modify" file paths** from each issue's research document:
   - Glob: `thoughts/shared/research/*GH-NNN*` for each issue
   - Parse backtick-wrapped paths under `### Will Modify` heading (regex: `` `[^`]+` ``)

2. **Call `detect_stream_positions`** with file paths and blockedBy relationships:
   ```
   ralph_hero__detect_stream_positions(
     issues: [
       { number: 42, files: ["src/auth.ts"], blockedBy: [] },
       { number: 43, files: ["src/auth.ts", "src/db.ts"], blockedBy: [42] },
       { number: 44, files: ["src/config.ts"], blockedBy: [] }
     ],
     issueStates: [...]
   )
   ```

3. **Read `suggestedRoster.builder`** from the response (1–3, capped at stream count).

4. **Spawn additional builders** if needed:
   - If `suggestedRoster.builder` > 1 and only 1 builder exists: spawn `builder-2` (and `builder-3` if needed)
   - Each new builder's spawn prompt: `"You are builder-N on team {team-name}. Your stream covers issues #A, #B. Only claim tasks tagged [stream-N]. Check TaskList for unblocked implementation tasks matching your stream."`

5. **Create implementation tasks with stream tags**:
   - Task subject: `"Implement GH-NNN: title [stream-N]"`
   - Task owner: assigned to the builder for that stream (`builder` → stream-1, `builder-2` → stream-2, `builder-3` → stream-3)
   - Within a stream: sequential `blockedBy` chain (second task blocked by first)
   - Across streams: no `blockedBy` (parallel execution)
   - Task description must include `base_branch` if stacked branches apply (set by GH-465 plumbing)

6. **Single-stream fallback**: If `totalStreams == 1` or only 1 issue, skip stream tagging. Create implementation tasks as today — the existing single builder handles them sequentially.

7. **Overflow assignment** (4+ streams with 3 builders): Assign stream-4 tasks to the least-loaded builder (fewest assigned tasks). Document the assignment in the task description.
```

#### 3. Update spawn prompt template
**File**: [`plugin/ralph-hero/skills/ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md)
**Location**: Line 50 (current spawn prompt guidance)

**Changes**: Update the spawn prompt paragraph to include stream-scoped instructions:

```markdown
Give each worker a spawn prompt that includes the issue number, title, current pipeline state, and what kinds of tasks they should look for. Analysts handle triage, splitting, research, and planning. Builders handle plan review and implementation. Integrators handle validation, PR creation, and merging. Workers are autonomous — they check TaskList, self-assign unblocked tasks, invoke the appropriate skills, and report results.

**Stream-scoped builder prompts**: When multiple builders are spawned for different streams, each builder's prompt must specify its stream assignment: issue numbers it covers and the `[stream-N]` tag to look for in task subjects. Example: `"You are builder-2. Your stream covers issues #44, #45. Only claim tasks tagged [stream-2]."` This prevents cross-stream task stealing.
```

#### 4. Update Post-Mortem Worker Table
**File**: [`plugin/ralph-hero/skills/ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md)
**Location**: Lines 93-97 (worker summary table in the post-mortem template)

**Changes**: Update the template to handle multiple builders dynamically:

```markdown
## Worker Summary

| Worker | Tasks Completed |
|--------|----------------|
| analyst | [task subjects] |
| builder | [task subjects] |
| builder-2 | [task subjects] |
| integrator | [task subjects] |
```

Add a note: *Include one row per spawned worker. Omit workers that were not spawned (e.g., builder-2 when only 1 builder was used).*

### Success Criteria
- [x] Automated: grep `ralph-team/SKILL.md` for "Roster Table" heading → found
- [x] Automated: grep `ralph-team/SKILL.md` for "Stream Detection Before Implementation Tasks" heading → found
- [x] Automated: grep `ralph-team/SKILL.md` for "`[stream-N]`" pattern → found
- [x] Automated: grep `ralph-team/SKILL.md` for "builder-2" and "builder-3" naming → found
- [x] Manual: SKILL.md "Create Team and Spawn Workers" section has roster table with 3 station rows (analyst, builder, integrator) with caps
- [x] Manual: "Build the Task List" section includes stream detection step with `detect_stream_positions` call pattern, file path extraction, and per-builder task assignment
- [x] Manual: spawn prompt guidance includes stream-scoped builder prompt example
- [x] Manual: post-mortem template handles multiple builders
- [x] Manual: single-stream fallback documented (no stream tags when N=1)

---

## Integration Testing
- [ ] Read through SKILL.md end-to-end and verify no contradictions between roster table, stream detection step, and spawn prompt guidance
- [ ] Verify `[stream-N]` tag pattern doesn't conflict with worker-stop-gate.sh keyword matching (`builder*` matches "Review or Implement" — the `[stream-N]` suffix appears after the keyword)
- [ ] Verify overflow assignment logic (4+ streams) is documented for the 3-builder cap

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0488-spawn-n-builders-stream-detection.md
- Parent: https://github.com/cdubiel08/ralph-hero/issues/464
- Dependency GH-487: https://github.com/cdubiel08/ralph-hero/issues/487 (suggestedRoster in detect_stream_positions)
- Dependency GH-465: https://github.com/cdubiel08/ralph-hero/issues/465 (stacked branch plumbing, base_branch metadata)
- Stream detection reference: [`plugin/ralph-hero/skills/ralph-hero/SKILL.md` Step 2.5](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-hero/SKILL.md)
- Naming convention: [`thoughts/shared/plans/2026-02-24-ralph-team-3-station-simplification.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-24-ralph-team-3-station-simplification.md)
- Worker stop gate: [`plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh:27-29`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh#L27-L29) (builder* glob, no changes needed)
