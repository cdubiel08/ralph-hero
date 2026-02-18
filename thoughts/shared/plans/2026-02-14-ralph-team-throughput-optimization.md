---
date: 2026-02-14
status: draft
linear_ticket: LAN-382
linear_url: https://linear.app/landcrawler-ai/issue/LAN-382/ralph-hero-plugin-team-throughput-optimization-pull-based-architecture
---

# Ralph-Hero Plugin: Team Throughput Optimization Plan

## Overview

Apply the same 7 throughput optimizations from the workspace-level Ralph Team to the ralph-hero plugin. This converts the plugin's agent team from a push-based system (lead assigns work via SendMessage, workers report via SendMessage) to a pull-based system (workers self-claim tasks from TaskList, report results via TaskUpdate description embedding).

Reference implementation: `~/projects/.claude/commands/ralph_team.md` and `~/projects/.claude/agents/ralph-*.md` (workspace-level optimized versions).

## Current State Analysis

### Plugin Files (all at `ralph-hero/plugin/ralph-hero/`)

| File | Lines | Issue |
|------|-------|-------|
| `agents/ralph-researcher.md` | 83 | Push-based: SendMessage for result reporting |
| `agents/ralph-planner.md` | 72 | Push-based: SendMessage for result reporting |
| `agents/ralph-advocate.md` | 79 | Push-based + "re-send if no ack" anti-pattern |
| `agents/ralph-implementer.md` | 76 | Push-based: SendMessage for result reporting |
| `agents/ralph-triager.md` | 62 | Push-based: SendMessage for result reporting |
| `skills/ralph-team/SKILL.md` | 691 | Missing all 7 optimizations, push-based dispatch |

### Key Differences from Workspace (to preserve)

- Uses `ralph_hero__*` MCP tools (not `mcp__plugin_linear_linear__*`)
- Issue numbers `#NNN` (not `LAN-XXX`)
- Plugin skill qualification `ralph-hero:ralph-xxx` (not `ralph_xxx`)
- Worktree paths `worktrees/GH-NNN` (not `landcrawler-worktrees/LAN-XXX`)
- GitHub Projects V2 workflow states via `ralph_hero__update_workflow_state`
- `$RALPH_GH_OWNER`, `$RALPH_GH_REPO`, `$RALPH_GH_PROJECT_NUMBER` env vars
- Team names `ralph-team-GH-NNN` (not `ralph-team-LAN-XXX`)

## Desired End State

All 6 plugin files updated with the same pull-based architecture as the workspace. Specifically:

1. **Workers self-claim tasks** from TaskList by matching subject patterns
2. **Results embedded in TaskUpdate description** instead of SendMessage
3. **SendMessage reserved for exceptions** (blocking issues, conflicts, skill failures)
4. **Dispatch loop has early-exit** (TeammateIdle without completion skips to worker-existence check)
5. **Proactive lookahead** (lead pre-queries GitHub while workers are busy)
6. **XS ticket fast-track** (skip research/plan/review for trivial issues)
7. **Parallel worker spawning** (up to 3 researchers for group issues)
8. **Richer spawn prompts** (6 required elements per Anthropic best practices)

### Verification

- Diff each plugin agent against its workspace counterpart to confirm pattern parity
- Confirm all `SendMessage` references in agents are exception-only
- Confirm all spawn prompts in SKILL.md use "Embed results in task description via TaskUpdate" (not "Report via SendMessage")
- Confirm dispatch loop has 5 steps including early-exit and lookahead
- Confirm Section 5 behavioral principles reference pull-based patterns

## What We're NOT Doing

- NOT changing `ralph-hero/SKILL.md` (solo orchestrator — different architecture, separate plan exists)
- NOT changing any skill files (`ralph-research`, `ralph-plan`, etc.) — only agent definitions and the team orchestrator
- NOT changing MCP tools, hooks infrastructure, or plugin manifest
- NOT adding new files — only editing existing ones
- NOT changing the state machine or workflow states

## Implementation Approach

