# Task Schema

## Purpose

Defines the schema for TaskCreate/TaskUpdate operations in the Ralph multi-agent workflow, including required fields, metadata conventions, and stop-gate integration.

## Definitions

- **Task**: A unit of work in the Ralph task system, created by the team lead and claimed by workers. Tasks have a subject, description, status, and metadata.
- **Metadata (input)**: Structured key-value pairs set by the team lead at TaskCreate time. Provides context workers need to execute.
- **Metadata (output)**: Structured key-value pairs set by workers via TaskUpdate when marking a task complete. Reports results back to the lead.
- **Blocking Dependency**: A relationship between tasks where one task cannot start until another completes. Expressed via `addBlockedBy` / `addBlocks` arrays of task IDs.
- **Stop Gate**: A hook that checks whether a worker has remaining work before allowing it to stop. Uses keyword matching against task subjects.
- **Keyword Matching**: Substring-based matching of task subjects against role-specific keywords to determine which tasks a worker can claim.
- **Subject Naming Convention**: The requirement that task subjects include specific keywords so stop-gate matching works correctly.

## Requirements

### 1. TaskCreate Required Fields

| Field | Type | Required | Description | Example |
|-------|------|----------|-------------|---------|
| `subject` | string | YES | Brief title in imperative form. MUST include GH-NNN for GitHub-linked tasks | "Research GH-468: Scaffold specs" |
| `description` | string | YES | Full task requirements including issue context, artifact paths, and what the worker needs | *(multiline text)* |
| `activeForm` | string | YES | Present continuous form shown in spinner during `in_progress` | "Researching GH-468" |
| `metadata` | object | YES | Structured key-value pairs; lead sets input keys at creation | `{ "issue_number": 468, ... }` |

| Requirement | Enablement |
|-------------|------------|
| TaskCreate MUST include all four required fields (subject, description, activeForm, metadata) | `[x]` `task-schema-validator.sh` (registered in ralph-team and ralph-hero PreToolUse hooks) |
| Subject MUST be in imperative form | `[x]` `task-schema-validator.sh` (proxy: role keyword check enforces imperative phrasing) |

### 2. Standard Input Metadata

Keys set by the team lead at TaskCreate time. Provides context workers need for execution.

| Key | When Set | Type | Description |
|-----|----------|------|-------------|
| `issue_number` | Always | number | GitHub issue number being processed |
| `issue_url` | Always | string | Full GitHub issue URL |
| `command` | Always | string | Ralph command this task maps to (e.g., "ralph_research") |
| `phase` | Always | string | Pipeline phase name (e.g., "research", "plan", "impl") |
| `estimate` | Always | string | Issue estimate (XS/S) |
| `group_primary` | Groups | number | Primary issue number of the group |
| `group_members` | Groups | string | Comma-separated member issue numbers |
| `artifact_path` | When prior artifact exists | string | Path to research/plan doc from prior phase |
| `worktree` | Impl tasks | string | Path to worktree directory |
| `stream_id` | Streams | string | Stream identifier |
| `stream_primary` | Streams | number | Primary issue of the stream |
| `stream_members` | Streams | string | Stream member issue numbers |
| `epic_issue` | Epics | number | Parent epic issue number |

| Requirement | Enablement |
|-------------|------------|
| Input metadata MUST include `issue_number`, `issue_url`, `command`, `phase`, and `estimate` for all tasks | `[x]` `task-schema-validator.sh` (validates all five keys at TaskCreate time) |
| Group-specific keys MUST be set when processing grouped issues | `[ ]` not enforced |

### 3. TaskUpdate Result Schema

Metadata keys that workers MUST set when marking a task complete via `TaskUpdate(status="completed", metadata={...})`. Organized by pipeline phase.

| Phase | Required Metadata Keys | Required Description Content |
|-------|----------------------|------------------------------|
| Triage | `action` (RESEARCH/PLAN/CLOSE/SPLIT), `workflow_state` | What action was taken and why |
| Split | `sub_tickets` (array of numbers), `estimates` | List of sub-issues created with estimates |
| Research | `artifact_path`, `workflow_state` | Key findings summary, artifact location |
| Plan | `artifact_path`, `phase_count`, `workflow_state` | Phase summary, artifact location |
| Review | `result` (APPROVED/NEEDS_ITERATION), `artifact_path` (if AUTO) | Full verdict, critique location if applicable |
| Impl | `worktree`, `phase_completed`, `pr_url` (if final phase) | Phase summary, PR URL if created |
| Validate | `result` (PASS/FAIL), `failures` (if FAIL) | Pass/fail verdict with details |
| PR | `pr_url`, `workflow_state` | PR URL, issue moved to In Review |
| Merge | `workflow_state` | Issue moved to Done, worktree cleaned |

