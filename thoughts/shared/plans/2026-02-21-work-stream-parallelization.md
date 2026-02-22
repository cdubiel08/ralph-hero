---
date: 2026-02-21
status: draft
github_issue: 321
github_url: https://github.com/cdubiel08/ralph-hero/issues/321
---

# Work Stream Parallelization - Implementation Plan

## Overview

Replace the phase-gated convergence model in `ralph-team` (where ALL sibling issues must finish each phase before ANY can advance to the next) with a **work-stream model** where issues are clustered by file overlap and each stream flows independently through research -> plan -> implement -> PR.

## Problem

The current system has two convergence bottlenecks:

1. **`pipeline-detection.ts`** returns ONE phase for the entire group. If any issue is in "Research Needed", the whole group returns `RESEARCH`, blocking ready-to-plan issues from advancing.

2. **`ralph-team/SKILL.md`** uses a "bough model" (Section 4.2) that creates tasks ONLY for the current global phase. Next-phase tasks aren't created until ALL group members converge.

Result: 5 issues under an epic where GH-42 and GH-44 touch the same files but GH-43 is completely independent — GH-43 must wait for GH-42 and GH-44 to finish research before it can start planning, even though it has zero code overlap.

## Desired End State

```
Epic GH-40 (5 children)
  |
  +-- Stream A: GH-42, GH-44 (share auth middleware files)
  |     research -> plan -> implement -> PR-A
  |
  +-- Stream B: GH-43 (standalone, touches only dashboard)
  |     research -> plan -> implement -> PR-B
  |
  +-- Stream C: GH-45, GH-46 (share database migration files)
        research -> plan -> implement -> PR-C

Streams A, B, C all run in parallel. Each gets its own plan and PR.
```

### Verification
- [ ] Given an epic with 4+ children, research docs include a `## Files Affected` section with `### Will Modify` file paths
- [ ] After research, `detect_work_streams` clusters issues by file overlap and `blockedBy` relationships into streams
- [ ] Independent streams advance through plan/implement/PR without waiting for other streams
- [ ] Each stream produces exactly 1 PR
- [ ] The `ralph-team` orchestrator creates per-stream task batches with `stream_id` in task metadata
- [ ] Existing single-issue and small-group (2 issue) workflows are unaffected

## What We're NOT Doing

- Changing how research works per-issue (each issue still gets individual research)
- Auto-merging PRs (still human-gated)
- Cross-stream dependency resolution (blockedBy relationships cause co-clustering, so streams are independent by construction)
- Changing the Linear/GitHub state machine states themselves
- Modifying hooks or state gate enforcement
- Changing the spawn template protocol (stream context goes in task descriptions per existing conventions)

## Current State Analysis

### Key Discoveries

1. **`group-detection.ts`** (`mcp-server/src/lib/group-detection.ts`) already does transitive closure across sub-issues + dependencies and topological sort. It produces one flat `GroupIssue[]` array. It does NOT sub-divide by code overlap — that concept doesn't exist yet.

2. **`pipeline-detection.ts`** (`mcp-server/src/lib/pipeline-detection.ts`) takes all issues and returns a single `PipelinePhase`. The first-match-wins logic means ANY issue in an early state drags the whole group back.

3. **Research docs** (`skills/ralph-research/SKILL.md`) currently include "key discoveries with file:line references" but no standardized, machine-parseable section listing affected files.

4. **Plan skill** (`skills/ralph-plan/SKILL.md`) already supports group plans with per-issue phases. The change is that "group" will now mean "work stream" rather than "entire epic".

5. **Convergence gate** (`hooks/scripts/convergence-gate.sh`) warns on planning transitions without convergence verification. This works as-is since convergence will be checked per-stream.

6. **Task metadata protocol** (new since initial plan): Tasks now carry structured metadata (`issue_number`, `issue_url`, `command`, `phase`, `estimate`, `artifact_path`, `group_primary`, `group_members`, `worktree`). Stream metadata fields will extend this pattern naturally.

7. **Task metadata as results channel** (new since initial plan): Workers report structured results via TaskUpdate metadata (e.g., `artifact_path`, `result`, `sub_tickets`). The lead reads result metadata from completed tasks via TaskGet. Task descriptions carry human-readable summaries. Stream context follows the same pattern — it goes in descriptions and metadata, NOT in spawn prompts. See `shared/conventions.md` "TaskUpdate Protocol".

8. **Carry forward artifact paths** (new since initial plan): Section 4.4 of ralph-team now explicitly says "extract artifact paths from completed tasks via TaskGet and include them in the new task descriptions." Stream-aware dispatch will carry research doc paths into stream-scoped plan tasks.

