---
date: 2026-02-17
github_issue: 46
github_url: https://github.com/cdubiel08/ralph-hero/issues/46
status: complete
type: research
---

# Builder Worker Agent Definition - Research Findings

## Problem Statement

Issue #46 requires creating the Builder worker agent (`ralph-builder.md`) that consolidates the current ralph-planner and ralph-implementer into a single stateless loop. The Builder owns the widest state range of any worker: Ready for Plan -> Plan in Progress -> Plan in Review -> In Progress -> In Review. It composes three skills (`ralph-plan`, `ralph-impl`, `ralph-review` in self-review mode) and must handle both main-branch operations (planning, document commits) and worktree-branch operations (implementation).

## Current State Analysis

### Agents Being Replaced

**ralph-planner** (`plugin/ralph-hero/agents/ralph-planner.md`):
- Model: `opus` (creative planning requires deep reasoning)
- Tools: Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage + MCP tools
- Task matching: subjects containing "Plan" (not "Review")
- Invokes: `Skill(skill="ralph-hero:ralph-plan", args="[issue-number]")`
- Output: "PLAN COMPLETE: [ticket/group]\nPlan: [path]\nPhases: [N]\nFile ownership: [groups]\nReady for review."
- Branch: main (plans committed to main)
- Handles revision requests from reviewer rejection

**ralph-implementer** (`plugin/ralph-hero/agents/ralph-implementer.md`):
- Model: `sonnet` (code execution, follows plan exactly)
- Tools: Read, Write, Edit, Bash, Glob, Grep, Skill, Task, TaskList, TaskGet, TaskUpdate, SendMessage + MCP tools
- Task matching: subjects containing "Implement"
- Invokes: `Skill(skill="ralph-hero:ralph-impl", args="[issue-number]")`
- Output: "IMPLEMENTATION COMPLETE\nTicket: #NNN\nPhases: [N] of [M]\nFiles: [list]\nTests: [PASSING/FAILING]\nCommit: [hash]\nWorktree: [path]"
- Branch: feature branch in worktree
- Does NOT push to remote (lead handles PR creation)
- Checks exclusive file ownership if provided

### Skills Composed

| Skill | SKILL.md Location | Model Override | Branch | Hooks | Key Env Vars |
|-------|-------------------|---------------|--------|-------|-------------|
| `ralph-plan` | `skills/ralph-plan/SKILL.md` | opus | main | branch-gate, convergence-gate, plan-research-required, plan-state-gate, plan-postcondition | `RALPH_COMMAND=plan`, `RALPH_REQUIRED_BRANCH=main`, `RALPH_REQUIRES_RESEARCH=true` |
| `ralph-impl` | `skills/ralph-impl/SKILL.md` | opus | worktree | impl-plan-required, impl-worktree-gate, impl-state-gate, impl-branch-gate, impl-verify-commit, impl-verify-pr, impl-postcondition | `RALPH_COMMAND=impl`, `RALPH_REQUIRES_PLAN=true` |
| `ralph-review` | `skills/ralph-review/SKILL.md` | opus | main | branch-gate, review-no-dup, review-state-gate, review-verify-doc, review-postcondition | `RALPH_COMMAND=review`, `RALPH_REQUIRED_BRANCH=main`, `RALPH_VALID_INPUT_STATES=Plan in Review` |

### Critical Observation: Branch Switching

The Builder must operate across two branch contexts:
1. **Planning phase**: On `main` branch -- commits plan documents, reads research docs
2. **Implementation phase**: On feature branch in worktree -- writes code, commits changes
3. **Self-review (optional)**: On `main` branch -- reads plan and critiques

This is the most complex aspect of the Builder. The planner and implementer are currently isolated agents that never switch branches. The Builder loop must handle the transition:

```
[main branch] -> ralph-plan -> commit plan to main -> push
[transition: create/enter worktree]
[worktree branch] -> ralph-impl (phase 1) -> commit -> push
[worktree branch] -> ralph-impl (phase 2) -> commit -> push
...
[worktree branch] -> ralph-impl (final phase) -> commit -> push -> PR
```

### Hook Conflict Analysis

The hooks enforce branch requirements per-skill:
- `branch-gate.sh`: Blocks Bash commands if NOT on `RALPH_REQUIRED_BRANCH` (main)
- `impl-branch-gate.sh`: Blocks git commit/push if ON main (inverse of branch-gate)
- `impl-worktree-gate.sh`: Blocks Write/Edit outside worktree directory

