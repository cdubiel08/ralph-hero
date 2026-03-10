---
date: 2026-03-01
status: draft
type: plan
github_issues: [470]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/470
primary_issue: 470
---

# Coordination Specs (task-schema, team-schema) — Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-470 | Ralph Protocol Specs Phase 3: Coordination specs (task-schema, team-schema) | XS |

## Current State Analysis

Phase 1 (GH-468) created the `specs/` directory with README.md (template, conventions, spec index) and 4 core specs. Phase 2 (GH-469) is planned to add issue-lifecycle.md and document-protocols.md. The README already has placeholder entries for Phase 3 specs (task-schema.md, team-schema.md) in the Spec Index.

The research document (`thoughts/shared/research/2026-03-01-GH-0470-coordination-specs.md`) fully extracted:
- TaskCreate required fields with types and constraints
- Standard input metadata keys (set by lead) and output metadata keys (set by workers on completion), separated by phase
- Worker-stop-gate keyword matching table with role prefixes and matched keywords
- Subject naming convention for keyword matching
- TeamCreate ordering rule (must precede TaskCreate)
- Roster sizing guidelines from GH-0044 research and GH-451 post-mortem evidence
- Worker spawn protocol with required prompt fields per role
- Sub-agent team isolation rule
- Step-by-step shutdown protocol
- Post-mortem template and required sections
- Enablement status for all hooks (team-task-completed.sh advisory, worker-stop-gate.sh enforced, team-stop-gate.sh enforced)

## Desired End State

### Verification
- [ ] `specs/task-schema.md` exists and follows the spec template (Purpose, Definitions, Requirements with Enablement table)
- [ ] TaskCreate required fields documented with types and constraints
- [ ] Standard input metadata keys table (set by lead) with per-phase required/optional columns
- [ ] TaskUpdate result schema table (set by workers on completion) per phase
- [ ] Blocking/dependency patterns documented
- [ ] Worker-stop-gate keyword matching table with role prefixes, keywords, and subject examples
- [ ] Subject naming convention documented as a MUST requirement
- [ ] `specs/team-schema.md` exists and follows the spec template
- [ ] TeamCreate ordering requirement (must precede TaskCreate) documented
- [ ] Roster sizing guidelines with role limits
- [ ] Worker spawn protocol with required prompt fields per role
- [ ] Sub-agent team isolation rule documented
- [ ] Shutdown protocol documented step-by-step (including post-mortem before TeamDelete ordering)
- [ ] Post-mortem template documented with required sections
- [ ] Enablement checkboxes accurately reflect current enforcement

## What We're NOT Doing
- No new hook enforcement (just documenting what exists)
- No modifications to existing Phase 1 or Phase 2 specs
- No fragment library or skill prompt refactor (Phase 4, GH-471)
- No changes to existing hooks, agents, or skill prompts

## Implementation Approach

Two spec files created sequentially. `task-schema.md` first since team-schema.md references task concepts (TaskCreate fields, TaskUpdate result schema). Both follow the exact template from `specs/README.md`: Purpose, Definitions, Requirements (with Enablement tables).

---

## Phase 1: Create `specs/task-schema.md`
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/470 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0470-coordination-specs.md

### Changes Required

#### 1. Create `specs/task-schema.md`
**File**: `specs/task-schema.md` (new)
**Changes**: Full spec following the template:

**Purpose**: Defines the schema for TaskCreate/TaskUpdate operations in the Ralph multi-agent workflow, including required fields, metadata conventions, and stop-gate integration.

**Definitions**: Key terms — task, metadata (input vs output), blocking dependency, stop gate, keyword matching, subject naming convention.

**Requirements sections**:

1. **TaskCreate Required Fields** — Table with 4 required fields (subject, description, activeForm, metadata) with types, constraints, and examples. Source: conventions.md and ralph-team SKILL.md usage patterns.

2. **Standard Input Metadata** — Table of keys set by the team lead at TaskCreate time. Columns: Key, When Required, Type, Description. Keys: `issue_number` (always), `issue_url` (always), `command` (always), `phase` (always), `estimate` (always), `group_primary` (groups), `group_members` (groups), `artifact_path` (when prior artifact exists), `worktree` (impl tasks), `stream_id`/`stream_primary`/`stream_members` (streams), `epic_issue` (epics). Enablement: `[ ] not enforced` (convention only).

