---
date: 2026-02-16
status: draft
type: plan
topic: "Peer-to-Peer Pipeline Handoffs - Agent Teams Task System Fix"
tags: [agent-teams, task-system, peer-handoff, token-optimization, ralph-team]
depends_on: 2026-02-15-skill-prompt-refactoring.md
---

# Peer-to-Peer Pipeline Handoffs

## Overview

Refactor the Agent Teams task system to use peer-to-peer SendMessage handoffs between pipeline stages, eliminating the lead as a token-burning middleman for routine pipeline progression. The lead's role narrows to **intake** (pulling GitHub issues) and **exception handling** (review rejections, failures).

## Problem Statement

When a researcher completes a task:
1. The plan task auto-unblocks (correct — blocking system works)
2. The planner is **idle (stopped)** — it can't poll TaskList
3. The lead receives a TaskCompleted hook, runs the full dispatch loop, then wakes the planner
4. This costs the lead significant tokens for what is a trivial routing decision

Additionally, when the lead uses `TaskUpdate(owner=...)` to assign tasks, teammates receive assignment notifications and re-process already-completed work.

## Current State Analysis

**What works correctly:**
- Task blocking/unblocking is automatic
- Agent definitions already use pull-based claiming ("On Spawn and After Each Completion")
- SendMessage between teammates is supported and wakes idle agents
- Lead idle notifications include DM summaries between teammates (visibility preserved)

**What's broken:**
- No peer-to-peer wake-up after task completion — lead is the only wake mechanism
- Lead's dispatch loop handles every single completion, burning tokens on routine routing
- TaskCompleted hook tells the lead to run the FULL dispatch loop for every completion
- TeammateIdle hook tells the lead to check for tasks, even when the idle is expected (waiting for upstream)

**Key files (current state on `feat/skill-prompt-refactoring`):**
- `plugin/ralph-hero/agents/ralph-researcher.md` — 77 lines, pull-based, SendMessage exceptions-only
- `plugin/ralph-hero/agents/ralph-planner.md` — 70 lines, pull-based, SendMessage exceptions-only
- `plugin/ralph-hero/agents/ralph-advocate.md` — 65 lines, pull-based, SendMessage exceptions-only
- `plugin/ralph-hero/agents/ralph-implementer.md` — 72 lines, pull-based, SendMessage exceptions-only
- `plugin/ralph-hero/skills/ralph-team/SKILL.md` — 252 lines, dispatch loop in Section 4.4
- `plugin/ralph-hero/skills/shared/conventions.md` — 77 lines, escalation + links + errors
- `plugin/ralph-hero/hooks/scripts/team-task-completed.sh` — 29 lines, full dispatch loop guidance
- `plugin/ralph-hero/hooks/scripts/team-teammate-idle.sh` — 23 lines, tells lead to check tasks

## Desired End State

### Token flow: before vs after

**Before (lead as middleman):**
```
Researcher completes → Lead wakes (tokens) → Lead runs dispatch (tokens)
→ Lead checks TaskList (tokens) → Lead messages Planner (tokens) → Planner wakes
```

**After (peer-to-peer):**
```
Researcher completes → SendMessage("planner", "check TaskList") → Planner wakes
Lead only wakes for: intake, exceptions, PR creation
```

### Lead's narrowed responsibilities

| Responsibility | When it triggers |
|---|---|
| **Intake** | Pipeline drains — no unblocked tasks remain → pull from GitHub |
| **Exceptions** | Review NEEDS_ITERATION → create revision task. Skill failure → replace worker. |
| **PR creation** | All implementation tasks complete → push + `gh pr create` |
| **Spawn** | Initial team setup, or when a role has unblocked tasks but no worker exists |

### Verification

- [ ] Workers complete tasks and wake next-stage peers without lead involvement
- [ ] Lead only activates on intake (no unblocked tasks) or exceptions (review rejections)
- [ ] Lead's TaskCompleted hook only triggers dispatch for exceptions, not routine completions
- [ ] Researchers, planners, reviewers, implementers all have peer handoff in their completion flow
- [ ] `grep -r "TaskUpdate.*owner" agents/` returns zero results (no push-based assignment)
- [ ] Full pipeline run (research → plan → review → implement) completes with lead doing only intake + PR

## What We're NOT Doing

- Changing the ralph-hero skill (single orchestrator, no agent teams)
- Modifying the task blocking/unblocking system (it works correctly)
- Adding a TeammateIdle hook on workers (not supported — TeammateIdle fires on the lead)
- Changing how workers claim tasks (pull-based claiming stays as-is)
- Removing the lead's dispatch loop entirely (still needed for exceptions + intake)

