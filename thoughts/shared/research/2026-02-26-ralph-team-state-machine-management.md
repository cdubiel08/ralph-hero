---
date: 2026-02-26
topic: "How ralph-team manages the state machine"
tags: [research, codebase, ralph-team, state-machine, hooks, workers, skills]
status: complete
type: research
git_commit: 3c437c8133eacee45654d594de652354d2449a10
git_branch: feature/GH-411-fix-skill-frontmatter
---

# Research: How ralph-team Manages the State Machine

## Research Question

How does ralph-team manage the workflow state machine? Does it manage state transitions directly, or does it rely on workers invoking skills that have their own hook-based enforcement? What happens if workers are not instructed to use skills with hooks?

## Summary

**ralph-team does not manage state transitions itself.** It has zero direct interaction with `update_workflow_state` or semantic intents (`__LOCK__`, `__COMPLETE__`, etc.). Instead, it relies entirely on a delegation chain:

1. ralph-team creates tasks and assigns them to workers
2. Workers invoke skills (via `Skill()` tool) based on task descriptions
3. Skills contain the state transition logic in their prompt text AND hook-based enforcement in their frontmatter
4. The state machine is enforced at the skill layer, not the team layer

This means **state management correctness depends on workers actually invoking the right skill**. If a worker attempts to do the work directly (e.g., calling `update_workflow_state` without going through a skill), the skill-level hooks would not fire. However, worker agent definitions explicitly instruct workers to invoke skills, and workers lack direct access to most state-management MCP tools (analyst has `update_workflow_state` but builder does not).

## Detailed Findings

### ralph-team's Role: Pure Orchestration

The ralph-team skill (`skills/ralph-team/SKILL.md`) has four responsibilities, none of which involve state transitions:

1. **Assess** — calls `detect_pipeline_position` to determine the current phase
2. **Create Team and Spawn Workers** — uses `suggestedRoster` to decide worker counts
3. **Build the Task List** — creates tasks with blocking dependencies
4. **Respond to Events** — reacts to `TaskCompleted` and `TeammateIdle` hooks

The skill's `allowed-tools` list confirms this — it includes `Task`, `TeamCreate`, `TaskCreate`, `SendMessage`, etc., but does NOT include any `ralph_hero__*` MCP tools. ralph-team cannot call `update_workflow_state` even if it wanted to.

### ralph-team's Hooks: Team Coordination Only

ralph-team registers four hooks, all focused on team lifecycle:

| Hook | Script | Purpose |
|------|--------|---------|
| `SessionStart` | `set-skill-env.sh RALPH_COMMAND=team` | Sets env vars for the team session |
| `TaskCompleted` | `team-task-completed.sh` | Logs which task completed; always exits 0 |
| `TeammateIdle` | `team-teammate-idle.sh` | Logs idle teammate; always exits 0 |
| `Stop` | `team-stop-gate.sh` | Blocks shutdown if pipeline has unprocessed issues |

None of these hooks interact with workflow state. `team-task-completed.sh` reads the task subject and teammate name, logs to stderr, and exits 0. The actual state transition decision-making is left to the team lead's LLM context.

### How Workers Reach Skills

Worker agent definitions instruct workers to invoke skills by name:

- **ralph-analyst** (`agents/ralph-analyst.md:18`): "Invoke the appropriate skill directly — ralph-triage, ralph-split, ralph-research, or ralph-plan — based on what the task requires."
- **ralph-builder** (`agents/ralph-builder.md:18`): "Invoke the appropriate skill directly — ralph-review for reviews, ralph-impl for implementation."
- **ralph-integrator** (`agents/ralph-integrator.md:16-22`): Has direct MCP tool access (`update_workflow_state`, `advance_children`, `advance_parent`) and performs state transitions inline rather than through skills. It handles PR creation, merging, and state advancement directly.

When a worker calls `Skill(skill="ralph-hero:ralph-research", args="42")`, the skill's full frontmatter loads, including:
- `SessionStart` hook that sets `RALPH_COMMAND=research` via `set-skill-env.sh`
- `PreToolUse` hooks for branch gates and state gates
- `PostToolUse` hooks for state validation
- `Stop` hooks for postcondition checks

