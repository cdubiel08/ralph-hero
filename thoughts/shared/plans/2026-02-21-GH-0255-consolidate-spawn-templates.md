---
date: 2026-02-21
status: implemented
github_issues: [255]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/255
primary_issue: 255
---

# Consolidate 7 Spawn Templates into Single worker.md - Atomic Implementation Plan

## Overview
Single issue (GH-255) to replace 7 role-specific spawn templates with one unified `worker.md` using placeholder substitution, and update SKILL.md Section 6 and conventions.md Spawn Template Protocol to match.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-255 | Consolidate 7 spawn templates into single worker.md | S |

## Current State Analysis

Seven spawn templates in [`templates/spawn/`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/) follow the same 3-part structure (task line, skill invocation, report format) with minor variations:

- **3 inconsistent post-task instructions**: "hand off per conventions.md" (researcher, planner, reviewer), "notify team-lead" (implementer), bare "check TaskList" (splitter, triager, integrator)
- **Integrator is structurally broken**: Defers to agent definition that never loads (workers spawn as `general-purpose`)
- **Implementer embeds role-specific constraint**: "DO NOT push to remote" belongs in the skill, not the template

[`SKILL.md:190-199`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md#L190-L199) maps task subjects to 7 different template files. [`conventions.md:138-248`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md#L138-L248) documents the 7-template system with per-role naming convention.

## Desired End State

### Verification
- [x] Single `templates/spawn/worker.md` exists with unified placeholder structure
- [x] All 7 old templates deleted from `templates/spawn/`
- [x] SKILL.md Section 6 spawn table references `worker.md` with role-specific placeholder values
- [x] conventions.md Spawn Template Protocol references single template
- [x] Resolved template for every role is under 10 lines (line-count guardrail)
- [x] No references to deleted template filenames remain in SKILL.md or conventions.md

## What We're NOT Doing
- Changing agent types from `general-purpose` to typed agents (GH-256)
- Creating the worker Stop hook (GH-256)
- Modifying agent definitions (GH-256)
- Changing the bough model / task creation pattern in SKILL.md Section 4.2 (GH-257)
- Removing the mid-pipeline assignment prohibition from conventions.md (GH-258)
- Changing peer-to-peer handoff protocol (GH-258)
- Modifying `team-teammate-idle.sh` (GH-258)

## Implementation Approach

Four sequential changes within a single phase:
1. Create the unified `worker.md` template
2. Update SKILL.md Section 6 (spawn table, placeholder docs, resolution procedure)
3. Update conventions.md Spawn Template Protocol (template location, placeholders, naming, resolution)
4. Delete all 7 old templates

---

## Phase 1: GH-255 - Consolidate 7 Spawn Templates
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/255 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0255-consolidate-spawn-templates.md

### Changes Required

#### 1. Create `templates/spawn/worker.md`
**File**: `plugin/ralph-hero/templates/spawn/worker.md` (NEW)
**Changes**: Create a single unified template that covers all roles through placeholder substitution.

```markdown
{TASK_VERB} GH-{ISSUE_NUMBER}: {TITLE}.
{TASK_CONTEXT}

Invoke: {SKILL_INVOCATION}

Report via TaskUpdate: "{REPORT_FORMAT}"
Then check TaskList for more tasks matching your role. If none, notify team-lead.
```

**Placeholder definitions**:

| Placeholder | Description |
|-------------|-------------|
| `{ISSUE_NUMBER}` | Issue number from `get_issue` |
| `{TITLE}` | Issue title from `get_issue` |
| `{TASK_VERB}` | Role verb from spawn table (e.g., "Research", "Plan", "Implement") |
| `{TASK_CONTEXT}` | Optional context line(s); empty string removed per empty-line-removal rule |
| `{SKILL_INVOCATION}` | Full skill call or integrator-specific instruction (see below) |
| `{REPORT_FORMAT}` | Result format contract string from conventions.md |

**Role-specific substitution map** (orchestrator uses this to resolve placeholders):

| Task subject | `{TASK_VERB}` | `{TASK_CONTEXT}` | `{SKILL_INVOCATION}` | `{REPORT_FORMAT}` |
|---|---|---|---|---|
| "Triage" | `Triage` | `Estimate: {ESTIMATE}.` | `Skill(skill="ralph-hero:ralph-triage", args="{ISSUE_NUMBER}")` | `TRIAGE COMPLETE: #{ISSUE_NUMBER}\nAction: [CLOSE/SPLIT/RESEARCH/KEEP]\n[If SPLIT]: Sub-tickets: #AAA, #BBB\nEstimates: #AAA (XS), #BBB (S)` |
| "Split" | `Split` | `Too large for direct implementation (estimate: {ESTIMATE}).` | `Skill(skill="ralph-hero:ralph-split", args="{ISSUE_NUMBER}")` | `SPLIT COMPLETE: #{ISSUE_NUMBER}\nSub-tickets: #AAA, #BBB, #CCC\nEstimates: #AAA (XS), #BBB (S), #CCC (XS)` |
| "Research" | `Research` | *(empty -- line removed)* | `Skill(skill="ralph-hero:ralph-research", args="{ISSUE_NUMBER}")` | `RESEARCH COMPLETE: #{ISSUE_NUMBER} - {TITLE}\nDocument: [path]\nKey findings: [summary]\nTicket moved to: Ready for Plan` |
| "Plan" (not "Review") | `Plan` | `{GROUP_CONTEXT}` *(empty if not group -- line removed)* | `Skill(skill="ralph-hero:ralph-plan", args="{ISSUE_NUMBER}")` | `PLAN COMPLETE: [ticket/group]\nPlan: [path]\nPhases: [N]\nFile ownership: [groups]\nReady for review.` |
| "Review" | `Review plan for` | `{GROUP_CONTEXT}` *(empty if not group -- line removed)* | `Skill(skill="ralph-hero:ralph-review", args="{ISSUE_NUMBER}")` | `VALIDATION VERDICT\nTicket: #{ISSUE_NUMBER}\nPlan: [path]\nVERDICT: [APPROVED/NEEDS_ITERATION]\n[findings]` |
| "Implement" | `Implement` | `{WORKTREE_CONTEXT}` *(empty if no worktree -- line removed)* | `Skill(skill="ralph-hero:ralph-impl", args="{ISSUE_NUMBER}")` | `IMPLEMENTATION COMPLETE\nTicket: #{ISSUE_NUMBER}\nFiles: [list]\nTests: [PASSING/FAILING]\nCommit: [hash]\nWorktree: [path]` |
| "Create PR" | `Integration task for` | *(empty -- line removed)* | *(see integrator handling below)* | `PR CREATED\nTicket: #{ISSUE_NUMBER}\nPR: [URL]\nBranch: [branch]\nState: In Review` |
| "Merge" / "Integrate" | `Integration task for` | *(empty -- line removed)* | *(see integrator handling below)* | `MERGE COMPLETE\nTicket: #{ISSUE_NUMBER}\nPR: [URL] merged\nBranch: deleted\nWorktree: removed\nState: Done` |

**Integrator handling**: The integrator does not invoke a skill. For integrator roles, `{SKILL_INVOCATION}` is replaced with:
```
Check your task subject to determine the operation (Create PR or Merge PR).
Follow the corresponding procedure in your agent definition.
```
This matches the current `integrator.md` behavior. The instruction becomes functional once GH-256 activates typed agents.

**Resolved template examples**:

Researcher (6 lines):
```
Research GH-42: Add caching.

Invoke: Skill(skill="ralph-hero:ralph-research", args="42")

Report via TaskUpdate: "RESEARCH COMPLETE: #42 - Add caching\nDocument: [path]\nKey findings: [summary]\nTicket moved to: Ready for Plan"
Then check TaskList for more tasks matching your role. If none, notify team-lead.
```

Planner with group (7 lines):
```
Plan GH-42: Add caching.
Group: GH-42 (GH-42, GH-43, GH-44). Plan covers all group issues.

Invoke: Skill(skill="ralph-hero:ralph-plan", args="42")

Report via TaskUpdate: "PLAN COMPLETE: [ticket/group]\nPlan: [path]\nPhases: [N]\nFile ownership: [groups]\nReady for review."
Then check TaskList for more tasks matching your role. If none, notify team-lead.
```

Integrator (7 lines):
```
Integration task for GH-42: Add caching.

Invoke: Check your task subject to determine the operation (Create PR or Merge PR).
Follow the corresponding procedure in your agent definition.

Report via TaskUpdate: "PR CREATED\nTicket: #42\nPR: [URL]\nBranch: [branch]\nState: In Review"
Then check TaskList for more tasks matching your role. If none, notify team-lead.
```

All resolved templates are 6-8 lines, within the 10-line guardrail.

#### 2. Update SKILL.md Section 6
**File**: [`plugin/ralph-hero/skills/ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md)
**Changes**:

**a) Replace spawn table** (lines 190-199). Current table maps task subjects to role-specific templates. Replace with:

```markdown
| Task subject contains | Role | Skill | Task Verb | Agent type |
|----------------------|------|-------|-----------|------------|
| "Triage" | analyst | ralph-triage | Triage | general-purpose |
| "Split" | analyst | ralph-split | Split | general-purpose |
| "Research" | analyst | ralph-research | Research | general-purpose |
| "Plan" (not "Review") | builder | ralph-plan | Plan | general-purpose |
| "Review" | validator | ralph-review | Review plan for | general-purpose |
| "Implement" | builder | ralph-impl | Implement | general-purpose |
| "Create PR" | integrator | (none) | Integration task for | general-purpose |
| "Merge" or "Integrate" | integrator | (none) | Integration task for | general-purpose |
```

- "Template" column removed (single `worker.md` for all)
- "Skill" column added (drives `{SKILL_INVOCATION}` substitution)
- "Task Verb" column added (drives `{TASK_VERB}` substitution)

**b) Update resolve template path** (line 201-202). Current:
```
2. **Resolve template path**: `Bash("echo $CLAUDE_PLUGIN_ROOT")` to get the plugin root, then read:
   `Read(file_path="[resolved-root]/templates/spawn/{template}")`
```
Replace with:
```
2. **Resolve template path**: `Bash("echo $CLAUDE_PLUGIN_ROOT")` to get the plugin root, then read:
   `Read(file_path="[resolved-root]/templates/spawn/worker.md")`
```

**c) Update placeholder substitution** (lines 203-211). Replace existing placeholder list with expanded set:

```markdown
3. **Substitute placeholders** from the issue context and spawn table:
   - `{ISSUE_NUMBER}` -> issue number
   - `{TITLE}` -> issue title
   - `{TASK_VERB}` -> from spawn table "Task Verb" column
   - `{TASK_CONTEXT}` -> role-dependent context line:
     - Triage: `Estimate: {ESTIMATE}.`
     - Split: `Too large for direct implementation (estimate: {ESTIMATE}).`
     - Plan/Review: `{GROUP_CONTEXT}` (group line if IS_GROUP, empty if not)
     - Implement: `{WORKTREE_CONTEXT}` (worktree path if exists, empty if not)
     - Research/Integrator: empty (line removed)
   - `{SKILL_INVOCATION}` -> `Skill(skill="ralph-hero:{SKILL_NAME}", args="{ISSUE_NUMBER}")` from spawn table Skill column. For integrator (no skill): `Check your task subject to determine the operation (Create PR or Merge PR).\nFollow the corresponding procedure in your agent definition.`
   - `{REPORT_FORMAT}` -> role-specific result format from conventions.md "Result Format Contracts"
   - `{ESTIMATE}` -> issue estimate (only used within `{TASK_CONTEXT}` for triage/split)
   - `{GROUP_CONTEXT}` -> group line if IS_GROUP, empty if not (only used within `{TASK_CONTEXT}` for plan/review)
   - `{WORKTREE_CONTEXT}` -> worktree path if exists, empty if not (only used within `{TASK_CONTEXT}` for implement)
```

**d) Remove "Template Integrity" subsection references to resolved prompts "5-8 lines"** -- the subsection at lines 223-235 stays but the line-count reference should say "6-8 lines" to match the unified template resolved output.

#### 3. Update conventions.md Spawn Template Protocol
**File**: [`plugin/ralph-hero/skills/shared/conventions.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md)
**Changes**:

**a) Template Location** (lines 138-150). Replace:
```markdown
### Template Location

Spawn templates live at: `${CLAUDE_PLUGIN_ROOT}/templates/spawn/{role}.md`

To resolve the path at runtime, use Bash to expand the variable first:
```
TEMPLATE_DIR=$(echo $CLAUDE_PLUGIN_ROOT)/templates/spawn
```
Then read templates via `Read(file_path="[resolved-path]/researcher.md")`.

Available templates: `triager`, `splitter`, `researcher`, `planner`, `reviewer`, `implementer`, `integrator`
```
With:
```markdown
### Template Location

A single spawn template lives at: `${CLAUDE_PLUGIN_ROOT}/templates/spawn/worker.md`

To resolve the path at runtime, use Bash to expand the variable first:
```
TEMPLATE_PATH=$(echo $CLAUDE_PLUGIN_ROOT)/templates/spawn/worker.md
```
Then read via `Read(file_path="[resolved-path]")`.

All roles use this template. Role-specific behavior is driven by placeholder substitution from the spawn table in SKILL.md Section 6.
```