These hooks are attached to SKILL.md frontmatter, not agent definitions. Since the Builder invokes skills via `Skill()` tool (which loads the skill's hooks), the branch enforcement is per-skill, not per-agent. This means:
- When Builder invokes `ralph-plan`: hooks enforce main branch
- When Builder invokes `ralph-impl`: hooks enforce worktree branch
- No hook conflict at the agent level

**Key insight**: Because skills are invoked as isolated tool calls with their own hook context, the Builder agent does NOT need to manage hook conflicts. Each skill brings its own hooks.

### Plan in Review: Dual Ownership with Validator

Per the foundation research (#44):
- `RALPH_REVIEW_MODE=skip` (default): Builder auto-progresses plans. Validator does not activate.
- `RALPH_REVIEW_MODE=auto`: Builder runs self-review via `ralph-review` skill in AUTO mode.
- `RALPH_REVIEW_MODE=interactive`: Validator activates. Builder pauses.

The Builder's behavior at "Plan in Review":

| RALPH_REVIEW_MODE | Builder Action | Validator Action |
|-------------------|---------------|------------------|
| `skip` | Auto-approve: immediately invoke `ralph-impl` | Inactive |
| `auto` | Invoke `ralph-review` (self-review), then proceed if APPROVED | Inactive |
| `interactive` | **PAUSE**: exit loop, report "Plan awaiting human review" | Active (human review) |

**Pause/resume mechanism**: When the Builder encounters "Plan in Review" in interactive mode, it should STOP (complete the current task with a status message). When re-invoked later (after human approval moves the issue to "In Progress"), the Builder's loop detects "In Progress" and proceeds to implementation.

### Context Window Management

From `shared/conventions.md`: Skills are forked via `Task()` for context isolation. Each skill gets a fresh context window. This is critical for the Builder because:
- Planning requires reading research docs, analyzing codebase patterns (large context)
- Implementation requires reading plan docs, modifying code files (large context)
- Running both in the same context window would exhaust it

The Builder loop itself is thin -- it reads the issue state, selects the skill, invokes it, and checkpoints. The heavy work happens in isolated skill contexts.

However, when the Builder is a team agent (not using `Task()` but direct `Skill()` invocations), it runs in its own context window. The skills are invoked inline but each `Skill()` call still creates its own conversation context. This is acceptable per the conventions: "the agent IS the subprocess."

### Model Selection

Current agents use different models:
- ralph-planner: `opus` (creative planning)
- ralph-implementer: `sonnet` (follows plan)

The Builder agent definition sets ONE model for the agent loop. However, skill model overrides take effect when skills are invoked:
- `ralph-plan` SKILL.md specifies `model: opus`
- `ralph-impl` SKILL.md specifies `model: opus`
- `ralph-review` SKILL.md specifies `model: opus`

The agent model is used for the loop logic (state reading, skill selection, task management). The skill model is used for the actual work.

**Recommendation**: `sonnet` for the agent loop. The Builder's loop logic is procedural (check state, invoke skill, update task). The skills themselves override to `opus` when they need it. This saves cost on the thin loop iterations.

### Tool Requirements

The Builder needs the union of planner and implementer tools:

**From planner**: Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage + MCP tools
**From implementer**: Read, Write, Edit, Bash, Glob, Grep, Skill, Task, TaskList, TaskGet, TaskUpdate, SendMessage + MCP tools

**Union**: Read, Write, Edit, Bash, Glob, Grep, Skill, Task, TaskList, TaskGet, TaskUpdate, SendMessage + MCP tools

Note: The `Edit` tool comes from the implementer (for code changes). The planner doesn't need it (creates new plan files). The Builder needs both because it invokes both skills.

**MCP tools needed**:
- `ralph_hero__get_issue` - read issue state, group data, comments
- `ralph_hero__list_issues` - find actionable issues
- `ralph_hero__update_issue` - update labels (needs-iteration)
- `ralph_hero__update_workflow_state` - state transitions
- `ralph_hero__create_comment` - post artifact links
- `ralph_hero__detect_group` - group detection for planning
- `ralph_hero__list_sub_issues` - sibling status for epics
- `ralph_hero__list_dependencies` - dependency order for planning

### Task Subject Matching

Current matching patterns:
- Planner matches: "Plan" (not "Review")
- Implementer matches: "Implement"

The Builder should match: tasks with "Plan" (not "Review") OR "Implement" in subject. This allows the orchestrator to create distinct tasks that the Builder claims based on the current phase.

Alternative: Use a single subject pattern like "Build" that covers both planning and implementation. But this loses granularity for task tracking.

**Recommendation**: Match on both "Plan" and "Implement" subjects. This preserves task granularity and backward compatibility with existing orchestrator task creation patterns.

## Proposed Builder Agent Architecture

### Agent Definition

```yaml
---
name: ralph-builder
description: Builder specialist - composes plan, implement, and self-review skills for the full build lifecycle
tools: Read, Write, Edit, Bash, Glob, Grep, Skill, Task, TaskList, TaskGet, TaskUpdate, SendMessage,
       ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue,
       ralph_hero__update_workflow_state, ralph_hero__create_comment,
       ralph_hero__detect_group, ralph_hero__list_sub_issues, ralph_hero__list_dependencies
model: sonnet
color: cyan
---
```

**Color**: `cyan` -- distinct from planner (blue) and implementer (orange), represents combined capability.

### Worker Loop

```
function builderLoop():
    1. TaskList() -- find tasks with "Plan" (not "Review") or "Implement" in subject,
       pending, empty blockedBy, no owner
    2. Claim lowest-ID match: TaskUpdate(taskId, status="in_progress", owner="builder")
    3. TaskGet(taskId) -- extract issue number from description
    4. get_issue(number) -- read current workflow state

    5. Select skill based on state:
       switch workflowState:
           case "Ready for Plan":
               Skill(skill="ralph-hero:ralph-plan", args="[issue-number]")
               // Plan skill moves issue to Plan in Review
               // Check RALPH_REVIEW_MODE for next action

           case "Plan in Progress":
               Skill(skill="ralph-hero:ralph-plan", args="[issue-number]")
               // Resume locked plan

           case "Plan in Review":
               if RALPH_REVIEW_MODE == "skip":
                   // Auto-approve: move to In Progress
                   update_workflow_state(state="In Progress", command="ralph_review")
               elif RALPH_REVIEW_MODE == "auto":
                   Skill(skill="ralph-hero:ralph-review", args="[issue-number]")
                   // Review skill handles APPROVED vs NEEDS_ITERATION
               elif RALPH_REVIEW_MODE == "interactive":
                   // PAUSE: report and exit, human reviews
                   TaskUpdate(taskId, description="PAUSED: Plan in Review, awaiting human approval")
                   break

           case "In Progress":
               Skill(skill="ralph-hero:ralph-impl", args="[issue-number]")
               // Impl skill executes one phase, may stay In Progress or move to In Review

    6. TaskUpdate(taskId, status="completed", description="BUILD PHASE COMPLETE: #NNN\n...")
    7. Repeat from step 1. If no tasks, hand off per shared/conventions.md.
```

### Handling Revision Requests (NEEDS_ITERATION)

When `ralph-review` returns NEEDS_ITERATION:
1. Review skill moves issue back to "Ready for Plan" and adds `needs-iteration` label
2. Builder's loop re-detects "Ready for Plan" on next iteration
3. Builder invokes `ralph-plan` again with the iteration feedback
4. The planner skill reads the critique document and adjusts the plan

This is a natural loop -- no special handling needed beyond the state machine.

### Spawn Template

New template: `plugin/ralph-hero/templates/spawn/builder.md`

```
Build #{ISSUE_NUMBER}: {TITLE}.
{GROUP_CONTEXT}
{WORKTREE_CONTEXT}

Check workflow state and invoke the appropriate skill (ralph-plan, ralph-review, ralph-impl).
Report results per your agent definition.
Then check TaskList for more build tasks. If none, hand off per shared/conventions.md.
```

### Pipeline Handoff

In the new 4-worker model:

| Current Worker | Next Stage | Worker to find |
|---|---|---|
| Analyst | Builder | `ralph-builder` |
| Builder (self-review, NEEDS_ITERATION) | Builder (re-plan) | self (loop) |
| Builder (final impl phase) | Integrator | `ralph-integrator` |
| Validator (rejection) | Builder (re-plan) | `ralph-builder` |

### Instance Limits

Max parallel: 3 (same as current -- worktree isolation per issue)

Multiple Builders can run on different issues simultaneously because:
- Planning: commits docs to main (non-conflicting filenames by issue number)
- Implementation: isolated worktrees per issue

## Key Design Decisions

### 1. Single Agent vs Skill-per-Phase Dispatching

**Option A**: Builder agent handles state detection and calls Skill() per phase
- Pro: Single agent, simple lifecycle
- Pro: Skills already have their own hook enforcement
- Con: Agent context accumulates across phases (mitigated by Skill() isolation)

**Option B**: Builder agent forks Task() per phase (full context isolation)
- Pro: Maximum context isolation between phases
- Con: Overhead of forking per phase
- Con: Loses continuity between phases (can't pass intermediate state)

**Recommendation**: Option A. The Builder is a thin loop that invokes Skill() calls. Each Skill() creates its own hook context. The agent's context window accumulates only the thin loop state (issue number, task ID, workflow state), not the full plan or implementation details.

### 2. Model for Agent Loop

**Recommendation**: `sonnet`. The loop is procedural. Skills override to their own models. This saves ~60% cost on loop iterations compared to opus.

### 3. Task Subject Pattern

**Recommendation**: Match both "Plan" and "Implement". This preserves the orchestrator's ability to create granular tasks and track pipeline progress.

### 4. Plan in Review Handling

**Recommendation**: Three-mode handling controlled by `RALPH_REVIEW_MODE`:
- `skip`: Builder auto-approves (directly moves to In Progress)
- `auto`: Builder invokes ralph-review as self-review
- `interactive`: Builder pauses, reports, exits (human handles)

### 5. PR Creation Ownership

Per the Integrator research (#48, Option B): PR creation stays in `ralph-impl`. The Builder invokes `ralph-impl` which creates the PR on the final phase. The Builder does NOT directly create PRs.

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Context window exhaustion (plan + impl in same agent) | Medium | Skills forked via Skill() tool with their own context. Builder loop is thin. |
| Branch switching mid-loop (main -> worktree) | Low | Skills handle their own branch requirements via hooks. No manual branch management needed. |
| Plan in Review dual ownership with Validator | Low | `RALPH_REVIEW_MODE` env var deterministically selects which worker acts. |
| Revision loops (NEEDS_ITERATION spirals) | Medium | Existing 3-rejection limit in team orchestrator (Section 10). Builder itself does not enforce -- orchestrator does. |
| Hook conflicts between skills | None | Hooks are per-skill, not per-agent. Each Skill() invocation loads its own hook context. |
| Multiple Builders on same issue | Low | Lock states (Plan in Progress, In Progress) prevent concurrent work on same issue. |

## Comparison: Builder vs Replaced Agents

| Aspect | ralph-planner | ralph-implementer | **ralph-builder** |
|--------|-------------|------------------|------------------|
| Model | opus | sonnet | **sonnet** (skills override) |
| Skills | ralph-plan | ralph-impl | **ralph-plan + ralph-impl + ralph-review** |
| State range | Ready for Plan -> Plan in Review | In Progress -> In Review | **Ready for Plan -> In Review** |
| Branch | main | worktree | **both** (per-skill) |
| Worktree | No | Yes | **Yes** (during impl phases) |
| Tools | No Edit | Has Edit | **Has Edit** (union) |
| Task match | "Plan" | "Implement" | **"Plan" or "Implement"** |
| Color | blue | orange | **cyan** |

## References

- Foundation research: `thoughts/shared/research/2026-02-17-GH-0044-worker-scope-boundaries.md`
- Parent epic: #40
- Current planner: `plugin/ralph-hero/agents/ralph-planner.md`
- Current implementer: `plugin/ralph-hero/agents/ralph-implementer.md`
- Plan skill: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`
- Impl skill: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`
- Review skill: `plugin/ralph-hero/skills/ralph-review/SKILL.md`
- Branch hooks: `plugin/ralph-hero/hooks/scripts/branch-gate.sh`, `impl-branch-gate.sh`, `impl-worktree-gate.sh`
- State machine: `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json`
- Shared conventions: `plugin/ralph-hero/skills/shared/conventions.md`
- Spawn templates: `plugin/ralph-hero/templates/spawn/planner.md`, `implementer.md`
