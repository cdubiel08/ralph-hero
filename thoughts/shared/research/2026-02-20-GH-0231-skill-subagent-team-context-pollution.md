---
date: 2026-02-20
github_issue: 231
github_url: https://github.com/cdubiel08/ralph-hero/issues/231
status: complete
type: research
---

# Research: GH-231 - Skill sub-agents pollute team roster via inherited team context

## Problem Statement

When the `ralph-team` orchestrator spawns a worker (e.g., an analyst) via `Task(team_name=TEAM_NAME, ...)`, and that worker invokes a skill like `ralph-research`, the skill's internal `Task()` calls (used to spawn sub-agents like `codebase-locator`, `codebase-analyzer`, etc.) inherit the parent's team context. These sub-agents enroll as phantom teammates in the team roster, generating unrecognizable idle notifications that flood the team lead.

This bug affects all skills that spawn internal sub-agents via `Task()` when those skills are executed within a team context.

## Current State Analysis

### How Team Context Propagates

The `ralph-team` skill ([`skills/ralph-team/SKILL.md:198`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L198)) spawns workers with explicit `team_name`:

```
Task(subagent_type="general-purpose", team_name=TEAM_NAME, name="[role]",
     prompt=[resolved template content],
     description="[Role] GH-NNN")
```

When a worker invokes a skill (e.g., `Skill(skill="ralph-hero:ralph-research", args="42")`), the skill runs in a forked subprocess (`context: fork` in skill frontmatter). This subprocess inherits the team session environment from the worker that invoked it.

