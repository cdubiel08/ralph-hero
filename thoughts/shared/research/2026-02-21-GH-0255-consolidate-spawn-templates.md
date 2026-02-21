---
date: 2026-02-21
github_issue: 255
github_url: https://github.com/cdubiel08/ralph-hero/issues/255
status: complete
type: research
---

# GH-255: Consolidate 7 Spawn Templates into Single worker.md

## Problem Statement

Seven role-specific spawn templates (`researcher.md`, `planner.md`, `implementer.md`, `integrator.md`, `splitter.md`, `triager.md`, `reviewer.md`) contain duplicated structure with minor variations. This causes behavioral inconsistencies (3 different handoff instructions) and makes protocol changes require edits to 7 files. GH-255 replaces them with a single `worker.md` template using variable substitution.

## Current State Analysis

### Template Inventory

All 7 templates follow the same 3-part pattern with role-specific substitutions:

| Template | Line 1 (Task) | Line 2-3 (Context) | Skill Invocation | Report Format | Post-Task Instruction |
|----------|---------------|---------------------|------------------|---------------|----------------------|
| `researcher.md` | `Research GH-{N}: {T}.` | (none) | `ralph-research` | `RESEARCH COMPLETE: #{N} - {T}\nDocument: [path]\nKey findings: [summary]\nTicket moved to: Ready for Plan` | "check TaskList for more research tasks. If none, hand off per shared/conventions.md." |
| `planner.md` | `Plan GH-{N}: {T}.` | `{GROUP_CONTEXT}` | `ralph-plan` | `PLAN COMPLETE: [ticket/group]\nPlan: [path]\nPhases: [N]\nFile ownership: [groups]\nReady for review.` | "check TaskList for more plan tasks. If none, hand off per shared/conventions.md." |
| `implementer.md` | `Implement GH-{N}: {T}.` | `{WORKTREE_CONTEXT}` | `ralph-impl` | `IMPLEMENTATION COMPLETE\nTicket: #{N}\nFiles: [list]\nTests: [PASSING/FAILING]\nCommit: [hash]\nWorktree: [path]` | "DO NOT push to remote. The integrator handles pushing and PR creation.\nThen check TaskList for more implementation tasks. If none, notify team-lead." |
| `integrator.md` | `Integration task for GH-{N}: {T}.` | (none) | (defers to agent definition) | (defers to agent definition) | "check TaskList for more integration tasks." |
| `splitter.md` | `Split GH-{N}: {T}.` | `Too large for direct implementation (estimate: {ESTIMATE}).` | `ralph-split` | `SPLIT COMPLETE: #{N}\nSub-tickets: #AAA, #BBB, #CCC\nEstimates: #AAA (XS), #BBB (S), #CCC (XS)` | "check TaskList for more split tasks." |
| `triager.md` | `Triage GH-{N}: {T}.` | `Estimate: {ESTIMATE}.` | `ralph-triage` | `TRIAGE COMPLETE: #{N}\nAction: [CLOSE/SPLIT/RESEARCH/KEEP]\n[If SPLIT]: Sub-tickets: #AAA, #BBB\nEstimates: #AAA (XS), #BBB (S)` | "check TaskList for more triage tasks." |
| `reviewer.md` | `Review plan for GH-{N}: {T}.` | `{GROUP_CONTEXT}` | `ralph-review` | `VALIDATION VERDICT\nTicket: #{N}\nPlan: [path]\nVERDICT: [APPROVED/NEEDS_ITERATION]\n[findings]` | "check TaskList for more review tasks. If none, hand off per shared/conventions.md." |

### Inconsistencies Identified

1. **Post-task instructions** (3 variants):
   - `researcher.md`, `planner.md`, `reviewer.md`: "hand off per shared/conventions.md"
   - `implementer.md`: "notify team-lead"
   - `splitter.md`, `triager.md`, `integrator.md`: just "check TaskList" (no handoff)

2. **Integrator template is structurally different**: It defers skill invocation and reporting to the agent definition rather than embedding them inline. Since workers currently spawn as `general-purpose`, the agent definition never loads -- the integrator template is effectively broken (worker has no skill invocation).

3. **`implementer.md` has a role-specific constraint**: "DO NOT push to remote" is embedded in the template. This is a role-specific concern that belongs in the skill definition (`ralph-impl`), not the spawn template.

### Placeholders Currently in Use

| Placeholder | Templates Using It | Source |
|-------------|-------------------|--------|
| `{ISSUE_NUMBER}` | All 7 | Issue number from `get_issue` |
| `{TITLE}` | All 7 | Issue title from `get_issue` |
| `{ESTIMATE}` | `triager.md`, `splitter.md` | Issue estimate from `get_issue` |
| `{GROUP_CONTEXT}` | `planner.md`, `reviewer.md` | Group line if IS_GROUP, empty if not |
| `{WORKTREE_CONTEXT}` | `implementer.md` | Worktree path if exists, empty if not |