Mechanical translation: take each optimized workspace file, adapt identifiers (LAN-XXX → #NNN, skill names, MCP tools, paths), and write the result to the corresponding plugin file.

## Phase 1: Update 5 Agent Definitions

### Overview
Convert all 5 plugin agent definitions from push-based to pull-based pattern. Each follows the same template as its workspace counterpart.

### Changes Required:

#### 1. `agents/ralph-researcher.md`
**File**: `ralph-hero/plugin/ralph-hero/agents/ralph-researcher.md`
**Changes**: Replace entire workflow with pull-based pattern from workspace `ralph-researcher.md`

Key changes:
- Replace Section 4 "Report Completion" (SendMessage) with TaskUpdate description embedding
- Replace Section 5 "Claim Next Task" with continuous pull loop
- Add "Task Claiming (Pull-Based)" as primary section
- Add "When to Use SendMessage" (exception-only)
- Add TaskUpdate `description` REPLACE warning
- Change skill qualification: `ralph-hero:ralph-research` (already correct)
- Keep `#NNN` format (already correct)

#### 2. `agents/ralph-planner.md`
**File**: `ralph-hero/plugin/ralph-hero/agents/ralph-planner.md`
**Changes**: Same conversion. Subject filter: "Plan" but NOT "Review"

Key changes:
- Replace Section 3 "Report Completion" with TaskUpdate
- Add "Handling Revision Requests" — read feedback from review task description
- Keep `ralph-hero:ralph-plan` skill qualification

#### 3. `agents/ralph-advocate.md`
**File**: `ralph-hero/plugin/ralph-hero/agents/ralph-advocate.md`
**Changes**: Same conversion. Subject filter: "Review". Remove "re-send if no ack" anti-pattern.

Key changes:
- Replace Section 4 "Report Verdict" with TaskUpdate (FULL verdict in description)
- REMOVE "If you don't get acknowledgment within 1 turn, re-send the verdict"
- REMOVE "Re-send if no acknowledgment" from Key Rules
- Keep `ralph-hero:ralph-review` skill qualification

#### 4. `agents/ralph-implementer.md`
**File**: `ralph-hero/plugin/ralph-hero/agents/ralph-implementer.md`
**Changes**: Same conversion. Subject filter: "Implement".

Key changes:
- Replace Section 4 "Report Completion" with TaskUpdate
- Keep "DO NOT push" rule
- Keep `ralph-hero:ralph-impl` skill qualification

#### 5. `agents/ralph-triager.md`
**File**: `ralph-hero/plugin/ralph-hero/agents/ralph-triager.md`
**Changes**: Same conversion. Subject filter: "Triage" or "Split".

Key changes:
- Replace Section 3 "Report Completion" with TaskUpdate
- Emphasize sub-ticket IDs MUST be in completion description
- Keep `ralph-hero:ralph-triage` and `ralph-hero:ralph-split` skill qualifications

### Success Criteria:

#### Automated Verification:
- [ ] All 5 agent files have "Task Claiming (Pull-Based)" section
- [ ] All 5 agent files have "When to Use SendMessage" (exception-only) section
- [ ] All 5 agent files reference TaskUpdate description embedding for results
- [ ] All 5 agent files warn about TaskUpdate `description` being REPLACE
- [ ] No agent file uses SendMessage for normal result reporting
- [ ] `ralph-advocate.md` does NOT contain "re-send" or "acknowledgment" patterns
- [ ] All skill references use `ralph-hero:` prefix

#### Manual Verification:
- [ ] Each agent file reads naturally and is self-consistent
- [ ] Diff each plugin agent against workspace counterpart confirms pattern parity

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to Phase 2.

---

## Phase 2: Update Orchestrator SKILL.md — Frontmatter & Sections 3-4

### Overview
Update the first half of the orchestrator: hooks, state detection (add fast-track), task creation, worker spawning, and dispatch loop.

### Changes Required:

#### 1. Frontmatter Hooks
**File**: `ralph-hero/plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Lines**: 11-17
**Changes**: Update hook messages to reference TaskGet-based result reading

```yaml
hooks:
  TaskCompleted:
    - hooks:
        - type: command
          command: "echo 'Task completed. Read its results via TaskGet, then advance the pipeline (Section 4.4 step 1-2).' >&2; exit 0"
  TeammateIdle:
    - hooks:
        - type: command
          command: "echo 'Teammate idle. Check if workers exist for all roles with available tasks (Section 4.4 step 3).' >&2; exit 0"
```

#### 2. Section 3.1: XS Ticket Fast-Track (NEW)
**Insert after**: Section 3 pipeline table (after line ~139)
**Changes**: Add new subsection

```markdown
### 3.1 Effort Scaling: XS Issue Fast-Track

For XS issues (estimate = 1) where the description is specific and actionable (e.g., "fix typo in X", "rename Y to Z", "add field F to model M"):

**Skip research and planning.** Create tasks for implementation directly:

TaskCreate(subject="Implement #NNN (fast-track)", description="XS fast-track: [title]\nDescription: [full description]\nNo plan needed — implement directly from issue description.", activeForm="Implementing #NNN")
TaskCreate(subject="Create PR for #NNN", description="Lead creates PR", activeForm="Creating PR")
TaskUpdate(taskId="[pr]", addBlockedBy=["[impl]"])

Move issue to "In Progress" (skip Research Needed → Ready for Plan → Plan in Review).

**Criteria for fast-track**:
- Estimate is XS (1 point)
- Description includes specific file paths or clear, unambiguous changes
- No architectural decisions needed
- Single-file or 2-3 file change

**When NOT to fast-track** (even if XS):
- Issue description is vague ("improve performance", "fix bug")
- Change touches shared infrastructure
- Change requires understanding complex business logic

The lead makes this judgment during state detection (Section 3).
```

#### 3. Section 4.3: Replace "Spawn Single Teammate" with "Spawn Workers for Available Tasks"
**Lines**: ~247-249
**Changes**: Replace entire subsection

```markdown
### 4.3 Spawn Workers for Available Tasks

Check the task list for pending, unblocked tasks. Spawn one worker per role that has available work:

- If research tasks exist → spawn researcher (it will self-claim)
- If plan tasks are unblocked → spawn planner (it will self-claim)
- If review tasks are unblocked → spawn reviewer (it will self-claim)
- If implementation tasks are unblocked → spawn implementer (it will self-claim)
- If triage/split tasks exist → spawn triager (it will self-claim)

**For group issues with multiple research tasks**: Spawn up to 3 researchers. Each will claim a different research task from the pool. Name them `researcher`, `researcher-2`, `researcher-3`.

Workers do NOT need assignment messages — they check TaskList on spawn and claim matching tasks.
```

#### 4. Section 4.4: Replace Dispatch Loop with 5-Step Version
**Lines**: ~251-316
**Changes**: Replace entire dispatch loop

Replace with the 5-step version including:
- Step 0: Early-exit check (TeammateIdle without completion → skip to step 3)
- Step 1: Read completed tasks via TaskGet (not SendMessage)
- Step 2: Advance pipeline based on task description results
- Step 3: Ensure workers exist for available work
- Step 4: Proactive lookahead when all workers are busy
- Step 5: Check stop conditions

Adapted for GitHub (ralph_hero__* tools, #NNN, workflow states).

### Success Criteria:

#### Automated Verification:
- [ ] Frontmatter hooks reference TaskGet
- [ ] Section 3.1 exists with XS fast-track logic
- [ ] Section 4.3 references "spawn workers for available tasks" pattern
- [ ] Section 4.4 has 5-step dispatch loop with steps 0-5
- [ ] Dispatch loop step 1 references TaskGet (not SendMessage)
- [ ] Dispatch loop step 3 says "Ensure workers EXIST" (not "assign work")
- [ ] Dispatch loop step 4 is "PROACTIVE LOOKAHEAD"
- [ ] All GitHub tool references use `ralph_hero__*` prefix

#### Manual Verification:
- [ ] Dispatch loop reads coherently end-to-end
- [ ] Fast-track section is consistent with state machine in Section 3

**Implementation Note**: After completing this phase, pause for manual review before proceeding to Phase 3.

---

## Phase 3: Update Orchestrator SKILL.md — Sections 5, 6, 9

### Overview
Update behavioral principles, spawn prompt examples, and known limitations to reflect pull-based architecture.

### Changes Required:

#### 1. Section 5: Replace Behavioral Principles
**Lines**: ~401-421
**Changes**: Replace with pull-based principles

```markdown
## Section 5 - Behavioral Principles (Momentum)

The lead cannot be nudged externally (no IPC to running sessions). These principles keep work moving:

BEHAVIORAL PRINCIPLES:
- Workers drive their own flow — your job is to ensure workers EXIST, not to assign tasks.
- Read results from completed tasks (TaskGet), not from incoming messages.
- After every TaskCompleted event, read the completed task's description for results.
- Spawn workers when a role has available tasks but no active worker.
- For group research: spawn up to 3 researchers — they self-balance across tasks.
- Between phases, create tasks for the next phase IMMEDIATELY. Workers claim them.
- When ALL workers are busy, proactively query GitHub for next issues and pre-create tasks.
- LOOKAHEAD: When all workers are actively processing, use the idle time to query
  GitHub for the NEXT batch of work. Create tasks now so they're ready when workers
  finish. The goal is zero gap between task completion and next task claim.
- SendMessage is for exceptions only: revision feedback, conflict resolution, escalations.
- If a task shows no progress for ~3 minutes, check work product directly (Glob, git log).
- If work product exists but task isn't marked complete, mark it yourself.
- If reviewer rejects a plan, create revision + re-review tasks. Planner will self-claim.
- Prefer action over deliberation. When in doubt, check TaskList.
```

#### 2. Section 6: Update All Spawn Prompt Examples
**Changes**: Replace every spawn example to:
- Use "Embed results in task description via TaskUpdate when complete" instead of "Report results via SendMessage"
- Add "Spawn Prompt Quality" subsection with 6 required elements
- Add "Parallel Workers" subsection
- Add "Giving Idle Workers New Work" subsection
- Remove "Reassigning Existing Teammates" via SendMessage subsection

All examples keep `ralph-hero:*` skill qualification and `#NNN` format.

#### 3. Section 6 — Reassigning Existing Teammates
**Lines**: ~571-592
**Changes**: Replace with "Giving Idle Workers New Work" that uses pull-based fallback

```markdown
### Giving Idle Workers New Work

When a worker finishes and you've created new tasks for their role:
- The worker will automatically check TaskList and claim the new task
- NO SendMessage needed — the worker's pull loop handles it
- If a worker has been idle for >2 minutes and unclaimed tasks exist for their role,
  nudge via SendMessage as a fallback:
  SendMessage(
    type="message",
    recipient="researcher",
    content="New research tasks are available. Check TaskList.",
    summary="New tasks available"
  )
```

#### 4. Section 9: Add Three New Subsections

**Add after "Team Name Must Be Unique":**

```markdown
### Pull-Based Task Claiming
Workers self-claim tasks from TaskList by matching subject patterns to their role. This means:
- Tasks MUST use consistent subject patterns: "Research", "Plan", "Review", "Implement", "Triage", "Split"
- If a task subject doesn't match any role's pattern, no worker will claim it
- Multiple workers of the same role will race to claim — file-locking prevents duplicate claims
- If a worker fails to claim (already taken), it checks TaskList again for the next available task

### Task Description as Communication Channel
Workers embed results in TaskUpdate `description` instead of using SendMessage. Key implications:
- `description` is a **REPLACE** operation — original task context is overwritten
- Workers MUST include issue number and key context in their completion description
- The lead reads results via `TaskGet(taskId)` after each TaskCompleted event
- If a worker fails to update the description, the lead has no results — check work product directly (Glob, git log)
- SendMessage is reserved for exceptions: blocking issues, conflicts, skill failures, revision feedback
```

**Update "Lead Name Is Hardcoded":**
Change to reference exception-only SendMessage context (same wording as workspace version).

**Update "Fire-and-Forget Messages":**
Add note that SendMessage is now exception-only.

### Success Criteria:

#### Automated Verification:
- [ ] Section 5 contains "Workers drive their own flow"
- [ ] Section 5 contains "TaskGet" and "LOOKAHEAD"
- [ ] All spawn examples in Section 6 use "Embed results in task description via TaskUpdate"
- [ ] No spawn example contains "Report results via SendMessage" or "Report via SendMessage"
- [ ] "Spawn Prompt Quality" subsection exists with 6 required elements
- [ ] "Parallel Workers" subsection exists
- [ ] "Giving Idle Workers New Work" subsection exists
- [ ] "Reassigning Existing Teammates" subsection does NOT exist
- [ ] Section 9 contains "Pull-Based Task Claiming" subsection
- [ ] Section 9 contains "Task Description as Communication Channel" subsection
- [ ] Grep for `SendMessage.*report` returns 0 matches across all 6 files

#### Manual Verification:
- [ ] Full SKILL.md reads coherently end-to-end
- [ ] Spawn examples are consistent with agent definitions from Phase 1
- [ ] Behavioral principles match dispatch loop logic

**Implementation Note**: After completing this phase, all 6 files should be updated. Do a final consistency check.

---

## Testing Strategy

### Consistency Checks (Automated):
- Grep all 6 files for remaining `"Report via SendMessage"` — should be 0 matches
- Grep all 6 files for `"Report results via SendMessage"` — should be 0 matches
- Grep all 5 agent files for `"Task Claiming (Pull-Based)"` — should be 5 matches
- Grep SKILL.md for `"Embed results in task description"` — should appear in every spawn example
- Grep SKILL.md for `"PROACTIVE LOOKAHEAD"` — should be 1 match
- Grep SKILL.md for `"EARLY-EXIT CHECK"` — should be 1 match
- Grep SKILL.md for `"fast-track"` — should appear in Section 3.1

### Pattern Parity Check:
- Diff each plugin agent against its workspace counterpart (adjusting for GitHub vs Linear identifiers)
- Diff SKILL.md sections 4.3, 4.4, 5, 6 against workspace `ralph_team.md` counterparts

## References

- Workspace optimized files: `~/projects/.claude/agents/ralph-*.md`, `~/projects/.claude/commands/ralph_team.md`
- Workspace plan: `landcrawler-ai/thoughts/shared/plans/2026-02-14-ralph-team-throughput-optimization.md`
- Comparison research: `landcrawler-ai/thoughts/shared/research/2026-02-14-agent-team-patterns-comparison.md`
- Anthropic golden examples: https://github.com/anthropics/anthropic-cookbook/blob/main/patterns/agents/
- Plugin skill qualification plan: `ralph-hero/thoughts/shared/plans/2026-02-13-skill-qualification-and-alignment.md`