**b) Placeholder Substitution table** (lines 153-161). Replace current 5-row table with expanded table:

```markdown
### Placeholder Substitution

| Placeholder | Source | Required |
|-------------|--------|----------|
| `{ISSUE_NUMBER}` | Issue number from GitHub | Always |
| `{TITLE}` | Issue title from `get_issue` | Always |
| `{TASK_VERB}` | Spawn table "Task Verb" column | Always |
| `{TASK_CONTEXT}` | Role-dependent (see SKILL.md Section 6) | Optional (empty -> line removed) |
| `{SKILL_INVOCATION}` | Spawn table "Skill" column (integrator uses special instruction) | Always |
| `{REPORT_FORMAT}` | Result Format Contracts below | Always |
```

**c) Group Context Resolution** (lines 162-184). Keep as-is -- `{GROUP_CONTEXT}` is still used as an input to `{TASK_CONTEXT}` for plan/review roles. Same for Worktree Context Resolution.

**d) Template Naming Convention** (lines 215-227). Replace role-to-template mapping table with:
```markdown
### Template Naming Convention

All roles use the single `worker.md` template. Role selection is driven by the task subject keyword, mapped through the spawn table in SKILL.md Section 6. The template file itself is role-agnostic.
```

**e) Resolution Procedure** (lines 206-213). Update step 1:
```markdown
### Resolution Procedure (for orchestrator)

1. Read the template: `Read(file_path="[resolved-root]/templates/spawn/worker.md")`
2. Look up the role in SKILL.md Section 6 spawn table using the task subject keyword
3. Substitute all `{PLACEHOLDER}` strings with values from `get_issue` response and spawn table
4. If a placeholder resolves to an empty string, remove the ENTIRE LINE containing it
5. Use the result as the `prompt` parameter in `Task()`
```