## Implementation Approach

The changes flow through 4 layers in order:

1. **Research output** — Add standardized `## Files Affected` section (data source)
2. **MCP server** — New `detect_work_streams` tool + per-stream pipeline detection (algorithm)
3. **Skills** — Plan and impl scope = one work stream (workflow)
4. **Orchestrator** — `ralph-team` uses stream model instead of bough model (coordination)

---

## Phase 1: Research Output — Structured File Paths

### Overview
Add a machine-parseable `## Files Affected` section to research documents so downstream clustering can determine which issues touch which code.

### Changes Required

#### 1. Research Skill SKILL.md
**File**: `plugin/ralph-hero/skills/ralph-research/SKILL.md`
**Changes**: Add to Step 4 (Create Research Document) a required `## Files Affected` section with this format:

```markdown
## Files Affected

### Will Modify
- `src/auth/middleware.ts` - Add token refresh logic
- `src/auth/types.ts` - New RefreshToken type

### Will Read (Dependencies)
- `src/config/auth-config.ts` - Token expiry settings
- `src/lib/http-client.ts` - Existing request interceptor pattern
```

Rules:
- Paths are relative to repo root
- `Will Modify` = files this issue needs to create or change
- `Will Read` = files this issue depends on but won't change
- This section is required for postcondition validation
- Backtick-wrapped paths on each line (parseable via regex `` `[^`]+` ``)

#### 2. Research Postcondition Hook
**File**: `plugin/ralph-hero/hooks/scripts/research-postcondition.sh`
**Changes**: Add validation that the `## Files Affected` heading exists in the research document. This is additive — existing checks remain.

### Success Criteria

#### Automated Verification:
- [ ] `grep -q "## Files Affected" thoughts/shared/research/*.md` finds the section in new research docs
- [ ] Research postcondition hook blocks stop if `## Files Affected` is missing

#### Manual Verification:
- [ ] Research docs produced by `/ralph-research` include the section with actual file paths (not placeholders)

---

## Phase 2: Work Stream Detection — MCP Server

### Overview
Add a new MCP tool `detect_work_streams` that takes pre-parsed file ownership data and `blockedBy` relationships, then clusters issues into independent work streams. Research doc discovery and parsing happens at the **orchestrator level** (not in the MCP server), since the orchestrator has local filesystem access via the `thoughts-locator` agent and `Read` tool.

### Architecture: Two-Layer Design

**Orchestrator layer** (ralph-team SKILL.md — has local file access):
1. Use `thoughts-locator` agent to find research docs for each issue: `Task(subagent_type="ralph-hero:thoughts-locator", prompt="Find research doc for GH-NNN")`
2. Read each research doc via `Read` tool
3. Parse `## Files Affected` > `### Will Modify` paths from each doc
4. Collect `blockedBy` relationships from `get_issue` responses (already available from group detection)
5. Pass pre-parsed data to the MCP clustering tool

**MCP server layer** (pure algorithm — no filesystem access needed):
1. Receive pre-parsed `{ issue, files[], blockedBy[] }` tuples
2. Run clustering algorithm
3. Return `WorkStreamResult`

This separation follows the existing architecture: MCP tools are primitive operations (Layer 1), orchestrators handle discovery and context (Layer 3).

### Changes Required

#### 1. New Library Module: `work-stream-detection.ts`
**File**: `plugin/ralph-hero/mcp-server/src/lib/work-stream-detection.ts`
**Changes**: New file implementing the clustering algorithm.

```typescript
export interface IssueFileOwnership {
  number: number;
  files: string[];               // Will Modify paths from research doc
  blockedBy: number[];           // GitHub blockedBy issue numbers
}

export interface WorkStream {
  id: string;                    // e.g., "stream-42-44" (sorted issue numbers)
  issues: number[];              // Issue numbers in this stream
  sharedFiles: string[];         // Files that caused clustering
  primaryIssue: number;          // First issue by topo order (for naming)
}

export interface WorkStreamResult {
  streams: WorkStream[];
  totalIssues: number;
  totalStreams: number;
  rationale: string;             // Human-readable clustering explanation
}
```

**Algorithm** (union-find / connected components):
1. Build a graph: issues are nodes
2. Add edges between issues that share any `Will Modify` file path
3. Add edges between issues connected by `blockedBy` relationships (blockers indicate business-logic coupling — they belong in the same stream)
4. Find connected components — each component is one work stream
5. Issues with no file overlap AND no `blockedBy` links to other issues are singleton streams
6. Return streams sorted by topological order (respecting `blockedBy` within streams)

