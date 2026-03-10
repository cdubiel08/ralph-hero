---
date: 2026-03-04
status: draft
type: plan
github_issues: [523]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/523
primary_issue: 523
---

# Ralph-team: Create Full Task Graph Upfront — Implementation Plan

## Overview

Replace the incremental task creation model in `ralph-team` SKILL.md with upfront full-graph creation. The team lead reads each issue's `workflowState`, maps it to remaining pipeline phases, and creates all tasks with `blockedBy` chains in one pass. Workers pick up tasks as blockers resolve — no team lead intervention needed between phases.

## Current State Analysis

The `ralph-team` skill at `plugin/ralph-hero/skills/ralph-team/SKILL.md` has four main sections:

1. **Assess** (lines 56-57): Fetches issue, detects pipeline position. No state-to-phase mapping.
2. **Build the Task List** (lines 79-120): Creates tasks for "current and upcoming pipeline phases" with the instruction: _"Add tasks incrementally as phases complete rather than predicting the entire pipeline upfront."_ (line 120)
3. **Respond to Events** (lines 122-126): Reacts to task completions by creating follow-up tasks for the next phase.
4. **Shut Down** (lines 128-185): Post-mortem, shutdown, delete.

### Key Discoveries:
- The workflow state machine is a contract (per `specs/issue-lifecycle.md`). Each state guarantees prior phase requirements are met.
- Skill input states are enforced by gate hooks (per `specs/skill-io-contracts.md`). Workers cannot run a skill on an issue in the wrong state — the hook blocks it.
- Task schema validator (`task-schema-validator.sh`) requires: role keyword in subject, `GH-NNN` pattern, and metadata with `issue_number`, `issue_url`, `command`, `phase`, `estimate`.
- The `team-task-completed.sh` hook is advisory only (exit 0, stderr log). It does not automate task creation — the lead must act manually.

## Desired End State

The team lead creates the full remaining task graph during initial setup. Each task has `blockedBy` pointing to its predecessor phase task. Workers auto-pick tasks when blockers clear. The "Respond to Events" section handles only error recovery (failed reviews, failed validations).

### Verification
- [ ] When ralph-team processes a group in Backlog, all tasks from triage through PR are created upfront with `blockedBy` chains
- [ ] When ralph-team processes an issue at Plan in Review, only implement/validate/PR tasks are created
- [ ] Workers begin implementation immediately after plan tasks complete, without team lead creating new tasks
- [ ] Failed reviews create corrective tasks (NEEDS_ITERATION → new plan task)
- [ ] All tasks satisfy `task-schema-validator.sh` constraints

## What We're NOT Doing

