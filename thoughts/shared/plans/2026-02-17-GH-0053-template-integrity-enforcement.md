---
date: 2026-02-17
status: draft
github_issue: 53
github_url: https://github.com/cdubiel08/ralph-hero/issues/53
---

# Enforce Template Integrity for Teammate Spawning

## Overview

Teammate agents sometimes perform substantive work (research, planning, implementation) directly in their primary context instead of invoking the designated skill via `Skill()`. The root cause is the orchestrator (team lead) augmenting spawn templates with rich context at runtime, diluting the `Invoke: Skill(...)` instruction. The fix adds template integrity rules to SKILL.md and conventions.md, plus reduces agent MCP tool surfaces.

## Current State Analysis

The HOP (Higher-Order Prompt) architecture (commit [8af8989](https://github.com/cdubiel08/ralph-hero/commit/8af8989)) correctly externalized spawn prompts to minimal 5-8 line templates at [templates/spawn/](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/). Each template prominently features `Invoke: Skill(...)` as the primary instruction.

However, the orchestrator bypasses template integrity at runtime by:
1. Prepending detailed root cause analysis, files to investigate, and research hints
2. Including information the agent should discover via skill invocation
3. Replacing template content with custom multi-paragraph instructions

This causes agents to skip skill invocation since they already have sufficient context to work directly, which bypasses hook enforcement and postcondition validation.

Relevant files:
- [skills/ralph-team/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md) -- Section 6 defines the spawn procedure
- [skills/shared/conventions.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md) -- Spawn Template Protocol section
- [agents/ralph-researcher.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-researcher.md) -- has MCP tools it doesn't need
- [agents/ralph-planner.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-planner.md) -- has MCP tools it doesn't need
- [agents/ralph-advocate.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-advocate.md) -- has MCP tools it doesn't need
- [agents/ralph-implementer.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-implementer.md) -- has MCP tools it doesn't need

## Desired End State

1. The orchestrator passes ONLY the resolved template content as the spawn prompt -- no augmentation
2. Agent definitions have minimal MCP tool surfaces, limiting direct GitHub access to only what is needed for task lifecycle (not substantive work)
3. Conventions document the template integrity rule and anti-patterns

### Verification
- [ ] SKILL.md Section 6 contains a "Template Integrity" rule with explicit anti-patterns
- [ ] conventions.md Spawn Template Protocol contains a "Template Integrity" subsection
- [ ] conventions.md includes a line-count guardrail ("resolved prompt MUST be under 10 lines")
- [ ] Agent definitions for researcher, planner, advocate, and implementer have reduced MCP tool lists
- [ ] Run a `/ralph-team` session and verify the orchestrator spawns teammates with template-only prompts (5-8 lines)

## What We're NOT Doing

- Not changing the spawn template files themselves (they are already correct)
- Not adding postcondition hooks to detect inline work (infeasible -- artifacts are identical regardless of path)
- Not removing Skill tool from agents (that would prevent skill invocation entirely)
- Not restructuring the agent definitions beyond tool list changes (GH-52 handles awareness notes)

## Implementation Approach

Three layers of defense:
1. **Orchestrator instructions** (SKILL.md) -- tell the lead NOT to augment templates
2. **Convention documentation** (conventions.md) -- codify the rule for all future orchestrators
3. **Agent tool reduction** -- remove MCP tools agents don't need, so they can't easily do substantive work inline

---

## Phase 1: Add Template Integrity Rule to SKILL.md

### Overview

Add a "Template Integrity" subsection to SKILL.md Section 6 (Teammate Spawning) that explicitly forbids augmenting template content.

### Changes Required

#### 1. Add Template Integrity rule after spawn procedure step 4
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
**Location**: After line 202 (end of spawn procedure), before "### Per-Role Instance Limits"
**Changes**: Insert a new subsection:

```markdown
### Template Integrity

**CRITICAL**: The resolved template content is the COMPLETE spawn prompt. Do NOT add any additional context.

**Rules**:
- The prompt passed to `Task()` must be the template output and NOTHING else
- Resolved prompts must be under 10 lines. If longer, you have violated template integrity
- The agent discovers all context it needs via skill invocation -- that is the entire point of HOP

**Anti-patterns** (NEVER do these):
- Prepending root cause analysis, research hints, or investigation guidance
- Including file paths, code snippets, or architectural context not in the template
- Replacing template content with custom multi-paragraph instructions
- Adding "Key files:", "Context:", or "Background:" sections
```

### Success Criteria

#### Automated Verification
- [x] `grep "Template Integrity" plugin/ralph-hero/skills/ralph-team/SKILL.md` matches
- [x] `grep "Anti-patterns" plugin/ralph-hero/skills/ralph-team/SKILL.md` matches
- [x] `grep "under 10 lines" plugin/ralph-hero/skills/ralph-team/SKILL.md` matches

#### Manual Verification
- [ ] Rule is positioned directly after the spawn procedure steps in Section 6
- [ ] Anti-patterns are concrete and actionable

---

## Phase 2: Update Spawn Template Protocol in conventions.md

### Overview

Add a "Template Integrity" subsection to the existing "Spawn Template Protocol" section in conventions.md.

### Changes Required

#### 1. Add Template Integrity subsection to Spawn Template Protocol
**File**: `plugin/ralph-hero/skills/shared/conventions.md`
**Location**: After the "Template Authoring Rules" subsection (after line 233), before "## Skill Invocation Convention"
**Changes**: Insert:

```markdown
### Template Integrity

Resolved template content is the COMPLETE prompt for spawned teammates. Orchestrators MUST NOT add context beyond placeholder substitution.

**Line-count guardrail**: A correctly resolved prompt is 5-8 lines. If the prompt exceeds 10 lines, the orchestrator has violated template integrity by adding prohibited context.

**Prohibited additions**:
- Research hints, root cause analysis, or investigation guidance
- File paths or code snippets not present in the template
- Custom instructions replacing or augmenting template content
- "Key files:", "Context:", "Background:" sections

**Why this matters**: Agents invoke skills in isolated context windows. When the orchestrator front-loads context, agents skip skill invocation and work directly, bypassing hook enforcement and postcondition validation.
```

### Success Criteria

#### Automated Verification
- [x] `grep "Template Integrity" plugin/ralph-hero/skills/shared/conventions.md` matches
- [x] `grep "Line-count guardrail" plugin/ralph-hero/skills/shared/conventions.md` matches

#### Manual Verification
- [ ] Subsection is placed within the Spawn Template Protocol section
- [ ] Explains both the rule and the rationale

---

## Phase 3: Reduce Agent MCP Tool Surfaces

### Overview

Remove `ralph_hero__*` MCP tools from agent definitions where they are not needed for task lifecycle operations. Agents that need GitHub data get it through skill invocation, not direct MCP access.

### Changes Required

#### 1. Reduce ralph-researcher.md tool list
**File**: `plugin/ralph-hero/agents/ralph-researcher.md`
**Current tools** (line 4): `Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__create_comment, ralph_hero__add_dependency, ralph_hero__remove_dependency, ralph_hero__list_dependencies, ralph_hero__detect_group`
**New tools**: `Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage`
**Rationale**: All `ralph_hero__*` tools are used by the ralph-research SKILL, not the agent wrapper. The agent only needs to invoke the skill and manage tasks.

#### 2. Reduce ralph-planner.md tool list
**File**: `plugin/ralph-hero/agents/ralph-planner.md`
**Current tools** (line 4): `Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__detect_group, ralph_hero__list_sub_issues, ralph_hero__list_dependencies, ralph_hero__create_comment`
**New tools**: `Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage`
**Rationale**: Same as researcher -- all MCP tools are used by the ralph-plan SKILL.

#### 3. Reduce ralph-advocate.md tool list
**File**: `plugin/ralph-hero/agents/ralph-advocate.md`
**Current tools** (line 4): `Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__create_comment`
**New tools**: `Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage`
**Rationale**: Same -- all MCP tools are used by the ralph-review SKILL.

#### 4. Reduce ralph-implementer.md tool list
**File**: `plugin/ralph-hero/agents/ralph-implementer.md`
**Current tools** (line 4): `Read, Write, Edit, Bash, Glob, Grep, Skill, Task, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__create_comment, ralph_hero__list_sub_issues`
**New tools**: `Read, Write, Edit, Bash, Glob, Grep, Skill, Task, TaskList, TaskGet, TaskUpdate, SendMessage`
**Rationale**: Same -- all MCP tools are used by the ralph-impl SKILL.

#### 5. Do NOT change ralph-triager.md
**File**: `plugin/ralph-hero/agents/ralph-triager.md`
**Rationale**: The triager is an exception -- as noted in [SKILL.md:246](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L246): "Only triager has direct MCP access. Others use skill invocations." The triager's MCP tools are intentionally included.

### Success Criteria

#### Automated Verification
- [x] `grep "ralph_hero__" plugin/ralph-hero/agents/ralph-researcher.md` returns no matches
- [x] `grep "ralph_hero__" plugin/ralph-hero/agents/ralph-planner.md` returns no matches
- [x] `grep "ralph_hero__" plugin/ralph-hero/agents/ralph-advocate.md` returns no matches
- [x] `grep "ralph_hero__" plugin/ralph-hero/agents/ralph-implementer.md` returns no matches
- [x] `grep "ralph_hero__" plugin/ralph-hero/agents/ralph-triager.md` still returns matches (unchanged)

#### Manual Verification
- [ ] Each reduced agent retains: Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage
- [ ] Implementer retains `Edit` (needed for code edits within skill context)
- [ ] Triager is unchanged

---

## Testing Strategy

1. **Static verification**: Run the grep checks in each phase's automated verification
2. **Line-count check**: Resolve each spawn template manually and verify output is 5-8 lines
3. **Runtime verification**: Run `/ralph-team [issue-number]` and verify:
   - Orchestrator spawns teammates with template-only prompts (inspect spawn messages)
   - Teammates invoke skills rather than working directly
   - No regressions in task lifecycle (claim, complete, handoff)

## References

- [Issue #53](https://github.com/cdubiel08/ralph-hero/issues/53)
- [Research document](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0053-teammate-inline-work-vs-skill-invocation.md)
- [HOP Architecture commit 8af8989](https://github.com/cdubiel08/ralph-hero/commit/8af8989)
- [Related: #52 - TaskUpdate self-notification](https://github.com/cdubiel08/ralph-hero/issues/52) -- touches same agent definition files, coordinate to avoid conflicts
