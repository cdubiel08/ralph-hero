---
date: 2026-02-17
github_issue: 44
github_url: https://github.com/cdubiel08/ralph-hero/issues/44
status: complete
type: research
---

# Worker Scope Boundaries and State Ownership Map

## Problem Statement

Ralph currently has 7 specialized agents (triager, researcher, planner, advocate, implementer, plus team-lead and hero orchestrators), each handling a single state transition. Epic #40 proposes consolidating these into 4 scope-bounded workers (Analyst, Builder, Validator, Integrator) where each worker loops over multiple skills within its state range. This research maps the current system and defines the exact boundaries for each proposed worker.

## Current State Analysis

### Existing Agents (5 worker agents + 2 orchestrators)

| Agent | File | Model | Skills Invoked | State Range |
|-------|------|-------|----------------|-------------|
| ralph-triager | `agents/ralph-triager.md` | sonnet | `ralph-triage`, `ralph-split` | Backlog |
| ralph-researcher | `agents/ralph-researcher.md` | sonnet | `ralph-research` | Research Needed -> Ready for Plan |
| ralph-planner | `agents/ralph-planner.md` | opus | `ralph-plan` | Ready for Plan -> Plan in Review |
| ralph-advocate | `agents/ralph-advocate.md` | opus | `ralph-review` | Plan in Review -> In Progress / Ready for Plan |
| ralph-implementer | `agents/ralph-implementer.md` | sonnet | `ralph-impl` | In Progress -> In Review |

**Orchestrators** (not worker agents -- coordinate only):
| Agent | Skills Invoked | Role |
|-------|----------------|------|
| ralph-team (SKILL.md) | Delegates to all worker agents | Team coordinator, PR creation |
| ralph-hero (SKILL.md) | Delegates to all skills via Task() | Single-threaded orchestrator |

### Existing Skills (8 skills + 1 shared conventions)

| Skill | File | Purpose | Input State(s) | Output State(s) | Creates Artifacts |
|-------|------|---------|----------------|-----------------|-------------------|
| ralph-triage | `skills/ralph-triage/SKILL.md` | Assess backlog issue | Backlog | Research Needed, Ready for Plan, Done, Canceled, Human Needed | None (comments only) |
| ralph-split | `skills/ralph-split/SKILL.md` | Decompose M/L/XL into XS/S | Backlog, Research Needed | Backlog (parent stays, children created) | Sub-issues |
| ralph-research | `skills/ralph-research/SKILL.md` | Investigate ticket | Research Needed | Ready for Plan, Human Needed | `thoughts/shared/research/*.md` |
| ralph-plan | `skills/ralph-plan/SKILL.md` | Create implementation plan | Ready for Plan | Plan in Review, Human Needed | `thoughts/shared/plans/*.md` |
| ralph-review | `skills/ralph-review/SKILL.md` | Review plan quality | Plan in Review | In Progress, Ready for Plan, Human Needed | `thoughts/shared/reviews/*.md` |
| ralph-impl | `skills/ralph-impl/SKILL.md` | Execute plan phases | In Progress (also Plan in Review for entry) | In Progress, In Review, Human Needed | Worktree, branch, commits, PR |
| ralph-hero | `skills/ralph-hero/SKILL.md` | Tree-expansion orchestrator | Any | Any (delegates) | None directly |
| ralph-team | `skills/ralph-team/SKILL.md` | Team coordinator | Any | Any (delegates) | PR creation |
| ralph-setup | `skills/ralph-setup/SKILL.md` | One-time project setup | N/A | N/A | Project config |

### Workflow States (from `ralph-state-machine.json`)

11 states total, ordered in pipeline progression:

| # | State | Description | Lock? | Terminal? | Human? | Command Producers | Command Consumers |
|---|-------|-------------|-------|-----------|--------|-------------------|-------------------|
| 1 | Backlog | Awaiting triage | No | No | No | `ralph_triage`, `ralph_split` | `ralph_triage`, `ralph_split` |
| 2 | Research Needed | Needs investigation | No | No | No | `ralph_triage` | `ralph_research`, `ralph_split` |
| 3 | Research in Progress | Investigation underway | **Yes** | No | No | `ralph_research` | -- |
| 4 | Ready for Plan | Research complete | No | No | No | `ralph_research` | `ralph_plan` |
| 5 | Plan in Progress | Plan being written | **Yes** | No | No | `ralph_plan` | -- |
| 6 | Plan in Review | Plan awaiting approval | No | No | Yes | `ralph_plan`, `ralph_review` | `ralph_review` |
| 7 | In Progress | Implementation underway | **Yes** | No | No | (manual or `ralph_review`) | `ralph_impl` |
| 8 | In Review | PR awaiting code review | No | No | Yes | `ralph_impl` | -- |
| 9 | Done | Completed and merged | No | **Yes** | No | `ralph_triage`, `ralph_impl` | -- |
| 10 | Canceled | Superseded | No | **Yes** | No | `ralph_triage` | -- |
| 11 | Human Needed | Escalated | No | No | **Yes** | Any (`*`) | -- |

### MCP Tools

| Tool Module | Tools | Purpose |
|-------------|-------|---------|
| `issue-tools.ts` | `list_issues`, `get_issue`, `create_issue`, `update_issue`, `update_workflow_state`, `update_estimate`, `update_priority`, `create_comment`, `detect_pipeline_position`, `check_convergence`, `pick_actionable_issue` | Issue CRUD + workflow state management |
| `project-tools.ts` | `setup_project`, `get_project`, `list_project_items` | Project V2 management |
| `relationship-tools.ts` | `add_sub_issue`, `list_sub_issues`, `add_dependency`, `remove_dependency`, `list_dependencies`, `detect_group`, `advance_children` | Issue relationships and group detection |
| `view-tools.ts` | `list_views`, `update_field_options` | View management |

### Semantic State Intents

The state machine uses semantic intents that resolve per-command:

| Intent | ralph_research | ralph_plan | ralph_impl | ralph_review | ralph_triage |
|--------|---------------|------------|------------|--------------|--------------|
| `__LOCK__` | Research in Progress | Plan in Progress | In Progress | -- | -- |
| `__COMPLETE__` | Ready for Plan | Plan in Review | In Review | In Progress | -- |
| `__ESCALATE__` | Human Needed | Human Needed | Human Needed | Human Needed | Human Needed |

## Proposed Worker Scope Boundaries

### Worker 1: Analyst

**Replaces**: ralph-triager + ralph-researcher

**Owned States**: Backlog, Research Needed, Research in Progress

**State Range**: Backlog -> Ready for Plan (hands off at Ready for Plan)

**Skills Composed**:
- `ralph-triage` (assess, close, re-estimate, route to research)
- `ralph-split` (decompose M/L/XL into XS/S sub-issues)
- `ralph-research` (investigate, document findings)

**Worker Loop Pseudocode**:
```
function analystLoop(issue):
    while true:
        state = readWorkflowState(issue)
        if state NOT IN {Backlog, Research Needed, Research in Progress}:
            break  # out of scope, hand off

        switch state:
            case Backlog:
                result = ralph_triage(issue)
                if result.action == SPLIT:
                    ralph_split(issue)
                # triage moves to Research Needed, Ready for Plan, Done, etc.

            case Research Needed:
                estimate = readEstimate(issue)
                if estimate IN {M, L, XL}:
                    ralph_split(issue)  # too large, split first
                else:
                    ralph_research(issue)  # moves to Ready for Plan

            case Research in Progress:
                # locked by current session, continue research
                ralph_research(issue)  # resume
```

**Artifacts Created**:
- Research documents: `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-*.md`
- Sub-issues (via split)
- Dependency relationships (via triage grouping)

**MCP Tools Used** (from existing agent definitions):
- `get_issue`, `list_issues`, `update_issue`, `update_workflow_state`, `update_estimate`, `update_priority`
- `create_issue`, `create_comment`, `add_sub_issue`, `add_dependency`, `remove_dependency`
- `list_sub_issues`, `list_dependencies`, `detect_group`

**Isolation**: Read-only codebase access + document writes to `thoughts/`. No file contention possible. Multiple Analysts can run in parallel on different issues.

**Branch Requirement**: Must be on `main` (same as triager + researcher today).

---

### Worker 2: Builder

**Replaces**: ralph-planner + ralph-implementer (absorbs self-review for own code)