### The State Enforcement Chain When It Works

For a research task flowing through ralph-team:

```
ralph-team creates task: "Research issue #42"
  → analyst claims task, calls Skill("ralph-hero:ralph-research", "42")
    → SessionStart fires: RALPH_COMMAND=research, RALPH_REQUIRED_BRANCH=main
    → skill prompt instructs: call update_workflow_state(42, "__LOCK__", "ralph_research")
    → PostToolUse fires: research-state-gate.sh validates "Research in Progress" is allowed
    → [research work happens with branch-gate.sh enforcing main branch]
    → skill prompt instructs: call update_workflow_state(42, "__COMPLETE__", "ralph_research")
    → PostToolUse fires: research-state-gate.sh validates "Ready for Plan" is allowed
    → Stop fires: research-postcondition.sh checks research doc exists
  → analyst marks task completed
```

### What Each Skill Enforces via Hooks

| Skill | Lock state | Complete state | Hook enforcement |
|-------|-----------|---------------|-----------------|
| ralph-triage | (none) | Done, Research Needed, Ready for Plan | PostToolUse state gate |
| ralph-research | Research in Progress | Ready for Plan | PostToolUse state gate + Stop postcondition |
| ralph-plan | Plan in Progress | Plan in Review | Pre + PostToolUse state gate + convergence gate |
| ralph-review | (none) | In Progress (approve) or Ready for Plan (reject) | PreToolUse state gate |
| ralph-impl | In Progress | In Review | PreToolUse state gate + worktree/branch/staging gates |
| ralph-split | (none) | Backlog (sub-issues) | Estimate and size gates only |
| ralph-val | (none) | (none — read-only validation) | Stop postcondition only |

### The Integrator Exception

The integrator is the only worker that manages state transitions **without** invoking a skill for all operations. Its agent definition (`agents/ralph-integrator.md`) includes direct MCP tool access:
- `ralph_hero__update_workflow_state` — moves issues to "In Review" and "Done"
- `ralph_hero__advance_children` — bulk-advances child issues
- `ralph_hero__advance_parent` — advances parent when all children complete

The integrator's prompt text contains the state transition instructions inline (e.g., "move all issues to 'In Review' via advance_children", "move issues to 'Done'"). It does invoke `ralph-val` via Skill for validation, but PR creation, merging, and state advancement are done directly.

Since the integrator operates without skill-level hooks for its state transitions, there is no hook enforcement on its `update_workflow_state` calls — only the plugin-level hooks in `hooks/hooks.json` apply (e.g., `pre-github-validator.sh`, `post-github-validator.sh`).

### Worker Tool Access vs Skill Tool Access

A subtle but important distinction: worker agent definitions specify a `tools:` list that constrains what tools the worker can use. When a worker invokes a skill, the skill's `allowed-tools:` further constrains within that skill context.

| Worker | Has `update_workflow_state`? | Has `Write`/`Edit`? |
|--------|------------------------------|---------------------|
| ralph-analyst | Yes (direct) | Yes (Write only) |
| ralph-builder | No | Yes (Write, Edit) |
| ralph-integrator | Yes (direct) | No |

The analyst having direct `update_workflow_state` access means it could theoretically call it outside a skill context. In practice, the agent prompt instructs it to invoke skills, but there is no hard enforcement preventing direct calls.

### Pipeline Detection Drives Task Creation

`detect_pipeline_position` is the only state-machine-aware component ralph-team uses directly. It reads all group issues' workflow states and returns:
- `phase`: which pipeline phase to execute (SPLIT, TRIAGE, RESEARCH, PLAN, REVIEW, IMPLEMENT, TERMINAL)
- `convergence`: whether all group members are in the same state
- `suggestedRoster`: how many analyst/builder/integrator workers to spawn
- `remainingPhases`: what comes after the current phase

