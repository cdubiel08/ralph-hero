---
date: 2026-02-17
github_issue: 53
github_url: https://github.com/cdubiel08/ralph-hero/issues/53
status: complete
type: research
---

# Research: GH-53 - Teammate agents perform work in primary context instead of invoking skills

## Problem Statement

When the ralph-team orchestrator spawns teammate agents (researcher, planner, reviewer, implementer), those agents sometimes perform the substantive work directly in their own context window instead of invoking the designated skill via `Skill(skill="ralph-hero:ralph-*", args="...")`. This defeats the purpose of skill isolation (separate context windows, hook enforcement, postcondition validation) and causes work to bypass the state machine.

## Current State Analysis

### HOP Architecture Already Implemented (Commit 8af8989)

The HOP (Higher-Order Prompt) architecture was implemented in commit [8af8989](https://github.com/cdubiel08/ralph-hero/commit/8af8989), which externalized spawn prompts from ralph-team SKILL.md Section 6 into minimal template files at `plugin/ralph-hero/templates/spawn/`.

Each template is 5-8 lines and prominently features `Invoke: Skill(...)` as the primary instruction. For example, [templates/spawn/researcher.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/researcher.md):

```
Research GH-{ISSUE_NUMBER}: {TITLE}.

Invoke: Skill(skill="ralph-hero:ralph-research", args="{ISSUE_NUMBER}")

Report results per your agent definition.
Then check TaskList for more research tasks. If none, hand off per shared/conventions.md.
```

All six templates follow this pattern: one-line context, `Invoke: Skill(...)`, post-completion instructions.

### SKILL.md Section 6 Correctly References Templates

[skills/ralph-team/SKILL.md:170-202](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L170-L202) describes the template-based spawn procedure: determine role, resolve template path, substitute placeholders, pass as prompt to `Task()`. No inline spawn prompts remain in Section 6.

### Agent Definitions Include Skill Invocation

All five agent definitions ([ralph-researcher.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-researcher.md), [ralph-planner.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-planner.md), [ralph-advocate.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-advocate.md), [ralph-implementer.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-implementer.md), [ralph-triager.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-triager.md)) include explicit "Task Loop" sections that specify step 4 as `Skill(skill="ralph-hero:ralph-*", args="[issue-number]")`.

## Root Cause Analysis

### Primary Cause: Orchestrator Overrides Templates at Runtime

**The templates and agent definitions are correct, but the orchestrator (team lead) bypasses them.** Evidence from this session: the team lead spawned me (researcher-2) with a message that included:

- Detailed root cause analysis ("ralph-team skill writes inline spawn prompts...")
- Specific files to investigate (4 bullet points)
- Detailed research objectives (4 numbered items)
- An `Invoke: Skill(...)` instruction at the end

This is exactly the pattern the HOP architecture was designed to eliminate: the orchestrator front-loads detailed context into the spawn prompt. When an agent receives a rich description of what needs to be done AND how to do it, the `Invoke: Skill(...)` line becomes just one instruction among many. The agent may determine it already has sufficient context to begin work directly rather than invoking the skill.

### Contributing Factor: No Enforcement Mechanism

There is no postcondition hook or validation that verifies a teammate agent actually invoked a skill. The existing hooks validate:

- **skill-precondition.sh** - Validates env vars are set (RALPH_COMMAND, RALPH_GH_OWNER, etc.) -- this runs when MCP tools are called, not when skills are invoked
- **research-postcondition.sh** - Validates research doc exists at Stop time
- **plan-postcondition.sh** - Validates plan doc exists at Stop time

But none of these detect whether the agent called `Skill()` or did the work inline. A postcondition hook that checks for research doc existence would pass regardless of whether the work was done via skill invocation or directly.

### Contributing Factor: Agent Definitions Are Redundant With Templates

The agent `.md` files contain 20+ lines including task loop instructions, result formatting, and shutdown protocol. When a spawn template says `Invoke: Skill(...)` and the agent definition ALSO says `Invoke: Skill(...)`, the instruction appears twice. But when the orchestrator's spawn message adds a third layer of detailed context, the signal-to-noise ratio drops and the `Invoke` instruction gets diluted.

### Contributing Factor: Skill Tool Available to Agent

Each agent has `Skill` in its tools list but also has `Read`, `Write`, `Glob`, `Grep`, `Bash`, and MCP tools (e.g., `ralph_hero__get_issue`, `ralph_hero__update_workflow_state`). With all these tools available, the agent CAN perform the work directly without invoking the skill. The skill invocation is an instruction, not a constraint.

## Key Discoveries

### 1. The problem is NOT in the template files

All six spawn templates at [templates/spawn/](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/) are minimal and correctly structured. The HOP architecture implementation is sound.

### 2. The problem is in what the orchestrator actually sends

The spawn procedure in SKILL.md Section 6 says to read the template, substitute placeholders, and pass the result as `prompt`. But the orchestrator (team lead agent) has the full issue context in its own context window. When it spawns a teammate, it may augment or replace the template content with richer context from its own analysis, thinking it's being "helpful."

This is a prompt engineering and behavioral problem in the orchestrator, not a structural problem in the templates.

### 3. No postcondition can reliably detect inline work

A postcondition hook cannot distinguish between "agent invoked skill which produced artifact" vs. "agent produced artifact directly." Both produce the same outputs (research doc, plan doc, commits, workflow state changes). The artifacts are identical regardless of whether a skill was used.

### 4. The agent definitions could be thinned further

Per Plan 3 (Skill Autonomy & Self-Validation, [2026-02-17-plan-3-skill-autonomy-self-validation.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-17-plan-3-skill-autonomy-self-validation.md)), agent definitions should be under 30 lines. Current agents are already around 20 lines each but could be reduced further to emphasize skill invocation as the ONLY substantive action.

## Potential Approaches

### Approach A: Strengthen Orchestrator Compliance (Recommended)

**Description**: Reinforce in SKILL.md Section 6 that the orchestrator MUST NOT augment the template with additional context. Add explicit anti-patterns.

**Changes**:
- Add to Section 6 a "Template Integrity" rule: "The resolved template content is the COMPLETE prompt. Do NOT prepend, append, or interleave additional context, analysis, files to investigate, or research hints."
- Add anti-pattern examples showing what NOT to do
- Clarify that the template's `{TITLE}` placeholder provides sufficient context -- the agent discovers everything else via skill invocation

**Pros**: Simple change, addresses root cause directly, no code changes needed
**Cons**: Still relies on LLM compliance -- orchestrator may still deviate

### Approach B: Reduce Agent Tool Surface

**Description**: Remove MCP tools (ralph_hero__get_issue, etc.) from non-triager agent definitions so they CANNOT perform substantive work directly. Force them through skills.

**Changes**:
- Researcher, Planner, Advocate, Implementer agents: remove all `ralph_hero__*` tools from the tools list
- Keep only: `Skill`, `TaskList`, `TaskGet`, `TaskUpdate`, `SendMessage`, and file tools (`Read`, `Write`, `Glob`, `Grep`, `Bash`)
- The agent can still claim tasks and invoke skills, but cannot call GitHub MCP tools directly

**Pros**: Creates a hard constraint -- agents physically cannot do the work without the skill
**Cons**: Agents need MCP tools for the Pipeline Handoff Protocol (reading team config, checking TaskList) and for TaskUpdate result reporting. Some MCP tools may be needed for edge cases. The Skill tool itself loads the skill which has full access.

### Approach C: Combined Template Integrity + Anti-Pattern Documentation

**Description**: Combine Approach A with explicit "DO NOT" anti-patterns in both conventions.md and SKILL.md.

**Changes**:
- Add to `shared/conventions.md` Spawn Template Protocol a new "Template Integrity" section:
  - "Templates are COMPLETE prompts. Orchestrators MUST NOT add context beyond placeholder substitution."
  - "Anti-pattern: Including research hints, file paths, root cause analysis in spawn message"
  - "Anti-pattern: Replacing template content with custom instructions"
- Add to SKILL.md Section 6 a "CRITICAL" callout reinforcing template integrity
- Add a "Verification" section: "After substitution, the resolved prompt should be 5-8 lines. If it exceeds 10 lines, you are adding prohibited context."

**Pros**: Addresses root cause, provides concrete guardrails, self-documenting
**Cons**: Still relies on LLM compliance

### Approach D: Hook-Based Skill Invocation Verification

**Description**: Add a postcondition hook that checks whether the Skill tool was called during the agent's session.

**Feasibility**: LOW. Hooks run as shell scripts and receive tool call input/output via stdin JSON. They cannot inspect the agent's full conversation history to verify whether `Skill()` was called. The hook infrastructure does not support this kind of retrospective analysis.

## Risks and Considerations

1. **Approach B may break Pipeline Handoff Protocol**: Agents need `ralph_hero__get_issue` to look up team config and `SendMessage` for peer handoffs. Removing MCP tools could break the handoff mechanism. However, the handoff protocol uses `SendMessage` (not an MCP tool) and reads team config via `Read` (also not an MCP tool), so this may be safe.

2. **The orchestrator is an LLM**: No amount of prompt engineering provides guaranteed compliance. The orchestrator may deviate from instructions in edge cases. The fix should be "defense in depth" -- multiple reinforcing signals rather than a single instruction.

3. **This is a known limitation of HOP**: Plan 2 (HOP Architecture) acknowledged that the orchestrator could bypass templates. The fix was making templates the path of least resistance, not a hard constraint.

4. **Interaction with #52**: Issue #52 (Teammates page themselves) touches the same files (agent definitions, conventions.md, spawn templates). Fixes should be coordinated to avoid merge conflicts.

## Recommended Next Steps

1. **Implement Approach C** (Combined Template Integrity + Anti-Pattern Documentation) as the primary fix. This is the most practical approach given the constraints.

2. **Consider Approach B** as a secondary hardening measure -- evaluate which MCP tools agents actually need for task claiming and handoffs vs. which are only needed by skills.

3. **Add a line-count check** to the spawn procedure documentation: "Resolved prompt MUST be under 10 lines. If longer, you have violated template integrity."

4. **Coordinate with #52** since both issues touch agent definitions and conventions.md.