**Owned States**: Ready for Plan, Plan in Progress, Plan in Review, In Progress

**State Range**: Ready for Plan -> In Review (hands off at In Review)

**Skills Composed**:
- `ralph-plan` (create implementation plan from research)
- `ralph-impl` (execute plan phases, create PR)
- (future: lightweight self-review before requesting external review)

**Worker Loop Pseudocode**:
```
function builderLoop(issue):
    while true:
        state = readWorkflowState(issue)
        if state NOT IN {Ready for Plan, Plan in Progress, Plan in Review, In Progress}:
            break  # out of scope, hand off

        switch state:
            case Ready for Plan:
                ralph_plan(issue)  # moves to Plan in Review

            case Plan in Progress:
                ralph_plan(issue)  # resume locked plan

            case Plan in Review:
                # Builder owns this state for the happy path (auto-approve)
                # In RALPH_REVIEW_MODE=skip, Builder auto-progresses to In Progress
                # In RALPH_REVIEW_MODE=auto, Builder runs self-review then progresses
                ralph_review(issue)  # or auto-approve -> move to In Progress

            case In Progress:
                ralph_impl(issue)  # execute one phase
                # if not last phase, stays In Progress -> loop
                # if last phase, moves to In Review -> break
```

**Important Design Decision -- Plan in Review Ownership**:

Plan in Review sits at the boundary between Builder and Validator. The proposed ownership is:
- **Builder** owns Plan in Review for the happy path: when `RALPH_REVIEW_MODE=skip` (default), the Builder auto-progresses plans through review. When `RALPH_REVIEW_MODE=auto`, the Builder runs a self-review critique before progressing.
- **Validator** can observe Plan in Review but only acts on it in `RALPH_REVIEW_MODE=interactive` (human review) or when the Builder's self-review flags issues.

This avoids a handoff for the most common case (auto-approved plans) while preserving the ability for the Validator to intervene when quality gates are needed.

**Artifacts Created**:
- Plan documents: `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-*.md`
- Worktrees: `worktrees/GH-NNN/`
- Feature branches, commits
- Pull requests

**MCP Tools Used**:
- `get_issue`, `list_issues`, `update_issue`, `update_workflow_state`
- `create_comment`, `detect_group`, `list_sub_issues`, `list_dependencies`

**Isolation**: Worktree per issue/group. Plan documents committed to main. Multiple Builders can run in parallel on different issues via worktree isolation.

**Branch Requirement**: `main` for planning, worktree branch for implementation.

---

### Worker 3: Validator

**Replaces**: ralph-advocate (expanded to include quality gates)

**Owned States**: (none exclusively -- observes Plan in Review and In Review)

**State Range**: Plan in Review -> In Progress (review verdict), In Review -> Done (future: merge approval)

**Skills Composed**:
- `ralph-review` (plan critique -- only in `RALPH_REVIEW_MODE=interactive` or when Builder escalates)
- (future: `ralph-test` -- run test suites, visual regression)
- (future: `ralph-quality-gate` -- lint, type check, coverage thresholds)

**Worker Loop Pseudocode**:
```
function validatorLoop(issue):
    while true:
        state = readWorkflowState(issue)

        switch state:
            case Plan in Review:
                if RALPH_REVIEW_MODE == "interactive":
                    ralph_review(issue)  # human-assisted review
                else:
                    break  # Builder handles auto-review

            case In Review:
                # Future: run automated quality gates
                # For now: PR is created, awaiting human code review
                break  # out of scope until quality gates exist

            default:
                break  # not our scope
```

**Key Difference from Current System**: Today, the advocate is mandatory in the pipeline (Plan in Review -> In Progress). In the new architecture, the Validator is **optional** -- the Builder handles the happy path. The Validator only activates for:
1. Interactive review mode (human in the loop)
2. Quality gate failures (future)
3. Escalation from Builder self-review

**Artifacts Created**:
- Critique documents: `thoughts/shared/reviews/YYYY-MM-DD-GH-NNNN-critique.md`

**MCP Tools Used**:
- `get_issue`, `list_issues`, `update_issue`, `update_workflow_state`
- `create_comment`

**Isolation**: Read-only access to worktrees + CI. No file contention.

