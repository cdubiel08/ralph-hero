---
date: 2026-02-17
github_issue: 44
github_url: https://github.com/cdubiel08/ralph-hero/issues/44
status: complete
type: design
---

# Worker Scope Boundaries and State Ownership Map

Reference document for the 4-worker architecture (epic #40). Defines state ownership, skill composition, conflict avoidance, and handoff protocols.

## State Ownership Map

All 11 workflow states from `ralph-state-machine.json` assigned to exactly one worker type.

| State | Owner | Lock? | Terminal? | Skills Active |
|-------|-------|-------|-----------|---------------|
| Backlog | **Analyst** | No | No | `ralph-triage`, `ralph-split` |
| Research Needed | **Analyst** | No | No | `ralph-research`, `ralph-split` |
| Research in Progress | **Analyst** | Yes | No | `ralph-research` (resume) |
| Ready for Plan | **Builder** | No | No | `ralph-plan` |
| Plan in Progress | **Builder** | Yes | No | `ralph-plan` (resume) |
| Plan in Review | **Builder** (primary) | No | No | `ralph-review` (self-review) |
| In Progress | **Builder** | Yes | No | `ralph-impl` |
| In Review | **Integrator** | No | No | merge, git ops (direct CLI) |
| Done | None | No | Yes | -- |
| Canceled | None | No | Yes | -- |
| Human Needed | None (human) | No | No | -- |

### Plan in Review Dual Ownership Resolution

Plan in Review has conditional ownership controlled by `RALPH_REVIEW_MODE`:

| Mode | Owner | Behavior |
|------|-------|----------|
| `skip` (default) | Builder | Auto-progresses to In Progress |
| `auto` | Builder | Runs `ralph-review` in self-review mode, then progresses |
| `interactive` | Validator | Human-in-the-loop review via `ralph-review` |

Only one worker acts on Plan in Review at a time per mode.

## Skill-to-Worker Mapping

All 6 existing skills mapped to exactly one worker.

| Worker | Skills | Notes |
|--------|--------|-------|
| **Analyst** | `ralph-triage`, `ralph-split`, `ralph-research` | Triage routes; split decomposes; research investigates |
| **Builder** | `ralph-plan`, `ralph-impl`, `ralph-review` (self-review) | Plan creates; impl executes; review in auto/skip mode only |
| **Validator** | `ralph-review` (external critique) | Only in `RALPH_REVIEW_MODE=interactive` |
| **Integrator** | None (direct `gh` CLI operations) | Merge PR, delete branch, clean worktree |

Orchestrator skills (`ralph-hero`, `ralph-team`, `ralph-setup`) are not worker-owned -- they coordinate workers.

## Worker Loop Patterns

### Analyst Loop

```
function analystLoop(issue):
    while state IN {Backlog, Research Needed, Research in Progress}:
        state = readWorkflowState(issue)
        switch state:
            Backlog       -> ralph_triage(issue)    # routes to Research Needed, Ready for Plan, Done, Canceled
            Research Needed:
                if estimate IN {M, L, XL} -> ralph_split(issue)
                else                      -> ralph_research(issue)  # moves to Ready for Plan
            Research in Progress -> ralph_research(issue)  # resume locked session
```

### Builder Loop

```
function builderLoop(issue):
    while state IN {Ready for Plan, Plan in Progress, Plan in Review, In Progress}:
        state = readWorkflowState(issue)
        switch state:
            Ready for Plan    -> ralph_plan(issue)     # moves to Plan in Review
            Plan in Progress  -> ralph_plan(issue)     # resume locked session
            Plan in Review    -> ralph_review(issue)   # self-review (auto/skip mode)
            In Progress       -> ralph_impl(issue)     # execute one phase; stays In Progress or moves to In Review
```

### Validator Loop

```
function validatorLoop(issue):
    state = readWorkflowState(issue)
    if state == Plan in Review AND RALPH_REVIEW_MODE == "interactive":
        ralph_review(issue)  # human-assisted critique
    # else: no action (Builder handles or state not in scope)
```

### Integrator Loop

```
function integratorLoop(issue):
    state = readWorkflowState(issue)
    if state == In Review:
        pr = findLinkedPR(issue)
        if pr.approved:
            gh pr merge --merge --delete-branch
            scripts/remove-worktree.sh GH-NNN
            update_workflow_state(issue, "Done")
            advance_children(epicNumber)  # if epic member
        # else: waiting for approval, go idle
```

## Conflict Avoidance Rules

### 1. State Ownership Lock

Each state is owned by exactly one worker type. Lock states (`Research in Progress`, `Plan in Progress`, `In Progress`) prevent concurrent access -- only the locking session can resume work.

### 2. Worktree Isolation

Builder uses worktrees per issue/group (`worktrees/GH-NNN/`). Multiple Builders run in parallel on different issues without file contention.

### 3. Main Branch Serialization

Integrator merges one PR at a time on main. Queue is implicit: pick highest-priority In Review issue, merge, repeat. If merge conflicts arise, escalate to Human Needed.

### 4. Plan in Review Protocol

Resolved by `RALPH_REVIEW_MODE` environment variable (see dual ownership table above). Only one worker acts per mode -- no concurrent access.

## Handoff Boundaries

3 worker-to-worker handoffs (down from 6+ with old agents):

| # | From | To | Trigger State | Mechanism |
|---|------|----|---------------|-----------|
| 1 | Analyst | Builder | Ready for Plan | Analyst loop ends; Builder picks up from state queue |
| 2 | Builder | Integrator | In Review | Builder creates PR; Integrator picks up from state queue |
| 3 | Validator | Builder | Ready for Plan (rejection) | Validator rejects plan; Builder re-plans |

Handoff mechanism is the GitHub Projects V2 workflow state itself -- no explicit messaging required. Workers poll their owned states.

## Instance Limits

| Worker | Max Parallel | Rationale |
|--------|-------------|-----------|
| Analyst | 3 | Parallel per issue, read-only + docs |
| Builder | 3 | Parallel per issue, worktree isolation |
| Validator | 1 | Review is sequential per issue |
| Integrator | 1 | Serialized on main branch |

Naming convention:
- Single: `analyst`, `builder`, `validator`, `integrator`
- Multiple: `analyst-2`, `analyst-3`, `builder-2`, `builder-3`

## Agent-to-Worker Migration Map

| Current Agent | New Worker | Skills Carried | Change |
|---------------|------------|----------------|--------|
| ralph-triager | **Analyst** | `ralph-triage`, `ralph-split` | Gains research |
| ralph-researcher | **Analyst** | `ralph-research` | Merged with triager |
| ralph-planner | **Builder** | `ralph-plan` | Gains implementation |
| ralph-implementer | **Builder** | `ralph-impl` | Merged with planner |
| ralph-advocate | **Validator** | `ralph-review` | Becomes optional |
| (new) | **Integrator** | -- | Entirely new worker |
