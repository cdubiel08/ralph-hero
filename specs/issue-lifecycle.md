# Issue Lifecycle

## Purpose

Governs the issue state machine, valid transitions, lock protocol, semantic intents, and Status sync for the Ralph workflow.

## Definitions

- **Workflow State**: The current position of an issue in the Ralph pipeline, stored as a custom field on the GitHub Projects V2 board. One of 11 defined states.
- **Lock State**: A workflow state indicating exclusive ownership by an agent. Other agents MUST NOT claim an issue in a lock state.
- **Terminal State**: A workflow state with no outbound transitions. The issue is complete or canceled.
- **Semantic Intent**: An abstract action (e.g., `__COMPLETE__`) that resolves to a concrete state based on which skill is executing.
- **Status Sync**: One-way, best-effort mapping from workflow states to the GitHub Projects default Status field (Todo / In Progress / Done).
- **Parent Gate State**: A workflow state that triggers parent issue advancement checks when all children reach it.

## Requirements

### 1. Workflow States

All 11 workflow states defined in the Ralph state machine.

| State | Description | Lock | Terminal | Requires Human |
|-------|-------------|------|----------|----------------|
| Backlog | Ticket awaiting triage | | | |
| Research Needed | Needs investigation before planning | | | |
| Research in Progress | Research actively underway | yes | | |
| Ready for Plan | Research complete, ready for planning | | | |
| Plan in Progress | Plan actively being created | yes | | |
| Plan in Review | Plan awaiting human approval | | | yes |
| In Progress | Implementation actively underway | yes | | |
| In Review | PR created, awaiting code review | | | yes |
| Human Needed | Escalated, requires human intervention | | | yes |
| Done | Ticket completed | | yes | |
| Canceled | Ticket canceled/superseded | | yes | |

| Requirement | Enablement |
|-------------|------------|
| Issues MUST be in exactly one workflow state at all times | `[ ]` not enforced |
| State names MUST match exactly (case-sensitive) | `[x]` `workflow-states.ts` via `VALID_STATES` |

### 2. Valid Transitions

Every non-terminal state has a defined set of allowed outbound transitions. No transitions are valid from terminal states.

| From | Allowed To |
|------|------------|
| Backlog | Research Needed, Ready for Plan, Done, Canceled |
| Research Needed | Research in Progress, Ready for Plan, Human Needed |
| Research in Progress | Ready for Plan, Human Needed |
| Ready for Plan | Plan in Progress, Human Needed |
| Plan in Progress | Plan in Review, Human Needed |
| Plan in Review | In Progress, Ready for Plan, Human Needed |
| In Progress | In Review, Human Needed |
| In Review | Done, In Progress, Human Needed |
| Human Needed | Backlog, Research Needed, Ready for Plan, In Progress |
| Done | *(none — terminal)* |
| Canceled | *(none — terminal)* |

| Requirement | Enablement |
|-------------|------------|
| State transitions MUST follow the allowed transition table | `[ ]` `auto-state.sh` (script not yet on main branch) via `ralph-state-machine.json` lookup |
| Transitions not listed in the table MUST be rejected | `[x]` per-command state gate hooks |

### 3. State Ownership by Skill

Which skills produce which states, and which states skills require as input.

**State production** (which skills can set which states):

| State Produced | Skill(s) Responsible |
|---------------|----------------------|
| Backlog | ralph_triage, ralph_split |
| Research Needed | ralph_triage |
| Research in Progress | ralph_research (lock acquire) |
| Ready for Plan | ralph_research |
| Plan in Progress | ralph_plan (lock acquire) |
| Plan in Review | ralph_plan, ralph_review (rejection bounce) |
| In Progress | ralph_review (approval), ralph_impl |
| In Review | ralph_impl |
| Human Needed | any skill via `__ESCALATE__` |
| Done | ralph_triage, ralph_impl, ralph_merge |
| Canceled | ralph_triage |

**Skill input state requirements** (preconditions):

| Skill | Required Input State(s) |
|-------|------------------------|
| ralph_triage | Backlog |
| ralph_split | Backlog, Research Needed |
| ralph_research | Research Needed |
| ralph_plan | Ready for Plan |
| ralph_review | Plan in Review |
| ralph_impl | Plan in Review, In Progress |
| ralph_merge | In Review |

| Requirement | Enablement |
|-------------|------------|
| Skills MUST only produce states listed in their production table | `[x]` per-command state gate hooks (`triage-state-gate.sh`, `research-state-gate.sh`, `plan-state-gate.sh`, `review-state-gate.sh`, `impl-state-gate.sh`, `merge-state-gate.sh`, `pr-state-gate.sh`) |
| Skills MUST NOT execute unless the issue is in a valid input state | `[x]` per-command state gate hooks |

### 4. Lock State Protocol

Lock states prevent concurrent claim by multiple agents. Three lock states exist.

| Lock State | Acquired From | By Command | Released To (success) | Released To (failure) | Released To (escalation) |
|------------|--------------|-----------|----------------------|----------------------|-----------------------------|
| Research in Progress | Research Needed | ralph_research | Ready for Plan | Research Needed | Human Needed |
| Plan in Progress | Ready for Plan | ralph_plan | Plan in Review | Ready for Plan | Human Needed |
| In Progress | Plan in Review | ralph_impl | In Review | *(stays In Progress)* | Human Needed |