**Branch Requirement**: `main` (review is read-only analysis).

---

### Worker 4: Integrator

**Replaces**: (new -- currently handled by ralph-team lead and ralph-impl PR creation)

**Owned States**: In Review (for merge operations only)

**State Range**: In Review -> Done (merge, deploy, git cleanup)

**Skills Composed**:
- (future: `ralph-merge` -- merge PR after review approval)
- (future: `ralph-deploy` -- trigger deployment pipeline)
- (future: `ralph-git-ops` -- clean up worktrees, branches after merge)

**Worker Loop Pseudocode**:
```
function integratorLoop(issue):
    while true:
        state = readWorkflowState(issue)

        switch state:
            case In Review:
                # Check if PR has been approved
                pr = findLinkedPR(issue)
                if pr.approved:
                    mergePR(pr)
                    cleanupWorktree(issue)
                    updateWorkflowState(issue, "Done")
                else:
                    break  # waiting for approval

            default:
                break  # not our scope
```

**Key Consideration**: The Integrator is **serialized on main branch**. Only one Integrator should merge at a time to prevent merge conflicts. This is a natural constraint since merges must be sequential.

**Current Gap**: Today, PR merge and worktree cleanup are manual steps (the team lead creates the PR, but merge/cleanup are done by the human). The Integrator worker would automate this final mile.

**Artifacts Created**:
- Merged PRs
- Cleaned up worktrees and branches

**MCP Tools Used**:
- `get_issue`, `update_workflow_state`, `create_comment`
- `advance_children` (to update parent epic when children complete)

**Isolation**: Serialized access to main branch. Only one Integrator active at a time.

**Branch Requirement**: `main` exclusively.

## Complete State Ownership Map

| State | Owner | Skills Active | Contention Risk | Notes |
|-------|-------|--------------|-----------------|-------|
| **Backlog** | Analyst | triage, split | None (parallel per issue) | Entry point for all new issues |
| **Research Needed** | Analyst | research, split | None (parallel per issue) | May trigger split if M/L/XL |
| **Research in Progress** | Analyst | research (locked) | None (lock prevents others) | Lock state -- single session |
| **Ready for Plan** | Builder | plan | None (parallel per issue) | Convergence gate for groups |
| **Plan in Progress** | Builder | plan (locked) | None (lock prevents others) | Lock state -- single session |
| **Plan in Review** | Builder (primary) / Validator (interactive) | review | **Contention point** -- see below | Dual ownership requires protocol |
| **In Progress** | Builder | impl (locked) | None (worktree isolation) | Lock state -- single session |
| **In Review** | Integrator | merge, git ops | **Serialized** (one at a time on main) | Waiting for human PR approval |
| **Done** | None | -- | None | Terminal state |
| **Canceled** | None | -- | None | Terminal state |
| **Human Needed** | None (human) | -- | None | Escalation state -- any worker can produce |

## Contention Points and Resolution

### 1. Plan in Review -- Dual Ownership

**Problem**: Both Builder and Validator can act on Plan in Review.

**Resolution Protocol**:
- `RALPH_REVIEW_MODE=skip` (default): Builder auto-progresses. Validator does not activate.
- `RALPH_REVIEW_MODE=auto`: Builder runs self-review via `ralph-review` skill in AUTO mode. If APPROVED, Builder progresses to In Progress. If NEEDS_ITERATION, Builder re-plans.
- `RALPH_REVIEW_MODE=interactive`: Validator activates for human-in-the-loop review. Builder waits.

**Implementation**: The `RALPH_REVIEW_MODE` environment variable acts as the ownership switch. Only one worker acts at a time per mode.

### 2. In Review -- Merge Serialization

**Problem**: Multiple issues may reach In Review simultaneously, but merges must be sequential.

**Resolution Protocol**:
- Integrator processes one PR at a time
- Queue is implicit: pick highest-priority In Review issue, merge, repeat
- If merge conflicts arise, the Integrator escalates to Human Needed

### 3. Backlog -> Research Needed Handoff (Within Analyst)

**Problem**: Triage may route to Research Needed, which is still within the Analyst scope. Is this a handoff or a loop iteration?

