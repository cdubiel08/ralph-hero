---
date: 2026-02-22
status: draft
github_issues: [328]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/328
primary_issue: 328
---

# Stream-Aware Dispatch in ralph-team SKILL.md - Atomic Implementation Plan

## Overview
Single issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-328 | Update SKILL.md Sections 4.2 & 4.4 with stream-aware dispatch and stream lifecycle | S |

## Current State Analysis

The ralph-team orchestrator SKILL.md currently uses a "bough model" where ALL group members must converge at each pipeline phase gate before ANY can advance. Section 3.2 (added by GH-326, now CLOSED) already detects work streams post-research and stores `STREAMS[]` with `stream_id`, `stream_primary`, `stream_members` fields. However, Sections 4.2 and 4.4 have no awareness of streams — they always operate on the full group.

**Key existing state** (from SKILL.md):

- **Section 3.2** (lines 121–150): Stream detection is present. After ALL research completes for groups with 3+ issues, it calls `detect_work_streams`, stores `STREAMS[]`, and says "partition the group by stream membership and call `detect_pipeline_position` on each partition independently." But Sections 4.2 and 4.4 don't implement this.

- **Section 4.2** (lines 160–211): Task creation templates with group-level metadata only. Subject patterns: `"Plan GH-NNN"`, `"Plan group GH-NNN"`, `"Implement GH-NNN"`, etc. No stream fields in metadata.

- **Section 4.4** (lines 224–235): Dispatch loop with 4 steps. Step 1 (bough advancement) calls `detect_pipeline_position` once for the whole group and waits for ALL members to converge before creating next-bough tasks.

- **Section 4.5** (line 237): Shutdown and Cleanup — will be renumbered to 4.6.

**Backward compatibility**: `STREAMS.length === 0` (groups ≤2 members) preserves existing bough model. Workers already match on keywords ("Plan", "Implement", etc.) which remain present in stream-prefixed subjects like `"Plan stream-42-44 GH-42"`.

## Desired End State
### Verification
- [ ] Section 4.2 includes stream-aware task templates with `stream_id`, `stream_primary`, `stream_members`, `epic_issue` metadata
- [ ] Subject patterns include stream-prefixed variants (`"Plan stream-42-44 GH-42"`)
- [ ] Section 4.4 dispatch step 1 has `if STREAMS[] non-empty` conditional with per-stream convergence loop
- [ ] New Section 4.5 "Stream Lifecycle" documents stream state machine, per-stream advancement, completion rules
- [ ] Current Section 4.5 renumbered to 4.6
- [ ] Groups with ≤2 members use existing bough model (no regression)
- [ ] `STREAMS[]` persistence documented (set once in 3.2, used throughout session)

## What We're NOT Doing
- No MCP server changes — this is SKILL.md only
- No Section 3 changes — already done by GH-326
- No dashboard changes — that's GH-330
- No worker skill changes — worker keyword matching already works
- No new tool implementations

## Implementation Approach

Three changes to one file, all additive with backward-compatible guards:

1. **Section 4.2**: Add stream-aware task template variants as conditional alternatives to existing group templates. Guard: `if STREAMS[] non-empty`.
2. **Section 4.4**: Add per-stream convergence loop as conditional branch in dispatch step 1. Existing bough model becomes the `else` branch.
3. **New Section 4.5**: Stream Lifecycle documentation. Renumber old 4.5 → 4.6.

---

## Phase 1: GH-328 — Stream-Aware Dispatch and Stream Lifecycle
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/328 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0328-stream-aware-dispatch-skill-md.md

### Changes Required

#### 1. Extend Section 4.2 with stream-aware task templates
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Lines**: After the existing COMPLETE template block (line 202) and before the "See shared/conventions.md" line (line 204)

**Changes**: Add a new conditional block after the COMPLETE entry (before line 204). This block activates when `STREAMS[]` is non-empty and provides stream-prefixed alternatives for PLAN, REVIEW, IMPLEMENT, and COMPLETE phases:

```markdown
**Stream-aware variants** (use these when `STREAMS[]` is non-empty):

- **PLAN (stream)**:
  Subject: `"Plan stream-{stream_id} GH-{stream_primary}"`
  Description: Include issue URLs for all stream members, research doc paths (carried forward from completed research tasks), stream membership.
  Metadata: `{ "issue_number": "{stream_primary}", "issue_url": "[url]", "command": "plan", "phase": "plan", "stream_id": "{stream_id}", "stream_primary": "{stream_primary}", "stream_members": "{comma-separated}", "epic_issue": "{parent_number}", "artifact_path": "[research doc paths]" }`

- **REVIEW (stream)** (only if `RALPH_REVIEW_MODE=interactive`):
  Subject: `"Review plan for stream-{stream_id} GH-{stream_primary}"`
  Metadata: adds `stream_id`, `stream_primary`, `stream_members`, `epic_issue`

- **IMPLEMENT (stream)**:
  Subject: `"Implement stream-{stream_id} GH-{stream_primary}"`
  Metadata: `{ "issue_number": "{stream_primary}", "issue_url": "[url]", "command": "impl", "phase": "implement", "stream_id": "{stream_id}", "stream_primary": "{stream_primary}", "stream_members": "{comma-separated}", "epic_issue": "{parent_number}", "artifact_path": "[plan doc path]", "worktree": "worktrees/GH-{epic_issue}-stream-{sorted-issues}/" }`

- **COMPLETE (stream)**:
  Subject: `"Create PR for stream-{stream_id} GH-{stream_primary}"` + `"Merge PR for stream-{stream_id} GH-{stream_primary}"`
  Metadata: adds `stream_id`, `stream_primary`, `stream_members`, `epic_issue`
```

Also update the **Subject patterns** line (line 207) to add stream variants:
```markdown
- Stream variants: `"Plan stream-X GH-NNN"` / `"Implement stream-X GH-NNN"` / `"Create PR for stream-X GH-NNN"` / `"Merge PR for stream-X GH-NNN"`
```

**Note**: Research tasks remain per-issue (no stream variants) since streams aren't detected until after research completes.

#### 2. Add stream-aware dispatch to Section 4.4
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Lines**: Replace dispatch step 1 content (line 230) with a conditional structure

**Changes**: Replace the current step 1 text with a conditional that checks `STREAMS[]`:

```markdown
1. **Bough advancement** (primary):
   **If `STREAMS[]` non-empty (stream-aware dispatch)**:
   For each stream in `STREAMS[]`:
   - Call `detect_pipeline_position(number=stream.stream_primary)` to get the pipeline position
   - Filter returned `issues[]` to only those in `stream.stream_members` — `detect_pipeline_position` traverses the full group, but stream convergence considers only stream members
   - Check `convergence.met` for the filtered subset: all stream members must be at the gate state
   - If stream-level convergence met: create next-phase tasks for THIS STREAM ONLY using stream-aware templates (Section 4.2) and assign to idle workers
   - Streams advance independently — one stream finishing plan does not wait for another stream

   **Carry forward artifact paths (per stream)**: When creating next-phase stream tasks, read `artifact_path` from completed task metadata via `TaskGet` — workers set this in their result metadata. Include all stream-member artifact paths in the new task description.

   **Else (bough model, `STREAMS[]` empty or group ≤2)**:
   When a phase's tasks complete, call `detect_pipeline_position` to check convergence. If `convergence.met === true` and the phase advances: create next-bough tasks per Section 4.2 and assign to idle workers. For groups: wait for ALL group members to converge before creating next-bough tasks.
   **Carry forward artifact paths**: When creating next-bough tasks, read `artifact_path` from completed task metadata via `TaskGet` — workers set this in their result metadata. Include it in the new task descriptions.
```

Steps 2–4 remain unchanged.

