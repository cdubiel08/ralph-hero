---
date: 2026-02-17
status: draft
github_issues: [44, 45, 46, 47, 48, 49, 50, 51]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/44
  - https://github.com/cdubiel08/ralph-hero/issues/45
  - https://github.com/cdubiel08/ralph-hero/issues/46
  - https://github.com/cdubiel08/ralph-hero/issues/47
  - https://github.com/cdubiel08/ralph-hero/issues/48
  - https://github.com/cdubiel08/ralph-hero/issues/49
  - https://github.com/cdubiel08/ralph-hero/issues/50
  - https://github.com/cdubiel08/ralph-hero/issues/51
primary_issue: 44
---

# Consolidate Agents into Scope-Bounded Workers - Atomic Implementation Plan

## Overview

This plan covers 8 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | #44 | Define worker scope boundaries and state ownership map | S |
| 2 | #45 | Create Analyst worker agent definition (replaces triager + researcher) | S |
| 3 | #46 | Create Builder worker agent definition (replaces planner + implementer) | S |
| 4 | #47 | Create Validator worker agent definition (replaces advocate) | XS |
| 5 | #48 | Create Integrator worker agent definition (new - merge/deploy/git ops) | S |
| 6 | #49 | Update ralph-team orchestrator to spawn 4 workers instead of 7 agents | S |
| 7 | #50 | Update ralph-hero orchestrator and scripts for worker-based architecture | S |
| 8 | #51 | Clean up legacy agent definitions and old spawn templates | XS |

**Why grouped**: All 8 issues are sub-issues of epic #40. They form a coherent architectural migration from 5 specialized agents to 4 scope-bounded workers. Each phase builds on the previous -- the design doc defines boundaries, worker agents implement those boundaries, orchestrators adopt the new workers, and cleanup removes the old agents. Implementing atomically ensures no intermediate broken state.

## Current State Analysis

The Ralph system currently uses 5 specialized agents (`ralph-triager`, `ralph-researcher`, `ralph-planner`, `ralph-advocate`, `ralph-implementer`), each handling a single state transition. Two orchestrators (`ralph-team` for multi-agent, `ralph-hero` for solo) coordinate these agents. The current architecture has:

- **7 agent roles** with narrow state ownership (one state transition per agent)
- **6 spawn templates** mapping to these agents
- **4+ handoff boundaries** between agents
- Each skill invoked by exactly one agent type

The proposed architecture consolidates into 4 scope-bounded workers:

- **Analyst** (Backlog -> Ready for Plan): triage + split + research
- **Builder** (Ready for Plan -> In Review): plan + review(self) + implement
- **Validator** (observes Plan in Review, In Review): external review (optional)
- **Integrator** (In Review -> Done): merge + git ops (new)

Key benefits: fewer handoffs (3 vs 6+), broader per-worker scope, optional validation, and new merge automation.

## Desired End State

All 4 new worker agents are operational, both orchestrators use the new worker model, and legacy agent/template files are removed. The state machine and skills remain unchanged -- only the agent definitions, orchestrators, and supporting docs change.

### Verification
- [ ] 4 new agent files exist: `ralph-analyst.md`, `ralph-builder.md`, `ralph-validator.md`, `ralph-integrator.md`
- [ ] 5 old agent files removed: `ralph-triager.md`, `ralph-researcher.md`, `ralph-planner.md`, `ralph-advocate.md`, `ralph-implementer.md`
- [ ] 6 old spawn templates removed: `triager.md`, `splitter.md`, `researcher.md`, `planner.md`, `reviewer.md`, `implementer.md`
- [ ] 1 new spawn template exists: `integrator.md`
- [ ] `ralph-team` SKILL.md spawn table references 4 worker agent types
- [ ] `ralph-hero` SKILL.md phases grouped by worker scope
- [ ] `ralph-loop.sh` has `--analyst-only`, `--builder-only`, `--validator-only`, `--integrator-only` flags
- [ ] `conventions.md` pipeline handoff table uses new worker names
- [ ] No stale references to old agent names in `plugin/` (excluding `thoughts/`)
- [ ] Design doc committed with complete state ownership map
- [ ] All existing skills (`ralph-triage`, `ralph-split`, `ralph-research`, `ralph-plan`, `ralph-review`, `ralph-impl`) remain unmodified

## What We're NOT Doing

- Modifying any existing skills (they stay as-is; worker consolidation is at the agent level)
- Changing the state machine (`ralph-state-machine.json` stays unchanged)
- Changing MCP server code or tools
- Adding new skills (e.g., `ralph-merge`, `ralph-analyze`)
- Implementing CI/CD or auto-merge functionality (Integrator is merge-only for now)
- Modifying hook scripts beyond comment updates in `team-task-completed.sh`
- Updating historical documents in `thoughts/`

## Implementation Approach

Phases 1-5 are additive (create new files alongside existing ones). Phases 6-7 update orchestrators to reference the new workers. Phase 8 removes the old files. This ordering ensures a working system at every intermediate commit.

Existing spawn templates (`triager.md`, `splitter.md`, `researcher.md`, `planner.md`, `reviewer.md`, `implementer.md`) are reused as-is by the new workers until Phase 8 cleanup. The templates invoke skills directly and are agent-type-agnostic -- the agent definition, not the template, determines tools and model. Only `integrator.md` is genuinely new (the Integrator has no existing skill to compose).