3. **TaskUpdate Result Schema** — Table of metadata keys that workers MUST set when marking task complete. Organized per phase (Triage, Split, Research, Plan, Review, Impl, Validate, PR, Merge) with required keys, optional keys, and description content expectations. Source: conventions.md and skill-io-contracts.md Phase 1. Enablement: `[ ] not enforced` (convention only).

4. **Blocking and Dependency Patterns** — How `addBlockedBy`/`addBlocks` work: array of task IDs. Workers MUST NOT claim tasks with open blockedBy. Within-group blockers define execution order, not blocking. Cross-group blockers define true blocking. Enablement: `[ ] not enforced` (task system handles visibility but no hook validates claim behavior).

5. **Subject Naming Convention** — Task subjects MUST include role-specific keywords for stop-gate matching. Table of required keywords per role with concrete examples:
   - Analyst tasks: "Triage GH-NNN", "Split GH-NNN", "Research GH-NNN: {title}", "Plan GH-NNN: {title}"
   - Builder tasks: "Review plan for #NNN", "Implement #NNN: {title}"
   - Integrator tasks: "Validate #NNN", "Create PR for #NNN", "Merge PR for #NNN"
   Enablement: `[ ] not enforced` (convention only — worker-stop-gate.sh depends on this but doesn't validate it).

6. **Worker Stop Gate Integration** — How `worker-stop-gate.sh` uses TaskList + keyword matching to prevent premature worker shutdown. Table: Role prefix (`analyst*`, `builder*`, `integrator*`) -> Matched keywords -> Behavior (blocks stop if unblocked task matching keywords exists). The `$TEAMMATE` variable provides the role prefix. Enablement: `[x] worker-stop-gate.sh` (registered in all 3 agent Stop hooks).

7. **TaskCompleted Hook** — `team-task-completed.sh` fires on task completion, provides advisory guidance to team lead for follow-up task creation. Always exits 0 (never blocks). Enablement: `[x] team-task-completed.sh` (registered in ralph-team SKILL.md TaskCompleted hook, advisory only).

**Cross-References**: Link to skill-io-contracts.md (command-level result schema), agent-permissions.md (which agents run which skills), team-schema.md (TeamCreate ordering, spawn protocol).

### Success Criteria
- [ ] Automated: `test -f specs/task-schema.md && grep -q "## Purpose" specs/task-schema.md && grep -q "## Requirements" specs/task-schema.md && grep -q "## Cross-References" specs/task-schema.md`
- [ ] Manual: All required TaskCreate fields present in table
- [ ] Manual: Input and output metadata tables separated by phase
- [ ] Manual: Stop gate keyword table with all 3 roles documented
- [ ] Manual: Enablement checkboxes match actual enforcement

**Creates for next phase**: Foundation for team-schema.md cross-references.

---

## Phase 2: Create `specs/team-schema.md`
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/470 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0470-coordination-specs.md

### Changes Required

#### 1. Create `specs/team-schema.md`
**File**: `specs/team-schema.md` (new)
**Changes**: Full spec following the template:

**Purpose**: Defines the schema for team creation, worker spawning, role contracts, and shutdown protocol in the Ralph multi-agent workflow.

**Definitions**: Key terms — team, team lead, worker, roster, spawn protocol, sub-agent isolation, shutdown, post-mortem.

**Requirements sections**:

1. **TeamCreate Ordering** — TeamCreate MUST be called before any TaskCreate. Workers are spawned as part of team creation; tasks are assigned after team exists. Enablement: `[ ] not enforced` (convention enforced by ralph-team skill prompt only).

2. **Roster Sizing** — Guidelines table by pipeline position (Backlog/Research -> 1 analyst; Ready for Plan -> 1 analyst + 1 builder; In Progress -> 1 builder + 1 integrator; Full pipeline -> 1 analyst + 1 builder + 1 integrator). Maximum parallel instances per role (analyst <=3, builder <=3, integrator =1). Rationale for integrator singleton: serialized on main branch for merges. Source: GH-0044 research + GH-451 post-mortem evidence. Enablement: `[ ] not enforced` (team lead decides).

3. **Worker Spawn Protocol** — Task() call schema: `subagent_type` (matches agent .md filename), `team_name` (binds to TaskList scope), `name` (becomes $TEAMMATE for stop gate — MUST use role prefix: analyst*, builder*, integrator*). Required spawn prompt fields table per role: issue number, issue title, current workflow state, task subjects to look for, skill(s) to invoke, how to report results. Enablement: `[ ] not enforced` (convention only).

4. **Worker Role Contracts** — Table per role (analyst, builder, integrator): handled phases, available skills, model recommendation. Worker autonomy rules: check TaskList, self-assign (owner + in_progress), invoke skill, report via TaskUpdate, check TaskList again before stopping. Communication discipline: workers MUST NOT send SendMessage for routine reporting — TaskUpdate is the primary channel. SendMessage reserved for escalations and direct question responses. Enablement: `[x] worker-stop-gate.sh` (TaskList check before idle), `[x] require-skill-context.sh` (blocks mutating calls outside skill context).

5. **Sub-Agent Team Isolation** — Internal sub-tasks spawned via Task() within a skill MUST NOT pass `team_name`. Internal sub-agents are research helpers, not team workers. Passing `team_name` would pollute the team's TaskList scope. Include correct/incorrect code examples. Enablement: `[ ] not enforced` (convention only).

6. **Shutdown Protocol** — Step-by-step sequence (6 steps from ralph-team SKILL.md):
   1. Collect session data: TaskList + TaskGet on each task
   2. Write post-mortem to `thoughts/shared/reports/YYYY-MM-DD-ralph-team-{team-name}.md`
   3. Commit and push: `git commit -m "docs(report): {team-name} session post-mortem"`
   4. Send shutdown_request to each teammate
   5. Wait for all confirmations (approve/reject)
   6. Call TeamDelete()
   Key requirement: post-mortem MUST be completed before TeamDelete (task data is ephemeral, destroyed by TeamDelete). Enablement: `[x] team-stop-gate.sh` (blocks lead stop if processable issues remain), `[ ] not enforced` (post-mortem before TeamDelete ordering).

7. **Post-Mortem Requirements** — Required sections: Date, Summary (one-line), Issues Processed table (number, title, estimate, outcome, PR), Worker Summary table (worker, tasks completed), Key Metrics (optional), Notes (escalations, errors). Commit message pattern: `docs(report): {team-name} session post-mortem`. Enablement: `[ ] not enforced` (convention only).

**Cross-References**: Link to task-schema.md (TaskCreate/TaskUpdate fields, metadata keys), agent-permissions.md (per-agent tool whitelists), skill-io-contracts.md (per-skill contracts workers execute).

### Success Criteria
- [ ] Automated: `test -f specs/team-schema.md && grep -q "## Purpose" specs/team-schema.md && grep -q "## Requirements" specs/team-schema.md && grep -q "## Cross-References" specs/team-schema.md`
- [ ] Manual: TeamCreate ordering requirement present
- [ ] Manual: Roster sizing table with role limits documented
- [ ] Manual: Spawn protocol with required prompt fields per role documented
- [ ] Manual: Shutdown protocol has all 6 steps with post-mortem-before-TeamDelete ordering
- [ ] Manual: Enablement checkboxes match actual enforcement

---

## Integration Testing
- [ ] All 9 specs in `specs/` directory: README.md + 4 Phase 1 + 2 Phase 2 + 2 Phase 3
- [ ] Phase 3 specs follow same template as Phase 1 and Phase 2 specs (Purpose, Definitions, Requirements, Cross-References)
- [ ] Cross-references between Phase 3 and earlier specs are consistent
- [ ] No duplicate content between task-schema.md (TaskUpdate result schema) and skill-io-contracts.md (per-skill postconditions)
- [ ] No duplicate content between team-schema.md (worker role contracts) and agent-permissions.md (per-agent permissions)
- [ ] Enablement checkboxes: advisory hooks marked appropriately (team-task-completed.sh is `[x]` advisory, not blocking)

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0470-coordination-specs.md
- Parent plan: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-28-ralph-protocol-specs.md
- Phase 1 plan: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-03-01-GH-0468-scaffold-and-core-specs.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/470
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/467
- Worker scope boundaries: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0044-worker-scope-boundaries.md
- GH-451 post-mortem: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/reports/2026-02-27-ralph-team-GH-451.md