- Not changing any hooks (they already work correctly — advisory TaskCompleted, enforcing task schema)
- Not changing MCP server code or TypeScript
- Not changing specs (they already define the contracts we're leveraging)
- Not changing agent definitions or other skills
- Not adding artifact validation — the workflow state is the contract

## Implementation Approach

Single phase — surgical edits to three sections of `plugin/ralph-hero/skills/ralph-team/SKILL.md`. The Shut Down section and frontmatter are unchanged.

---

## Phase 1: Rewrite SKILL.md task creation model

> **Estimate**: XS | **Files**: 1

### Changes Required:

#### 1. Replace the Assess section (lines 55-57)

**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`

**Current** (lines 55-57):
```markdown
## Assess

Fetch the issue and detect its pipeline position. If no issue number is given, scan the project board for actionable work. If the issue is terminal (PR exists or Done), report that and stop.
```

**Replace with**:
```markdown
## Assess

Fetch the issue and detect its pipeline position. If no issue number is given, scan the project board for actionable work. If the issue is terminal (PR exists or Done), report that and stop.

### State-to-Remaining-Phases Mapping

The workflow state is a contract — each state guarantees prior phase requirements are met. Map each issue's `workflowState` to its remaining pipeline phases:

| workflowState | Remaining Phases | Skills |
|---------------|-----------------|--------|
| Backlog | triage → research → plan → review → implement → validate → PR | triage, research, plan, review, impl, val, pr |
| Research Needed | research → plan → review → implement → validate → PR | research, plan, review, impl, val, pr |
| Ready for Plan | plan → review → implement → validate → PR | plan, review, impl, val, pr |
| Plan in Review | review → implement → validate → PR | review, impl, val, pr |
| In Progress | implement → validate → PR | impl, val, pr |
| In Review | merge | merge |

Use this mapping to determine the full set of tasks to create for each issue. Issues at advanced states simply have fewer tasks.
```

#### 2. Replace the Build the Task List section (lines 79-120)

**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`

**Current** (lines 79-120): The section including "Build the Task List", "Stream Detection Before Implementation Tasks", and the incremental instruction at line 120.

**Replace lines 79-120 with** (preserving the Stream Detection subsection content but reframing it):

```markdown
## Build the Task List

Create tasks for ALL remaining pipeline phases upfront. Use `blockedBy` chains to enforce phase ordering. Workers pick up tasks as soon as their blockers resolve — no team lead intervention needed between phases.

### Task Template Per Phase

Each task must satisfy `task-schema-validator.sh`. Use these templates:

| Phase | Subject Pattern | Owner | Command | activeForm |
|-------|----------------|-------|---------|------------|
| Triage | `Triage GH-NNN: {title}` | analyst | ralph_triage | Triaging GH-NNN |
| Research | `Research GH-NNN: {title}` | analyst | ralph_research | Researching GH-NNN |
| Plan | `Plan GH-NNN: {title}` | analyst | ralph_plan | Planning GH-NNN |
| Review | `Review plan for GH-NNN: {title}` | builder | ralph_review | Reviewing GH-NNN |
| Implement | `Implement GH-NNN: {title}` | builder | ralph_impl | Implementing GH-NNN |
| Validate | `Validate GH-NNN: {title}` | integrator | ralph_val | Validating GH-NNN |
| Create PR | `Create PR for GH-NNN: {title}` | integrator | ralph_pr | Creating PR for GH-NNN |
| Merge | `Merge PR for GH-NNN: {title}` | integrator | ralph_merge | Merging GH-NNN |

**Required metadata for every task**: `issue_number`, `issue_url`, `command`, `phase`, `estimate`. Add `group_primary` and `group_members` for group issues.

### Full Graph Example

For an issue group with two sub-issues (#42 XS at Backlog, #43 S at Ready for Plan):

**#42 (Backlog — 6 remaining phases)**:
```
Task 1: Triage GH-42: title (analyst)
Task 2: Research GH-42: title (analyst, blockedBy: [1])
Task 3: Plan GH-42: title (analyst, blockedBy: [2])
Task 4: Review plan for GH-42: title (builder, blockedBy: [3])
Task 5: Implement GH-42: title (builder, blockedBy: [4])
Task 6: Validate GH-42: title (integrator, blockedBy: [5])
Task 7: Create PR for GH-42: title (integrator, blockedBy: [6])
```

**#43 (Ready for Plan — 4 remaining phases)**:
```
Task 8: Plan GH-43: title (analyst)
Task 9: Review plan for GH-43: title (builder, blockedBy: [8])
Task 10: Implement GH-43: title (builder, blockedBy: [9])
Task 11: Validate GH-43: title (integrator, blockedBy: [10])
Task 12: Create PR for GH-43: title (integrator, blockedBy: [11])
```

Workers claim unblocked tasks matching their role. No team lead action needed between phases.

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
   - Task description must include `base_branch` if stacked branches apply: set `base_branch` to the predecessor's branch name (e.g., `feature/GH-42`). This tells the builder to create its worktree stacked on the predecessor branch instead of main. Issues in independent streams or standalone issues should not have `base_branch` set.

6. **Single-stream fallback**: If `totalStreams == 1` or only 1 issue, skip stream tagging. Create implementation tasks as today — the existing single builder handles them sequentially.

7. **Overflow assignment** (4+ streams with 3 builders): Assign stream-4 tasks to the least-loaded builder (fewest assigned tasks). Document the assignment in the task description.

### Stream Detection Timing

Stream detection requires research documents (for file paths). If issues haven't been researched yet (pre-research states), the implementation task subjects and stream tags cannot be determined at initial graph creation time.

**Strategy**: Create placeholder implementation tasks without stream tags. When the last research task for the group completes, the team lead calls `detect_stream_positions`, updates implementation task subjects with stream tags, spawns additional builders if needed, and reassigns owners. This is the ONE exception to "no team lead intervention between phases" — stream detection is a graph refinement step, not a new task creation step.
```

#### 3. Replace the Respond to Events section (lines 122-126)

**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`

**Current** (lines 122-126):
```markdown
## Respond to Events

Hooks fire when tasks complete or teammates go idle. When a task completes, decide if the next phase is ready and create those tasks. When a review returns a NEEDS_ITERATION verdict, create a new planning task for the analyst. When a validation fails, create a new implementation task for the builder.

Workers going idle between turns is normal — don't nudge them. Task assignment is the communication mechanism.
```

**Replace with**:
```markdown
## Respond to Events

Normal phase progression is handled by `blockedBy` chains — no team lead action needed. Workers going idle between turns is normal — don't nudge them.

The team lead intervenes only for error recovery:

- **NEEDS_ITERATION review**: Create a new Plan task for the analyst (blockedBy: none, since the review is complete). Update the corresponding Implement task's `blockedBy` to include the new Plan task.
- **Failed validation**: Create a new Implement task for the builder (blockedBy: none). Update the Validate task's `blockedBy` to include the new Implement task.
- **Escalation (Human Needed)**: Report to the user and stop. Do not create corrective tasks — a human must decide next steps.

### Stream Detection Refinement

When research tasks complete for a group with 2+ issues, refine the task graph:

1. Call `detect_stream_positions` with file paths from research documents
2. Update implementation task subjects with `[stream-N]` tags
3. Spawn additional builders if `suggestedRoster.builder` > current builder count
4. Reassign implementation task owners to stream-specific builders
```

### Success Criteria:

#### Automated Verification:
- [x] `npm run build` — no TypeScript errors (SKILL.md is markdown, but build validates the project)
- [x] Skill frontmatter unchanged (hooks, allowed-tools, model all preserved)

#### Manual Verification:
- [ ] Run `ralph-team 523` or similar — verify full task graph created upfront with `blockedBy` chains
- [ ] Verify workers pick up tasks automatically when blockers resolve
- [ ] Verify tasks at advanced states have earlier phases skipped

---

## Testing Strategy

### Manual Testing Steps:
1. Run `ralph-team` on an issue group where some issues are at advanced states (e.g., one at Backlog, one at Plan in Review)
2. Verify the full task graph shows correct remaining phases per issue
3. Verify `blockedBy` chains are correct (each phase blocked by its predecessor)
4. Verify workers begin work without team lead creating follow-up tasks
5. Simulate a review failure — verify corrective task is created correctly

## References

- Issue: #523
- Current skill: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
- State machine contract: `specs/issue-lifecycle.md`
- Skill I/O contracts: `specs/skill-io-contracts.md`
- Task schema: `specs/task-schema.md`
- Team schema: `specs/team-schema.md`