## Implementation Approach

The pipeline has a fixed order: Research → Plan → Review → Implement → PR (lead).
Each worker learns who comes next via a role-based lookup of the team config file.
After completing a task and finding no more tasks of their type, a worker SendMessages
the next-stage peer. If the peer doesn't exist, they fall back to messaging the lead.

---

## Phase 1: Shared Conventions — Pipeline Handoff Protocol

### Overview
Add the pipeline handoff protocol to the shared conventions doc, establishing the canonical reference that all agents will follow.

### Changes Required

#### 1. Update shared/conventions.md
**File**: `plugin/ralph-hero/skills/shared/conventions.md`
**Changes**: Add a new "Pipeline Handoff Protocol" section

Add after the existing "Common Error Handling" section:

```markdown
## Pipeline Handoff Protocol

Workers hand off to the next pipeline stage via peer-to-peer SendMessage, bypassing the lead for routine progression.

### Pipeline Order

| Current Role | Next Stage | agentType to find |
|---|---|---|
| ralph-researcher | Planner | ralph-planner |
| ralph-planner | Reviewer | ralph-advocate |
| ralph-advocate | Implementer | ralph-implementer |
| ralph-implementer | Lead (PR creation) | team-lead |

### Handoff Procedure (after completing a task)

1. Check TaskList for more tasks matching your role
2. If found: self-claim and continue (no handoff needed)
3. If none available: hand off to the next-stage peer:

```
# Read team config to find next-stage teammate by agentType
# Config location: ~/.claude/teams/[TEAM_NAME]/config.json
# Find member where agentType matches the "Next Stage" column above

SendMessage(
  type="message",
  recipient="[name from config]",  # Use the `name` field, not agentId
  content="Pipeline handoff: check TaskList for newly unblocked work",
  summary="Handoff: task unblocked"
)
```

4. If the next-stage teammate is NOT found in the config (role not spawned):

```
SendMessage(
  type="message",
  recipient="team-lead",
  content="No [next-role] teammate exists. Unblocked tasks may need a new worker.",
  summary="No peer for handoff"
)
```

### Rules

- **Never use TaskUpdate with `owner` parameter** to assign tasks to other teammates. Workers self-claim only.
- **SendMessage is fire-and-forget** — no acknowledgment mechanism. The handoff wakes the peer; they self-claim from TaskList.
- **Lead gets visibility** via idle notification DM summaries — no need to CC the lead on handoffs.
- **Multiple handoffs are fine** — if 3 researchers complete and all message the planner, the planner wakes up 3 times and claims one task each time.
```

### Success Criteria

#### Automated Verification:
- [x] `grep "Pipeline Handoff Protocol" plugin/ralph-hero/skills/shared/conventions.md` returns a match
- [x] `grep "TaskUpdate.*owner" plugin/ralph-hero/skills/shared/conventions.md` finds the "Never use" prohibition

#### Manual Verification:
- [ ] Protocol is clear and complete — a new agent reading only conventions.md could execute a handoff

---

## Phase 2: Agent Definitions — Add Peer Handoff to Workers

### Overview
Update all 4 worker agent definitions to include the peer handoff procedure after task completion. Each agent learns the pipeline map and uses role-based lookup.

### Changes Required

#### 1. ralph-researcher.md
**File**: `plugin/ralph-hero/agents/ralph-researcher.md`
**Changes**: Add handoff step after "Then immediately run `TaskList()`" in the Completing Tasks section

Replace the current completion flow:
```
Then immediately run `TaskList()` to claim next available research task.
```

With:
```
Then immediately run `TaskList()` to claim next available research task.
If no research tasks are available, hand off to the next pipeline stage per
[shared/conventions.md](../shared/conventions.md#pipeline-handoff-protocol):
read the team config, find the `ralph-planner` teammate, and SendMessage them
to check TaskList.
```

#### 2. ralph-planner.md
**File**: `plugin/ralph-hero/agents/ralph-planner.md`
**Changes**: Same pattern — after checking TaskList, hand off to `ralph-advocate`

Replace:
```
Then immediately run `TaskList()` to claim next available planning task.
```

With:
```
Then immediately run `TaskList()` to claim next available planning task.
If no planning tasks are available, hand off to the next pipeline stage per
[shared/conventions.md](../shared/conventions.md#pipeline-handoff-protocol):
read the team config, find the `ralph-advocate` teammate, and SendMessage them
to check TaskList.
```

