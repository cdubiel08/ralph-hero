---
date: 2026-02-24
status: draft
github_issues: []
github_urls: []
primary_issue: null
---

# Simplify Ralph Team & Worker Architecture

## Overview

Radical simplification of the ralph-team orchestrator, worker skills, and supporting infrastructure. Remove over-engineering, enforce clear architectural boundaries, delete dead abstractions.

## Current State Analysis

The ralph-team SKILL.md is 460 lines across 10 sections with streams, XS fast-track, spawn templates, placeholder resolution, behavioral principles, forbidden communication patterns, and elaborate metadata schemas. Worker skills have prescriptive TaskUpdate code blocks and static task list IDs that cause cross-session collisions. Worker agents invoke skills inline, consuming their context window.

## Desired End State

- ralph-team SKILL.md is ~80 lines: assess work, spawn team, build task graph, monitor
- Worker skills have general 3-line team reporting guidance
- No static task list IDs, no internal TaskCreate in skills
- No spawn template system (worker.md, placeholder resolution, conventions.md protocol)
- Worker agents use Task() for skill invocation to protect context
- Task() subagents are leaf nodes — no nested Task() calls

## What We're NOT Doing

- Changing hook scripts (worker-stop-gate, team-stop-gate, etc.)
- Changing skill workflow logic (research, plan, impl steps)
- Changing MCP tools or server code

---

## Phase 1: Clean up worker skills

Remove cross-session collision bugs and over-prescriptive instructions from all worker skills.

### 1a. Remove `CLAUDE_CODE_TASK_LIST_ID` from skill frontmatters

Remove the line `CLAUDE_CODE_TASK_LIST_ID: "ralph-workflow"` from env blocks in:
- `plugin/ralph-hero/skills/ralph-split/SKILL.md`
- `plugin/ralph-hero/skills/ralph-research/SKILL.md`
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md`
- `plugin/ralph-hero/skills/ralph-triage/SKILL.md`

### 1b. Remove internal TaskCreate/TaskUpdate from ralph-split

**File**: `plugin/ralph-hero/skills/ralph-split/SKILL.md`

- Delete Step 2.5 "Create Split Tasks" entirely (two TaskCreate calls)
- Remove `analyze_task`/`create_task` TaskUpdate wrapper calls from Steps 3 and 5
- Keep the actual split work content in those steps

### 1c. Simplify Team Result Reporting across all 6 worker skills

Replace each skill's verbose Team Result Reporting section with:

```markdown
When running as a team worker, mark your assigned task complete via TaskUpdate. Include key results in metadata and a human-readable summary in the description. Then check TaskList for more work matching your role.
```

Files: ralph-split, ralph-research, ralph-plan, ralph-impl, ralph-review, ralph-triage

### Success Criteria
- [x] `grep -r "CLAUDE_CODE_TASK_LIST_ID" plugin/ralph-hero/skills/` returns no results
- [x] `grep -r "TaskCreate" plugin/ralph-hero/skills/ralph-split/` returns no results
- [x] No references to `analyze_task` or `create_task` in ralph-split
- [x] Each skill's Team Result Reporting section is ≤5 lines

---

## Phase 2: Renumber all skill steps to sequential integers

Every skill has accumulated fractional steps (0, 1.5, 2.25, 3.5, 4.5, 9.5) from incremental additions. Renumber all to clean sequential integers.

### Changes Required

For each skill, rename `### Step N:` headers to sequential integers starting at 1. No content changes — just renumber.

**ralph-split** (current → new):
| Current | New | Title |
|---------|-----|-------|
| Step 1 | Step 1 | Select Issue for Splitting |
| Step 2 | Step 2 | Fetch and Analyze Issue |
| Step 2.25 | Step 3 | Discover Existing Children |
| Step 3 | Step 4 | Research Scope |
| Step 4 | Step 5 | Propose Split |
| Step 5 | Step 6 | Create or Update Sub-Issues |
| Step 6 | Step 7 | Establish Dependencies |
| Step 7 | Step 8 | Update Original Issue |
| Step 8 | Step 9 | Move Sub-Issues to Appropriate State |
| Step 9 | Step 10 | Team Result Reporting |
| Step 10 | Step 11 | Report |

