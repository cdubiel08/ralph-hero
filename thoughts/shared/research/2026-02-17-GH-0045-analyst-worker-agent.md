---
date: 2026-02-17
github_issue: 45
github_url: https://github.com/cdubiel08/ralph-hero/issues/45
status: complete
type: research
---

# Analyst Worker Agent Definition - Research Findings

## Problem Statement

Issue #45 requires creating an Analyst worker agent (`ralph-analyst.md`) that consolidates the current `ralph-triager` and `ralph-researcher` agents into a single stateless loop. The Analyst operates over the Backlog -> Ready for Plan state range, composing three skills (`ralph-triage`, `ralph-split`, `ralph-research`) with state-driven skill selection. Per the #44 scope boundaries research, the Analyst owns Backlog, Research Needed, and Research in Progress states.

## Current State Analysis

### Existing Triager Agent (`ralph-triager.md`)

The triager at [plugin/ralph-hero/agents/ralph-triager.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-triager.md):

**Frontmatter**:
- `name: ralph-triager`
- `model: sonnet`
- `color: gray`
- `tools`: Read, Glob, Grep, Skill, Task, TaskList, TaskGet, TaskUpdate, SendMessage, plus MCP tools (get_issue, list_issues, update_issue, update_workflow_state, update_estimate, update_priority, create_issue, create_comment, add_sub_issue, add_dependency, list_sub_issues, list_dependencies)

**Behavior**:
- Task loop matches "Triage" or "Split" in subject
- Claims as `owner="triager"`
- Dispatches to `ralph-hero:ralph-triage` or `ralph-hero:ralph-split` based on task subject keyword
- Reports results including action taken, sub-ticket IDs (for splits), and estimates
- No file writes (comments only, plus issue creation for splits)

**Task matching keywords**: "Triage", "Split"

### Existing Researcher Agent (`ralph-researcher.md`)

The researcher at [plugin/ralph-hero/agents/ralph-researcher.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-researcher.md):

**Frontmatter**:
- `name: ralph-researcher`
- `model: sonnet`
- `color: magenta`
- `tools`: Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, plus MCP tools (get_issue, list_issues, update_issue, update_workflow_state, create_comment, add_dependency, remove_dependency, list_dependencies, detect_group)

**Behavior**:
- Task loop matches "Research" in subject
- Claims as `owner="researcher"`
- Dispatches to `ralph-hero:ralph-research` skill
- Reports results including document path, key findings, and state transition
- After completion, hands off to `ralph-planner` via pipeline convention
- Writes research docs to `thoughts/shared/research/`

**Task matching keywords**: "Research"

### Skills to Compose

| Skill | Input States | Output States | Lock State | Artifacts | Hooks |
|-------|-------------|---------------|------------|-----------|-------|
| `ralph-triage` | Backlog | Research Needed, Ready for Plan, Done, Canceled, Human Needed | None | Comments only | branch-gate, triage-state-gate, triage-postcondition |
| `ralph-split` | Backlog, Research Needed | Backlog (parent stays) | None | Sub-issues | branch-gate, split-estimate-gate, split-size-gate, split-verify-sub-issue, split-postcondition |
| `ralph-research` | Research Needed | Ready for Plan, Human Needed | Research in Progress | `thoughts/shared/research/*.md` | branch-gate, research-state-gate, research-postcondition |

All three skills share `RALPH_REQUIRED_BRANCH: "main"` and use the branch-gate hook.

### State Machine Context

From [hooks/scripts/ralph-state-machine.json](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/ralph-state-machine.json):

**Analyst-owned states**:
- **Backlog** (order 1): Produced by `ralph_triage`, `ralph_split`. Consumed by `ralph_triage`, `ralph_split`.
- **Research Needed** (order 2): Produced by `ralph_triage`. Consumed by `ralph_research`, `ralph_split`.
- **Research in Progress** (order 3): Lock state. Produced by `ralph_research`. Exclusive ownership.