**Resolution**: This is a **loop iteration**, not a handoff. The Analyst's loop detects the new state and selects the appropriate skill. No inter-worker communication needed.

## State Transition Handoff Protocol

Worker-to-worker handoffs occur at **exactly 3 boundaries** (down from 6+ today):

| Boundary | From Worker | To Worker | Trigger State | Handoff Mechanism |
|----------|-------------|-----------|---------------|-------------------|
| 1 | Analyst | Builder | Ready for Plan | Analyst's loop ends; Builder picks up from queue |
| 2 | Builder | Integrator | In Review | Builder creates PR, moves to In Review; Integrator picks up |
| 3 | Validator | Builder | Ready for Plan (rejected) | Validator moves plan back to Ready for Plan with needs-iteration label; Builder re-plans |

**Handoff Mechanism**: No explicit messaging required. Workers poll their owned states:
- Analyst watches: Backlog, Research Needed
- Builder watches: Ready for Plan, Plan in Review, In Progress
- Validator watches: Plan in Review (interactive mode only), In Review (future quality gates)
- Integrator watches: In Review

The GitHub Projects V2 workflow state IS the handoff mechanism. State change = handoff complete.

## Mapping: Current Agents to New Workers

| Current Agent | New Worker | Skills Carried | Skills Dropped | Notes |
|---------------|------------|---------------|----------------|-------|
| ralph-triager | **Analyst** | triage, split | -- | Gains research capability |
| ralph-researcher | **Analyst** | research | -- | Merged with triager |
| ralph-planner | **Builder** | plan | -- | Gains implementation capability |
| ralph-advocate | **Validator** | review | -- | Becomes optional (Builder self-reviews) |
| ralph-implementer | **Builder** | impl | -- | Merged with planner |
| (new) | **Integrator** | -- | -- | Entirely new -- merge, deploy, git ops |

## Worker Instance Limits

| Worker | Max Parallel Instances | Reason |
|--------|----------------------|--------|
| Analyst | 3 | Parallel per issue, read-only + docs |
| Builder | 3 | Parallel per issue, worktree isolation |
| Validator | 1 | Review is sequential per issue |
| Integrator | 1 | **Serialized** on main branch |

## Impact on Orchestrators

### ralph-team (Team Coordinator)

Currently spawns: triager, researcher, planner, reviewer, implementer (5 agents)
Will spawn: analyst, builder, validator (optional), integrator (3-4 workers)

Key changes:
- Section 6 spawn templates reduce from 6 to 4
- Pipeline handoff table simplifies (3 handoffs instead of 4)
- Dispatch loop checks 4 worker states instead of 5 agent states
- `pick_actionable_issue` queries map to worker scopes, not individual agent scopes

### ralph-hero (Solo Orchestrator)

Currently delegates: split, research, plan, review, impl (5 skills via Task())
Will delegate: analyst-loop, builder-loop, validator-check, integrator-merge (4 worker invocations)

Key changes:
- EXPANDING, RESEARCHING phases collapse into ANALYST phase
- PLANNING, IMPLEMENTING phases collapse into BUILDER phase
- REVIEWING phase becomes conditional (VALIDATOR only in interactive mode)
- COMPLETE phase maps to INTEGRATOR

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Builder context window exhaustion (plan + impl in one session) | Medium | Skills are forked via Task(). Each skill gets a fresh context. The Builder loop is thin. |
| Plan in Review dual ownership confusion | Low | `RALPH_REVIEW_MODE` env var is deterministic. Only one path active at a time. |
| Integrator blocking pipeline (slow merge) | Low | Integrator is async. Builder completes and moves on. |
| Loss of specialist expertise (advocate becomes optional) | Medium | Builder's self-review uses the same `ralph-review` skill with the same criteria. Quality preserved. |
| Migration complexity (7 agents -> 4 workers) | Medium | Incremental migration: create new workers, run in parallel with old agents, phase out old agents. |

## Recommended Next Steps

1. Create worker agent definitions (#45-#48) based on this scope map
2. Update spawn templates to match 4-worker model (#49)
3. Update orchestrator dispatch logic (#49, #50)
4. Deprecate old agent definitions (#51)
5. Add `ralph-merge` and `ralph-git-ops` skills for Integrator (future issue)