**ralph-research** (current → new):
| Current | New | Title |
|---------|-----|-------|
| Step 0 | Step 1 | Verify Branch |
| Step 1 | Step 2 | Select Issue |
| Step 2 | Step 3 | Transition to Research in Progress |
| Step 3 | Step 4 | Conduct Research |
| Step 3.5 | Step 5 | Refine Group Dependencies |
| Step 4 | Step 6 | Create Research Document |
| Step 4.5 | Step 7 | Commit and Push |
| Step 5 | Step 8 | Update GitHub Issue |
| Step 6 | Step 9 | Team Result Reporting |
| Step 7 | Step 10 | Report Completion |

**ralph-plan** (current → new):
| Current | New | Title |
|---------|-----|-------|
| Step 0 | Step 1 | Verify Branch |
| Step 1 | Step 2 | Select Issue Group for Planning |
| Step 2 | Step 3 | Gather Group Context |
| Step 3 | Step 4 | Transition to Plan in Progress |
| Step 4 | Step 5 | Create Implementation Plan |
| Step 4.5 | Step 6 | Commit and Push |
| Step 5 | Step 7 | Update All Group Issues |
| Step 6 | Step 8 | Team Result Reporting |
| Step 7 | Step 9 | Report Completion |

**ralph-triage** (current → new):
| Current | New | Title |
|---------|-----|-------|
| Step 0 | Step 1 | Verify Branch |
| Step 1 | Step 2 | Select Issue |
| Step 2 | Step 3 | Assess Issue |
| Step 3 | Step 4 | Determine Recommendation |
| Step 4 | Step 5 | Take Action |
| Step 4.5 | Step 6 | Mark Issue as Triaged |
| Step 5 | Step 7 | Find and Link Related Issues |
| Step 6 | Step 8 | Team Result Reporting |
| Step 7 | Step 9 | Report |

**ralph-impl** (current → new):
| Current | New | Title |
|---------|-----|-------|
| Step 1 | Step 1 | Select Implementation Target |
| Step 1.5 | Step 2 | Detect Mode |
| Step 2 | Step 3 | Gather Context and Build Issue List |
| Step 3 | Step 4 | Verify Readiness (First Phase Only) |
| Step 4 | Step 5 | Transition to In Progress |
| Step 5 | Step 6 | Set Up or Reuse Worktree |
| Step 6 | Step 7 | Implement ONE Phase |
| Step 7 | Step 8 | Commit and Push |
| Step 8 | Step 9 | Check if All Phases Complete |
| Step 9 | Step 10 | Create PR (Final Phase Only) |
| Step 9.5 | Step 11 | PR Gate |
| Step 10 | Step 12 | Update GitHub Issues (Final Phase Only) |
| Step 11 | Step 13 | Team Result Reporting |
| Step 12 | Step 14 | Final Report |

**ralph-review** (current → new):
| Current | New | Title |
|---------|-----|-------|
| Step 0 | Step 1 | Detect Execution Mode |
| Step 1 | Step 2 | Select Issue |
| Step 2 | Step 3 | Validate Plan Exists |
| Step 3A | Step 4A | INTERACTIVE Mode - Wizard Review |
| Step 3B | Step 4B | AUTO Mode - Delegated Critique |
| Step 4 | Step 5 | Execute Transition |
| Step 5 | Step 6 | Team Result Reporting |
| Step 6 | Step 7 | Report Completion |

Also fix any internal cross-references (e.g., "see Step 4.5" → "see Step 6").

### Success Criteria
- [x] No fractional step numbers (0, 1.5, 2.25, 3.5, 4.5, 9.5) in any skill
- [x] All steps are sequential integers starting at 1
- [x] Internal cross-references updated to match new numbers

---

## Phase 3: Rewrite ralph-team SKILL.md

