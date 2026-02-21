---
date: 2026-02-21
github_issue: 230
github_url: https://github.com/cdubiel08/ralph-hero/issues/230
status: complete
type: research
---

# GH-230: Redesign Ralph-Team Worker Architecture

## Problem Statement

Ralph team sessions produce duplicate work, worker confusion, and excessive lead overhead. The issue identifies 6 root causes stemming from duplicated spawn templates, eager work discovery, dead-code agent definitions, upfront pipeline creation, conflicting handoff models, and a rule forbidding mid-pipeline assignment. A detailed design document already exists at `thoughts/shared/plans/2026-02-20-ralph-team-worker-redesign.md`.

## Current State Analysis

### Spawn Templates (7 files, `templates/spawn/`)

All 7 templates follow the same pattern:
1. One-line task description with `{ISSUE_NUMBER}` and `{TITLE}` placeholders
2. Optional context placeholders (`{GROUP_CONTEXT}`, `{WORKTREE_CONTEXT}`, `{ESTIMATE}`)
3. `Skill()` invocation
4. Report format via `TaskUpdate`
5. **"Then check TaskList for more [role] tasks"** -- the problematic work-discovery instruction

Files: [`researcher.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/researcher.md), [`planner.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/planner.md), [`implementer.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/implementer.md), [`integrator.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/integrator.md), [`splitter.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/splitter.md), [`triager.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/triager.md), [`reviewer.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/reviewer.md).

**Key inconsistencies**:
- `implementer.md:8` says "notify team-lead" when no tasks; `researcher.md:6` says "hand off per shared/conventions.md"; `splitter.md:7` and `triager.md:7` say "check TaskList for more [x] tasks" (no handoff instruction)
- `implementer.md` includes "DO NOT push to remote" instruction; no other template has role-specific constraints
- `integrator.md` defers entirely to agent definition ("Follow the corresponding procedure in your agent definition") while others embed the full skill invocation inline

### Agent Definitions (4 files, `agents/`)

Each agent definition contains:
- Frontmatter: `name`, `description`, `tools`, `model`, `color` (no hooks currently)
- Body: Task Loop (7-step scan/claim/dispatch cycle), role-specific notes, shutdown behavior

**The Task Loop is dead code**: Workers are spawned as `general-purpose` (see [`SKILL.md:215`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L215): `subagent_type="general-purpose"`), so agent definitions never load as system prompts. The Task Loop competes with spawn template instructions -- whichever the worker reads, it gets conflicting guidance on work discovery.

Agent definitions reference in [`SKILL.md:190-199`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L190-L199):
| Task subject | Agent type in SKILL.md |
|---|---|
| All roles | `general-purpose` |

This means the rich role knowledge in `ralph-analyst.md`, `ralph-builder.md`, `ralph-validator.md`, `ralph-integrator.md` is never loaded.

### SKILL.md (Team Orchestrator)

The [`ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md) is a comprehensive 302-line orchestrator. Key sections relevant to redesign:

- **Section 4.2 (line 128-143)**: Creates tasks for ALL remaining phases upfront with sequential blocking (Research -> Plan -> Review -> Implement -> PR). This is the "full pipeline created upfront" problem.
- **Section 4.3 (line 145-152)**: Pre-assigns ownership before spawning. This is correct and should be kept.
- **Section 5 (line 173-180)**: "Pre-assign at spawn, pull-based thereafter. Do NOT assign tasks mid-pipeline." This contradicts the bough model which requires mid-pipeline assignment.
- **Section 6 (line 182-252)**: Spawn procedure uses `general-purpose` agent type (line 215).

### Hooks

