---
date: 2026-02-19
github_issue: 136
github_url: https://github.com/cdubiel08/ralph-hero/issues/136
status: complete
type: research
---

# GH-136: Update conventions.md Handoff Protocol for General-Purpose Agent Types

## Problem Statement

The `conventions.md` file in `plugin/ralph-hero/skills/shared/conventions.md` contains three sections that reference custom agent types (`ralph-analyst`, `ralph-builder`, `ralph-validator`, `ralph-integrator`). When the team migrates to `general-purpose` subagents (parent issue #133), these sections become incorrect because:

1. All workers will have `subagent_type="general-purpose"` -- there is no `agentType` field to discover peers
2. Peer discovery must shift from `agentType`-based lookup to `name`-based lookup in team config
3. Template naming no longer maps from "agent type" but from "role" (determined by task subject)

## Current State Analysis

### Section 1: Pipeline Handoff Protocol (lines 91-136)

**Location**: [`plugin/ralph-hero/skills/shared/conventions.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md) lines 91-136

**Current state**: The Pipeline Order table (lines 97-103) maps `agentType` to next-stage `agentType`:

```
| Current Role (agentType) | Next Stage | agentType to find |
|---|---|---|
| `ralph-analyst` | Builder | `ralph-builder` |
| `ralph-builder` (plan done) | Validator | `ralph-validator` (if `RALPH_REVIEW_MODE=interactive`) |
| `ralph-builder` (impl done) | Integrator (PR creation) | `ralph-integrator` |
| `ralph-validator` (approved) | Builder | `ralph-builder` |
| `ralph-validator` (rejected) | Builder (re-plan) | `ralph-builder` |
```

**Problem**: With `general-purpose` agents, there is no `agentType` distinction. Workers are differentiated by their `name` field in the team config (e.g., `"analyst"`, `"builder"`, `"validator"`, `"integrator"`).

**Handoff Procedure** (lines 105-129): Step 3 says:
- "Read team config at `~/.claude/teams/[TEAM_NAME]/config.json`"
- "Find the member whose `agentType` matches your 'Next Stage' from the table above"

This must change to find the member whose `name` matches the target role name.

### Section 2: Template Naming Convention (lines 215-227)

**Location**: [`plugin/ralph-hero/skills/shared/conventions.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md) lines 217-227

**Current state**: Maps "Agent type" to templates:

```
| Agent type | Template |
|------------|----------|
| `ralph-analyst` agent (triage mode) | `triager.md` |
| `ralph-analyst` agent (split mode) | `splitter.md` |
| `ralph-analyst` agent (research mode) | `researcher.md` |
| `ralph-builder` agent (plan mode) | `planner.md` |
| `ralph-builder` agent (implement mode) | `implementer.md` |
| `ralph-validator` agent | `reviewer.md` |
| `ralph-integrator` agent | `integrator.md` |
```

**Problem**: Templates are no longer selected by agent type. They are selected by the task subject keyword. The ralph-team SKILL.md Section 6 spawn table (lines 168-177) already shows this mapping from task subject to template. The conventions.md table should align with that pattern.

### Section 3: Skill Invocation Convention (lines 250-276)

**Location**: [`plugin/ralph-hero/skills/shared/conventions.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md) lines 268-276

**Current state**: "Exception: Team Agents" section (lines 268-276):

```
### Exception: Team Agents

When agents are spawned as team members, the agent IS the subprocess. The agent invokes the skill inline:

```
Skill(skill="ralph-hero:ralph-research", args="42")
```

This is acceptable because the agent already has its own isolated context window via the team system.
```

**Problem**: With general-purpose subagents, the team agent exception is no longer a special case -- it is the SAME as the default `Task()` pattern. General-purpose subagents called via `Task()` ARE isolated subprocesses that invoke `Skill()` inline. The exception section either needs removal or rewording to clarify that team members follow the same pattern as the default.

## Key Discoveries

### Discovery 1: Name-based peer discovery replaces agentType-based discovery

With all workers as `general-purpose`, the team config `config.json` will still have a `name` field per member (e.g., `"analyst"`, `"builder"`, `"validator"`, `"integrator"`). The `name` field is the identifier, not `agentType`.

**Evidence**: The ralph-team SKILL.md Section 6 (line 193) shows the spawn pattern:
```
Task(subagent_type="[agent-type]", team_name=TEAM_NAME, name="[role]", ...)
```
The `name` parameter is what identifies the teammate. When this changes to `subagent_type="general-purpose"`, the `name` parameter remains and continues to serve as the identifier for SendMessage routing.

### Discovery 2: Template selection is already role-based, not agent-type-based

The ralph-team SKILL.md Section 6 spawn table (lines 168-177) maps task subject keywords to templates. The "Agent type" column is redundant information -- what matters is the task subject, which determines the role and therefore the template.

**Current mapping in SKILL.md**:
```
| Task subject contains | Role | Template | Agent type |
|----------------------|------|----------|------------|
| "Research" | analyst | `researcher.md` | ralph-analyst |
```

The "Agent type" column will change to `general-purpose` for all rows. The template selection logic (task subject -> role -> template) remains unchanged.

### Discovery 3: The "Team Agent Exception" collapses into the default pattern

The current Skill Invocation Convention has three cases:
1. **Default**: Fork via `Task(subagent_type="general-purpose", prompt="Skill(...)")`
2. **Exception: Team Agents**: Agent IS the subprocess, invokes `Skill()` inline
3. **Exception: Direct User Invocation**: Runs inline in user session

When team agents become `general-purpose` subagents, case 2 becomes identical to case 1. The team member is spawned via `Task(subagent_type="general-purpose", ...)` and invokes `Skill()` inline within its isolated subprocess -- which is exactly what case 1 describes.

### Discovery 4: Spawn templates already reference role names, not agent types

All 7 spawn templates in `plugin/ralph-hero/templates/spawn/` use phrases like:
- "Report results per your agent definition" (6 templates)
- "Follow the corresponding procedure in your agent definition" (1 template: `integrator.md`)

These references point to agent definition files (`agents/ralph-analyst.md`, etc.). With general-purpose agents, there is no custom agent definition. However, this is the scope of sibling issue **#135** (Update spawn templates to be self-contained), NOT this issue.

### Discovery 5: Hook scripts use `teammate_name`, not `agentType`

The team lifecycle hooks (`team-task-completed.sh`, `team-teammate-idle.sh`, `team-stop-gate.sh`) extract `teammate_name` from the hook input, not `agentType`. This confirms that the runtime infrastructure already uses name-based identification. No hook changes are needed.

## Recommended Changes

### Change 1: Pipeline Handoff Protocol -- Replace `agentType` with `name`

Update the Pipeline Order table to use worker name instead of agent type:

**Before**:
```
| Current Role (agentType) | Next Stage | agentType to find |
```

**After**:
```
| Current Worker (name) | Next Stage | Worker name to find |
```

And update the values:
- `ralph-analyst` -> `analyst`
- `ralph-builder` -> `builder`
- `ralph-validator` -> `validator`
- `ralph-integrator` -> `integrator`

Update the Handoff Procedure (step 3):
- **Before**: "Find the member whose `agentType` matches..."
- **After**: "Find the member whose `name` matches your 'Next Stage' from the table above"

### Change 2: Template Naming Convention -- Replace agent type with role/task subject

Update the table header and content:

**Before**:
```
| Agent type | Template |
|------------|----------|
| `ralph-analyst` agent (triage mode) | `triager.md` |
```

**After**:
```
| Role (task subject) | Template |
|---------------------|----------|
| Analyst (triage) | `triager.md` |
```

This aligns with how templates are actually selected in practice (by role derived from task subject), not by agent type.

### Change 3: Skill Invocation Convention -- Simplify team agent exception

The "Exception: Team Agents" section should be updated to note that team agents now follow the same pattern as the default:

**Before**: Describes team agents as a special case with inline `Skill()` invocation.

**After**: Brief note that team members are spawned as `general-purpose` subagents via `Task()`, so they follow the same isolation pattern as the default. The exception is no longer special -- it is the standard pattern applied in a team context.

## Potential Approaches

### Approach A: Minimal text changes (Recommended)

Change only the three sections identified above. Keep the same document structure. Replace `agentType` references with `name` references, update tables, and simplify the team agent exception.

**Pros**: Smallest diff, lowest risk, matches XS estimate.
**Cons**: None identified -- the changes are straightforward text updates.

### Approach B: Restructure handoff protocol entirely

Redesign the handoff protocol section to remove the concept of peer discovery entirely, replacing it with a simpler "notify by name" pattern.

**Pros**: Cleaner conceptual model.
**Cons**: Larger scope, exceeds XS estimate, risk of breaking references from other documents.

**Recommendation**: Approach A. The changes are simple text substitutions that preserve the existing document structure while accurately reflecting the new `general-purpose` agent model.

## Risks

1. **Coordination with siblings**: The four sub-issues (#134-#137) under parent #133 must ship together for consistency. If #136 updates conventions.md but #134 does not update the spawn table, there will be a temporary inconsistency. The dependency chain (#134 -> #135, #136, #137) mitigates this.

2. **References from other documents**: The handoff protocol is referenced by spawn templates (e.g., "hand off per shared/conventions.md"). The spawn templates will be updated by sibling #135 in parallel. No conflict expected since #135 changes template content, not how they reference conventions.md.

3. **GH-132 plan Phase 2 overlap**: The GH-132 plan includes adding an "Architecture Decision" section and "Result Format Contracts" section to conventions.md. These are new sections that do not overlap with the three sections being updated by this issue. However, implementers should be aware of potential merge conflicts if both are in progress simultaneously.

## Dependencies

- **Blocked by #134**: The spawn table change establishes `general-purpose` as the agent type. This issue updates conventions.md to match.
- **No blockers on this issue**: This issue can proceed as soon as #134 is complete.
- **Parallel with #135 and #137**: These touch different files (spawn templates and SKILL.md Section 9 respectively). No file overlap.

## References

- Parent issue: [#133](https://github.com/cdubiel08/ralph-hero/issues/133) -- ralph-team should dispatch via general-purpose subagents
- Foundation: [#134](https://github.com/cdubiel08/ralph-hero/issues/134) -- Update spawn table to use general-purpose
- Sibling: [#135](https://github.com/cdubiel08/ralph-hero/issues/135) -- Update spawn templates to be self-contained
- Sibling: [#137](https://github.com/cdubiel08/ralph-hero/issues/137) -- Remove custom agent tool restriction docs from Section 9
- Bowser research: [GH-132 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0132-agent-skill-patterns-bowser-reference.md)
- Target file: [`plugin/ralph-hero/skills/shared/conventions.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md)