---

## Phase 1: #44 - Define worker scope boundaries and state ownership map

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/44
> **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0044-worker-scope-boundaries.md

### Overview

Create a design document that maps each worker to owned states, skills, isolation requirements, and handoff protocols. This document is the reference for all subsequent phases.

### Changes Required

#### 1. Create design document
**File**: `thoughts/shared/plans/2026-02-17-GH-0044-worker-scope-boundaries-design.md`
**Changes**: Create a new design document containing:

1. **State ownership map** -- all 11 workflow states assigned to exactly one worker:
   - Analyst: Backlog, Research Needed, Research in Progress
   - Builder: Ready for Plan, Plan in Progress, Plan in Review (primary), In Progress
   - Validator: observes Plan in Review (interactive mode only), In Review (future quality gates)
   - Integrator: In Review (merge operations)
   - None: Done, Canceled, Human Needed (terminal/escalation)

2. **Skill-to-worker mapping**:
   - Analyst: `ralph-triage`, `ralph-split`, `ralph-research`
   - Builder: `ralph-plan`, `ralph-impl`, `ralph-review` (self-review mode)
   - Validator: `ralph-review` (external critique mode)
   - Integrator: none (direct git/gh CLI operations)

3. **Worker loop pseudocode** for each worker (conceptual -- actual implementation is task-driven)

4. **Conflict avoidance rules**:
   - Plan in Review dual ownership: resolved by `RALPH_REVIEW_MODE` env var
   - In Review merge serialization: one Integrator at a time
   - Worktree isolation: Builder uses worktrees per issue

5. **Handoff boundaries** (3 total):
   - Analyst -> Builder (at Ready for Plan)
   - Builder -> Integrator (at In Review)
   - Validator -> Builder (rejection back to Ready for Plan)

6. **Instance limits**: Analyst (3), Builder (3), Validator (1), Integrator (1)

Use the research document as the primary source. Structure the design doc as a concise reference (not a narrative).

### Success Criteria

#### Automated Verification
- [x] `test -f thoughts/shared/plans/2026-02-17-GH-0044-worker-scope-boundaries-design.md`
- [x] `grep -c "Analyst\|Builder\|Validator\|Integrator" thoughts/shared/plans/2026-02-17-GH-0044-worker-scope-boundaries-design.md` returns >= 20

#### Manual Verification
- [ ] All 11 workflow states from `ralph-state-machine.json` appear in the ownership map
- [ ] No state is assigned to multiple workers (except Plan in Review with documented resolution)
- [ ] All 6 existing skills are mapped to a worker

**Dependencies created for next phase**: Design doc defines the exact frontmatter, tool lists, and behavioral patterns for Phases 2-5.

---

## Phase 2: #45 - Create Analyst worker agent definition

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/45
> **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0045-analyst-worker-agent.md
> **Depends on**: Phase 1 (uses state ownership map)

### Overview

Create `ralph-analyst.md` as a thin task-loop agent that replaces `ralph-triager` + `ralph-researcher`. Matches tasks with "Triage", "Split", or "Research" in subject and dispatches to the appropriate skill.

### Changes Required

#### 1. Create Analyst agent definition
**File**: `plugin/ralph-hero/agents/ralph-analyst.md`
**Changes**: Create new file with:

**Frontmatter**:
```yaml
---
name: ralph-analyst
description: Analyst worker - composes triage, split, and research skills for issue assessment and investigation
tools: Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__update_estimate, ralph_hero__update_priority, ralph_hero__create_issue, ralph_hero__create_comment, ralph_hero__add_sub_issue, ralph_hero__add_dependency, ralph_hero__remove_dependency, ralph_hero__list_sub_issues, ralph_hero__list_dependencies, ralph_hero__detect_group
model: sonnet
color: green
---
```

**Body** (follow existing agent pattern from `ralph-triager.md` and `ralph-researcher.md`):
- Identity: "You are an **ANALYST** in the Ralph Team."
- Task loop:
  1. `TaskList()` -- find tasks with "Triage", "Split", or "Research" in subject, pending, empty blockedBy, no owner
  2. Claim lowest-ID match: `TaskUpdate(taskId, status="in_progress", owner="analyst")`
  3. `TaskGet(taskId)` -- extract issue number from description
  4. Dispatch by subject keyword:
     - "Split" -> `Skill(skill="ralph-hero:ralph-split", args="[issue-number]")`
     - "Triage" -> `Skill(skill="ralph-hero:ralph-triage", args="[issue-number]")`
     - "Research" -> `Skill(skill="ralph-hero:ralph-research", args="[issue-number]")`
  5. `TaskUpdate(taskId, status="completed", description="...")` with appropriate result format per action type
  6. Repeat. If no tasks, hand off to `ralph-builder` per `shared/conventions.md`
- Shutdown: Approve unless mid-skill.

### Success Criteria