**Stream ID format**: Deterministic, content-based — concatenation of `stream-` plus sorted issue numbers joined by `-`. Examples: `stream-42-44`, `stream-43`, `stream-45-46`. This ensures IDs are stable across session restarts.

#### 2. New Tool Registration: `detect_work_streams`
**File**: `plugin/ralph-hero/mcp-server/src/tools/relationship-tools.ts`
**Changes**: Register new tool in the existing relationship tools module.

Input:
```typescript
{
  issues: IssueFileOwnership[];  // Pre-parsed by orchestrator (files + blockedBy per issue)
}
```

Output: `WorkStreamResult`

The orchestrator is responsible for discovering research docs (via `thoughts-locator`), reading them, and parsing `## Files Affected` before calling this tool. The MCP tool never touches the local filesystem.

#### 3. Per-Stream Pipeline Detection
**File**: `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts`
**Changes**: Add new function `detectStreamPipelinePositions` that calls `detectPipelinePosition` per-stream rather than for the whole group.

```typescript
export interface StreamPipelinePosition {
  streamId: string;
  issues: number[];
  position: PipelinePosition;  // Reuse existing type
}

export function detectStreamPipelinePositions(
  streams: WorkStream[],
  issueStates: IssueState[],
  groupPrimary: number | null,
): StreamPipelinePosition[]
```

This is a thin wrapper — it partitions `IssueState[]` by stream membership and calls existing `detectPipelinePosition` for each partition. The existing function is unchanged.

#### 4. Tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/work-stream-detection.test.ts`
**Changes**: New test file covering:
- 2 issues sharing files → 1 stream
- 2 issues with no file overlap → 2 streams
- 3 issues where A overlaps B, B overlaps C but A doesn't overlap C → 1 stream (transitive file overlap)
- 2 issues with no file overlap but A `blockedBy` B → 1 stream (dependency co-clustering)
- 3 issues: A blocks B (no file overlap), C independent → 2 streams (A+B, C)
- 1 issue → 1 stream (degenerate case)
- Stream IDs are deterministic: `stream-42-44` not `stream-1`
- Missing file data for an issue → error with clear message

### Success Criteria

#### Automated Verification:
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes with new tests
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` succeeds

#### Manual Verification:
- [ ] `detect_work_streams` correctly clusters issues that share modified files
- [ ] `detect_work_streams` co-clusters issues connected by `blockedBy` relationships
- [ ] Issues with no file overlap and no blockers form separate streams
- [ ] Stream IDs are deterministic (e.g., `stream-42-44`)

---

## Phase 3: Plan & Impl Skill Adjustments

### Overview
Adjust plan and implementation skills so their scope is "one work stream" rather than "entire group". Minimal changes since these skills already handle groups — the change is in what constitutes a "group."

### Changes Required

#### 1. Plan Skill — Stream-Aware Group Context
**File**: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`
**Changes**:
- In Step 1a/1b: When building the issue group for planning, the group fed to it is a stream subset (the orchestrator controls this by only including stream-member issue numbers in the plan task description)
- The plan skill already handles multi-issue groups. No structural change needed — the skill plans whatever issues it receives
- Plan filename convention: `YYYY-MM-DD-stream-GH-NNN-NNN-description.md` for stream plans (vs `group-GH-NNN` for full-group plans). Stream ID in filename uses sorted issue numbers.
- Add stream metadata to plan frontmatter:
  ```yaml
  stream_id: "stream-42-44"
  stream_issues: [42, 44]
  epic_issue: 40
  ```

#### 2. Impl Skill — Stream-Scoped Worktree and PR
**File**: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`
**Changes**:
- In Step 5.2 (Determine Worktree ID): Add stream-based worktree naming: `GH-[EPIC]-stream-[SORTED-ISSUES]` (e.g., `GH-40-stream-42-44`)
- In Step 9.3 (Create PR): PR title includes stream context: `feat(auth): GH-42, GH-44 - Token refresh [stream-42-44 of GH-40]`
- PR body references the parent epic and other streams for reviewer context

#### 3. Shared Conventions — Stream Naming & Metadata
**File**: `plugin/ralph-hero/skills/shared/conventions.md`
**Changes**: Add a "Work Streams" section documenting:
- Stream ID format (`stream-[sorted-issue-numbers]`, e.g., `stream-42-44`)
- How stream plans are named (`stream-GH-NNN-NNN` vs `group-GH-NNN`)
- How stream worktrees are named (`GH-[EPIC]-stream-[SORTED-ISSUES]`)
- That research is per-issue (pre-stream), plans are per-stream, PRs are per-stream

**File**: `plugin/ralph-hero/skills/shared/conventions.md` (Group Context Resolution)
**Changes**: Add stream context resolution alongside existing group context:
```
{STREAM_CONTEXT} = "Stream stream-42-44: GH-42, GH-44 (shared: src/auth/). Plan covers stream issues only."
```

#### 4. Shared Conventions — Stream Metadata Fields
**File**: `plugin/ralph-hero/skills/shared/conventions.md`
**Changes**: Extend the "Standard input metadata" list in the "TaskUpdate Protocol" section with stream metadata fields:
```
Standard input metadata (set by lead at TaskCreate):
  ..., stream_id, stream_primary, stream_members, epic_issue
