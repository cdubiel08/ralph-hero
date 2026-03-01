---
date: 2026-03-01
github_issue: 470
github_url: https://github.com/cdubiel08/ralph-hero/issues/470
status: complete
type: research
---

# Research: Ralph Protocol Specs Phase 3 — Coordination Specs (task-schema, team-schema)

## Problem Statement

Phase 3 requires creating two spec files: `specs/task-schema.md` (TaskCreate/TaskUpdate contracts for multi-agent coordination) and `specs/team-schema.md` (TeamCreate ordering, worker spawn protocol, shutdown, post-mortem). Both must be designed from first principles from actual hook scripts, skill prompts, agent definitions, and post-mortem evidence.

---

## Current State Analysis

### 1. Task Schema (`specs/task-schema.md`)

#### TaskCreate Required Fields

From observed usage across ralph-team SKILL.md and conventions.md:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `subject` | string | YES | Brief title in imperative form, includes GH-NNN for GitHub-linked tasks |
| `description` | string | YES | Full task requirements including issue context, artifact paths, and what the worker needs |
| `activeForm` | string | YES | Present continuous form shown in spinner during in_progress (e.g., "Researching GH-42") |
| `metadata` | object | YES (lead sets input keys) | Structured key-value pairs; merges with existing metadata on update |

#### Standard Input Metadata Keys (set by lead at TaskCreate)

From conventions.md `Standard input metadata` section:

| Key | When Set | Description |
|-----|----------|-------------|
| `issue_number` | Always | GitHub issue number being processed |
| `issue_url` | Always | Full GitHub issue URL |
| `command` | Always | Ralph command this task maps to (e.g., "ralph_research") |
| `phase` | Always | Pipeline phase name (e.g., "research", "plan", "impl") |
| `estimate` | Always | XS/S issue estimate |
| `group_primary` | Groups | Primary issue number of the group |
| `group_members` | Groups | Comma-separated member issue numbers |
| `artifact_path` | When prior artifact exists | Path to research/plan doc from prior phase |
| `worktree` | Impl tasks | Path to worktree directory |
| `stream_id` | Streams | Stream identifier |
| `stream_primary` | Streams | Primary issue of the stream |
| `stream_members` | Streams | Stream member issue numbers |
| `epic_issue` | Epics | Parent epic issue number |

#### TaskUpdate Result Schema (what workers MUST set on completion)

Workers report via `TaskUpdate(status="completed", metadata={...}, description="...")`. From conventions.md and observed post-mortem data:

| Phase | Required metadata keys | Required description content |
|-------|----------------------|------------------------------|
| Triage | `action` (RESEARCH/PLAN/CLOSE/SPLIT), `workflow_state` | What action was taken and why |
| Split | `sub_tickets` (array of numbers), `estimates` | List of sub-issues created with estimates |
| Research | `artifact_path` (research doc path), `workflow_state` | Key findings summary, artifact location |
| Plan | `artifact_path` (plan doc path), `phase_count`, `workflow_state` | Phase summary, artifact location |
| Review | `result` (APPROVED/NEEDS_ITERATION), `artifact_path` (if AUTO) | Full verdict, critique location if applicable |
| Impl | `worktree`, `phase_completed`, `pr_url` (if final phase) | Phase summary, PR URL if created |
| Validate | `result` (PASS/FAIL), `failures` (if FAIL) | Pass/fail verdict with details |
| PR | `pr_url`, `workflow_state` | PR URL, issue moved to In Review |
| Merge | `workflow_state` | Issue moved to Done, worktree cleaned |

#### Blocking/Dependency Patterns

From task system usage:
- `addBlockedBy`: array of task IDs that must complete before this task can start
- `addBlocks`: array of task IDs that this task prevents from starting
- Workers MUST NOT claim tasks where `blockedBy` contains open tasks
- `worker-stop-gate.sh` only permits stopping after checking for UNBLOCKED tasks

#### Hook Integration Points

**TaskCompleted hook** (`team-task-completed.sh`): Fires when any teammate marks a task completed. Provides guidance to team lead to:
- Check if next-phase tasks should be created
- Handle review rejections (create new plan task)
- Handle validation failures (create new impl task)

Enablement: `[x]` `team-task-completed.sh` registered in ralph-team SKILL.md TaskCompleted hook. Note: hook is advisory (exit 0 always) — team lead decides follow-up.

**Worker stop gate keyword matching** (`worker-stop-gate.sh`): Before a worker stops, it checks TaskList for matching unblocked tasks using role keywords:

| Role prefix | Keywords matched in task subjects |
|-------------|----------------------------------|
| `analyst*` | "Triage", "Split", "Research", "Plan" |
| `builder*` | "Review", "Implement" |
| `integrator*` | "Validate", "Create PR", "Merge", "Integrate" |

Matching is substring-based against task `subject`. Subject naming convention: include the keyword explicitly (e.g., "Research GH-468: Scaffold specs", "Review plan for #468").

Enablement: `[x]` `worker-stop-gate.sh` registered in all three agent definitions' Stop hooks.

#### Subject Naming Convention