#### Automated Verification
- [x] `test -f plugin/ralph-hero/agents/ralph-analyst.md`
- [x] `grep -q 'name: ralph-analyst' plugin/ralph-hero/agents/ralph-analyst.md`
- [x] `grep -q 'model: sonnet' plugin/ralph-hero/agents/ralph-analyst.md`
- [x] `grep -q 'ralph-hero:ralph-triage' plugin/ralph-hero/agents/ralph-analyst.md`
- [x] `grep -q 'ralph-hero:ralph-split' plugin/ralph-hero/agents/ralph-analyst.md`
- [x] `grep -q 'ralph-hero:ralph-research' plugin/ralph-hero/agents/ralph-analyst.md`

#### Manual Verification
- [ ] Tool list is the union of `ralph-triager` and `ralph-researcher` tools
- [ ] Task matching covers all 3 keywords: Triage, Split, Research

**Dependencies created for next phase**: Analyst agent exists for orchestrator to reference.

---

## Phase 3: #46 - Create Builder worker agent definition

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/46
> **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0046-builder-worker-agent.md
> **Depends on**: Phase 1 (uses state ownership map)

### Overview

Create `ralph-builder.md` that replaces `ralph-planner` + `ralph-implementer`. Matches tasks with "Plan" (not "Review") or "Implement" in subject. Handles branch switching transparently (skills enforce their own branch requirements via hooks).

### Changes Required

#### 1. Create Builder agent definition
**File**: `plugin/ralph-hero/agents/ralph-builder.md`
**Changes**: Create new file with:

**Frontmatter**:
```yaml
---
name: ralph-builder
description: Builder worker - composes plan, implement, and self-review skills for the full build lifecycle
tools: Read, Write, Edit, Bash, Glob, Grep, Skill, Task, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__create_comment, ralph_hero__detect_group, ralph_hero__list_sub_issues, ralph_hero__list_dependencies
model: sonnet
color: cyan
---
```

**Body**:
- Identity: "You are a **BUILDER** in the Ralph Team."
- Task loop:
  1. `TaskList()` -- find tasks with "Plan" (not "Review") or "Implement" in subject, pending, empty blockedBy, no owner
  2. Claim: `TaskUpdate(taskId, status="in_progress", owner="builder")`
  3. `TaskGet(taskId)` -- extract issue number
  4. Dispatch by subject keyword:
     - "Plan" -> `Skill(skill="ralph-hero:ralph-plan", args="[issue-number]")`
     - "Implement" -> `Skill(skill="ralph-hero:ralph-impl", args="[issue-number]")`
  5. `TaskUpdate(taskId, status="completed", description="...")` with result format
  6. Repeat. If no tasks, hand off to `ralph-integrator` per conventions
- Handling revision requests: Read feedback from review task description, re-invoke `ralph-plan`
- DO NOT push to remote for implementation -- lead handles PR creation
- Shutdown: Verify work committed in worktree, then approve

Note: `Edit` tool comes from the implementer role (for code changes during implementation phases). Model is `sonnet` for the thin loop; skills override to `opus` as needed.

### Success Criteria

#### Automated Verification
- [ ] `test -f plugin/ralph-hero/agents/ralph-builder.md`
- [ ] `grep -q 'name: ralph-builder' plugin/ralph-hero/agents/ralph-builder.md`
- [ ] `grep -q 'model: sonnet' plugin/ralph-hero/agents/ralph-builder.md`
- [ ] `grep -q 'Edit' plugin/ralph-hero/agents/ralph-builder.md` (has Edit tool from implementer)
- [ ] `grep -q 'ralph-hero:ralph-plan' plugin/ralph-hero/agents/ralph-builder.md`
- [ ] `grep -q 'ralph-hero:ralph-impl' plugin/ralph-hero/agents/ralph-builder.md`

#### Manual Verification
- [ ] Tool list is the union of `ralph-planner` and `ralph-implementer` tools
- [ ] Task matching covers "Plan" (not "Review") and "Implement"

**Dependencies created for next phase**: Builder agent exists for orchestrator to reference.

---

## Phase 4: #47 - Create Validator worker agent definition

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/47
> **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0047-validator-worker-agent.md
> **Depends on**: Phase 1 (uses state ownership map)

### Overview

Create `ralph-validator.md` replacing `ralph-advocate`. Optional worker that only activates when `RALPH_REVIEW_MODE=interactive`. Matches tasks with "Review" or "Validate" in subject.

### Changes Required

#### 1. Create Validator agent definition
**File**: `plugin/ralph-hero/agents/ralph-validator.md`
**Changes**: Create new file with:

**Frontmatter**:
```yaml
---
name: ralph-validator
description: Quality gate - invokes ralph-review skill for plan critique and future quality validation
tools: Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__create_comment
model: opus
color: blue
---
```

**Body**:
- Identity: "You are a **VALIDATOR** in the Ralph Team."
- Task loop:
  1. `TaskList()` -- find tasks with "Review" or "Validate" in subject, pending, empty blockedBy, no owner
  2. Claim: `TaskUpdate(taskId, status="in_progress", owner="validator")`
  3. `TaskGet(taskId)` -- extract issue number
  4. Dispatch: `Skill(skill="ralph-hero:ralph-review", args="[issue-number]")`
  5. `TaskUpdate(taskId, status="completed", description="VALIDATION VERDICT\nTicket: #NNN\nPlan: [path]\nVERDICT: [APPROVED/NEEDS_ITERATION]\n[blocking issues]\n[warnings]\n[what's good]")`
  6. **CRITICAL**: Full verdict MUST be in task description -- lead cannot see skill output
  7. Repeat. If no tasks, go idle