| Requirement | Enablement |
|-------------|------------|
| Workers MUST set phase-appropriate metadata keys when completing a task | `[x]` `task-schema-validator.sh` (blocks TaskUpdate(status=completed) without metadata) |
| Workers MUST include a meaningful description summarizing results | `[x]` `task-schema-validator.sh` (blocks TaskUpdate(status=completed) without description) |
| TaskUpdate is the primary reporting channel — workers MUST NOT use SendMessage for routine reporting | `[ ]` not enforced (convention only) |

### 4. Blocking and Dependency Patterns

Tasks can express ordering constraints via blocking relationships.

- `addBlockedBy`: array of task IDs that MUST complete before this task can start
- `addBlocks`: array of task IDs that this task prevents from starting
- Within-group blockers define execution order (sequential phases)
- Cross-group blockers define true blocking (e.g., research blocks planning)

| Requirement | Enablement |
|-------------|------------|
| Workers MUST NOT claim tasks where `blockedBy` contains open (non-completed) tasks | `[ ]` not enforced (task system shows visibility but no hook validates claim behavior) |
| The team lead SHOULD use `addBlockedBy` to express phase ordering within a pipeline | `[ ]` not enforced |

### 5. Subject Naming Convention

Task subjects MUST include role-specific keywords for stop-gate matching to work. The `worker-stop-gate.sh` hook uses substring matching against task subjects to determine if a worker has remaining work.

**Analyst tasks**:
- "Triage GH-NNN"
- "Split GH-NNN"
- "Research GH-NNN: {title}"
- "Plan GH-NNN: {title}"

**Builder tasks**:
- "Review plan for #NNN"
- "Implement #NNN: {title}"

**Integrator tasks**:
- "Validate #NNN"
- "Create PR for #NNN"
- "Merge PR for #NNN"

| Requirement | Enablement |
|-------------|------------|
| Task subjects MUST include the role-specific keyword for the target worker | `[x]` `task-schema-validator.sh` (blocks TaskCreate with subject missing Triage/Split/Research/Plan/Review/Implement/Validate/Create PR/Merge) |
| Task subjects MUST include the issue number (GH-NNN or #NNN format) | `[x]` `task-schema-validator.sh` (blocks TaskCreate with subject missing GH-NNN or #NNN pattern) |

### 6. Worker Stop Gate Integration

`worker-stop-gate.sh` runs before any worker stops. It calls TaskList to check for unblocked tasks matching the worker's role keywords. If matching tasks exist, the stop is blocked.

| Role Prefix | Matched Keywords | Behavior |
|-------------|-----------------|----------|
| `analyst*` | "Triage", "Split", "Research", "Plan" | Blocks stop if unblocked task with matching keyword exists |
| `builder*` | "Review", "Implement" | Blocks stop if unblocked task with matching keyword exists |
| `integrator*` | "Validate", "Create PR", "Merge", "Integrate" | Blocks stop if unblocked task with matching keyword exists |

The `$TEAMMATE` environment variable provides the worker's name (set from the `name` field in `Task()` spawn). The role prefix is matched against `$TEAMMATE`.

| Requirement | Enablement |
|-------------|------------|
| Workers MUST check TaskList for unblocked matching tasks before stopping | `[x]` `worker-stop-gate.sh` (registered in all 3 agent Stop hooks) |
| Worker names MUST use role prefixes (`analyst*`, `builder*`, `integrator*`) for stop gate matching | `[ ]` not enforced (convention only) |

### 7. TaskCompleted Hook

`team-task-completed.sh` fires when any teammate marks a task completed. It provides advisory guidance to the team lead for follow-up task creation.

The hook:
- Reads the completed task's metadata and description
- Suggests next-phase task creation (e.g., after research completes, suggest creating a plan task)
- Handles review rejections (suggest creating new plan task)
- Handles validation failures (suggest creating new impl task)
- Always exits 0 (never blocks completion)

| Requirement | Enablement |
|-------------|------------|
| The TaskCompleted hook MUST fire on task completion | `[x]` `team-task-completed.sh` (registered in ralph-team SKILL.md TaskCompleted hook) |
| The hook MUST be advisory only (exit 0, never block) | `[x]` `team-task-completed.sh` (always exits 0) |

## Cross-References

- [skill-io-contracts.md](skill-io-contracts.md) — Command-level result schemas and per-skill postconditions
- [agent-permissions.md](agent-permissions.md) — Which agents run which skills (determines which task types each worker handles)
- [team-schema.md](team-schema.md) — TeamCreate ordering, worker spawn protocol, shutdown sequence