**f) Template Authoring Rules** (lines 229-234). Update to reference single template:
```markdown
### Template Authoring Rules

- The single `worker.md` template MUST be under 10 lines (raw, before substitution)
- Resolved prompts MUST be under 10 lines for every role
- DO NOT include: conversation history, document contents, code snippets, assignment instructions
- Teammates message the lead using `recipient="team-lead"` exactly
- Result reporting follows conventions.md Result Format Contracts (via `{REPORT_FORMAT}`)
```

**g) Template Integrity** (lines 236-248). Update the line-count guardrail:
```markdown
**Line-count guardrail**: A correctly resolved prompt is 6-8 lines. If the prompt exceeds 10 lines, the orchestrator has violated template integrity by adding prohibited context.
```

#### 4. Delete old templates
**Files to delete** (7 files):
- `plugin/ralph-hero/templates/spawn/researcher.md`
- `plugin/ralph-hero/templates/spawn/planner.md`
- `plugin/ralph-hero/templates/spawn/implementer.md`
- `plugin/ralph-hero/templates/spawn/integrator.md`
- `plugin/ralph-hero/templates/spawn/splitter.md`
- `plugin/ralph-hero/templates/spawn/triager.md`
- `plugin/ralph-hero/templates/spawn/reviewer.md`

### Success Criteria
- [x] Automated: `ls plugin/ralph-hero/templates/spawn/` shows only `worker.md`
- [x] Automated: `grep -r "researcher.md\|planner.md\|implementer.md\|integrator.md\|splitter.md\|triager.md\|reviewer.md" plugin/ralph-hero/skills/` returns no matches (no stale references)
- [x] Manual: Resolve the template for each of the 8 roles (triage, split, research, plan, review, implement, create-pr, merge) and verify each is 6-8 lines
- [x] Manual: SKILL.md Section 6 spawn table has Skill and Task Verb columns, no Template column
- [x] Manual: conventions.md references single `worker.md`, not 7 role-specific templates

---

## Integration Testing
- [x] Verify no references to old template filenames in `skills/ralph-team/SKILL.md`
- [x] Verify no references to old template filenames in `skills/shared/conventions.md`
- [x] Verify `worker.md` placeholder set matches what SKILL.md Section 6 documents
- [x] Verify the Result Format Contracts in conventions.md (lines 344-435) are unchanged (this plan does not modify them)
- [x] Verify the empty-line-removal rule in conventions.md still applies

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0255-consolidate-spawn-templates.md
- Parent research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0230-ralph-team-worker-redesign.md
- Design document: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-20-ralph-team-worker-redesign.md
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/230
- Related issues: https://github.com/cdubiel08/ralph-hero/issues/256 (Phase 2: typed agents), https://github.com/cdubiel08/ralph-hero/issues/257 (Phase 3: bough model), https://github.com/cdubiel08/ralph-hero/issues/258 (Phase 4: conventions cleanup)