#### 3. ralph-advocate.md
**File**: `plugin/ralph-hero/agents/ralph-advocate.md`
**Changes**: Same pattern — after checking TaskList, hand off to `ralph-implementer`

Replace:
```
Then immediately run `TaskList()` to claim next available review task.
```

With:
```
Then immediately run `TaskList()` to claim next available review task.
If no review tasks are available, hand off to the next pipeline stage per
[shared/conventions.md](../shared/conventions.md#pipeline-handoff-protocol):
read the team config, find the `ralph-implementer` teammate, and SendMessage them
to check TaskList.
```

#### 4. ralph-implementer.md
**File**: `plugin/ralph-hero/agents/ralph-implementer.md`
**Changes**: After checking TaskList, notify the lead (implementation complete → PR creation is lead's job)

Replace:
```
Then immediately run `TaskList()` to claim next available implementation task.
```

With:
```
Then immediately run `TaskList()` to claim next available implementation task.
If no implementation tasks are available, notify the lead per
[shared/conventions.md](../shared/conventions.md#pipeline-handoff-protocol):
SendMessage `team-lead` that implementation is complete and PR creation may be needed.
```

### Success Criteria

#### Automated Verification:
- [x] `grep -l "pipeline-handoff-protocol" plugin/ralph-hero/agents/*.md` returns all 4 agent files
- [x] Handoff sections use SendMessage only, no TaskUpdate with owner for assignment
- [x] All agent .md files parse valid YAML frontmatter

#### Manual Verification:
- [ ] Each agent's completion flow reads: claim next task → if none → handoff to peer → if peer missing → fall back to lead
- [ ] The pipeline map in each agent matches: researcher→planner, planner→reviewer, reviewer→implementer, implementer→lead

---

## Phase 3: Lead Skill & Hooks — Narrow to Exceptions + Intake

### Overview
Update the ralph-team SKILL.md dispatch loop and hook scripts so the lead only activates for exceptions (review rejections, failures) and intake (pulling new GitHub issues when the pipeline drains).

### Changes Required

#### 1. Update team-task-completed.sh
**File**: `plugin/ralph-hero/hooks/scripts/team-task-completed.sh`
**Changes**: Narrow guidance from "full dispatch loop" to "exceptions + intake check"

Replace the current DISPATCH LOOP guidance with:

```bash
#!/bin/bash
# team-task-completed.sh - Guide lead after task completion
# Peer-to-peer handoffs handle routine pipeline progression.
# Lead only needs to act on exceptions or pipeline drain.
set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

INPUT=$(cat)

TASK_SUBJECT=$(echo "$INPUT" | jq -r '.task_subject // "unknown"')
TEAMMATE=$(echo "$INPUT" | jq -r '.teammate_name // "unknown"')

# Check if this is a review task (may need exception handling)
if echo "$TASK_SUBJECT" | grep -qi "review"; then
  cat >&2 <<EOF
Review task completed by $TEAMMATE: "$TASK_SUBJECT"
ACTION: TaskGet the completed task. Check verdict:
- APPROVED: peer handoff will wake implementer. Verify worker exists.
- NEEDS_ITERATION: Create revision task with "Plan" in subject for planner.
EOF
else
  cat >&2 <<EOF
Task completed by $TEAMMATE: "$TASK_SUBJECT"
Peer handoff handles routine pipeline progression.
CHECK: Are there idle workers with no unblocked tasks? If so, pull new GitHub issues.
EOF
fi
exit 0
```

#### 2. Update team-teammate-idle.sh
**File**: `plugin/ralph-hero/hooks/scripts/team-teammate-idle.sh`
**Changes**: Distinguish expected idle (waiting for upstream) from pipeline drain (needs intake)

```bash
#!/bin/bash
# team-teammate-idle.sh - Guide lead when teammate goes idle
# Workers go idle when no tasks match their role. This is normal
# if upstream stages haven't completed yet. Only act if the pipeline
# has drained and new GitHub issues need pulling.
set -euo pipefail
source "$(dirname "$0")/hook-utils.sh"

INPUT=$(cat)

TEAMMATE=$(echo "$INPUT" | jq -r '.teammate_name // "unknown"')

cat >&2 <<EOF
$TEAMMATE is idle.
This is NORMAL if upstream pipeline stages haven't completed yet.
Peers will wake this teammate when work unblocks.
ACTION: Only intervene if TaskList shows NO pending/in-progress tasks at all.
If pipeline is drained: use pick_actionable_issue to find new GitHub work.
EOF
exit 0
```

#### 3. Update ralph-team SKILL.md dispatch loop
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**: Rewrite Section 4.4 to reflect the narrowed dispatch loop

Replace the current Section 4.4 content with:

```markdown
### 4.4 Dispatch Loop

The lifecycle hooks (`TaskCompleted`, `TeammateIdle`, `Stop`) fire at natural
decision points and tell you what to check. Follow their guidance.

**Routine pipeline progression is handled by peer-to-peer handoffs** — workers
SendMessage the next-stage teammate when they complete a task and have no more
work of their type. You do NOT need to route every completion.

Your dispatch responsibilities:

1. **Exception handling**: When a review task completes with NEEDS_ITERATION,
   create a revision task with "Plan" in the subject. The planner will self-claim.
2. **Worker gaps**: If a role has unblocked tasks but no active worker (role was
   never spawned, or worker crashed), spawn one (Section 6).
3. **Intake**: When idle notifications arrive and TaskList shows no pending tasks,
   pull new issues from GitHub via `pick_actionable_issue` for each idle role.
   Create task chains for found issues.
4. **PR creation**: When all implementation tasks for an issue/group complete,
   push and create PR (Section 4.5). This is your only direct work.

The Stop hook prevents premature shutdown — you cannot stop while GitHub has
processable issues. Trust it.
```

#### 4. Add anti-pattern note to Section 5 (Behavioral Principles)
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**: Add one line to the behavioral principles

Add to the existing principles:

```markdown
- **Never assign tasks**: Do NOT call TaskUpdate with `owner` to assign work.
  Workers self-claim. Do NOT send assignment messages via SendMessage.
  Pipeline handoffs are peer-to-peer.
```

#### 5. Add peer handoff to Section 9 (Known Limitations)
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Changes**: Add note about peer handoff dependency

Add to known limitations:

```markdown
- **Peer handoff depends on workers existing**: If a stage has no worker (never
  spawned or crashed), the handoff falls back to the lead. The lead must then
  spawn a replacement.
```

### Success Criteria

#### Automated Verification:
- [x] `team-task-completed.sh` contains "Peer handoff" text
- [x] `team-teammate-idle.sh` contains "Peers will wake" text
- [x] `grep "Never assign tasks" plugin/ralph-hero/skills/ralph-team/SKILL.md` returns a match
- [x] `grep -c "TaskUpdate.*owner" plugin/ralph-hero/skills/ralph-team/SKILL.md` returns 0 (no push-based assignment)
- [x] All 3 hook scripts are executable: `test -x hooks/scripts/team-*.sh`

#### Manual Verification:
- [ ] Run a simulated pipeline: researcher completes → planner wakes via peer SendMessage → lead stays idle
- [ ] Verify lead only activates on: review rejection, pipeline drain, PR creation
- [ ] Verify lead does NOT activate for routine research→plan, plan→review, review→implement transitions

**Implementation Note**: After completing this phase, test by running `/ralph_team` on a test issue and observing the lead's token usage. The lead should be significantly less active during routine pipeline progression.

---

## Testing Strategy

### Unit Tests
- N/A — changes are to markdown skill/agent files and bash hook scripts

### Integration Tests
- Run `/ralph_team [test-issue]` end-to-end
- Monitor which agents activate at each pipeline transition
- Verify peer SendMessage appears in idle notification DM summaries

### Manual Testing Steps
1. Run `/ralph_team` with a single issue in "Research Needed" state
2. Watch researcher complete → verify it SendMessages planner (not lead)
3. Watch planner complete → verify it SendMessages reviewer
4. Watch reviewer approve → verify it SendMessages implementer
5. Watch implementer complete → verify it SendMessages lead for PR
6. Verify lead only ran dispatch loop for: initial setup, PR creation, and any exceptions

## Performance Considerations

**Token savings**: For a 4-stage pipeline (research → plan → review → implement), the lead currently runs 4 full dispatch cycles. With peer handoffs, the lead runs 0 dispatch cycles for routine progression — only intake at start and PR at end. Estimated ~60% reduction in lead token spend per issue.

**Latency**: Peer-to-peer SendMessage is faster than going through the lead (one hop vs three: worker→lead, lead processes, lead→worker).

## References

- Claude Code Agent Teams: https://code.claude.com/docs/en/agent-teams
- SendMessage between teammates: documented in Claude Code Agent Teams
- Existing skill plan: `thoughts/shared/plans/2026-02-15-skill-prompt-refactoring.md` (Phases 1-4)
- Current agent definitions: `plugin/ralph-hero/agents/*.md`
- Current hook scripts: `plugin/ralph-hero/hooks/scripts/team-*.sh`