## Proposed Single Template Design

### worker.md Template

The design document proposes:

```markdown
You are a {ROLE_NAME} in the Ralph Team.

{TASK_CONTEXT}

{SKILL_DISPATCH}
```

However, this template is incomplete -- it drops the report format, which is currently embedded in each template and is referenced by hooks (e.g., `team-task-completed.sh` parses result descriptions) and the lead (who reads results via `TaskGet`). The report format contracts are documented in `conventions.md` (lines 344-435).

### Recommended Template (preserving report format)

```markdown
{TASK_VERB} GH-{ISSUE_NUMBER}: {TITLE}.
{TASK_CONTEXT}

Invoke: Skill(skill="ralph-hero:{SKILL_NAME}", args="{ISSUE_NUMBER}")

Report via TaskUpdate: "{REPORT_FORMAT}"
Then check TaskList for more tasks matching your role. If none, notify team-lead.
```

This preserves the current structure while unifying the post-task instruction to a single consistent pattern.

### New Placeholder Set

| Placeholder | Description | Source |
|-------------|-------------|--------|
| `{ISSUE_NUMBER}` | Issue number | `get_issue` response |
| `{TITLE}` | Issue title | `get_issue` response |
| `{TASK_VERB}` | Role-specific verb: Research, Plan, Implement, Review, Triage, Split, Integrate | Task subject keyword |
| `{TASK_CONTEXT}` | Optional context lines (estimate, group, worktree) | Varies by role (see below) |
| `{SKILL_NAME}` | Skill to invoke: `ralph-research`, `ralph-plan`, `ralph-impl`, `ralph-review`, `ralph-triage`, `ralph-split` | Role mapping |
| `{REPORT_FORMAT}` | Result format contract from conventions.md | Role mapping |

### Task Context Resolution per Role

| Role | `{TASK_CONTEXT}` Value |
|------|----------------------|
| Triager | `Estimate: {ESTIMATE}.` |
| Splitter | `Too large for direct implementation (estimate: {ESTIMATE}).` |
| Researcher | (empty -- remove line) |
| Planner | `{GROUP_CONTEXT}` (empty if not group) |
| Reviewer | `{GROUP_CONTEXT}` (empty if not group) |
| Implementer | `{WORKTREE_CONTEXT}` (empty if no worktree) |
| Integrator | (empty -- but see Special Handling below) |

### Integrator Special Handling

The integrator is unique: it does not invoke a skill. Instead, it performs direct git/gh operations following procedures in its agent definition. Current `integrator.md` template says "Follow the corresponding procedure in your agent definition." Since workers currently spawn as `general-purpose`, this instruction is broken -- the agent definition never loads.

**Resolution for GH-255**: The unified template can handle the integrator by setting `{SKILL_NAME}` to a no-op or by using a conditional pattern. However, the simplest approach is:
- Set `{TASK_VERB}` to the task-specific verb ("Create PR for" or "Merge PR for")
- Set `{SKILL_NAME}` placeholder to empty and use a special instruction line
- OR: Keep a minimal integrator-specific override

**Recommendation**: The integrator case is an edge case that can be handled by the lead substituting a different instruction line. The template line `Invoke: Skill(...)` becomes `Check your task subject to determine the operation (Create PR or Merge PR).\nFollow the corresponding procedure in your agent definition.` when the role is integrator. This is valid because GH-256 (Phase 2) will activate typed agents, at which point the agent definition will actually load.

**Alternatively**: Accept that the integrator template line will be non-functional until GH-256 activates typed agents. The integrator already defers to agent definitions today, and this is documented as a known issue.

## Files to Change

### Create
- `templates/spawn/worker.md` -- single unified template (~8 lines)

### Delete (7 files)
- `templates/spawn/researcher.md`
- `templates/spawn/planner.md`
- `templates/spawn/implementer.md`
- `templates/spawn/integrator.md`
- `templates/spawn/splitter.md`
- `templates/spawn/triager.md`
- `templates/spawn/reviewer.md`

### Update
- `skills/ralph-team/SKILL.md` -- Section 6 spawn table: replace 7 role-specific templates with single `worker.md`; update placeholder substitution docs for new variables (`{TASK_VERB}`, `{SKILL_NAME}`, `{REPORT_FORMAT}`, `{TASK_CONTEXT}`); update Section 6 "Template Naming Convention" subsection
- `skills/shared/conventions.md` -- "Spawn Template Protocol" section (lines 138-248): update template location from 7 files to single `worker.md`; update placeholder reference table; update Template Naming Convention subsection; update "Available templates" list

## SKILL.md Section 6 Changes (Detailed)

### Current Spawn Table ([SKILL.md:190-199](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L190-L199))