Inside the skill, internal `Task()` calls spawn sub-agents for parallel research work. These calls do NOT include `team_name`, but the team context is inherited from the session environment. Per the [Claude Code agent teams documentation](https://code.claude.com/docs/en/agent-teams): "teammates cannot spawn their own teams or teammates. Only the lead can manage the team." However, the `Task()` mechanism for subagents operates at the session level and appears to inherit team membership implicitly.

### Affected Files and Their Task() Calls

**1. `ralph-research` ([`skills/ralph-research/SKILL.md:76-81`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-research/SKILL.md#L76-L81))**

Step 3 instructs spawning parallel sub-tasks with specialized agents:
- `codebase-locator`: Find all files related to the issue
- `codebase-analyzer`: Understand current implementation
- `codebase-pattern-finder`: Find similar patterns to model after
- `thoughts-locator`: Find existing research or decisions
- `web-search-researcher`: External APIs, best practices

No `Task()` call examples are shown inline (the skill SKILL.md describes them in prose), but the agent executing the skill uses `Task(subagent_type="codebase-locator", ...)` etc.

**2. `ralph-plan` ([`skills/ralph-plan/SKILL.md:127-128`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-plan/SKILL.md#L127-L128))**

```python
Task(subagent_type="codebase-pattern-finder", prompt="Find patterns for [feature] in [dir]")
Task(subagent_type="codebase-analyzer", prompt="Analyze [component] details. Return file:line refs.")
```

**3. `ralph-split` ([`skills/ralph-split/SKILL.md:50,159-161`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-split/SKILL.md#L50))**

```python
Task(subagent_type="codebase-locator", prompt="Find issues with M/L/XL estimates...")
Task(subagent_type="codebase-locator", prompt="Find all files related to [issue topic]...")
Task(subagent_type="codebase-analyzer", prompt="Analyze [primary component]...")
```

**4. `ralph-triage` ([`skills/ralph-triage/SKILL.md:104`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-triage/SKILL.md#L104))**

```python
Task(subagent_type="codebase-locator", prompt="Search for [keywords from issue title]...")
```

**5. `ralph-review` ([`skills/ralph-review/SKILL.md:183,195`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-review/SKILL.md#L183))**

```python
Task(subagent_type="general-purpose", prompt="You are executing an autonomous plan critique...")
# And inside the delegated critique:
Task(subagent_type='codebase-analyzer', prompt='Verify files mentioned in plan exist...')
```

### Non-Affected Skills

- **`ralph-impl`**: Does not use `Task()` for internal sub-agents (implementation is done inline).
- **`ralph-hero`**: Uses `Task()` to invoke skills (e.g., `Task(subagent_type="general-purpose", prompt="Use Skill(skill='ralph-hero:ralph-research'...)")`) but these are orchestration-level calls, not internal sub-agent calls within a skill. The `ralph-hero` orchestrator does NOT run inside a team context (it is a separate skill).

### Non-Affected Execution Contexts

This bug ONLY manifests when skills are executed by team workers. The same skills run without issues when:
- Invoked directly by a user (e.g., `/ralph-research 42`)
- Invoked by the `ralph-hero` orchestrator (not a team context)
- Invoked standalone via `Skill()` in a non-team session

## Key Discoveries

### 1. The `context: fork` setting does not isolate from team context

All affected skills use `context: fork` in their frontmatter, which creates a forked subprocess for skill execution. This isolates the skill's context window (conversation history, token usage) but does NOT isolate the team session environment. The team membership propagates through the fork.

### 2. None of the internal Task() calls specify team_name

Across all 5 affected skills, the internal `Task()` calls use only `subagent_type` and `prompt` parameters. No call explicitly passes `team_name`. The bug arises because team context is inherited implicitly from the session environment, not because skills explicitly join the team.

### 3. The fix is to explicitly NOT pass team_name (or pass no team context)

Per Claude Code's documentation, the `team_name` parameter in `Task()` is what enrolls a subagent as a teammate. When it is omitted, the sub-agent should run as a regular subagent outside the team. However, the current behavior appears to inherit team membership from the parent session environment. The fix is to ensure internal `Task()` calls within skills explicitly run outside team context.

### 4. The skill SKILL.md files are prompt-level instructions, not API code

The `Task()` calls in SKILL.md files are prompt-level instructions that guide the LLM executing the skill. The fix is a prompt-level change: adding explicit instructions to skill SKILL.md files to omit `team_name` in internal `Task()` calls, ensuring sub-agents do not inherit team membership.

### 5. This fix is independently actionable from GH-230

The parent issue GH-230 proposes a broader redesign of the worker architecture. GH-231 (this issue) is listed as section 6 of that design. However, the fix for GH-231 -- adding isolation instructions to skill SKILL.md files -- can be implemented independently without waiting for the full GH-230 redesign.

## Potential Approaches

### Approach A: Add "no team context" instruction to affected SKILL.md files (Recommended)

**Description**: Add explicit instructions in each affected skill's SKILL.md to ensure internal `Task()` calls do not inherit team context. The instruction would read something like: "When spawning internal sub-agents via Task(), do NOT include team_name. Sub-agents must run outside any team context."

**Changes**:
- [`skills/ralph-research/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-research/SKILL.md) -- Step 3 sub-task instructions
- [`skills/ralph-plan/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-plan/SKILL.md) -- Step 2 sub-task instructions
- [`skills/ralph-split/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-split/SKILL.md) -- Step 1 and Step 3 sub-task instructions
- [`skills/ralph-triage/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-triage/SKILL.md) -- Step 2 sub-task instructions
- [`skills/ralph-review/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-review/SKILL.md) -- Step 3B sub-task instructions

**Pros**:
- Simple, localized change -- only touches SKILL.md prompt text
- No TypeScript/MCP server changes required
- Independently deployable from GH-230
- Clear, actionable instruction for the executing LLM

**Cons**:
- Relies on LLM compliance (same limitation as all prompt-level instructions)
- Must be applied to each affected file individually

### Approach B: Add isolation instruction to shared/conventions.md

**Description**: Add a "Sub-Agent Team Isolation" section to `shared/conventions.md` that all skills reference. This centralizes the rule rather than repeating it in each skill.

**Changes**:
- [`skills/shared/conventions.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md) -- Add new section
- Each affected SKILL.md -- Add reference to the conventions section

**Pros**:
- Single source of truth for the isolation rule
- Consistent with how other cross-cutting concerns are documented

**Cons**:
- Indirect reference may be less effective than inline instruction (LLMs respond better to instructions in immediate context)
- Still requires touching each SKILL.md to add the reference

### Approach C: Combined inline + conventions (Recommended)

**Description**: Add the rule to `shared/conventions.md` AND add a brief inline reminder in each affected SKILL.md near the `Task()` call examples.

**Changes**: Same as A + B.

**Pros**: Defense in depth -- both centralized documentation and inline reinforcement.
**Cons**: Minor duplication.

## Risks and Considerations

1. **LLM compliance is not guaranteed**: As with all prompt-level fixes, the executing agent may ignore the instruction in edge cases. However, this matches the existing constraint model throughout the codebase (all skill instructions are prompt-level).

2. **No automated enforcement mechanism exists**: There is no hook or postcondition that can verify sub-agents did not join a team. The [prior research on GH-53](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-17-GH-0053-teammate-inline-work-vs-skill-invocation.md) established that postcondition hooks cannot reliably detect this class of behavioral issue.

3. **The `context: fork` setting may evolve**: If Claude Code's fork mechanism is updated to isolate team context in the future, this fix would become redundant but not harmful.

4. **Interaction with GH-230**: The parent redesign may change how workers are spawned (typed agents instead of `general-purpose`). The fix for GH-231 should remain compatible regardless, since the isolation instruction targets skill-internal sub-agents, not the worker spawn mechanism.

## Recommended Next Steps

1. **Implement Approach C**: Add a "Sub-Agent Team Isolation" section to `shared/conventions.md` and inline reminders in all 5 affected SKILL.md files.

2. **Pattern for the inline reminder**: Near each `Task()` example in the affected skills, add:
   ```
   **Important**: Do NOT pass `team_name` to internal sub-agent Task() calls.
   Sub-agents must run outside any team context to avoid polluting the team roster.
   ```

3. **Pattern for conventions.md section**:
   ```markdown
   ## Sub-Agent Team Isolation

   Skills that spawn internal sub-agents via `Task()` (e.g., `codebase-locator`,
   `codebase-analyzer`) must ensure those sub-agents do NOT inherit team context.

   **Rule**: Never pass `team_name` to internal `Task()` calls within skills.
   Sub-agents are utility workers that return results to the skill -- they are
   not team members.

   **Why**: When a skill runs inside a team worker's session, the team context
   propagates to child sub-agents. Those sub-agents enroll as phantom teammates,
   generating idle notifications that flood the team lead.
   ```

4. **Estimate is appropriate at S**: The fix touches 5 SKILL.md files and 1 conventions.md file with prompt-level changes only. No TypeScript or MCP server modifications needed.
