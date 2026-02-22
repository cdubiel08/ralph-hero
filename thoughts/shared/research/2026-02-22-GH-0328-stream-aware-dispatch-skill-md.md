---
date: 2026-02-22
github_issue: 328
github_url: https://github.com/cdubiel08/ralph-hero/issues/328
status: complete
type: research
---

# GH-328: Update SKILL.md Sections 4.2 & 4.4 with Stream-Aware Dispatch and Stream Lifecycle

## Problem Statement

The ralph-team orchestrator currently uses a "bough model" (Section 4.2/4.4) where all group members must converge at each pipeline phase gate before the next phase begins. Phase 4 of the work-stream parallelization epic (GH-325) replaces this with a "stream model" where each detected work stream advances independently through plan → implement → PR. This ticket changes only the orchestrator SKILL.md — no MCP server changes.

**Prerequisite**: GH-326 (sibling) adds Section 3.2 to SKILL.md, which runs `detect_work_streams` post-research and stores `STREAMS[]`. GH-326 is already CLOSED, so Section 3.2 is already present in the file.

## Current State Analysis

### SKILL.md Structure (key sections)

**Section 3.2** (lines 121–151) — **Already present** (added by GH-326):
- Runs after ALL research tasks complete AND group ≥ 3 issues
- Calls `detect_work_streams(issues=[{ number, files, blockedBy }])`
- Stores `STREAMS[]` with `stream_id`, `stream_primary`, `stream_members`
- Groups ≤ 2 members: skip stream detection, preserve bough model

**Section 4.2** (lines 162–212) — Current bough model task creation:
- Creates tasks for current phase only (no downstream)
- Task metadata: `{ issue_number, issue_url, command, phase, estimate, group_primary, group_members, artifact_path, worktree }`
- Subject patterns: `"Research GH-NNN"`, `"Plan GH-NNN"`, `"Plan group GH-NNN"`, `"Implement GH-NNN"`, etc.
- No stream awareness — all tasks use group-level metadata

**Section 4.4** (lines 224–235) — Current dispatch loop:
1. **Bough advancement**: call `detect_pipeline_position` → check `convergence.met === true` for entire group → create next-bough tasks
2. **Exception handling**: review verdict = NEEDS_ITERATION → create revision
3. **Worker gaps**: spawn missing workers
4. **Intake**: pull new issues from GitHub when idle

**Key limitation**: `detect_pipeline_position` returns ONE phase for the whole group. If stream-1 is at PLAN but stream-2 is still at RESEARCH, the bough model blocks stream-1 from advancing.

### Metadata Fields Today

Base (all phases): `issue_number`, `issue_url`, `command`, `phase`, `estimate`
PLAN adds: `artifact_path`, `group_primary`, `group_members`
IMPLEMENT adds: `artifact_path`, `worktree`
COMPLETE adds: `worktree`

### Subject Pattern Matching

Workers self-claim by matching subjects. The current keyword anchors are:
`"Research"`, `"Plan"`, `"Review plan"`, `"Implement"`, `"Create PR"`, `"Merge PR"`

Stream-prefixed subjects like `"Plan stream-42-44 GH-42"` still contain these keywords, so existing worker matching continues to work with no changes to worker skills.

## Key Discoveries

### 1. STREAMS[] Is the Gating Condition

The stream model only activates when `STREAMS[]` is non-empty (set by Section 3.2). The lead checks this stored variable:
- `STREAMS.length === 0` or group size ≤ 2 → use existing bough model (no change)
- `STREAMS.length > 0` → use stream-aware dispatch

This makes the change backward-compatible at the SKILL.md level: all single-issue and 2-issue groups hit the `STREAMS.length === 0` path.

### 2. Per-Stream Convergence Is a Scope Reduction

Instead of calling `detect_pipeline_position(number=GROUP_PRIMARY)` once for the whole group, the lead calls it once per stream with any member of the stream as seed. Because `detect_pipeline_position` uses `detectGroup()` transitive closure, passing a stream member returns that stream's convergence status.

**Critical**: After stream detection, the lead must work with stream-member-filtered subsets. `detect_pipeline_position` still traverses the full group — the lead must filter returned `issues[]` to only stream members when assessing per-stream convergence.

**Alternative approach** (recommended): Pass the stream primary issue number and filter `issues` in the response to only those in `stream.members`. This avoids needing a new MCP tool for per-stream detection.

### 3. Task Creation Per Stream vs. Per Group

Current PLAN task: one per group (`"Plan group GH-NNN"`)
Stream model PLAN tasks: one per stream (`"Plan stream-42-44 GH-42"`)

For a group of 4 issues split into 2 streams, the lead creates 2 Plan tasks (one per stream) instead of 1 group Plan task. Each Plan task's metadata carries the stream membership.

**Subject pattern update** (from plan doc, line 353):
```
"Plan stream-{stream_id} GH-{stream_primary}"
"Implement stream-{stream_id} GH-{stream_primary}"
"Create PR for stream-{stream_id} GH-{stream_primary}"
"Merge PR for stream-{stream_id} GH-{stream_primary}"
```

### 4. Research Phase Unchanged

Research remains per-issue (not per-stream). Streams don't exist yet at research time — they're detected after ALL research completes. The bough model's research phase is preserved unchanged.