**Handoff boundary**: Ready for Plan (order 4) -- produced by `ralph_research` and `ralph_triage`, consumed by Builder's `ralph_plan`.

### Current Spawn and Team Integration

From [skills/ralph-team/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md) Section 6:

| Task subject contains | Role | Template | Agent type |
|----------------------|------|----------|------------|
| "Triage" | triager | `triager.md` | ralph-triager |
| "Split" | splitter | `splitter.md` | ralph-triager |
| "Research" | researcher | `researcher.md` | ralph-researcher |

The team lead currently spawns separate agents for triage/split vs research. The Analyst worker would unify these into a single agent type, simplifying spawn logic.

### Instance Limits

Current: Up to 3 researchers (`researcher`, `researcher-2`, `researcher-3`), 1 triager. Per #44: Analyst supports up to 3 parallel instances (read-only + docs, parallel per issue).

## Key Discoveries

### 1. Tool Superset is the Union of Both Agents

The Analyst needs tools from BOTH current agents:

**From triager only** (not in researcher):
- `update_estimate`, `update_priority` (triage re-estimation)
- `create_issue`, `add_sub_issue` (split creates sub-issues)
- `list_sub_issues` (split checks existing children)

**From researcher only** (not in triager):
- `Write`, `Bash` (research docs)
- `detect_group` (research group detection)
- `remove_dependency` (research refines dependencies)

**Shared by both**:
- Read, Glob, Grep, Skill, Task, TaskList, TaskGet, TaskUpdate, SendMessage
- `get_issue`, `list_issues`, `update_issue`, `update_workflow_state`, `create_comment`
- `add_dependency`, `list_dependencies`

**Complete Analyst tool list** (union):
`Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__update_estimate, ralph_hero__update_priority, ralph_hero__create_issue, ralph_hero__create_comment, ralph_hero__add_sub_issue, ralph_hero__add_dependency, ralph_hero__remove_dependency, ralph_hero__list_sub_issues, ralph_hero__list_dependencies, ralph_hero__detect_group`

### 2. Skill Selection Logic is State-Driven

The Analyst's inner loop reads the current workflow state and selects a skill:

```
state = readWorkflowState(issue)
switch state:
    Backlog:
        estimate = readEstimate(issue)
        if estimate in {M, L, XL}:
            skill = ralph-split  # Too large, decompose first
        else:
            skill = ralph-triage  # Assess and route
    Research Needed:
        estimate = readEstimate(issue)
        if estimate in {M, L, XL}:
            skill = ralph-split  # Still too large
        else:
            skill = ralph-research  # Investigate
    Research in Progress:
        skill = ralph-research  # Resume locked research
```

However, the Analyst agent definition should NOT implement this loop itself. The agent definition is a thin task-loop wrapper -- skill selection is determined by the **task subject keyword**, just like today's agents. The team lead creates tasks with "Triage", "Split", or "Research" in the subject, and the Analyst matches on all three.

### 3. Task Matching Must Cover Three Keywords

The triager matches "Triage" or "Split". The researcher matches "Research". The Analyst must match ALL three:

```
TaskList() -> find tasks with "Triage", "Split", or "Research" in subject
```

This is a simple OR match. The task subject already encodes which skill to invoke.

### 4. Owner Name Needs Consideration