- Note: Validator is optional. Only spawned when `RALPH_REVIEW_MODE=interactive`
- Shutdown: If idle, approve. If mid-skill, reject, finish, then approve

### Success Criteria

#### Automated Verification
- [ ] `test -f plugin/ralph-hero/agents/ralph-validator.md`
- [ ] `grep -q 'name: ralph-validator' plugin/ralph-hero/agents/ralph-validator.md`
- [ ] `grep -q 'model: opus' plugin/ralph-hero/agents/ralph-validator.md`
- [ ] `grep -q 'ralph-hero:ralph-review' plugin/ralph-hero/agents/ralph-validator.md`

#### Manual Verification
- [ ] Tool list matches current `ralph-advocate` (no Edit tool -- read-only for implementation)
- [ ] Agent description notes it is optional / mode-dependent

**Dependencies created for next phase**: Validator agent exists for orchestrator to reference.

---

## Phase 5: #48 - Create Integrator worker agent definition

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/48
> **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0048-integrator-worker-agent.md
> **Depends on**: Phase 1 (uses state ownership map)

### Overview

Create `ralph-integrator.md` -- an entirely new worker that handles PR merge and git cleanup. Does NOT compose existing skills; operates directly via Bash/gh CLI. Also create the `integrator.md` spawn template.

### Changes Required

#### 1. Create Integrator agent definition
**File**: `plugin/ralph-hero/agents/ralph-integrator.md`
**Changes**: Create new file with:

**Frontmatter**:
```yaml
---
name: ralph-integrator
description: Integration specialist - handles PR merge, worktree cleanup, and git operations for completed implementations
tools: Read, Glob, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__create_comment, ralph_hero__advance_children, ralph_hero__list_sub_issues
model: sonnet
color: orange
---
```

**Body**:
- Identity: "You are an **INTEGRATOR** in the Ralph Team."
- Task loop:
  1. `TaskList()` -- find tasks with "Merge" or "Integrate" in subject, pending, empty blockedBy, no owner
  2. Claim: `TaskUpdate(taskId, status="in_progress", owner="integrator")`
  3. `TaskGet(taskId)` -- extract issue number
  4. Fetch issue: `get_issue(number)` -- verify In Review state, find PR link in comments
  5. Check PR readiness: `gh pr view [N] --json state,reviews,mergeable,statusCheckRollup`
     - If not ready: report status, keep task in_progress, go idle (will be re-checked)
  6. If ready:
     a. Merge: `gh pr merge [N] --merge --delete-branch`
     b. Clean worktree: `scripts/remove-worktree.sh GH-NNN` (from git root)
     c. Update state: `update_workflow_state(state="Done", command="ralph_impl")` for each issue
     d. Advance parent: `advance_children(parentNumber=EPIC)` if epic member
     e. Post comment: merge completion summary
  7. `TaskUpdate(taskId, status="completed", description="MERGE COMPLETE\nTicket: #NNN\nPR: [URL] merged\nBranch: deleted\nWorktree: removed\nState: Done")`
  8. **CRITICAL**: Full result MUST be in task description
  9. Repeat. If no tasks, go idle
- Serialization: Only one Integrator runs at a time (enforced by orchestrator, not agent)
- Shutdown: Approve unless mid-merge

#### 2. Create Integrator spawn template
**File**: `plugin/ralph-hero/templates/spawn/integrator.md`
**Changes**: Create new file:
```
Merge PR for #{ISSUE_NUMBER}: {TITLE}.

Check PR status and merge if ready per your agent definition.
Report results. Then check TaskList for more integration tasks.
```

### Success Criteria

#### Automated Verification
- [ ] `test -f plugin/ralph-hero/agents/ralph-integrator.md`
- [ ] `test -f plugin/ralph-hero/templates/spawn/integrator.md`
- [ ] `grep -q 'name: ralph-integrator' plugin/ralph-hero/agents/ralph-integrator.md`
- [ ] `grep -q 'model: sonnet' plugin/ralph-hero/agents/ralph-integrator.md`
- [ ] `grep -q 'advance_children' plugin/ralph-hero/agents/ralph-integrator.md`

#### Manual Verification
- [ ] Agent does NOT have Skill tool (operates directly, no skill composition)
- [ ] Agent does NOT have Write or Edit tools (no document/code creation)
- [ ] Spawn template follows <15 line rule

**Dependencies created for next phase**: All 4 worker agents exist. Integrator template exists. Orchestrators can now reference the new agents.

---

## Phase 6: #49 - Update ralph-team orchestrator for 4-worker spawning

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/49
> **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0049-update-ralph-team-orchestrator.md
> **Depends on**: Phases 2-5 (all 4 worker agents must exist)

### Overview

Update ralph-team SKILL.md spawn table, conventions.md pipeline handoff protocol, and hook script references to use the 4 new worker types.

### Changes Required

#### 1. Update ralph-team SKILL.md
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**:

**Frontmatter description** (line 2): Update from "triager, researcher, planner, reviewer, implementer" to "analyst, builder, validator, integrator":
```
description: Multi-agent team coordinator that spawns specialist workers (analyst, builder, validator, integrator) to process GitHub issues in parallel. Detects issue state, drives forward through state machine. Use when you want to run a team, start agent teams, or process issues with parallel agents.
```