ralph-team uses this to create initial tasks. When tasks complete, the team lead is expected to re-assess (potentially calling `detect_pipeline_position` again) and create next-phase tasks. The v4 architecture spec (`thoughts/shared/plans/2026-02-22-ralph-workflow-v4-architecture-spec.md:59-60`) notes that ralph-team creates tasks incrementally as phases complete, while ralph-hero creates the entire upfront task list.

## Architecture Documentation

### Two-Layer State Management

```
Layer 1: Skill prompts (LLM-directed)
  - Skill prompt text says WHEN to transition and WHAT intent to use
  - e.g., "Call update_workflow_state(number, state='__LOCK__', command='ralph_research')"
  - This is advisory — the LLM could ignore it

Layer 2: Skill hooks (deterministic enforcement)
  - SessionStart sets RALPH_COMMAND so hooks know which skill is active
  - PreToolUse/PostToolUse hooks validate every state transition attempt
  - Stop hooks verify postconditions (artifacts created, correct branch, etc.)
  - This is enforcement — hooks can block (exit 2) invalid transitions

Layer 3 (team only): Task-based orchestration
  - ralph-team creates tasks that describe what phase to execute
  - Workers self-assign tasks and invoke the appropriate skill
  - TaskCompleted/TeammateIdle hooks notify the lead for next-phase decisions
  - No state enforcement at this layer — it delegates down to Layer 1+2
```

### Hook Firing Context

Hooks fire based on where they are registered:

- **Skill frontmatter hooks**: Fire only when that skill is active (invoked via `Skill()`)
- **Agent frontmatter hooks**: Fire for the agent's entire session (e.g., `worker-stop-gate.sh`)
- **Plugin-level hooks** (`hooks/hooks.json`): Fire for all sessions in the plugin

When a worker invokes a skill, both the skill's hooks AND the plugin-level hooks fire. The agent's own hooks also remain active. This means a worker running `ralph-research` has three layers of hooks active simultaneously.

## Historical Context

The v4 architecture spec (`thoughts/shared/plans/2026-02-22-ralph-workflow-v4-architecture-spec.md`) documents several diagnosed failures in the team system related to state management:
- Guidance overload from `team-task-completed.sh` creating reactive checking loops
- Workers claiming blocked tasks and attempting future-phase work
- Message-as-task-assignment bypassing the task system

The 3-station simplification plan (`thoughts/shared/plans/2026-02-24-ralph-team-3-station-simplification.md`) reduced workers from 4 to 3 (analyst, builder, integrator) and introduced ralph-val as a separate skill for validation.

## Code References

- `plugin/ralph-hero/skills/ralph-team/SKILL.md` — Team orchestrator skill definition
- `plugin/ralph-hero/agents/ralph-analyst.md` — Analyst worker agent
- `plugin/ralph-hero/agents/ralph-builder.md` — Builder worker agent
- `plugin/ralph-hero/agents/ralph-integrator.md` — Integrator worker agent
- `plugin/ralph-hero/hooks/scripts/team-task-completed.sh` — TaskCompleted hook
- `plugin/ralph-hero/hooks/scripts/team-teammate-idle.sh` — TeammateIdle hook
- `plugin/ralph-hero/hooks/scripts/team-stop-gate.sh` — Team stop gate
- `plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh` — Worker stop gate
- `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:113-338` — Pipeline detection logic
- `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:372-396` — Roster computation

## Open Questions

1. **Does `Skill()` invocation from within an agent subagent properly load skill frontmatter hooks?** If skill hooks don't fire when invoked from a subagent context, then ALL state enforcement is absent during team runs. This is the critical assumption the entire architecture depends on but is not explicitly verified.

2. **What prevents the analyst from calling `update_workflow_state` directly (outside a skill)?** The analyst agent has the tool in its `tools:` list. Only the LLM prompt instruction constrains it to use skills. If the analyst decides to skip the skill and call the MCP tool directly, only plugin-level hooks (not skill-level hooks) would fire.

3. **The integrator's direct state management has no skill-level hook enforcement.** It calls `update_workflow_state`, `advance_children`, and `advance_parent` directly. Only plugin-level hooks in `hooks/hooks.json` apply. Is this intentional?