### 5. Stream Lifecycle State Machine

Each stream progresses through: `RESEARCH_COMPLETE → PLAN → REVIEW? → IMPLEMENT → PR → MERGED`

Streams advance independently:
- Stream-1 can be in IMPLEMENT while Stream-2 is still in PLAN
- Each stream creates its own tasks and worktree
- A stream is "complete" when its Merge PR task completes
- The epic (parent) is complete when ALL streams complete

### 6. Worktree Naming for Streams

From plan doc (Phase 3, stream worktree section):
```
GH-{epic}-stream-{sorted-issue-numbers}
e.g., GH-40-stream-42-44
```

For single-issue streams: `GH-{epic}-stream-{number}` or just `GH-{number}` (existing convention).

### 7. artifact_path Carry-Forward Per Stream

The existing carry-forward mechanism (TaskGet on completed task → read artifact_path → include in next task description) works per-stream. When Plan task for stream-42-44 completes, lead reads its `artifact_path` and passes it to the Implement task for stream-42-44.

### 8. REVIEW Phase with Streams

If `RALPH_REVIEW_MODE=interactive`, each stream gets its own review task. Stream convergence for REVIEW requires only that stream's plan to be approved.

### 9. Dispatch Loop Refactor

Current Section 4.4 dispatch step 1:
```
call detect_pipeline_position → if convergence.met → create next-bough tasks
```

Stream-aware Section 4.4 dispatch step 1:
```
if STREAMS[] non-empty:
  for each stream in STREAMS[]:
    call detect_pipeline_position(seed=stream.stream_primary)
    filter issues to stream members
    if stream-level convergence met:
      create next-phase tasks for THIS STREAM ONLY
else:
  [existing bough model logic unchanged]
```

### 10. Stream Lifecycle Section Placement

The new "Stream Lifecycle" section should be added between Sections 4.4 and 4.5 (before shutdown). It documents:
- When streams are created (after Section 3.2 runs)
- Per-stream phase advancement rules
- Stream completion definition
- Epic completion (all streams merged)

## Potential Approaches

### Option A: Inline Stream Logic in Section 4.4 (Recommended)

Add stream-aware dispatch as a conditional branch within the existing Section 4.4 dispatch step 1. The condition `if STREAMS[] non-empty` gates the new path; existing logic is the `else` branch. Keeps related logic co-located.

**Pros**: Single location for dispatch logic; minimal diff from current; easy to reason about regression path.
**Cons**: Section 4.4 grows longer.

### Option B: Separate Stream Dispatch Sub-Section

Create Section 4.4a "Stream-Aware Dispatch" and 4.4b "Bough Dispatch (Legacy)". Section 4.4 becomes a router.

**Pros**: Cleaner separation.
**Cons**: Splitting one logical section; harder to see the full dispatch flow.

**Recommendation**: Option A. The conditional guard is simple and the stream logic is a natural extension of the existing dispatch step.

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `detect_pipeline_position` returns issues from other streams | Medium | Filter returned `issues[]` to `stream.members` before checking convergence |
| Stream detection runs but `STREAMS[]` lost between dispatch iterations | Low | STREAMS[] must be stored in a persistent variable or re-computed from task metadata |
| Workers don't recognize stream-prefixed subjects | Low | Keywords ("Plan", "Implement") remain unchanged — worker matching works |
| Stream divergence (one stream stalls) | Medium | Per-stream convergence means other streams continue; stalled stream gets escalated independently |
| Regression on 2-issue groups | Low | `STREAMS.length === 0` guard is unconditional for ≤2 member groups |

## Recommended Next Steps

1. **Section 4.2** changes (task templates):
   - Add stream metadata block to PLAN, REVIEW, IMPLEMENT, COMPLETE templates:
     `stream_id`, `stream_primary`, `stream_members`, `epic_issue`
   - Add stream-prefixed subject variants for these phases
   - Add conditional: "If `STREAMS[]` non-empty, use stream subjects and metadata; else use group subjects (existing)"

2. **Section 4.4** changes (dispatch loop):
   - Step 1 (bough advancement): wrap in `if STREAMS[] non-empty` conditional
   - Stream path: loop over `STREAMS[]`, call `detect_pipeline_position` per stream, filter issues to stream members, create next-phase tasks per stream
   - Bough path: existing logic unchanged (else branch)

3. **New "Stream Lifecycle" section** (after 4.4, before 4.5):
   - Document stream state machine diagram
   - Per-stream phase rules
   - Stream completion = Merge PR task done for that stream
   - Epic completion = all streams complete

4. **STREAMS[] persistence**: Document that `STREAMS[]` is set once in Section 3.2 and used throughout the session. On crash recovery, re-run Section 3.2 (it is idempotent — `detect_work_streams` is deterministic).

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/ralph-team/SKILL.md` — Sections 4.2, 4.4, and new Stream Lifecycle section (~80–120 line change)

### Will Read
- `plugin/ralph-hero/skills/shared/conventions.md` — metadata field reference for stream fields
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` — `detect_pipeline_position` return shape
- `thoughts/shared/plans/2026-02-21-work-stream-parallelization.md` — authoritative design spec (Phase 4)
- `thoughts/shared/plans/2026-02-22-GH-0324-stream-scoped-plan-impl-skills.md` — stream metadata field definitions