Current agents claim as `owner="triager"` or `owner="researcher"`. The Analyst should claim as `owner="analyst"` (with `-2`, `-3` suffixes for parallel instances). This means:
- Team lead spawn templates need updating (sibling issue #49)
- Task descriptions from the lead already work -- they use subject keywords, not owner names

### 5. Model Selection: sonnet is Correct

Both triager and researcher use `model: sonnet`. The Analyst should also use sonnet. The skills themselves specify their own model in SKILL.md frontmatter:
- `ralph-triage`: opus (for nuanced assessment)
- `ralph-split`: opus (for scope decomposition)
- `ralph-research`: opus (for deep investigation)

The agent model is only used for the thin task-loop logic. The forked skill gets its own model. So `sonnet` for the agent wrapper is appropriate.

### 6. Hooks Are Skill-Level, Not Agent-Level

A key architectural insight: hooks are defined in SKILL.md frontmatter, not in agent definitions. The Analyst agent does NOT need any hooks -- all validation (branch-gate, state-gate, postconditions) is enforced by the skills when invoked via `Skill()`.

This means the agent definition is purely:
1. Frontmatter (name, description, tools, model, color)
2. Task loop instructions
3. Shutdown behavior

### 7. Pipeline Handoff Changes

Current pipeline handoff from `shared/conventions.md`:
```
ralph-researcher -> ralph-planner
```

New pipeline handoff for Analyst:
```
ralph-analyst -> ralph-builder (or ralph-planner until builder exists)
```

During migration, the Analyst should look for EITHER `ralph-builder` OR `ralph-planner` in the team config when handing off. This provides backward compatibility during the transition.

### 8. No Internal Loop Needed in Agent Definition

The issue description mentions "worker loop pattern: `while state in MY_SCOPE: state=readState(); skill=selectSkill(state); skill.execute()`". However, analyzing the current architecture reveals this loop is unnecessary at the agent level because:

1. **Skills are atomic**: Each skill invocation handles one state transition completely
2. **Task system drives iteration**: The team lead creates individual tasks ("Triage #42", "Research #42"), and the agent's task loop processes them one at a time
3. **State changes happen within skills**: `ralph-triage` moves from Backlog -> Research Needed, `ralph-research` moves from Research Needed -> Ready for Plan

The "worker loop" described in #44 is conceptual -- it describes the Analyst's scope, not its implementation. The actual implementation is the same task-loop pattern used by all current agents: `TaskList -> claim -> Skill() -> complete -> repeat`.

If the team lead wanted a single task like "Analyze #42" that drives the issue from Backlog through Ready for Plan, that would require a new orchestration skill (`ralph-analyze`). But that's unnecessary complexity -- the existing skills already handle each phase, and the team lead already creates phase-specific tasks.

### 9. Color Should Distinguish from Other Workers

Current colors: triager=gray, researcher=magenta, planner=blue, advocate=blue, implementer=orange.

The Analyst should pick a color that's distinct. Options: `green` (analysis/research connotation), `cyan` (distinct from existing), or `magenta` (inherited from researcher as the more visible role). Recommendation: `green` for the Analyst (analysis), with `magenta` available for Builder if desired.

## Potential Approaches

### Approach A: Thin Task-Loop Agent (Recommended)

Create `ralph-analyst.md` as a thin task-loop wrapper that:
- Matches tasks with "Triage", "Split", or "Research" in subject
- Dispatches to the appropriate skill based on the keyword
- Reports results following the same pattern as current agents
- Hands off to the next pipeline stage

**Pros**:
- Consistent with all existing agent definitions
- Skills remain unmodified (no changes to triage, split, or research)
- Simple to test and verify
- Compatible with current team orchestrator (just change agent type mapping)
- No new orchestration logic needed

**Cons**:
- Not truly a "worker loop" -- still task-driven like today
- Doesn't automatically chain triage -> research (lead must create both tasks)

### Approach B: Orchestrating Agent with Internal Loop

Create `ralph-analyst.md` with an internal state-driven loop that:
- Takes an issue number
- Reads current state
- Selects and invokes the appropriate skill
- Loops until the issue exits the Analyst's scope

**Pros**:
- True "worker loop" as described in #44
- Single task from lead: "Analyze #42" handles the entire Analyst scope
- Fewer task management overhead for the lead

**Cons**:
- More complex agent definition
- Requires a new skill or inline orchestration logic
- Breaks the current pattern where skills are invoked exactly once per task
- More difficult to track progress (single task covers multiple phases)
- Conflicts with parallel instance support (task granularity)

### Recommendation

**Approach A** (Thin Task-Loop Agent) is recommended because:
1. It follows the established pattern used by all 5 existing agents
2. Skills stay as-is (acceptance criteria: "No modifying existing skills")
3. Compatible with existing team orchestrator spawn logic
4. Individual tasks for triage/split/research provide better observability
5. Parallel instances naturally claim individual tasks

The "worker loop" from #44 is satisfied at the conceptual level -- the Analyst worker handles ALL tasks within Backlog -> Research in Progress, just dispatched as individual tasks rather than as a single loop invocation.

## Implementation Guidance

### Agent Definition Structure

```yaml
---
name: ralph-analyst
description: Analyst worker - invokes ralph-triage, ralph-split, and ralph-research skills for issue assessment and investigation
tools: Read, Write, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__update_estimate, ralph_hero__update_priority, ralph_hero__create_issue, ralph_hero__create_comment, ralph_hero__add_sub_issue, ralph_hero__add_dependency, ralph_hero__remove_dependency, ralph_hero__list_sub_issues, ralph_hero__list_dependencies, ralph_hero__detect_group
model: sonnet
color: green
---
```

### Task Loop

```
1. TaskList() -- find tasks with "Triage", "Split", or "Research" in subject
   - Must be pending, empty blockedBy, no owner
2. Claim lowest-ID match: TaskUpdate(taskId, status="in_progress", owner="analyst")
3. TaskGet(taskId) -- extract issue number from description
4. Determine skill from task subject:
   - "Split" -> Skill(skill="ralph-hero:ralph-split", args="[issue-number]")
   - "Triage" -> Skill(skill="ralph-hero:ralph-triage", args="[issue-number]")
   - "Research" -> Skill(skill="ralph-hero:ralph-research", args="[issue-number]")
5. TaskUpdate(taskId, status="completed", description="...")
   - For Triage: "TRIAGE COMPLETE: #NNN\nAction: [CLOSE/SPLIT/RESEARCH/KEEP]\n..."
   - For Split: "SPLIT COMPLETE: #NNN\nSub-tickets: #AAA, #BBB\nEstimates: ..."
   - For Research: "RESEARCH COMPLETE: #NNN\nDocument: [path]\nKey findings: ..."
6. Repeat from step 1. If no tasks, hand off per shared/conventions.md
```

### Pipeline Handoff Update

In `shared/conventions.md`, the Analyst's next-stage mapping:
```
ralph-analyst -> ralph-builder (or ralph-planner during migration)
```

### Spawn Template Compatibility

The Analyst uses existing spawn templates (`triager.md`, `splitter.md`, `researcher.md`) without modification. The team lead's spawn table in Section 6 changes the agent type column:

| Task subject contains | Role | Template | Agent type (new) |
|----------------------|------|----------|------------------|
| "Triage" | analyst | `triager.md` | ralph-analyst |
| "Split" | analyst | `splitter.md` | ralph-analyst |
| "Research" | analyst | `researcher.md` | ralph-analyst |

This is a change to the orchestrator (issue #49), not the agent definition.

## Risks and Considerations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Tool list is larger than either individual agent | Low | Tools are additive. Skills only use what they need. No security risk. |
| Task matching is broader (3 keywords vs 1-2) | Low | Keywords are distinct. No ambiguity between "Triage"/"Split"/"Research". |
| Migration confusion (old agents still exist) | Medium | Cleanup issue #51 handles deprecation. Run both during transition. |
| Pipeline handoff target changes | Low | Check for both `ralph-builder` and `ralph-planner` during migration. |
| Parallel instance naming collision with old agents | Low | Analyst uses `analyst`, `analyst-2`, `analyst-3`. Distinct from `researcher-N`. |

## Recommended Next Steps

1. Create `plugin/ralph-hero/agents/ralph-analyst.md` following the structure above
2. Verify compatibility with current team orchestrator by checking task subject matching
3. Update spawn template mapping in #49 (sibling issue, not this issue)
4. Update pipeline handoff table in `shared/conventions.md` in #49
5. Test with a real issue: create Triage + Research tasks, verify Analyst processes both