Task subjects MUST include the role keyword for stop-gate matching to work:
- Analyst tasks: "Triage GH-NNN", "Split GH-NNN", "Research GH-NNN", "Plan GH-NNN"
- Builder tasks: "Review plan for #NNN", "Implement #NNN"
- Integrator tasks: "Validate #NNN", "Create PR for #NNN", "Merge PR for #NNN"

Enablement: `[ ]` No hook enforces subject naming convention — convention only.

---

### 2. Team Schema (`specs/team-schema.md`)

#### TeamCreate Ordering Rule

From ralph-team SKILL.md and conventions.md:
TeamCreate MUST be called before TaskCreate. Workers are spawned as part of TeamCreate. Tasks are assigned to workers after the team exists.

Enablement: `[ ]` No hook enforces TeamCreate-before-TaskCreate ordering. Convention enforced by ralph-team skill prompt.

#### Roster Sizing Rules

From ralph-team SKILL.md and GH-0044 research:

Suggested roster based on pipeline position:

| Pipeline Position | Recommended Workers |
|------------------|---------------------|
| Backlog/Research Needed | 1 analyst |
| Ready for Plan | 1 analyst (planning), 1 builder |
| In Progress | 1 builder, 1 integrator |
| Full pipeline | 1 analyst, 1 builder, 1 integrator |

Maximum parallel instances per role (from GH-0044 research):
- Analyst: up to 3 (parallel per issue, read-only + docs, no contention)
- Builder: up to 3 (parallel per issue, worktree isolation)
- Integrator: 1 (serialized on main branch for merges)

From GH-451 post-mortem: actual session used 1 analyst + 1 builder + 1 integrator for an XL issue split into 6 sub-issues.

Enablement: `[ ]` No hook enforces roster sizing — team lead decides.

#### Worker Spawn Protocol

Workers are spawned via `Task()` with `subagent_type` matching the agent definition name:

```
Task(
  subagent_type="ralph-analyst",  # matches agents/ralph-analyst.md
  team_name=TEAM_NAME,            # binds worker to this team's TaskList scope
  name="analyst",                  # used for stop gate matching ($TEAMMATE)
  prompt="..."                     # spawn prompt (see required fields below)
)
```

**Required spawn prompt fields** per role:

| Field | Analyst | Builder | Integrator |
|-------|---------|---------|------------|
| Issue number | YES | YES | YES |
| Issue title | YES | YES | YES |
| Current workflow state | YES | YES | YES |
| Task subjects to look for | YES | YES | YES |
| Skill(s) to invoke | YES | YES | YES |
| How to report results | YES | YES | YES |

From ralph-team SKILL.md: "Give each worker a spawn prompt that includes the issue number, title, current pipeline state, and what kinds of tasks they should look for."

Enablement: `[ ]` No hook validates spawn prompt completeness.

#### Worker Role Contracts

From agent `.md` definitions:

| Role | Handles | Skills | Model |
|------|---------|--------|-------|
| analyst | Triage, split, research, plan | ralph-triage, ralph-split, ralph-research, ralph-plan | sonnet |
| builder | Plan review, implementation | ralph-review, ralph-impl | sonnet |
| integrator | Validation, PR creation, merge | ralph-val, ralph-pr, ralph-merge | haiku |

Workers are **autonomous**: they check TaskList, self-assign unblocked tasks (set owner + in_progress), invoke appropriate skill, report results via TaskUpdate, check TaskList again before stopping.

Workers MUST NOT: nudge the lead, send progress updates via SendMessage, acknowledge task receipt. SendMessage is reserved for escalations and responses to direct questions.

Enablement: `[x]` worker-stop-gate.sh forces TaskList check before idle. `[x]` require-skill-context.sh blocks mutating calls outside skill context.

#### Sub-Agent Team Isolation Rule

From conventions.md "Sub-Agent Team Isolation":

Skills that spawn internal sub-tasks via `Task()` MUST NOT pass `team_name`. Internal sub-agents must run outside any team context.

```
# CORRECT
Task(subagent_type="codebase-locator", prompt="Find files...")

# INCORRECT
Task(subagent_type="codebase-locator", team_name=TEAM_NAME, prompt="Find files...")
```

Rationale: Internal sub-agents are research helpers, not team workers. Passing `team_name` would incorrectly add them to the team's TaskList scope, polluting visibility.

Enablement: `[ ]` No hook enforces absence of `team_name` in internal Task calls.

#### Shutdown Protocol

From ralph-team SKILL.md "Shut Down" section:

Step-by-step:
1. **Collect session data**: Call TaskList, then TaskGet on each task. Extract issues processed, PRs created, worker assignments, errors.
2. **Write post-mortem** to `thoughts/shared/reports/YYYY-MM-DD-ralph-team-{team-name}.md` (see template in SKILL.md)
3. **Commit and push** post-mortem: `git commit -m "docs(report): {team-name} session post-mortem"`
4. **Send shutdown to each teammate**: `SendMessage(type="shutdown_request", recipient=teammate)`
5. **Wait for all confirmations**: Workers approve or reject (approve if idle/done, reject if mid-skill)
6. **Call TeamDelete()**: Removes task list and team config

