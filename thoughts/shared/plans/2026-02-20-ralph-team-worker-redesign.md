# Ralph Team Worker Redesign

**Date**: 2026-02-20
**Status**: Draft
**Related**: GH-218 (supersedes original approach)

---

## Problem Statement

Ralph team runs produce duplicate work, worker confusion, and excessive lead overhead. Root causes identified across multiple sessions (GH-94, GH-99):

1. **Seven spawn templates instead of one** — behavioral logic is duplicated and inconsistent across templates. `implementer.md` contacts the lead; others defer to `conventions.md`. No single source of truth.
2. **Workers check TaskList on spawn** — templates instruct workers to scan for new work immediately. Multiple workers spawned in the same bough see the same unclaimed tasks and race to claim them.
3. **Agent definitions are dead code** — `ralph-analyst.md`, `ralph-builder.md`, etc. define a complete Task Loop that workers never see (workers are spawned as `general-purpose`, not as typed agents). The files contain conflicting instructions that nobody reads.
4. **Full pipeline created upfront** — SKILL.md Section 4.2 creates Research → Plan → Implement → PR tasks all at once. Workers can see and claim future-phase tasks before their phase is reached.
5. **Conflicting handoff instructions** — `conventions.md` says peer-to-peer; `implementer.md` says message the lead; `team-teammate-idle.sh` says peers will wake idle workers. Three different models.
6. **Lead assigns mid-pipeline is forbidden** — `conventions.md` line 133 says "Do NOT assign tasks mid-pipeline via TaskUpdate or SendMessage." This prevents the lead from assigning bough work to idle workers, which is necessary for the bough model.

---

## Design Principles

1. **Workers do assigned work, not discovered work** — on spawn, a worker has a task. It does that task. It does not scan for more work on spawn.
2. **TaskList checking happens at idle, not at start** — when a worker finishes and tries to stop, a Stop hook checks for more owned or matching unclaimed work. This is the only work-discovery point.
3. **One spawn template** — a single `worker.md` with role-specific variables substituted like lego pieces. Protocol changes (claiming, stopping) happen in one place.
4. **Activated agent definitions** — workers spawned as typed agents (`ralph-analyst`, `ralph-builder`, etc.) so agent definitions load as the worker's system prompt. Agent definitions own role knowledge (which skills, how to dispatch). Spawn template owns session protocol.
5. **Stop hook does one job** — check TaskList for more work. Not task completion (worker does that naturally). Not pipeline logic. Just: is there more work for my role?
6. **Bough model** — lead creates tasks for the current phase only. Next phase tasks are created after convergence is detected. Workers can only see and claim tasks that exist.
7. **Lead assigns to idle workers** — when convergence is detected and next bough tasks are created, lead assigns them (TaskUpdate owner) before workers go looking. Workers discover their assignment via priority-1 check (owned tasks first).

---

## Proposed Changes

### 1. One Spawn Template: `templates/spawn/worker.md`

Replaces all 7 current templates. Session protocol lives here.

```markdown
You are a {ROLE_NAME} in the Ralph Team.

{TASK_CONTEXT}

{SKILL_DISPATCH}
```

**Variables**:

| Variable | Description |
|----------|-------------|
| `{ROLE_NAME}` | Analyst / Builder / Validator / Integrator |
| `{TASK_CONTEXT}` | "GH-{ISSUE_NUMBER}: {TITLE}" |
| `{SKILL_DISPATCH}` | Role-specific skill invocation (from agent definition) |

- No TaskList instructions in the template
- No report format in the template (skill defines its own output)
- No handoff instructions in the template

The 7 existing templates (`researcher.md`, `planner.md`, `implementer.md`, `integrator.md`, `splitter.md`, `triager.md`, `reviewer.md`) are deleted.

---

### 2. Activated Agent Definitions

Workers are spawned as their typed agent (`ralph-analyst`, `ralph-builder`, etc.) instead of `general-purpose`. Agent definitions load as the worker's system prompt and own role knowledge.

Each agent definition:
- **Frontmatter**: tools, model, color, Stop hook
- **Body**: role description, skill dispatch table, task completion behavior

**Skill dispatch per role** (in agent body):

| Role | Task keywords | Skills |
|------|--------------|--------|
| `ralph-analyst` | Triage, Split, Research | ralph-triage, ralph-split, ralph-research |
| `ralph-builder` | Plan, Implement | ralph-plan, ralph-impl |
| `ralph-validator` | Review | ralph-review |
| `ralph-integrator` | Create PR, Merge | (direct git/gh commands) |

**Task completion** (in agent body): After the skill completes, find your owned `in_progress` task via `TaskList()` and mark it `completed`. This is natural cleanup, not work discovery.