Three team lifecycle hooks exist:
- [`team-stop-gate.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/team-stop-gate.sh): Checks GitHub for processable issues. Exit 2 blocks stop. Has re-entry safety (`stop_hook_active`).
- [`team-teammate-idle.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/team-teammate-idle.sh): Guidance-only (exit 0). Contains "Peers will wake this teammate" messaging.
- [`team-task-completed.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/team-task-completed.sh): Guidance-only (exit 0). Routes review exceptions to lead.

### Conventions.md

[`shared/conventions.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md) (556 lines) contains:
- **Line 133**: "Do NOT assign tasks mid-pipeline via TaskUpdate or SendMessage" -- contradicts bough model
- **Lines 92-136**: Pipeline Handoff Protocol -- peer-to-peer model
- **Lines 138-248**: Spawn Template Protocol -- references 7 templates
- **Lines 282-301**: Sub-Agent Team Isolation -- already documented, GH-231 (closed)

## Key Discoveries

### 1. Templates Are Already Minimal

The 7 templates are already 5-8 lines each. The inconsistencies are small:
- Different handoff instructions (3 variants)
- `implementer.md` has one extra role-specific rule
- `integrator.md` defers to agent definition instead of embedding skill invocation

A single `worker.md` template with variable substitution is achievable. The template only needs: task context line, skill invocation, report format. The "check TaskList" and handoff lines are removed entirely (moved to Stop hook).

### 2. Agent Type Switching Is the Core Change

Changing `subagent_type="general-purpose"` to `subagent_type="ralph-analyst"` (etc.) is a one-line change in `SKILL.md:215`. But it has cascading effects:
- Agent definitions become live system prompts
- Agent definitions need Stop hooks in frontmatter
- Agent body content needs cleanup (remove Task Loop, add skill dispatch table)
- The `tools` list in agent frontmatter constrains what skills can do (documented in conventions.md ADR-001: "Do NOT remove MCP tools from agent definitions")

### 3. Stop Hook Is the Key Innovation