```

Example stream task metadata:
```json
{
  "stream_id": "stream-42-44",
  "stream_primary": "42",
  "stream_members": "42,44",
  "epic_issue": "40"
}
```

These extend the existing metadata pattern (alongside `group_primary`, `group_members`). The `stream_*` fields are present when the orchestrator is operating in stream mode; `group_*` fields are still used when there's no stream decomposition (2 or fewer issues, or all share files).

### Success Criteria

#### Automated Verification:
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` succeeds

#### Manual Verification:
- [ ] `/ralph-plan 42` when GH-42 is part of a stream produces a plan covering only that stream's issues
- [ ] `/ralph-impl 42` creates a worktree named with stream context and PR scoped to stream
- [ ] Existing single-issue `/ralph-plan` and `/ralph-impl` flows are unchanged

---

## Phase 4: Orchestrator — Stream Model for ralph-team

### Overview
Replace the "bough model" (Section 4.2 of ralph-team SKILL.md) with a "stream model" where the orchestrator creates tasks per-stream and streams advance independently. Task metadata and descriptions carry stream context per the established conventions.

### Changes Required

#### 1. Ralph-Team SKILL.md — Stream-Based Dispatch
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**:

**Section 3 (State Detection)**: After detecting pipeline position, add a "stream detection" sub-step:
- If phase is RESEARCH or later AND group has 3+ issues: call `detect_work_streams` (if research is complete for all issues) or note that streams will be detected post-research
- Store `STREAMS[]` with issue memberships and stream IDs

**Section 3.1 (XS Fast-Track)**: Add exclusion rule:
- XS fast-track is **disabled** for epics with 3+ children. These issues always go through the full research → plan → implement pipeline so that stream detection has accurate `## Files Affected` data to cluster on.
- Rationale: fast-tracked issues skip research, producing no `## Files Affected` section. In a multi-stream epic, this creates blind spots in the clustering algorithm. The overhead of researching an XS issue is small relative to the risk of incorrect stream assignment.

**Section 4.2 (Task Creation)**: Extend current metadata conventions with stream fields.

New task types for stream-aware phases:

- **PLAN (stream)**:
  Subject: `"Plan stream-42-44 GH-42"`
  Description: Include issue URLs for stream members, research doc paths from completed research tasks (carried forward per Section 4.4), stream membership.
  Metadata: `{ "issue_number": "42", "issue_url": "[url]", "command": "plan", "phase": "plan", "stream_id": "stream-42-44", "stream_primary": "42", "stream_members": "42,44", "epic_issue": "40", "artifact_path": "[research doc paths]" }`

- **IMPLEMENT (stream)**:
  Subject: `"Implement stream-42-44 GH-42"`
  Description: Include plan doc path, stream membership, worktree path.
  Metadata: `{ "issue_number": "42", "issue_url": "[url]", "command": "impl", "phase": "implement", "stream_id": "stream-42-44", "stream_primary": "42", "stream_members": "42,44", "epic_issue": "40", "artifact_path": "[plan doc path]", "worktree": "worktrees/GH-40-stream-42-44/" }`

- **COMPLETE (stream)**:
  Subject: `"Create PR for stream-42-44 GH-42"` + `"Merge PR for stream-42-44 GH-42"`
  Metadata: adds `stream_id`, `stream_primary`, `stream_members`, `epic_issue`

Research tasks remain per-issue (unchanged) since streams aren't known yet.

**Section 4.4 (Dispatch Loop)**: Replace convergence check with stream-aware dispatch:

```
RESEARCH phase (pre-stream, unchanged):
  -> Create per-issue research tasks as today
  -> As research tasks complete, carry forward artifact paths

STREAM DETECTION (new micro-phase, lead does this directly):
  -> When ALL research tasks complete:
  1. For each issue, use `thoughts-locator` agent to find research doc:
     Task(subagent_type="ralph-hero:thoughts-locator",
          prompt="Find research doc for GH-NNN")
  2. Read each research doc, parse `## Files Affected` > `### Will Modify` paths
  3. Collect `blockedBy` arrays from `get_issue` responses (already cached from group detection)
  4. Call `detect_work_streams` with pre-parsed { issue, files[], blockedBy[] } tuples
  -> Store STREAMS[] array (stream IDs are deterministic, e.g., stream-42-44)
  -> For each stream, call `detect_pipeline_position` on that stream's issues
  -> Create next-phase tasks for each stream independently

PER-STREAM phases (plan, implement, PR):
  -> Each stream advances independently
  -> Stream convergence = all issues in THAT stream at the gate state
  -> Lead creates per-stream tasks when a stream converges
  -> Workers self-claim based on task subjects as before
  -> Carry forward artifact paths from completed tasks to new tasks
```

**Artifact path forwarding**: When creating stream-scoped plan tasks, the lead uses `TaskGet` on completed research tasks to read the `artifact_path` from their result metadata (set by workers per each SKILL.md "Team Result Reporting" section), then includes them in the plan task description. This follows the existing "carry forward artifact paths" pattern in Section 4.4.

**Section on Stream Lifecycle** (new):
- Streams are detected once (after all research completes) and are immutable for the session
- Each stream tracks its own phase independently
- Stream convergence = all issues in that stream at the gate state
- Lead creates per-stream plan/impl/PR tasks with `stream_*` metadata fields
- Workers self-claim based on task subjects as before
- For epics with <=2 children, skip stream detection (single group, same as current behavior)
- XS fast-track disabled for epics with 3+ children (see Section 3.1 change above)

#### 2. Subject Pattern Update
Workers self-claim via subject keyword matching. New stream-prefixed subjects need to be recognized:

| Subject pattern | Role | Skill |
|----------------|------|-------|
| `"Plan stream-42-44 GH-42"` | builder | ralph-plan |
| `"Implement stream-42-44 GH-42"` | builder | ralph-impl |
| `"Create PR for stream-42-44 GH-42"` | integrator | (none) |
| `"Merge PR for stream-42-44 GH-42"` | integrator | (none) |

The existing keyword matching ("Plan", "Implement", "Create PR", "Merge") already works — the stream prefix doesn't interfere.

#### 3. Pipeline Dashboard Updates
**File**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`
**Changes**: Update `pipeline_dashboard` output to show per-stream status when streams are detected.

### Success Criteria

#### Automated Verification:
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` succeeds

#### Manual Verification:
- [ ] Given an epic with 4+ children with different file scopes, `/ralph-team [epic-number]` produces multiple PRs (one per stream)
- [ ] Independent streams advance to planning while other streams finish planning (streams don't block each other)
- [ ] Task metadata includes `stream_id`, `stream_members`, `stream_primary` for stream-phase tasks
- [ ] Existing single-issue and 2-issue group workflows continue to work (stream detection skipped, bough model preserved)

---

## Integration Testing

- [ ] End-to-end: Create an epic with 4 child issues, 2 sharing auth files and 2 sharing DB files. Run `/ralph-team`. Expect: 2 streams, 2 plans, 2 PRs, each PR touching only its stream's files.
- [ ] Regression: Single issue `/ralph-research` + `/ralph-plan` + `/ralph-impl` flow is unchanged
- [ ] Regression: 2-issue group with shared files produces 1 stream (same as current group behavior)
- [ ] Edge case: All issues in epic touch the same file → 1 stream, 1 plan, 1 PR (current behavior preserved)
- [ ] Edge case: No file overlap at all → N streams of 1 issue each, N PRs
- [ ] Edge case: Research doc missing `## Files Affected` → postcondition hook blocks, clear error message
- [ ] Edge case: Epic with <=2 children → stream detection skipped, bough model preserved
- [ ] Edge case: 2 issues with no file overlap but A `blockedBy` B → co-clustered into 1 stream
- [ ] Edge case: XS issue in epic with 3+ children → NOT fast-tracked, goes through full research pipeline
- [ ] Edge case: Session restart → stream IDs are deterministic (same issue set → same stream-42-44 ID)

## References

- Current ralph-team SKILL.md: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
- Pipeline detection: `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts`
- Group detection: `plugin/ralph-hero/mcp-server/src/lib/group-detection.ts`
- Research skill: `plugin/ralph-hero/skills/ralph-research/SKILL.md`
- Plan skill: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`
- Impl skill: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`
- Shared conventions: `plugin/ralph-hero/skills/shared/conventions.md` (includes TaskUpdate Protocol, Spawn Template Protocol, Artifact Comment Protocol)