**Stop hook** (in agent frontmatter):
```yaml
hooks:
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/worker-stop-gate.sh"
```

---

### 3. New Hook: `hooks/scripts/worker-stop-gate.sh`

One job: check TaskList for more work before allowing stop.

```
Input: worker role keywords (via env var or agent context)
Logic:
  - Scan TaskList for tasks matching role keywords
  - Priority 1: unblocked tasks owned by this worker (status != completed)
  - Priority 2: unblocked unclaimed tasks matching role keywords
  - If found: exit 2 (block stop, inject guidance to claim and continue)
  - If not found: exit 0 (allow stop, worker DMs lead)
```

Open question: team name discovery. The hook needs the task directory path (`~/.claude/tasks/{TEAM_NAME}/`). Resolution options:
- Env var injected by team system
- Spawn template includes `TEAM_NAME` as exported variable
- Hook reads `~/.claude/teams/` to discover active team

---

### 4. SKILL.md (`ralph-team`) — Bough Model

**Section 4.2** — Create current bough only:
- Create tasks for the current pipeline phase only (e.g., only Research tasks at start)
- Set owner immediately after TaskCreate (task is owned before worker scans)
- Next phase tasks are created only after convergence is detected

**Section 4.3** — Spawn typed agents:
- `subagent_type="ralph-analyst"` (not `general-purpose`)
- Same for builder, validator, integrator

**Section 4.4** — Convergence-triggered bough advancement:
- On TaskCompleted hook: check GitHub state for phase convergence
- On convergence: create next bough tasks, assign owners, no DM needed (workers discover via Stop hook or natural scan)
- Lead assigns to idle workers if all workers are idle when new bough is created

**Section 5** — Remove "Do NOT assign tasks mid-pipeline" constraint:
- Lead CAN assign tasks mid-pipeline when idle workers need work

---

### 5. `conventions.md` — Remove Conflicting Instructions

- Remove: "Do NOT assign tasks mid-pipeline via TaskUpdate or SendMessage" (line 133-134)
- Update: Pipeline Handoff Protocol — simplify, peer-to-peer is optional not required
- Update: `team-teammate-idle.sh` guidance — remove "peers will wake this teammate"
- Add: Worker Claiming section — two-level check (owned first, unclaimed second), only at idle via Stop hook

---

## File Change Summary

| File | Change |
|------|--------|
| `templates/spawn/worker.md` | New — single template |
| `templates/spawn/researcher.md` | Deleted |
| `templates/spawn/planner.md` | Deleted |
| `templates/spawn/implementer.md` | Deleted |
| `templates/spawn/integrator.md` | Deleted |
| `templates/spawn/splitter.md` | Deleted |
| `templates/spawn/triager.md` | Deleted |
| `templates/spawn/reviewer.md` | Deleted |
| `agents/ralph-analyst.md` | Updated — Stop hook, slimmed body |
| `agents/ralph-builder.md` | Updated — Stop hook, slimmed body |
| `agents/ralph-validator.md` | Updated — Stop hook, slimmed body |
| `agents/ralph-integrator.md` | Updated — Stop hook, slimmed body |
| `hooks/scripts/worker-stop-gate.sh` | New |
| `hooks/scripts/team-teammate-idle.sh` | Updated |
| `skills/ralph-team/SKILL.md` | Updated — bough model, typed agents |
| `skills/shared/conventions.md` | Updated — remove conflicting rules |

---

### 6. Skill Sub-Agent Team Context Isolation (GH-231)

Skills invoked by workers (`ralph-research`, `ralph-plan`, `ralph-impl`, `ralph-split`) internally spawn sub-agents via `Task()`. These sub-agents inherit the parent's team context and appear as phantom teammates (`@list-issues`, `@codebase-locator`, etc.), flooding the lead with unrecognizable idle notifications.

**Fix**: All internal `Task()` calls within skills must omit `team_name`. Sub-agents run outside the team and return results to the invoking skill without ever enrolling as teammates.

Affected files: any skill that uses `Task()` internally — at minimum `ralph-research`, likely `ralph-plan`, `ralph-impl`, `ralph-split`.

---

## Open Questions

1. **Team name in stop hook** — how does `worker-stop-gate.sh` discover the team name to find the task directory? Needs resolution during implementation.
2. **Spawn template variable substitution** — lead currently reads template files and substitutes placeholders. With one template, the variable set grows. Leader needs a clear map of which agent definition provides which variable values.
3. **RALPH_REVIEW_MODE handling** — validator is only spawned when `RALPH_REVIEW_MODE=interactive`. The single spawn template needs to handle the case where the validator role's `{SKILL_DISPATCH}` is conditionally included. Likely handled by lead not spawning a validator at all rather than template branching.
