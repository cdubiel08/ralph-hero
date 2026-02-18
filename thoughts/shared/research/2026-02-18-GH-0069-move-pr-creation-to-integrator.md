---
date: 2026-02-18
github_issue: 69
github_url: https://github.com/cdubiel08/ralph-hero/issues/69
status: complete
type: research
---

# Research: Move PR Creation from Team-Lead to Integrator Worker

## Problem Statement

Currently, PR creation (git push + `gh pr create`) is the team-lead's "only direct work." This violates the lead's pure-coordinator role and creates a bottleneck: the lead must wait for implementation to finish, perform git operations, then resume dispatch duties. The integrator worker already handles the post-PR lifecycle (merge, worktree cleanup, state transitions) but has no role between implementation completion and PR merge.

## Current State Analysis

### Team-Lead (SKILL.md)

The lead's identity explicitly lists PR creation as direct work in two places:

1. **Section 1 - Identity** ([SKILL.md:35](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L35)): `"PR creation (after implementation completes)"` listed under "Your ONLY direct work"

2. **Section 4.2 - Task Creation** ([SKILL.md:128](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L128)): `"PR task is always lead's direct work (not delegated to a teammate)."`

3. **Section 4.4 - Dispatch Loop** ([SKILL.md:147](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L147)): Responsibility #4: `"PR creation: When all implementation tasks for an issue/group complete, push and create PR (Section 4.5). This is your only direct work."`

4. **Section 4.5 - Lead Creates PR** ([SKILL.md:151-157](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L151-L157)): Full implementation details for git push and `gh pr create` commands, including single-issue vs group handling and post-PR state transitions.

### Builder Agent (ralph-builder.md)

Two references enforce the current flow:

1. [ralph-builder.md:22](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-builder.md#L22): Step 6 says `"If no tasks, SendMessage team-lead that implementation is complete (lead handles PR creation)."`

2. [ralph-builder.md:30](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-builder.md#L30): `"DO NOT push to remote for implementation -- lead handles PR creation."`

### Implementer Spawn Template (templates/spawn/implementer.md)

[implementer.md:7](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/implementer.md#L7): `"DO NOT push to remote. The lead handles pushing and PR creation."`

### Integrator Agent (ralph-integrator.md)

[ralph-integrator.md:13](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-integrator.md#L13): Task loop step 1 only claims `"Merge" or "Integrate"` tasks. No mention of PR creation or `"Create PR"` in subject matching.

### Integrator Spawn Template (templates/spawn/integrator.md)

[integrator.md:1](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/integrator.md#L1): Only mentions `"Merge PR for #..."` -- no PR creation instructions.

### Pipeline Handoff Protocol (conventions.md)

[conventions.md:101](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md#L101): Builder (impl done) hands off to `team-lead` for PR creation. This would need to change to hand off to `ralph-integrator`.

### Task Subject Patterns (SKILL.md)

[SKILL.md:116](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L116): `"Create PR for GH-NNN"` is already listed as a task subject pattern. The integrator spawn table ([SKILL.md:188](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L188)) does NOT list "Create PR" -- only "Merge" and "Integrate."

## Files Requiring Changes

| # | File | Change Type | Description |
|---|------|-------------|-------------|
| 1 | `skills/ralph-team/SKILL.md` | Major | Remove Section 4.5 PR creation logic. Update Section 1 identity (remove PR creation from lead's direct work). Update Section 4.2 to make PR task delegatable. Update Section 4.4 dispatch to remove PR responsibility. Update Section 6 spawn table to add "Create PR" to integrator role. |
| 2 | `agents/ralph-integrator.md` | Major | Add "Create PR" to task subject matching in step 1. Add PR creation procedure (git push + gh pr create + state transitions). Ensure the integrator has `gh` CLI access for PR creation. |
| 3 | `agents/ralph-builder.md` | Minor | Update step 6 to hand off to integrator instead of team-lead. Keep "DO NOT push" instruction (integrator now handles push). |
| 4 | `templates/spawn/implementer.md` | Minor | Change "The lead handles pushing and PR creation" to "The integrator handles pushing and PR creation." |
| 5 | `templates/spawn/integrator.md` | Minor | Add "Create PR" task awareness alongside "Merge PR" task. |
| 6 | `skills/shared/conventions.md` | Minor | Update Pipeline Handoff Protocol table: builder (impl done) -> `ralph-integrator` instead of `team-lead`. |

## Potential Approaches

### Approach A: Move PR Logic to Integrator Agent Definition (Recommended)

Move the full PR creation procedure (currently in SKILL.md Section 4.5) into `ralph-integrator.md`. The integrator's task loop gains a new dispatch path: tasks with "Create PR" in subject trigger the push + PR creation flow, while "Merge" tasks trigger the existing merge flow.

**Pros:**
- Clean separation: integrator owns the entire PR lifecycle (create -> merge)
- Lead becomes a pure coordinator with zero direct work
- Integrator already has `Bash` tool access for `gh pr create`
- Natural extension of integrator's existing role
- Builder handoff simplifies: always hand off to integrator (for PR creation or merge)

**Cons:**
- Integrator is serialized (single worker) -- PR creation adds to its queue, but this is acceptable since PR creation is fast
- Integrator needs `gh` CLI knowledge, which it already uses for `gh pr view` and `gh pr merge`

### Approach B: Create a Dedicated PR Skill

Create a new `ralph-hero:ralph-pr` skill that encapsulates the PR creation logic, invoked by the integrator.

**Pros:**
- Reusable skill, testable independently
- Keeps agent definition lean

**Cons:**
- Over-engineering for a simple git push + gh pr create
- Adds a new skill to maintain
- The logic is straightforward enough to live in the agent definition

### Approach C: Move PR Logic to Builder

Have the builder push and create the PR directly after implementation.

**Pros:**
- Fewer handoffs

**Cons:**
- Builder already has "DO NOT push" constraint for good reason (serialization on main)
- Violates the builder's focused implementation role
- Would conflict with multi-builder scenarios (builder-2, builder-3)

## Risks and Considerations

1. **Integrator tool access**: The integrator already has `Bash` tool access ([ralph-integrator.md:5](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-integrator.md#L5)), so `gh pr create` is available. No tool configuration changes needed.

2. **State transition ownership**: Currently the lead moves issues to "In Review" after PR creation ([SKILL.md:157](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L157)). The integrator already has `update_workflow_state` and `advance_children` tools, so this transfers cleanly.

3. **Serialization is correct**: The integrator is intentionally single-instance and serialized ([ralph-integrator.md:31](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-integrator.md#L31)). PR creation should also be serialized (one push at a time), so this is a natural fit.

4. **Builder handoff change**: The Pipeline Handoff Protocol (conventions.md:101) currently sends builder (impl done) to `team-lead`. This must change to `ralph-integrator`. The builder agent's step 6 message also changes from team-lead to integrator.

5. **No MCP server changes**: This is purely a documentation/instruction change across markdown files. No TypeScript code is affected.

6. **Task subject patterns already exist**: "Create PR for GH-NNN" is already defined as a task subject ([SKILL.md:116](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L116)). The lead already creates this task -- the only change is that it's no longer marked as "lead's direct work" and the integrator claims it instead of the lead executing it.

## Recommended Next Steps

1. Use **Approach A** -- move PR creation logic to integrator agent definition
2. Update all 6 files listed above
3. No test changes needed (all changes are to markdown instruction files)
4. The change is atomic and self-contained -- no dependencies on other issues
