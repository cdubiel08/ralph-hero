# Team Schema

## Purpose

Defines the schema for team creation, worker spawning, role contracts, and shutdown protocol in the Ralph multi-agent workflow.

## Definitions

- **Team**: A coordinated group of agents (one lead + N workers) operating on a shared TaskList scope. Created via TeamCreate, destroyed via TeamDelete.
- **Team Lead**: The orchestrating agent that creates the team, spawns workers, creates tasks, and manages shutdown. Runs the ralph-team skill.
- **Worker**: An autonomous agent spawned into a team. Claims tasks from TaskList, executes skills, reports results via TaskUpdate.
- **Roster**: The set of workers spawned for a team session. Sized based on pipeline position and workload.
- **Spawn Protocol**: The process of creating a worker via `Task()` with required parameters (subagent_type, team_name, name, prompt).
- **Sub-Agent Isolation**: The rule that internal sub-tasks spawned within a skill MUST NOT be added to the team's TaskList scope.
- **Shutdown**: The orderly process of collecting results, writing a post-mortem, dismissing workers, and destroying the team.
- **Post-Mortem**: A markdown report capturing all session results, written before TeamDelete destroys ephemeral task data.

## Requirements

### 1. TeamCreate Ordering

| Requirement | Enablement |
|-------------|------------|
| TeamCreate MUST be called before any TaskCreate | `[x]` `team-protocol-validator.sh` (blocks TaskCreate if no TeamCreate marker exists) |
| Workers are spawned as part of team creation; tasks are assigned after the team exists | `[x]` `team-protocol-validator.sh` |

### 2. Roster Sizing

Guidelines for worker allocation based on pipeline position.

**Recommended roster by pipeline position**:

| Pipeline Position | Recommended Workers |
|------------------|---------------------|
| Backlog / Research Needed | 1 analyst |
| Ready for Plan | 1 analyst + 1 builder |
| In Progress | 1 builder + 1 integrator |
| Full pipeline | 1 analyst + 1 builder + 1 integrator |

**Maximum parallel instances per role**:

| Role | Max Instances | Rationale |
|------|--------------|-----------|
| Analyst | 3 | Parallel per issue; read-only + docs, no contention |
| Builder | 3 | Parallel per issue; worktree isolation prevents conflicts |
| Integrator | 1 | Serialized on main branch for merges |

Source: GH-0044 worker scope boundaries research + GH-451 post-mortem evidence (actual session: 1 analyst + 1 builder + 1 integrator for XL issue split into 6 sub-issues).

| Requirement | Enablement |
|-------------|------------|
| Integrator instances SHOULD be limited to 1 per team | `[ ]` not enforced (team lead decides) |
| Roster size SHOULD match the pipeline position guidelines | `[ ]` not enforced |

### 3. Worker Spawn Protocol

Workers are spawned via `Task()` call with specific parameters:

```
Task(
  subagent_type="ralph-analyst",   # matches agents/ralph-analyst.md filename
  team_name=TEAM_NAME,             # binds worker to this team's TaskList scope
  name="analyst",                   # becomes $TEAMMATE for stop gate matching
  prompt="..."                      # spawn prompt with required fields
)
```

The `name` field MUST use a role prefix (`analyst*`, `builder*`, `integrator*`) for stop-gate keyword matching to work. Names like "analyst-1" or "builder-primary" are valid; "worker-1" is not.

**Required spawn prompt fields per role**:

| Field | Analyst | Builder | Integrator |
|-------|---------|---------|------------|
| Issue number | YES | YES | YES |
| Issue title | YES | YES | YES |
| Current workflow state | YES | YES | YES |
| Task subjects to look for | YES | YES | YES |
| Skill(s) to invoke | YES | YES | YES |
| How to report results | YES | YES | YES |

| Requirement | Enablement |
|-------------|------------|
| Worker `name` MUST use a role prefix (analyst*, builder*, integrator*) | `[x]` `team-protocol-validator.sh` (blocks Agent spawn if name lacks role prefix) |
| Spawn prompts MUST include all 6 required fields | `[ ]` not enforced |
| `team_name` MUST be set to bind the worker to the team's TaskList scope | `[x]` `team-protocol-validator.sh` (blocks Agent spawn if team_name is missing) |

### 4. Worker Role Contracts

Each role handles specific pipeline phases and has access to specific skills.

| Role | Handled Phases | Available Skills | Model |
|------|---------------|-----------------|-------|
| Analyst | Triage, Split, Research, Plan | ralph-triage, ralph-split, ralph-research, ralph-plan | sonnet |
| Builder | Plan review, Implementation | ralph-review, ralph-impl | sonnet |
| Integrator | Validation, PR creation, Merge | ralph-val, ralph-pr, ralph-merge | haiku |