**Section 4.2** -- Add conditional review task creation and Merge task:
- After "Create PR for #NNN" task, add: `"Merge PR for #NNN"` task blocked by the PR task
- Review task creation conditional on `RALPH_REVIEW_MODE`:
  - `interactive`: create "Review plan for #NNN" task, Implement blocked by Review
  - `skip` or `auto`: no Review task, Implement blocked by Plan

**Section 4.3** -- Update parallel spawn references:
- Change "up to 3 researchers" to "up to 3 analysts"

**Section 4.4** -- Update dispatch loop intake mapping:
- Change intake state references:
  - `Researcher -> "Research Needed"` becomes `Analyst -> "Backlog"` and `Analyst -> "Research Needed"`
  - `Planner -> "Ready for Plan"` becomes `Builder -> "Ready for Plan"`
  - `Reviewer -> "Plan in Review"` becomes `Validator -> "Plan in Review"` (interactive mode only)
  - `Implementer -> "In Progress"` becomes `Builder -> "In Progress"`
  - Add: `Integrator -> "In Review"`
  - `Triager -> "Backlog"` removed (covered by Analyst)

**Section 4.5** -- After PR creation, add step to create "Merge PR for #NNN" task for Integrator.

**Section 5** -- Update role references in behavioral principles.

**Section 6** -- Replace spawn table:

| Task subject contains | Role | Template | Agent type |
|----------------------|------|----------|------------|
| "Triage" | analyst | `triager.md` | ralph-analyst |
| "Split" | analyst | `splitter.md` | ralph-analyst |
| "Research" | analyst | `researcher.md` | ralph-analyst |
| "Plan" (not "Review") | builder | `planner.md` | ralph-builder |
| "Review" | validator | `reviewer.md` | ralph-validator |
| "Implement" | builder | `implementer.md` | ralph-builder |
| "Merge" or "Integrate" | integrator | `integrator.md` | ralph-integrator |

Update instance limits:
- **Analyst**: Up to 3 parallel (`analyst`, `analyst-2`, `analyst-3`)
- **Builder**: Up to 3 parallel if non-overlapping file ownership (`builder`, `builder-2`, `builder-3`)
- **Validator**: Single worker (`validator`)
- **Integrator**: Single worker, serialized on main (`integrator`)

Update naming convention:
- Single: `"analyst"`, `"builder"`, `"validator"`, `"integrator"`
- Multiple: `"analyst-2"`, `"analyst-3"`, `"builder-2"`, `"builder-3"`

**Section 9** -- Update known limitations:
- Change "Only triager has direct MCP access" to "Only analyst has direct MCP access"
- Change task subject list to include "Merge"

#### 2. Update shared conventions
**File**: `plugin/ralph-hero/skills/shared/conventions.md`
**Changes**:

**Pipeline Handoff Protocol -- Pipeline Order table**: Replace with:

| Current Role (agentType) | Next Stage | agentType to find |
|---|---|---|
| `ralph-analyst` | Builder | `ralph-builder` |
| `ralph-builder` (plan done) | Validator | `ralph-validator` (if `RALPH_REVIEW_MODE=interactive`) |
| `ralph-builder` (impl done) | Lead (PR creation) | `team-lead` |
| `ralph-validator` (approved) | Builder | `ralph-builder` |
| `ralph-validator` (rejected) | Builder (re-plan) | `ralph-builder` |

**Spawn Template Protocol -- Available templates line**: Update to:
```
Available templates: `triager`, `splitter`, `researcher`, `planner`, `reviewer`, `implementer`, `integrator`
```

**Spawn Template Protocol -- Template Naming Convention table**: Replace with:

| Agent type | Template |
|------------|----------|
| `ralph-analyst` agent (triage mode) | `triager.md` |
| `ralph-analyst` agent (split mode) | `splitter.md` |
| `ralph-analyst` agent (research mode) | `researcher.md` |
| `ralph-builder` agent (plan mode) | `planner.md` |
| `ralph-builder` agent (implement mode) | `implementer.md` |
| `ralph-validator` agent | `reviewer.md` |
| `ralph-integrator` agent | `integrator.md` |

#### 3. Update team-task-completed.sh
**File**: `plugin/ralph-hero/hooks/scripts/team-task-completed.sh`
**Changes**: Update guidance text on lines 25-27:
- Change "implementer" to "builder" in the review-approved guidance
- Change "planner" to "builder" in the NEEDS_ITERATION guidance

Specifically, update the review block (lines 22-27) to:
```bash
if echo "$TASK_SUBJECT" | grep -qi "review"; then
  cat >&2 <<EOF
Review task completed by $TEAMMATE: "$TASK_SUBJECT"
ACTION: TaskGet the completed task. Check verdict:
- APPROVED: peer handoff will wake builder. Verify worker exists.
- NEEDS_ITERATION: Create revision task with "Plan" in subject for builder.
EOF
```

### Success Criteria