Replace the entire 460-line body with ~80 lines covering 4 steps.

**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`

**Keep frontmatter as-is** (hooks, env, allowed_tools, model).

**Replace entire body** with:

````markdown
# Ralph Team

You coordinate a team of specialists to process GitHub issues. You NEVER do substantive work yourself — you delegate everything.

## Step 1: Assess Work

Fetch the issue and detect its pipeline position:

```
ralph_hero__get_issue(number=[issue-number])
ralph_hero__detect_pipeline_position(number=[issue-number])
```

The response tells you:
- `phase`: Where to start (TRIAGE, RESEARCH, PLAN, REVIEW, IMPLEMENT, TERMINAL)
- `remainingPhases`: What's left
- `suggestedRoster`: Which worker roles to spawn
- `convergence`: Whether a group is ready for the next gate

If TERMINAL (PR exists or issue Done), report and stop.

## Step 2: Create Team and Spawn Workers

```
TeamCreate(team_name="ralph-team-GH-NNN")
```

Spawn one teammate per role from `suggestedRoster`:

```
Task(subagent_type="ralph-analyst", team_name="ralph-team-GH-NNN", name="analyst",
     prompt="You are an analyst on ralph-team-GH-NNN. Check TaskList for your assigned work.",
     description="Analyst for GH-NNN")
```

| Role | Agent type | Handles |
|------|-----------|---------|
| analyst | ralph-analyst | Research, Triage, Split |
| builder | ralph-builder | Plan, Implement |
| validator | ralph-validator | Review |
| integrator | ralph-integrator | Create PR, Merge PR |

Multiple analysts/builders allowed (append `-2`, `-3`). One validator, one integrator.

## Step 3: Build Task Graph

Create the full pipeline as tasks with `blockedBy` chains. Assign owners on unblocked tasks.

**Single issue example**:
```
T-1: Research GH-42       → unblocked      → owner: analyst
T-2: Plan GH-42           → blockedBy: T-1 → owner: (none, claimed later)
T-3: Review plan GH-42    → blockedBy: T-2
T-4: Implement GH-42      → blockedBy: T-3
T-5: Create PR for GH-42  → blockedBy: T-4
T-6: Merge PR for GH-42   → blockedBy: T-5
```

**Group** (N issues): N parallel research tasks, then plan/review/implement/PR as a group.

Each task needs:
- `subject`: e.g. "Research GH-42"
- `activeForm`: e.g. "Researching GH-42" (present-continuous of subject)
- `description`: Issue URL, title, estimate, group context if applicable
- `metadata`: `{ "issue_number": "42", "command": "research", "phase": "research" }`

**Procedure**:
1. `TaskCreate` all tasks (captures IDs)
2. `TaskUpdate(taskId, addBlockedBy=[...])` to wire dependencies
3. `TaskUpdate(taskId, owner="analyst")` to assign unblocked tasks

Workers discover assigned tasks via TaskList and begin work autonomously.

## Step 4: Monitor and Shutdown

The dispatch loop is passive. Hooks fire at decision points:

- **TaskCompleted**: Check if all tasks done. If yes, shutdown.
- **TeammateIdle**: Normal — don't nudge. Workers self-claim via Stop hook.
- **Escalation (SendMessage)**: Respond and unblock.

When a review completes with `verdict: "NEEDS_ITERATION"`, create a new "Plan GH-NNN" task blocked by the failed review. Builder self-claims.

When all tasks complete, `shutdown_request` each teammate, then `TeamDelete()`.

## Constraints

- Never do research, planning, reviewing, or implementing yourself
- Task assignment IS the communication — don't SendMessage after assigning
- Workers go idle between turns — this is normal
- All tasks created AFTER TeamCreate
- If stuck, escalate via GitHub comment (`__ESCALATE__` intent) and move on
````

### Success Criteria
- [x] ralph-team SKILL.md body is ≤100 lines (excluding frontmatter)
- [x] No references to: streams, XS fast-track, Mode B, spawn templates, behavioral principles
- [x] Contains exactly 4 steps: Assess, Create Team, Build Tasks, Monitor

---

## Phase 4: Delete spawn template system

### 3a. Delete template file and directory

- Delete `plugin/ralph-hero/templates/spawn/worker.md`
- Remove `plugin/ralph-hero/templates/` directory if empty

### 3b. Remove Spawn Template Protocol from conventions.md

**File**: `plugin/ralph-hero/skills/shared/conventions.md`

Delete the entire "Spawn Template Protocol" section, including:
- Template Location
- Placeholder Substitution table
- Group/Worktree/Stream Context Resolution
- Empty Placeholder Line Removal
- Resolution Procedure

### 3c. Remove Work Streams section from conventions.md

**File**: `plugin/ralph-hero/skills/shared/conventions.md`

Delete the entire "Work Streams" section, including:
- Stream ID Format
- Naming Conventions table
- Lifecycle description

### Success Criteria
- [x] `plugin/ralph-hero/templates/spawn/worker.md` does not exist
- [x] No "Spawn Template Protocol" section in conventions.md
- [x] No "Work Streams" section in conventions.md

---

## Phase 5: Update worker agents for Task() context protection

Workers use Task() to invoke skills, keeping their own context window clean. Task() subagents are leaf nodes — they cannot call Task() themselves.

### 4a. Update ralph-analyst, ralph-builder, ralph-validator

**Files**:
- `plugin/ralph-hero/agents/ralph-analyst.md`
- `plugin/ralph-hero/agents/ralph-builder.md`
- `plugin/ralph-hero/agents/ralph-validator.md`

Replace the current Task Loop with:

```markdown
## Task Loop