**Worker autonomy rules**:
1. Check TaskList for unblocked tasks matching role keywords
2. Self-assign: set `owner` and `status: in_progress`
3. Invoke the appropriate skill
4. Report results via TaskUpdate (metadata + description)
5. Check TaskList again before stopping

**Communication discipline**: Workers MUST NOT send SendMessage for routine reporting — TaskUpdate is the primary communication channel. SendMessage is reserved for escalations (blockers, errors requiring lead intervention) and responses to direct questions from the lead.

| Requirement | Enablement |
|-------------|------------|
| Workers MUST check TaskList before stopping | `[x]` `worker-stop-gate.sh` (blocks stop if unblocked matching tasks exist) |
| Workers MUST NOT invoke mutating tools outside of a skill context | `[x]` `require-skill-context.sh` (blocks mutating calls outside skill context) |
| Workers MUST NOT use SendMessage for routine status reporting | `[ ]` not enforced (convention only) |
| Workers MUST report results via TaskUpdate metadata and description | `[ ]` not enforced |

### 5. Sub-Agent Team Isolation

Internal sub-tasks spawned via `Task()` within a skill MUST NOT pass `team_name`. Internal sub-agents are research helpers, not team workers. Passing `team_name` would pollute the team's TaskList scope, causing confusion for workers checking TaskList.

```
# CORRECT — internal sub-agent, no team binding
Task(subagent_type="codebase-locator", prompt="Find files related to...")

# INCORRECT — pollutes team's TaskList with internal sub-agent tasks
Task(subagent_type="codebase-locator", team_name=TEAM_NAME, prompt="Find files...")
```

| Requirement | Enablement |
|-------------|------------|
| Internal sub-tasks spawned within a skill MUST NOT pass `team_name` | `[ ]` not enforced (convention only) |

### 6. Shutdown Protocol

Step-by-step shutdown sequence for the team lead:

1. **Collect session data**: Call TaskList, then TaskGet on each task. Extract issues processed, PRs created, worker assignments, errors.
2. **Write post-mortem**: Create `thoughts/shared/reports/YYYY-MM-DD-ralph-team-{team-name}.md` (see Section 7 for template).
3. **Commit and push**: `git commit -m "docs(report): {team-name} session post-mortem"`
4. **Send shutdown to each teammate**: `SendMessage(type="shutdown_request", recipient=teammate)`
5. **Wait for confirmations**: Workers approve (if idle/done) or reject (if mid-skill). Handle rejections.
6. **Call TeamDelete()**: Removes task list and team config. Task data is destroyed.

| Requirement | Enablement |
|-------------|------------|
| The team lead MUST NOT stop while processable issues remain on the board | `[x]` `team-stop-gate.sh` (blocks lead stop if processable issues remain) |
| Post-mortem MUST be written and committed BEFORE TeamDelete is called | `[x]` `team-shutdown-validator.sh` (blocks TeamDelete if no post-mortem found in thoughts/shared/reports/) |
| Shutdown requests MUST be sent to all teammates before TeamDelete | `[ ]` not enforced |

### 7. Post-Mortem Requirements

Post-mortem reports are the only persistent artifact from a team session. Task data is ephemeral and destroyed by TeamDelete.

**Required sections**:

| Section | Content |
|---------|---------|
| Date | Session date |
| Summary | One-line outcome description |
| Issues Processed | Table: Issue number, title, estimate, outcome, PR |
| Worker Summary | Table: Worker name, tasks completed (list of task subjects) |
| Key Metrics | *(optional)* PRs merged, tests passing, other measurable outcomes |
| Notes | Escalations, errors, anything notable |

**Commit message pattern**: `docs(report): {team-name} session post-mortem`

**File path pattern**: `thoughts/shared/reports/YYYY-MM-DD-ralph-team-{team-name}.md`

| Requirement | Enablement |
|-------------|------------|
| Post-mortem MUST include Issues Processed and Worker Summary tables | `[ ]` not enforced (convention only) |
| Post-mortem MUST be committed with the standard commit message pattern | `[ ]` not enforced |
| Post-mortem MUST capture all session results before TeamDelete destroys task data | `[ ]` not enforced |

## Cross-References

- [task-schema.md](task-schema.md) — TaskCreate/TaskUpdate fields, metadata keys, stop-gate integration
- [agent-permissions.md](agent-permissions.md) — Per-agent tool whitelists and PreToolUse gates
- [skill-io-contracts.md](skill-io-contracts.md) — Per-skill contracts that workers execute