#### Automated Verification
- [ ] `grep -q 'ralph-analyst' plugin/ralph-hero/skills/ralph-team/SKILL.md`
- [ ] `grep -q 'ralph-builder' plugin/ralph-hero/skills/ralph-team/SKILL.md`
- [ ] `grep -q 'ralph-integrator' plugin/ralph-hero/skills/ralph-team/SKILL.md`
- [ ] `grep -q 'ralph-analyst' plugin/ralph-hero/skills/shared/conventions.md`
- [ ] `grep -q 'integrator.md' plugin/ralph-hero/skills/shared/conventions.md`
- [ ] `grep -q 'builder' plugin/ralph-hero/hooks/scripts/team-task-completed.sh`

#### Manual Verification
- [ ] Spawn table has 7 rows mapping to 4 agent types
- [ ] Pipeline handoff table uses new worker names
- [ ] Convention naming table has 7 rows (4 agent types, 7 templates)

**Dependencies created for next phase**: Orchestrator uses new worker names. Conventions updated.

---

## Phase 7: #50 - Update ralph-hero orchestrator and scripts

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/50
> **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0050-hero-orchestrator-worker-update.md
> **Depends on**: Phases 2-5 (all 4 worker agents must exist)

### Overview

Update ralph-hero SKILL.md phase structure to use worker-scoped grouping. Update ralph-loop.sh with new CLI flags. Update ralph-team-loop.sh comments.

### Changes Required

#### 1. Update ralph-hero SKILL.md
**File**: `plugin/ralph-hero/skills/ralph-hero/SKILL.md`
**Changes**:

**State machine ASCII diagram** (lines 26-52): Replace with worker-scoped version:
```
+-------------------------------------------------------------------+
|                     RALPH HERO STATE MACHINE                       |
+-------------------------------------------------------------------+
|  START                                                             |
|    |                                                               |
|    v                                                               |
|  ANALYZE ROOT                                                      |
|    |                                                               |
|    v                                                               |
|  ANALYST PHASE                                                     |
|    |- SPLIT (if M/L/XL) -- loop until all XS/S                    |
|    |- RESEARCH (parallel) -- all "Research Needed" leaves          |
|    | all "Ready for Plan"                                          |
|    v                                                               |
|  BUILDER PHASE                                                     |
|    |- PLAN (per group) -- create implementation plans              |
|    |- REVIEW (if RALPH_REVIEW_MODE == "auto")                      |
|    |   | APPROVED -> continue                                      |
|    |   | NEEDS_ITERATION -> re-plan (loop)                         |
|    |- IMPLEMENT (sequential) -- execute plan phases                |
|    | all "In Review"                                               |
|    v                                                               |
|  VALIDATOR PHASE (if RALPH_REVIEW_MODE == "interactive")           |
|    |- HUMAN GATE: report and STOP                                  |
|    v                                                               |
|  INTEGRATOR PHASE                                                  |
|    |- Report PR URLs and "In Review" status                        |
|    |- (future: auto-merge if RALPH_AUTO_MERGE=true)                |
|    v                                                               |
|  COMPLETE                                                          |
+-------------------------------------------------------------------+
```

**Phase sections**: Rename headers to use worker-scoped names:
- "PHASE: EXPANDING" -> "PHASE: ANALYST - SPLIT"
- "PHASE: RESEARCHING" -> "PHASE: ANALYST - RESEARCH"
- "PHASE: PLANNING" -> "PHASE: BUILDER - PLAN"
- "PHASE: REVIEWING (Optional)" -> "PHASE: BUILDER - REVIEW / VALIDATOR - REVIEW"
- "HUMAN GATE" -> "PHASE: VALIDATOR - HUMAN GATE"
- "PHASE: IMPLEMENTING" -> "PHASE: BUILDER - IMPLEMENT"
- Add new section "PHASE: INTEGRATOR - COMPLETE" after implementing (report PRs, future merge)

Phase content stays the same -- only headers and the introductory description lines change.

#### 2. Update ralph-loop.sh
**File**: `plugin/ralph-hero/scripts/ralph-loop.sh`
**Changes**:

**Usage comment** (line 3): Add new flags:
```bash
# Usage: ./scripts/ralph-loop.sh [--triage-only|--split-only|--research-only|--plan-only|--review-only|--impl-only]
#        ./scripts/ralph-loop.sh [--analyst-only|--builder-only|--validator-only|--integrator-only]
```

**Argument parsing** (line 29): Add new cases:
```bash
--analyst-only|--builder-only|--validator-only|--integrator-only)
    MODE="$arg"
    ;;
```

**Phase execution blocks**: Group under worker headings and add new mode checks. Keep existing `--*-only` flags working alongside new `--*-only` flags:

```bash
# === ANALYST PHASE ===

# Triage phase
if [ "$MODE" = "all" ] || [ "$MODE" = "--triage-only" ] || [ "$MODE" = "--analyst-only" ]; then
    echo "--- Analyst: Triage Phase ---"
    run_claude "/ralph-triage" "triage"
    work_done=true
fi

# Split phase
if [ "$MODE" = "all" ] || [ "$MODE" = "--split-only" ] || [ "$MODE" = "--analyst-only" ]; then
    if [ "$SPLIT_MODE" != "skip" ]; then
        echo "--- Analyst: Split Phase (mode: $SPLIT_MODE) ---"
        run_claude "/ralph-split" "split"
        work_done=true
    else
        echo "--- Analyst: Split Phase: SKIPPED (--split=skip) ---"
    fi
fi

# Research phase
if [ "$MODE" = "all" ] || [ "$MODE" = "--research-only" ] || [ "$MODE" = "--analyst-only" ]; then
    echo "--- Analyst: Research Phase ---"
    run_claude "/ralph-research" "research"
    work_done=true
fi

# === BUILDER PHASE ===

# Planning phase
if [ "$MODE" = "all" ] || [ "$MODE" = "--plan-only" ] || [ "$MODE" = "--builder-only" ]; then
    echo "--- Builder: Planning Phase ---"
    run_claude "/ralph-plan" "plan"
    work_done=true
fi

# Review phase (optional)
if [ "$MODE" = "all" ] || [ "$MODE" = "--review-only" ] || [ "$MODE" = "--builder-only" ] || [ "$MODE" = "--validator-only" ]; then
    if [ "$REVIEW_MODE" != "skip" ]; then
        echo "--- Review Phase (mode: $REVIEW_MODE) ---"
        if [ "$REVIEW_MODE" = "interactive" ]; then
            export RALPH_INTERACTIVE="true"
        else
            export RALPH_INTERACTIVE="false"
        fi
        run_claude "/ralph-review" "review"
        work_done=true
    else
        echo "--- Review Phase: SKIPPED (--review=skip) ---"
    fi
fi

# Implementation phase
if [ "$MODE" = "all" ] || [ "$MODE" = "--impl-only" ] || [ "$MODE" = "--builder-only" ]; then
    echo "--- Builder: Implementation Phase ---"
    run_claude "/ralph-impl" "implement"
    work_done=true
fi

# === INTEGRATOR PHASE ===
if [ "$MODE" = "all" ] || [ "$MODE" = "--integrator-only" ]; then
    echo "--- Integrator Phase (report only) ---"
    # Future: run_claude "/ralph-integrate" "integrate"
fi
```

#### 3. Update ralph-team-loop.sh
**File**: `plugin/ralph-hero/scripts/ralph-team-loop.sh`
**Changes**: Update comment on line 7:
```bash
# Launches the team coordinator skill which spawns specialized workers
# for each pipeline phase (analyst, builder, validator, integrator).
```

### Success Criteria

#### Automated Verification
- [ ] `grep -q 'ANALYST PHASE' plugin/ralph-hero/skills/ralph-hero/SKILL.md`
- [ ] `grep -q 'BUILDER PHASE' plugin/ralph-hero/skills/ralph-hero/SKILL.md`
- [ ] `grep -q 'INTEGRATOR PHASE' plugin/ralph-hero/skills/ralph-hero/SKILL.md`
- [ ] `grep -q 'analyst-only' plugin/ralph-hero/scripts/ralph-loop.sh`
- [ ] `grep -q 'builder-only' plugin/ralph-hero/scripts/ralph-loop.sh`
- [ ] `grep -q 'integrator-only' plugin/ralph-hero/scripts/ralph-loop.sh`
- [ ] `bash -n plugin/ralph-hero/scripts/ralph-loop.sh` (syntax check passes)
- [ ] `bash -n plugin/ralph-hero/scripts/ralph-team-loop.sh` (syntax check passes)

#### Manual Verification
- [ ] Old CLI flags (`--triage-only`, `--plan-only`, etc.) still work
- [ ] New CLI flags (`--analyst-only`, `--builder-only`) trigger correct phase groups
- [ ] ralph-hero SKILL.md phase headers use worker-scoped names

**Dependencies created for next phase**: Orchestrators and scripts use new worker terminology.

---

## Phase 8: #51 - Clean up legacy agent definitions and old spawn templates

> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/51
> **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0051-legacy-cleanup.md
> **Depends on**: Phases 2-7 (all new workers and orchestrator updates must be in place)

### Overview

Remove the 5 old agent definitions and 6 old spawn templates. Update README.md and workspace CLAUDE.md references. Verify no stale references remain.

### Changes Required

#### 1. Delete old agent definitions
**Files to delete** (via `git rm`):
- `plugin/ralph-hero/agents/ralph-triager.md`
- `plugin/ralph-hero/agents/ralph-researcher.md`
- `plugin/ralph-hero/agents/ralph-planner.md`
- `plugin/ralph-hero/agents/ralph-advocate.md`
- `plugin/ralph-hero/agents/ralph-implementer.md`

#### 2. Delete old spawn templates
**Files to delete** (via `git rm`):
- `plugin/ralph-hero/templates/spawn/triager.md`
- `plugin/ralph-hero/templates/spawn/splitter.md`
- `plugin/ralph-hero/templates/spawn/researcher.md`
- `plugin/ralph-hero/templates/spawn/planner.md`
- `plugin/ralph-hero/templates/spawn/reviewer.md`
- `plugin/ralph-hero/templates/spawn/implementer.md`

#### 3. Update README.md
**File**: `plugin/ralph-hero/README.md`
**Changes**: Update the directory structure diagram in the agents section. Replace:
```
├── ralph-triager.md
├── ralph-researcher.md
├── ralph-planner.md
├── ralph-advocate.md
└── ralph-implementer.md
```
With:
```
├── ralph-analyst.md
├── ralph-builder.md
├── ralph-validator.md
└── ralph-integrator.md
```

Also update the templates section. Replace the 6 old template names with 1 remaining + 1 new:
```
└── integrator.md
```