#### 3. Add new Section 4.5 "Stream Lifecycle" and renumber
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Lines**: Insert between current line 235 (end of Section 4.4) and line 237 (current Section 4.5 header)

**Changes**:

Insert new section:
```markdown
### 4.5 Stream Lifecycle

Streams partition a group into independently-advancing subsets. This section documents the stream state machine.

**Creation**: Streams are detected once in Section 3.2 (after ALL research completes, groups with 3+ issues). `STREAMS[]` is immutable for the session — streams are never re-detected or modified.

**Per-stream phase progression**:
```
RESEARCH_COMPLETE → PLAN → REVIEW (if interactive) → IMPLEMENT → PR → MERGED
```

Each stream advances through these phases independently:
- Stream-1 can be in IMPLEMENT while Stream-2 is still in PLAN
- Each stream creates its own tasks and worktree (named `GH-{epic}-stream-{sorted-issues}`)
- Stream convergence = all issues in THAT stream at the gate state (not all group issues)

**Stream completion**: A stream is complete when its `"Merge PR"` task completes.

**Epic completion**: The epic (parent issue) is complete when ALL streams are complete (all Merge PR tasks done).

**Crash recovery**: If the session restarts, re-run Section 3.2 stream detection. `detect_work_streams` is deterministic — the same inputs always produce the same `STREAMS[]`, so stream IDs and memberships are stable.

**STREAMS[] persistence**: `STREAMS[]` is set once in Section 3.2 and referenced throughout dispatch (Section 4.4). It is a session-level variable — not persisted to GitHub. On crash, re-derive from research docs (idempotent).
```

Renumber current `### 4.5 Shutdown and Cleanup` to `### 4.6 Shutdown and Cleanup`.

### File Ownership Summary

| File | Change Type |
|------|------------|
| `plugin/ralph-hero/skills/ralph-team/SKILL.md` | MODIFY — Sections 4.2, 4.4, new 4.5, renumber 4.5→4.6 |

### Success Criteria
- [ ] Automated: N/A (SKILL.md is a markdown document, no build/test)
- [ ] Manual: Section 4.2 includes stream-aware task templates with `stream_id`, `stream_primary`, `stream_members`, `epic_issue` metadata
- [ ] Manual: Subject patterns include `"Plan stream-X GH-NNN"` format and existing keywords ("Plan", "Implement") remain present for worker matching
- [ ] Manual: Section 4.4 step 1 has `if STREAMS[] non-empty` conditional with per-stream convergence loop
- [ ] Manual: `detect_pipeline_position` response filtering documented — filter `issues[]` to stream members before checking convergence
- [ ] Manual: Section 4.5 "Stream Lifecycle" documents creation, per-stream advancement, stream/epic completion, crash recovery
- [ ] Manual: Old Section 4.5 renumbered to 4.6
- [ ] Manual: Groups with ≤2 members fall through to existing bough model (no regression)
- [ ] Manual: `STREAMS[]` persistence and crash recovery documented

---

## Integration Testing
- [ ] Read through Sections 3.2 → 4.2 → 4.4 → 4.5 end-to-end: stream detection → task creation → dispatch → lifecycle forms a coherent narrative
- [ ] Verify bough model path is unchanged when `STREAMS[]` is empty
- [ ] Verify stream-prefixed subjects still contain worker-matching keywords
- [ ] Cross-reference with `shared/conventions.md` stream metadata fields

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-GH-0328-stream-aware-dispatch-skill-md.md
- Parent plan (Phase 4): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-21-work-stream-parallelization.md
- Stream conventions: `plugin/ralph-hero/skills/shared/conventions.md` (Work Streams section)
- Prerequisite (done): https://github.com/cdubiel08/ralph-hero/issues/326 (Section 3.2 stream detection)
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/325
- Sibling (not ready): https://github.com/cdubiel08/ralph-hero/issues/330 (dashboard per-stream status)