```
| Task subject contains | Role | Template | Agent type |
|----------------------|------|----------|------------|
| "Triage" | analyst | triager.md | general-purpose |
| "Split" | analyst | splitter.md | general-purpose |
| "Research" | analyst | researcher.md | general-purpose |
| "Plan" (not "Review") | builder | planner.md | general-purpose |
| "Review" | validator | reviewer.md | general-purpose |
| "Implement" | builder | implementer.md | general-purpose |
| "Create PR" | integrator | integrator.md | general-purpose |
| "Merge" or "Integrate" | integrator | integrator.md | general-purpose |
```

### Proposed Spawn Table

```
| Task subject contains | Role | Skill | Task Verb | Agent type |
|----------------------|------|-------|-----------|------------|
| "Triage" | analyst | ralph-triage | Triage | general-purpose |
| "Split" | analyst | ralph-split | Split | general-purpose |
| "Research" | analyst | ralph-research | Research | general-purpose |
| "Plan" (not "Review") | builder | ralph-plan | Plan | general-purpose |
| "Review" | validator | ralph-review | Review plan for | general-purpose |
| "Implement" | builder | ralph-impl | Implement | general-purpose |
| "Create PR" | integrator | (none) | Create PR for | general-purpose |
| "Merge" or "Integrate" | integrator | (none) | Merge PR for | general-purpose |
```

Notes:
- Template column removed (single `worker.md` for all)
- Skill column added (drives `{SKILL_NAME}` substitution)
- Task Verb column added (drives `{TASK_VERB}` substitution)
- Agent type remains `general-purpose` -- changing to typed agents is GH-256 scope

### Placeholder Substitution Docs Update

Current placeholder reference ([SKILL.md:204-211](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L204-L211)):
```
- {ISSUE_NUMBER} -> issue number
- {TITLE} -> issue title
- {ESTIMATE} -> issue estimate
- {GROUP_CONTEXT} -> group line if IS_GROUP, empty if not
- {WORKTREE_CONTEXT} -> worktree path if exists, empty if not
```

Proposed update adds:
```
- {TASK_VERB} -> from spawn table Task Verb column
- {SKILL_NAME} -> from spawn table Skill column (empty for integrator)
- {REPORT_FORMAT} -> from Result Format Contracts in conventions.md
- {TASK_CONTEXT} -> role-dependent (estimate for triage/split, group for plan/review, worktree for implement, empty otherwise)
```

## conventions.md Changes (Detailed)

### Template Location ([conventions.md:142-150](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md#L142-L150))

Current:
```
Spawn templates live at: ${CLAUDE_PLUGIN_ROOT}/templates/spawn/{role}.md
Available templates: triager, splitter, researcher, planner, reviewer, implementer, integrator
```

Proposed:
```
Spawn template lives at: ${CLAUDE_PLUGIN_ROOT}/templates/spawn/worker.md
Single template for all roles. Role-specific behavior is driven by placeholder substitution.
```

### Placeholder Table ([conventions.md:154-161](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md#L154-L161))

Replace with expanded table matching the new placeholder set.

### Template Naming Convention ([conventions.md:216-227](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md#L216-L227))

Remove role-to-template mapping table. Replace with note that all roles use `worker.md`.

### Resolution Procedure ([conventions.md:206-213](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md#L206-L213))

Update step 1 from "Determine role -> read role-specific template" to "Read `worker.md`, substitute role-specific placeholders from spawn table."

## Risks and Edge Cases

1. **Integrator has no skill**: The integrator performs direct git/gh operations. The template's `Invoke: Skill(...)` line doesn't apply. Resolution: use conditional substitution where `{SKILL_NAME}` is empty and the invoke line is replaced with integrator-specific instruction. This is acceptable because the integrator template already defers to agent definitions.

2. **Report format is long**: Some report formats (e.g., implementer's) span 5 lines. Embedding the full format in a placeholder keeps the template under 10 lines but the resolved output may exceed the 10-line guardrail. **Recommendation**: Keep report formats as single-line escaped strings in the template, matching current behavior.

3. **Backward compatibility**: The SKILL.md spawn procedure reads templates by path. Changing from 7 files to 1 file requires updating the read path logic. The current code reads `Read(file_path="[resolved-root]/templates/spawn/{template}")` -- this just needs to always resolve to `worker.md`.

4. **conventions.md line-count guardrail**: Current guardrail says "5-8 lines" for resolved prompts. The unified template with all substitutions may produce 6-8 lines, which is within bounds. Verify after implementation.

## Recommended Implementation Approach

1. Create `templates/spawn/worker.md` with the unified template
2. Update `SKILL.md` Section 6: spawn table, placeholder docs, resolution procedure
3. Update `conventions.md`: template location, placeholder table, naming convention, resolution procedure
4. Delete all 7 old templates
5. Verify the resolved template for each role is under 10 lines