Note: The old templates (`triager.md`, `splitter.md`, etc.) are deleted in this phase. The ralph-team spawn table (updated in Phase 6) now maps task subjects to agent types, and the existing templates that were being reused are no longer needed since the old agents are gone. However, the spawn table in Phase 6 still references `triager.md`, `researcher.md`, etc. This creates a conflict.

**Resolution**: The spawn templates referenced in Phase 6 MUST continue to exist for the spawn table to work. Since the templates are agent-type-agnostic (they invoke skills, not agent-specific logic), they should NOT be deleted. Only delete the old agent definitions (5 files). The spawn templates stay.

**Revised deletion list**:
- Delete 5 old agent definitions (as listed above)
- Do NOT delete spawn templates -- they are still referenced by the spawn table
- This aligns with the research finding: "Existing spawn templates can be REUSED as-is"

#### 4. Update workspace CLAUDE.md
**File**: `/home/chad_a_dubiel/projects/CLAUDE.md`
**Changes**:
- Line with `/ralph_team` description: Update "triager, researcher, planner, reviewer, implementer" to "analyst, builder, validator, integrator"
- Supporting Agents table: Replace old agent names with new worker names:

| Agent | Purpose |
|-------|---------|
| `ralph-analyst` | Analysis worker - triage, split, research |
| `ralph-builder` | Build worker - plan, implement, self-review |
| `ralph-validator` | Quality gate - plan critique, future quality validation |
| `ralph-integrator` | Integration - PR merge, git ops, worktree cleanup |

#### 5. Verification scan
Run grep to confirm no stale references:
```bash
grep -r "ralph-triager\|ralph-researcher\|ralph-planner\|ralph-advocate\|ralph-implementer" \
  plugin/ CLAUDE.md --include="*.md" --include="*.sh" --include="*.json" \
  | grep -v "thoughts/"
```
Expected: no results (all references updated or removed).

### Success Criteria

#### Automated Verification
- [ ] `test ! -f plugin/ralph-hero/agents/ralph-triager.md`
- [ ] `test ! -f plugin/ralph-hero/agents/ralph-researcher.md`
- [ ] `test ! -f plugin/ralph-hero/agents/ralph-planner.md`
- [ ] `test ! -f plugin/ralph-hero/agents/ralph-advocate.md`
- [ ] `test ! -f plugin/ralph-hero/agents/ralph-implementer.md`
- [ ] `test -f plugin/ralph-hero/agents/ralph-analyst.md`
- [ ] `test -f plugin/ralph-hero/agents/ralph-builder.md`
- [ ] `test -f plugin/ralph-hero/agents/ralph-validator.md`
- [ ] `test -f plugin/ralph-hero/agents/ralph-integrator.md`
- [ ] Stale reference grep returns 0 matches (excluding thoughts/)

#### Manual Verification
- [ ] README.md directory diagram shows new agent names
- [ ] Workspace CLAUDE.md Supporting Agents table uses new worker names
- [ ] Plugin loads correctly after cleanup

**Dependencies created for next phase**: None -- this is the final phase.

---

## Integration Testing

After all phases complete:
- [ ] Run `bash -n plugin/ralph-hero/scripts/ralph-loop.sh` and `bash -n plugin/ralph-hero/scripts/ralph-team-loop.sh` -- both pass syntax check
- [ ] Run stale reference scan: `grep -r "ralph-triager\|ralph-researcher\|ralph-planner\|ralph-advocate\|ralph-implementer" plugin/ CLAUDE.md --include="*.md" --include="*.sh" --include="*.json" | grep -v "thoughts/"` -- returns empty
- [ ] Verify all 4 new agent files exist and have valid frontmatter (name, tools, model, color)
- [ ] Verify spawn table in ralph-team SKILL.md has 7 rows mapping to 4 agent types
- [ ] Verify pipeline handoff table in conventions.md uses new worker names
- [ ] Verify no existing skills were modified: `git diff --name-only plugin/ralph-hero/skills/ralph-{triage,split,research,plan,review,impl}/` returns empty

## References

- Research documents:
  - [#44 Research - Worker scope boundaries](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0044-worker-scope-boundaries.md)
  - [#45 Research - Analyst worker](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0045-analyst-worker-agent.md)
  - [#46 Research - Builder worker](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0046-builder-worker-agent.md)
  - [#47 Research - Validator worker](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0047-validator-worker-agent.md)
  - [#48 Research - Integrator worker](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0048-integrator-worker-agent.md)
  - [#49 Research - ralph-team updates](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0049-update-ralph-team-orchestrator.md)
  - [#50 Research - ralph-hero updates](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0050-hero-orchestrator-worker-update.md)
  - [#51 Research - Legacy cleanup](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0051-legacy-cleanup.md)
- Epic: [#40 - Consolidate agents into scope-bounded workers](https://github.com/cdubiel08/ralph-hero/issues/40)
- State machine: [`plugin/ralph-hero/hooks/scripts/ralph-state-machine.json`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/ralph-state-machine.json)
- Existing agents: [`plugin/ralph-hero/agents/`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/)
- Existing skills: [`plugin/ralph-hero/skills/`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/)
- Spawn templates: [`plugin/ralph-hero/templates/spawn/`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/)