1. Check TaskList for assigned or unclaimed tasks matching your role
2. Claim unclaimed tasks: `TaskUpdate(taskId, owner="my-name")`
3. Read task context via TaskGet
4. **Run the skill via Task()** to protect your context window:
   ```
   Task(subagent_type="general-purpose",
        prompt="Skill(skill='ralph-hero:ralph-research', args='NNN')",
        description="Research GH-NNN")
   ```
5. Report results via TaskUpdate (metadata + description)
6. Check TaskList for more work before stopping

**Important**: Task() subagents cannot call Task() — they are leaf nodes.
```

Remove verbose first-turn disclaimers and claim-lost-to-another-worker flows. Keep role-specific notes (analyst: sub-ticket IDs, builder: revision handling + implementation notes, validator: VERDICT in description).

### 4b. Simplify ralph-integrator task loop header

**File**: `plugin/ralph-hero/agents/ralph-integrator.md`

Integrator runs git/gh commands directly (no skill invocation). Simplify the task loop to match the same 6-step pattern but without the Task() wrapping. Keep PR Creation and Merge procedures as-is.

### Success Criteria
- [x] All 3 skill-invoking agents (analyst, builder, validator) use `Task()` for skill invocation
- [x] All agents mention the "no nested Task()" constraint
- [x] Integrator retains direct command execution

---

## Integration Testing

- [x] `grep -r "CLAUDE_CODE_TASK_LIST_ID" plugin/ralph-hero/skills/` returns no results
- [x] `grep -r "TaskCreate" plugin/ralph-hero/skills/ralph-split/` returns no results
- [x] `grep -r "REPORT_FORMAT" plugin/ralph-hero/` returns no results
- [x] Each skill's Team Result Reporting section is ≤5 lines
- [x] No fractional step numbers in any skill SKILL.md
- [x] ralph-team SKILL.md body is ≤100 lines
- [x] `plugin/ralph-hero/templates/spawn/worker.md` does not exist
- [x] No "Spawn Template Protocol" in conventions.md
- [x] No "Work Streams" in conventions.md
- [x] Worker agents use Task() for skill invocation

## References

- Research: `thoughts/shared/research/2026-02-24-agent-teams-task-list-scoping.md`
- Root cause analysis from GH-364 ralph-team session
- disler/IndyDevDan agent team implementations (observability hooks, builder/validator pattern)