| Requirement | Enablement |
|-------------|------------|
| Agents MUST NOT claim an issue that is in a lock state | `[x]` `save_issue` server-side guard (fetches current workflow state via `getCurrentFieldValue`, returns `toolError` when target is a lock state and issue is already locked) |
| Lock acquisition MUST transition from the correct source state | `[ ]` `auto-state.sh` (script not yet on main branch) |
| Lock release on success MUST transition to the correct target state | `[x]` per-command state gate hooks |
| Lock release on failure MUST return to the pre-lock state (except In Progress) | `[x]` `lock-release-on-failure.sh` Stop hook on ralph-research, ralph-plan, ralph-impl |

### 5. Semantic Intents

Abstract intents resolve to concrete states based on the executing skill.

| Intent | ralph_research | ralph_plan | ralph_impl | ralph_review | ralph_split | ralph_merge | all commands |
|--------|---------------|------------|------------|--------------|-------------|-------------|--------------|
| `__LOCK__` | Research in Progress | Plan in Progress | In Progress | — | — | — | — |
| `__COMPLETE__` | Ready for Plan | Plan in Review | In Review | In Progress | Backlog | Done | — |
| `__ESCALATE__` | — | — | — | — | — | — | Human Needed |
| `__CLOSE__` | — | — | — | — | — | — | Done |
| `__CANCEL__` | — | — | — | — | — | — | Canceled |

**Triage-specific actions** (ralph_triage has multiple output paths not captured by semantic intents):

| Action | Resolved State |
|--------|---------------|
| RESEARCH | Research Needed |
| PLAN | Ready for Plan |
| CLOSE | Done |
| KEEP | *(no state change)* |
| SPLIT | *(delegates to ralph_split)* |

| Requirement | Enablement |
|-------------|------------|
| Skills MUST use semantic intents when setting workflow state via `save_issue` | `[ ]` not enforced (convention only) |
| `__ESCALATE__` MUST resolve to Human Needed for all commands | `[x]` `ralph-state-machine.json` definition |

### 6. Status Sync

One-way, best-effort mapping from workflow states to the GitHub Projects default Status field.

| Workflow State | GitHub Status |
|---------------|--------------|
| Backlog | Todo |
| Research Needed | Todo |
| Ready for Plan | Todo |
| Plan in Review | Todo |
| Research in Progress | In Progress |
| Plan in Progress | In Progress |
| In Progress | In Progress |
| In Review | In Progress |
| Done | Done |
| Canceled | Done |
| Human Needed | Done |

**Rationale**: Todo = work not yet actively started (queued states). In Progress = work actively being processed (lock states + review). Done = terminal/escalated states (no automated progression).

| Requirement | Enablement |
|-------------|------------|
| `save_issue` MUST sync Status when setting workflowState | `[x]` `workflow-states.ts` via `WORKFLOW_STATE_TO_STATUS` mapping in `issue-tools.ts` |
| `batch_update` and `advance_issue` MUST also sync Status | `[x]` `workflow-states.ts` |
| Status sync MUST be best-effort: silently skip if Status field is missing or has non-standard options | `[x]` `workflow-states.ts` |

### 7. Issue Creation

| Requirement | Enablement |
|-------------|------------|
| Issues MUST have a title at creation | `[ ]` not enforced (GitHub API requires title) |
| Estimate, priority, and workflowState MUST be set via project fields after creation | `[ ]` not enforced |
| New issues created by ralph_split MUST start in Backlog | `[x]` `triage-state-gate.sh` |

### 8. Close/Reopen Semantics

| Requirement | Enablement |
|-------------|------------|
| Done and Canceled are terminal states — no outbound transitions are valid | `[x]` `ralph-state-machine.json` (empty `allowed_transitions`) |
| Human Needed is NOT terminal — it can return to Backlog, Research Needed, Ready for Plan, or In Progress | `[x]` `ralph-state-machine.json` |
| Only a human MAY transition issues out of Human Needed | `[x]` `human-needed-outbound-block.sh` (blocks save_issue when RALPH_CURRENT_STATE is Human Needed and RALPH_COMMAND is set) |

### 9. Parent Gate States

When all children of a parent issue reach a gate state, the parent issue advancement check triggers.

| Gate State | Trigger |
|-----------|---------|
| Ready for Plan | All children researched — parent can advance to planning |
| In Review | All children implemented — parent can advance to review |
| Done | All children complete — parent can close |

| Requirement | Enablement |
|-------------|------------|
| `advance_issue` MUST check parent gate states when a child reaches Ready for Plan, In Review, or Done | `[x]` `workflow-states.ts` via `PARENT_GATE_STATES` |
| Parent advancement MUST only occur when ALL children reach the gate state | `[x]` `relationship-tools.ts` |

### 10. State Ordering

Canonical pipeline order defines left-to-right progression through the workflow.

```
Backlog → Research Needed → Research in Progress → Ready for Plan → Plan in Progress → Plan in Review → In Progress → In Review → Done
```

States not in the canonical order: Canceled, Human Needed. These are off-pipeline states with special semantics.

| Requirement | Enablement |
|-------------|------------|
| Pipeline position comparisons MUST use the canonical state ordering | `[x]` `workflow-states.ts` via `STATE_ORDER`, `stateIndex()`, `compareStates()` |
| States not in STATE_ORDER MUST return -1 from `stateIndex()` | `[x]` `workflow-states.ts` |

## Cross-References

- [skill-io-contracts.md](skill-io-contracts.md) — Per-skill preconditions and postconditions that reference workflow states
- [agent-permissions.md](agent-permissions.md) — Which agents run which skills (and therefore which state transitions they can trigger)
- [document-protocols.md](document-protocols.md) — Document creation requirements triggered by state transitions