The proposed `worker-stop-gate.sh` replaces all work-discovery instructions across templates and agent definitions. It's a single enforcement point:
- Priority 1: Owned unblocked tasks (worker's own backlog)
- Priority 2: Unclaimed unblocked tasks matching role keywords
- Exit 2 blocks stop with guidance; exit 0 allows stop

**Open question resolved**: Team name discovery can use the `CLAUDE_TEAM_NAME` environment variable if available, or scan `~/.claude/tasks/` for the most recently modified team directory. The `team-stop-gate.sh` already uses environment variables (`RALPH_GH_OWNER`, `RALPH_GH_REPO`), so adding `CLAUDE_TEAM_NAME` to the agent frontmatter `env` block is the cleanest approach.

### 4. Bough Model Requires SKILL.md Section 4.2 Rewrite

Currently, Section 4.2 creates all pipeline tasks upfront. The bough model creates only current-phase tasks. This means:
- Initial creation: only Research tasks (or whatever the entry phase is)
- After convergence: create Plan tasks, assign owners
- After plan: create Review/Implement tasks, assign owners

This requires convergence detection at each phase boundary. The existing `convergence-gate.sh` hook only warns about plan transitions. The `team-task-completed.sh` hook would need to trigger bough advancement logic.

### 5. Sub-Agent Isolation (GH-231) Is Already Closed

GH-231 was implemented and merged. The `conventions.md` already documents the sub-agent team isolation rule (lines 282-301). The skill SKILL.md files include inline reminders. This part of GH-230's scope is already done.

## File Change Matrix

| File | Current State | Proposed Change | Risk |
|------|--------------|----------------|------|
| `templates/spawn/worker.md` | Does not exist | New -- single template with `{ROLE_NAME}`, `{TASK_CONTEXT}`, `{SKILL_DISPATCH}` | Low -- new file |
| `templates/spawn/researcher.md` | 6 lines | Delete | Low -- replaced by worker.md |
| `templates/spawn/planner.md` | 7 lines | Delete | Low |
| `templates/spawn/implementer.md` | 8 lines | Delete | Low |
| `templates/spawn/integrator.md` | 5 lines | Delete | Low |
| `templates/spawn/splitter.md` | 7 lines | Delete | Low |
| `templates/spawn/triager.md` | 7 lines | Delete | Low |
| `templates/spawn/reviewer.md` | 7 lines | Delete | Low |
| `agents/ralph-analyst.md` | 30 lines, Task Loop | Slim to ~15 lines, add Stop hook, skill dispatch table | Medium -- behavior change |
| `agents/ralph-builder.md` | 35 lines, Task Loop | Slim to ~15 lines, add Stop hook, skill dispatch table | Medium |
| `agents/ralph-validator.md` | 28 lines, Task Loop | Slim to ~15 lines, add Stop hook, skill dispatch table | Medium |
| `agents/ralph-integrator.md` | 62 lines, Task Loop + procedures | Slim to ~20 lines, add Stop hook, keep PR/Merge procedures | Medium -- integrator has most procedural knowledge |
| `hooks/scripts/worker-stop-gate.sh` | Does not exist | New -- TaskList scan, role keyword matching, exit 2/0 | Medium -- core innovation |
| `hooks/scripts/team-teammate-idle.sh` | 27 lines | Remove "Peers will wake" messaging | Low |
| `hooks/scripts/team-task-completed.sh` | 35 lines | Add bough advancement trigger | Medium |
| `skills/ralph-team/SKILL.md` | 302 lines | Section 4.2 rewrite (bough), Section 4.3 typed agents, Section 5 remove assignment prohibition | High -- orchestrator core |
| `skills/shared/conventions.md` | 556 lines | Remove line 133 prohibition, update handoff protocol, update spawn template references | Medium |

## Risks and Considerations

1. **Integrator agent definition is the most complex**: It contains PR Creation and Merge procedures (40+ lines). These procedures cannot simply be deleted -- they're the integrator's core knowledge. The slim-down needs to preserve procedural content while removing the Task Loop wrapper.

2. **Stop hook reliability**: If the hook fails or is slow (TaskList query takes too long), workers will stop prematurely. Need a timeout and fallback (allow stop on hook error to prevent stuck workers).

3. **Bough model coordination**: Creating tasks only for the current phase means the lead must be responsive to convergence events. If the lead is busy or context-saturated, bough advancement stalls. The `team-task-completed.sh` hook can inject urgency.

4. **Role keyword matching in Stop hook**: The hook needs to match task subjects to worker roles. If task subjects drift from conventions, matching fails. This is fragile -- consider using task metadata (e.g., `owner` field matching) instead of or in addition to keyword matching.

5. **Agent frontmatter `tools` constraint**: When workers are spawned as typed agents, the `tools` list in the agent definition constrains skill execution. The current tool lists are comprehensive but may need verification against actual skill requirements. ADR-001 explicitly warns: "Do NOT remove MCP tools from agent definitions (PR #57 proved this breaks skill execution)."

6. **M estimate is appropriate**: This is a cross-cutting change touching 16+ files, with behavioral implications across the entire team system. The design document is detailed and the implementation path is clear, but the surface area is large.

## Recommended Approach

1. **Implement in phases**: Phase 1 (one spawn template + delete 7), Phase 2 (typed agents + Stop hook), Phase 3 (bough model in SKILL.md), Phase 4 (conventions.md cleanup). Each phase is independently testable.

2. **Keep integrator procedures in agent definition**: Unlike other agents, the integrator's PR/Merge procedures are core knowledge that skills don't encapsulate. Slim the Task Loop wrapper but keep the procedural body.

3. **Use `owner` field as primary matching in Stop hook**: More reliable than keyword matching. Fall back to subject keywords for unclaimed tasks only.

4. **Test with a single issue first**: The bough model changes sequencing fundamentally. Validate with a single-issue pipeline before testing with groups.

5. **Consider splitting this M issue**: The 4 phases above could be 4 sub-issues (S, S, S, XS). This would allow incremental delivery and easier review. However, the design document is already comprehensive enough to plan directly from.