Enablement: `[x]` team-stop-gate.sh blocks lead shutdown if GitHub processable issues remain. `[ ]` No hook enforces post-mortem creation before shutdown. `[ ]` No hook enforces TeamDelete call.

#### Post-Mortem Requirements

From ralph-team SKILL.md template and GH-451 example:

Required sections:
- Date
- Summary (one-line outcome)
- Issues Processed table: Issue number, title, estimate, outcome, PR
- Worker Summary table: Worker, Tasks Completed (list of task subjects)
- Key Metrics (optional but recommended): PRs merged, tests passing, other measurable outcomes
- Notes: Escalations, errors, anything notable

Commit message pattern: `docs(report): {team-name} session post-mortem`

Enablement: `[ ]` No hook enforces post-mortem structure or commit.

---

## Key Discoveries

### Discovery 1: TaskUpdate Is the Primary Communication Channel
From conventions.md "The Reporting Rule": workers report via TaskUpdate (metadata + description). SendMessage is for escalations and responses to direct questions ONLY. This means the task system is the state machine for inter-agent communication — not message passing.

### Discovery 2: team-task-completed.sh Is Advisory Only
The TaskCompleted hook (`team-task-completed.sh`) always exits 0 — it provides guidance to the team lead but never blocks. All lead logic (creating follow-up tasks, handling review rejections) is in the skill prompt, not enforced by hooks.

### Discovery 3: Worker Name Must Match Stop Gate Pattern
`worker-stop-gate.sh` matches `$TEAMMATE` against patterns: `analyst*`, `builder*`, `integrator*`. The `name` field in `Task()` spawn becomes the `$TEAMMATE` value. Names MUST use these prefixes for stop gate keyword matching to work. Names like "analyst-1" or "analyst-primary" work; "worker-1" does not.

### Discovery 4: No Hook Enforces TeamCreate-Before-TaskCreate
The ordering rule is a convention enforced only by the ralph-team skill prompt. A future hook could validate this via the team system API, but currently there is no machine enforcement.

### Discovery 5: TaskList Scope Is Bound by team_name
Workers see only tasks in their team's scope (via `team_name` on spawn). The lead sees all tasks. This is why the GH-451 post-mortem noted a "TaskList visibility issue for analyst (team context mismatch)" — when team context is incorrect, workers see empty TaskList and go idle.

### Discovery 6: Post-Mortem Is the Only Shutdown Artifact
The only persistent artifact from a team session is the post-mortem report. Task data is ephemeral (destroyed by TeamDelete). The post-mortem MUST capture all relevant results before TeamDelete is called.

---

## Recommended Next Steps (for Planning)

1. **`specs/task-schema.md`**: Document all required fields, standard metadata keys table (input + output by phase), worker-stop-gate keyword matching table, and subject naming convention. Clearly separate "input metadata" (set by lead) from "output metadata" (set by workers on completion).

2. **`specs/team-schema.md`**: Document TeamCreate ordering, roster sizing guidelines, spawn protocol with required prompt fields, worker role contracts, sub-agent isolation rule, and step-by-step shutdown protocol. Include the post-mortem template and commit pattern.

3. **Spec cross-references**: task-schema.md should reference skill-io-contracts.md (Phase 1) for the command-level result schema. team-schema.md should reference agent-permissions.md (Phase 1) for worker tool whitelists.

---

## Risks

- **Stop gate keyword fragility**: If task subjects don't include the exact keywords (Triage/Split/Research/Plan for analyst, etc.), workers will stop prematurely. The spec must make the naming convention mandatory and give concrete examples.
- **TeamDelete destroys task history**: Post-mortem must be completed before TeamDelete. The spec should make this ordering explicit as a MUST requirement.
- **TaskList scope mismatch**: Workers with wrong `team_name` see empty TaskList and go idle. The spec should document the team isolation mechanism clearly so developers can debug it.

---

## Files Affected

### Will Modify
- `specs/task-schema.md` — new file to create
- `specs/team-schema.md` — new file to create

### Will Read (Dependencies)
- `plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh` — stop gate keyword matching implementation
- `plugin/ralph-hero/hooks/scripts/team-task-completed.sh` — TaskCompleted hook (advisory)
- `plugin/ralph-hero/hooks/scripts/team-stop-gate.sh` — lead stop gate (checks processable issues)
- `plugin/ralph-hero/hooks/scripts/team-teammate-idle.sh` — TeammateIdle hook (advisory)
- `plugin/ralph-hero/skills/ralph-team/SKILL.md` — full team coordination protocol
- `plugin/ralph-hero/agents/ralph-analyst.md` — analyst role definition
- `plugin/ralph-hero/agents/ralph-builder.md` — builder role definition
- `plugin/ralph-hero/agents/ralph-integrator.md` — integrator role definition
- `plugin/ralph-hero/skills/shared/conventions.md` — TaskUpdate protocol, communication discipline
- `thoughts/shared/reports/2026-02-27-ralph-team-GH-451.md` — post-mortem example
- `thoughts/shared/research/2026-02-17-GH-0044-worker-scope-boundaries.md` — worker scope boundaries
