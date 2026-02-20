---
date: 2026-02-19
status: draft
github_issues: [134, 135, 136, 137]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/134
  - https://github.com/cdubiel08/ralph-hero/issues/135
  - https://github.com/cdubiel08/ralph-hero/issues/136
  - https://github.com/cdubiel08/ralph-hero/issues/137
primary_issue: 134
---

# Migrate ralph-team from Custom Agent Types to General-Purpose Subagents - Atomic Implementation Plan

## Overview

4 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-134 | Update ralph-team SKILL.md spawn table to use general-purpose subagent type | XS |
| 2 | GH-135 | Update spawn templates to be self-contained for general-purpose agents | S |
| 3 | GH-136 | Update conventions.md handoff protocol for general-purpose agent types | XS |
| 4 | GH-137 | Update ralph-team SKILL.md Section 9 to remove custom agent tool restriction docs | XS |

**Why grouped**: All four issues decompose parent [#133](https://github.com/cdubiel08/ralph-hero/issues/133) -- migrating ralph-team from custom agent types (`ralph-analyst`, `ralph-builder`, `ralph-validator`, `ralph-integrator`) to `general-purpose` subagents. Phase 1 is the foundation change (spawn table); Phases 2-4 update dependent documentation (templates, conventions, known limitations) to match. They must ship together for consistency.

## Current State Analysis

The ralph-team orchestrator currently uses four custom agent types for spawning workers. These custom types carry scoped tool restrictions via agent frontmatter and provide result format contracts via agent definition files. The ralph-hero orchestrator already uses `general-purpose` for all spawns, matching the Bowser reference architecture (GH-132). This group aligns ralph-team to the same pattern.

Key files in current state:
- [`plugin/ralph-hero/skills/ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md) -- Section 6 spawn table uses custom agent types (lines 170-177), spawn call example uses `[agent-type]` placeholder (line 193), Section 9 documents tool restrictions (line 258)
- [`plugin/ralph-hero/templates/spawn/`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/) -- 7 templates reference "your agent definition" for result reporting
- [`plugin/ralph-hero/skills/shared/conventions.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md) -- Pipeline Handoff Protocol uses `agentType` for peer discovery (lines 97-103), Template Naming Convention maps agent types to templates (lines 219-227), Skill Invocation Convention has a "Team Agents" exception (lines 268-276)

## Desired End State

After implementation:
- All worker spawns use `subagent_type="general-purpose"` instead of custom agent types
- Spawn templates are self-contained with inline result format contracts (no references to "agent definition")
- Peer discovery uses worker `name` instead of `agentType`
- Obsolete tool restriction documentation is removed
- Integrator template remains as a deferred exception (still uses `ralph-integrator` custom agent type until a `ralph-integrate` skill is created)

### Verification
- [ ] All 8 spawn table rows in SKILL.md Section 6 show `general-purpose` in the "Agent type" column
- [ ] Spawn call example (SKILL.md line 193) uses literal `"general-purpose"` instead of `[agent-type]`
- [ ] 6 non-integrator templates have inline result format contracts replacing "per your agent definition"
- [ ] Integrator template is unchanged (deferred exception)
- [ ] conventions.md Pipeline Handoff table uses `name` instead of `agentType`
- [ ] conventions.md Template Naming Convention uses role-based naming instead of agent-type-based
- [ ] conventions.md Skill Invocation "Team Agents" exception is simplified
- [ ] SKILL.md Section 9 "Teammate GitHub access" bullet (line 258) is removed
- [ ] All templates remain under 15 lines

## What We're NOT Doing

- **Not creating a `ralph-integrate` skill** -- the integrator template remains as a `ralph-integrator` custom agent type exception until a future issue addresses this
- **Not adding `allowed_tools` to skill frontmatter** -- that is GH-132's scope (separate plan)
- **Not modifying agent definition files** -- the custom agent `.md` files will remain for now; their deprecation is a separate concern
- **Not changing hook scripts** -- hooks already use `teammate_name`, not `agentType`
- **Not restructuring the handoff protocol** -- minimal text changes only, preserving existing document structure

## Implementation Approach

Phase 1 establishes the foundation by changing the spawn table and spawn call example in SKILL.md. Phases 2-4 are independent of each other (they touch different files) but all depend on Phase 1's conceptual change. The ordering is: spawn table first, then templates + conventions + Section 9 cleanup in parallel.

All changes are markdown documentation updates -- no TypeScript, no code, no tests. Verification is visual inspection of the changed files.

---

## Phase 1: GH-134 -- Update ralph-team SKILL.md Spawn Table
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/134 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0134-spawn-table-general-purpose-subagent.md | **Depends on**: none

### Changes Required

#### 1. Update spawn table "Agent type" column values
**File**: [`plugin/ralph-hero/skills/ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md)
**Lines**: 170-177

Replace all 8 custom agent type values with `general-purpose`:

**Before**:
```markdown
   | "Triage" | analyst | `triager.md` | ralph-analyst |
   | "Split" | analyst | `splitter.md` | ralph-analyst |
   | "Research" | analyst | `researcher.md` | ralph-analyst |
   | "Plan" (not "Review") | builder | `planner.md` | ralph-builder |
   | "Review" | validator | `reviewer.md` | ralph-validator |
   | "Implement" | builder | `implementer.md` | ralph-builder |
   | "Create PR" | integrator | `integrator.md` | ralph-integrator |
   | "Merge" or "Integrate" | integrator | `integrator.md` | ralph-integrator |
```

**After**:
```markdown
   | "Triage" | analyst | `triager.md` | general-purpose |
   | "Split" | analyst | `splitter.md` | general-purpose |
   | "Research" | analyst | `researcher.md` | general-purpose |
   | "Plan" (not "Review") | builder | `planner.md` | general-purpose |
   | "Review" | validator | `reviewer.md` | general-purpose |
   | "Implement" | builder | `implementer.md` | general-purpose |
   | "Create PR" | integrator | `integrator.md` | general-purpose |
   | "Merge" or "Integrate" | integrator | `integrator.md` | general-purpose |
```

Keep the "Agent type" column header -- it serves as documentation even when all values are identical (prevents future contributors from wondering what subagent type to use).

#### 2. Update spawn call example to use literal "general-purpose"
**File**: [`plugin/ralph-hero/skills/ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md)
**Lines**: 191-196

**Before**:
```markdown
4. **Spawn**:
   ```
   Task(subagent_type="[agent-type]", team_name=TEAM_NAME, name="[role]",
        prompt=[resolved template content],
        description="[Role] GH-NNN")
   ```
```

**After**:
```markdown
4. **Spawn**:
   ```
   Task(subagent_type="general-purpose", team_name=TEAM_NAME, name="[role]",
        prompt=[resolved template content],
        description="[Role] GH-NNN")
   ```
```

### Success Criteria
- [x] Automated: `grep -c 'ralph-analyst\|ralph-builder\|ralph-validator\|ralph-integrator' plugin/ralph-hero/skills/ralph-team/SKILL.md` returns 0 (no custom agent types remain in the file)
- [x] Manual: Spawn table retains "Agent type" column header with all rows showing `general-purpose`

**Creates for next phases**: The conceptual foundation -- all spawns are now `general-purpose`, which makes Phases 2-4 necessary (templates, conventions, and Section 9 must align).

---

## Phase 2: GH-135 -- Update Spawn Templates to Be Self-Contained
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/135 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0135-spawn-templates-self-contained-general-purpose.md | **Depends on**: Phase 1 (GH-134)

### Changes Required

Update 6 of 7 spawn templates to replace "Report results per your agent definition" with inline compact result format contracts. The integrator template is a **deferred exception** -- it remains unchanged.

#### 1. Update `triager.md`
**File**: [`plugin/ralph-hero/templates/spawn/triager.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/triager.md)

**Before**:
```
Triage GH-{ISSUE_NUMBER}: {TITLE}.
Estimate: {ESTIMATE}.

Invoke: Skill(skill="ralph-hero:ralph-triage", args="{ISSUE_NUMBER}")

Report results per your agent definition.
Then check TaskList for more triage tasks.
```

**After**:
```
Triage GH-{ISSUE_NUMBER}: {TITLE}.
Estimate: {ESTIMATE}.

Invoke: Skill(skill="ralph-hero:ralph-triage", args="{ISSUE_NUMBER}")

Report via TaskUpdate: "TRIAGE COMPLETE: #{ISSUE_NUMBER}\nAction: [CLOSE/SPLIT/RESEARCH/KEEP]\n[If SPLIT]: Sub-tickets: #AAA, #BBB\nEstimates: #AAA (XS), #BBB (S)"
Then check TaskList for more triage tasks.
```

#### 2. Update `splitter.md`
**File**: [`plugin/ralph-hero/templates/spawn/splitter.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/splitter.md)

**Before**:
```
Split GH-{ISSUE_NUMBER}: {TITLE}.
Too large for direct implementation (estimate: {ESTIMATE}).

Invoke: Skill(skill="ralph-hero:ralph-split", args="{ISSUE_NUMBER}")

Report results per your agent definition.
Then check TaskList for more split tasks.
```

**After**:
```
Split GH-{ISSUE_NUMBER}: {TITLE}.
Too large for direct implementation (estimate: {ESTIMATE}).

Invoke: Skill(skill="ralph-hero:ralph-split", args="{ISSUE_NUMBER}")

Report via TaskUpdate: "SPLIT COMPLETE: #{ISSUE_NUMBER}\nSub-tickets: #AAA, #BBB, #CCC\nEstimates: #AAA (XS), #BBB (S), #CCC (XS)"
Then check TaskList for more split tasks.
```

#### 3. Update `researcher.md`
**File**: [`plugin/ralph-hero/templates/spawn/researcher.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/researcher.md)

**Before**:
```
Research GH-{ISSUE_NUMBER}: {TITLE}.

Invoke: Skill(skill="ralph-hero:ralph-research", args="{ISSUE_NUMBER}")

Report results per your agent definition.
Then check TaskList for more research tasks. If none, hand off per shared/conventions.md.
```

**After**:
```
Research GH-{ISSUE_NUMBER}: {TITLE}.

Invoke: Skill(skill="ralph-hero:ralph-research", args="{ISSUE_NUMBER}")

Report via TaskUpdate: "RESEARCH COMPLETE: #{ISSUE_NUMBER} - {TITLE}\nDocument: [path]\nKey findings: [summary]\nTicket moved to: Ready for Plan"
Then check TaskList for more research tasks. If none, hand off per shared/conventions.md.
```

#### 4. Update `planner.md`
**File**: [`plugin/ralph-hero/templates/spawn/planner.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/planner.md)

**Before**:
```
Plan GH-{ISSUE_NUMBER}: {TITLE}.
{GROUP_CONTEXT}

Invoke: Skill(skill="ralph-hero:ralph-plan", args="{ISSUE_NUMBER}")

Report results per your agent definition.
Then check TaskList for more plan tasks. If none, hand off per shared/conventions.md.
```

**After**:
```
Plan GH-{ISSUE_NUMBER}: {TITLE}.
{GROUP_CONTEXT}

Invoke: Skill(skill="ralph-hero:ralph-plan", args="{ISSUE_NUMBER}")

Report via TaskUpdate: "PLAN COMPLETE: [ticket/group]\nPlan: [path]\nPhases: [N]\nFile ownership: [groups]\nReady for review."
Then check TaskList for more plan tasks. If none, hand off per shared/conventions.md.
```

#### 5. Update `reviewer.md`
**File**: [`plugin/ralph-hero/templates/spawn/reviewer.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/reviewer.md)

**Before**:
```
Review plan for GH-{ISSUE_NUMBER}: {TITLE}.
{GROUP_CONTEXT}

Invoke: Skill(skill="ralph-hero:ralph-review", args="{ISSUE_NUMBER}")

Report results per your agent definition.
Then check TaskList for more review tasks. If none, hand off per shared/conventions.md.
```

**After**:
```
Review plan for GH-{ISSUE_NUMBER}: {TITLE}.
{GROUP_CONTEXT}

Invoke: Skill(skill="ralph-hero:ralph-review", args="{ISSUE_NUMBER}")

Report via TaskUpdate: "VALIDATION VERDICT\nTicket: #{ISSUE_NUMBER}\nPlan: [path]\nVERDICT: [APPROVED/NEEDS_ITERATION]\n[findings]"
Then check TaskList for more review tasks. If none, hand off per shared/conventions.md.
```

#### 6. Update `implementer.md`
**File**: [`plugin/ralph-hero/templates/spawn/implementer.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/implementer.md)

**Before**:
```
Implement GH-{ISSUE_NUMBER}: {TITLE}.
{WORKTREE_CONTEXT}

Invoke: Skill(skill="ralph-hero:ralph-impl", args="{ISSUE_NUMBER}")

Report results per your agent definition.
DO NOT push to remote. The integrator handles pushing and PR creation.
Then check TaskList for more implementation tasks. If none, notify team-lead.
```

**After**:
```
Implement GH-{ISSUE_NUMBER}: {TITLE}.
{WORKTREE_CONTEXT}

Invoke: Skill(skill="ralph-hero:ralph-impl", args="{ISSUE_NUMBER}")

Report via TaskUpdate: "IMPLEMENTATION COMPLETE\nTicket: #{ISSUE_NUMBER}\nFiles: [list]\nTests: [PASSING/FAILING]\nCommit: [hash]\nWorktree: [path]"
DO NOT push to remote. The integrator handles pushing and PR creation.
Then check TaskList for more implementation tasks. If none, notify team-lead.
```

#### 7. `integrator.md` -- DEFERRED (no change)
**File**: [`plugin/ralph-hero/templates/spawn/integrator.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/integrator.md)

The integrator template is the only template that does NOT invoke a skill via `Skill()`. It follows procedures defined in the `ralph-integrator.md` agent definition. Making it self-contained requires either creating a new `ralph-integrate` skill or inlining 15+ lines of procedure, both of which exceed this issue's scope. The integrator remains as a `ralph-integrator` custom agent type exception.

### Success Criteria
- [ ] Automated: `grep -c 'per your agent definition' plugin/ralph-hero/templates/spawn/*.md` returns 0 for all non-integrator templates
- [ ] Automated: `wc -l plugin/ralph-hero/templates/spawn/*.md` shows all templates under 15 lines
- [ ] Manual: Each template contains an inline `Report via TaskUpdate:` line with the expected format string
- [ ] Manual: `integrator.md` is unchanged

**Creates for next phases**: Independent -- does not create dependencies for Phases 3 or 4.

---

## Phase 3: GH-136 -- Update conventions.md Handoff Protocol
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/136 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0136-conventions-handoff-protocol-general-purpose-agents.md | **Depends on**: Phase 1 (GH-134)

### Changes Required

Three sections of `conventions.md` need updating:

#### 1. Pipeline Handoff Protocol -- Replace `agentType` with `name`
**File**: [`plugin/ralph-hero/skills/shared/conventions.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md)
**Lines**: 97-111

**Before (Pipeline Order table, lines 97-103)**:
```markdown
| Current Role (agentType) | Next Stage | agentType to find |
|---|---|---|
| `ralph-analyst` | Builder | `ralph-builder` |
| `ralph-builder` (plan done) | Validator | `ralph-validator` (if `RALPH_REVIEW_MODE=interactive`) |
| `ralph-builder` (impl done) | Integrator (PR creation) | `ralph-integrator` |
| `ralph-validator` (approved) | Builder | `ralph-builder` |
| `ralph-validator` (rejected) | Builder (re-plan) | `ralph-builder` |
```

**After**:
```markdown
| Current Worker (name) | Next Stage | Worker name to find |
|---|---|---|
| `analyst` | Builder | `builder` |
| `builder` (plan done) | Validator | `validator` (if `RALPH_REVIEW_MODE=interactive`) |
| `builder` (impl done) | Integrator (PR creation) | `integrator` |
| `validator` (approved) | Builder | `builder` |
| `validator` (rejected) | Builder (re-plan) | `builder` |
```

**Before (Handoff Procedure step 3, line 111)**:
```markdown
   - Find the member whose `agentType` matches your "Next Stage" from the table above
```

**After**:
```markdown
   - Find the member whose `name` matches your "Next Stage" from the table above
```

#### 2. Template Naming Convention -- Replace agent type with role
**File**: [`plugin/ralph-hero/skills/shared/conventions.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md)
**Lines**: 217-227

**Before**:
```markdown
Templates are named by role: `{role}.md` matching the agent type:

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

**After**:
```markdown
Templates are named by role, selected via task subject keyword:

| Role (task subject) | Template |
|---------------------|----------|
| Analyst (triage) | `triager.md` |
| Analyst (split) | `splitter.md` |
| Analyst (research) | `researcher.md` |
| Builder (plan) | `planner.md` |
| Builder (implement) | `implementer.md` |
| Validator (review) | `reviewer.md` |
| Integrator (create PR / merge) | `integrator.md` |
```

#### 3. Skill Invocation Convention -- Simplify "Team Agents" exception
**File**: [`plugin/ralph-hero/skills/shared/conventions.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md)
**Lines**: 268-276

**Before**:
```markdown
### Exception: Team Agents

When agents are spawned as team members, the agent IS the subprocess. The agent invokes the skill inline:

```
Skill(skill="ralph-hero:ralph-research", args="42")
```

This is acceptable because the agent already has its own isolated context window via the team system.
```

**After**:
```markdown
### Note: Team Agents

Team members are spawned as `general-purpose` subagents via `Task()`, so they follow the same isolation pattern as the default. Each team member invokes its skill inline:

```
Skill(skill="ralph-hero:ralph-research", args="42")
```

This works because the team system provides isolated context windows, identical to `Task()` subprocesses.
```

#### 4. Template Authoring Rules -- Update result reporting reference
**File**: [`plugin/ralph-hero/skills/shared/conventions.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md)
**Line**: 234

**Before**:
```markdown
- Result reporting follows the agent's `.md` definition, not the spawn template
```

**After**:
```markdown
- Result reporting follows the inline format in the spawn template (via `TaskUpdate`)
```

### Success Criteria
- [ ] Automated: `grep -c 'agentType' plugin/ralph-hero/skills/shared/conventions.md` returns 0
- [ ] Automated: `grep -c 'ralph-analyst\|ralph-builder\|ralph-validator\|ralph-integrator' plugin/ralph-hero/skills/shared/conventions.md` returns 0
- [ ] Manual: Pipeline Handoff table uses worker `name` values (`analyst`, `builder`, `validator`, `integrator`)
- [ ] Manual: Template Naming Convention uses role-based descriptions instead of agent type references

**Creates for next phases**: Independent -- does not create dependencies for Phase 4.

---

## Phase 4: GH-137 -- Remove Custom Agent Tool Restriction Docs from Section 9
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/137 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0137-section-9-custom-agent-tool-restriction-docs.md | **Depends on**: Phase 1 (GH-134)

### Changes Required

#### 1. Delete the "Teammate GitHub access" bullet
**File**: [`plugin/ralph-hero/skills/ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md)
**Line**: 258

**Delete this line entirely**:
```markdown
- **Teammate GitHub access**: All 4 workers have scoped `ralph_hero__*` MCP tool access in their frontmatter. `Skill()` runs inline and inherits the calling agent's tool restrictions, so these tools MUST remain in agent frontmatter even when accessed indirectly through skills. Analyst has the widest set (14 tools); validator has the narrowest (5 tools).
```

No replacement text is needed -- full tool access is expected behavior for `general-purpose` agents, not a "limitation."

### Success Criteria
- [ ] Automated: `grep -c 'scoped.*ralph_hero' plugin/ralph-hero/skills/ralph-team/SKILL.md` returns 0
- [ ] Automated: `grep -c 'Teammate GitHub access' plugin/ralph-hero/skills/ralph-team/SKILL.md` returns 0
- [ ] Manual: Section 9 has 11 bullet points (was 12), all remaining bullets are agent-type-agnostic

**Creates for next phases**: Final phase -- no further dependencies.

---

## Integration Testing

- [ ] Read `plugin/ralph-hero/skills/ralph-team/SKILL.md` end-to-end and confirm no references to custom agent types (`ralph-analyst`, `ralph-builder`, `ralph-validator`, `ralph-integrator`) remain anywhere in the file
- [ ] Read all 7 templates in `plugin/ralph-hero/templates/spawn/` and confirm: (a) 6 non-integrator templates have inline `Report via TaskUpdate:` lines, (b) integrator template is unchanged, (c) all templates are under 15 lines
- [ ] Read `plugin/ralph-hero/skills/shared/conventions.md` and confirm no `agentType` references remain
- [ ] Verify that `conventions.md` Pipeline Handoff, Template Naming, and Skill Invocation sections are internally consistent with the new `general-purpose` model

## References

- Research: [GH-134](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0134-spawn-table-general-purpose-subagent.md), [GH-135](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0135-spawn-templates-self-contained-general-purpose.md), [GH-136](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0136-conventions-handoff-protocol-general-purpose-agents.md), [GH-137](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0137-section-9-custom-agent-tool-restriction-docs.md)
- Parent issue: [#133](https://github.com/cdubiel08/ralph-hero/issues/133) -- ralph-team should dispatch via general-purpose subagents
- Bowser reference: [GH-132 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-19-GH-0132-agent-skill-patterns-bowser-reference.md)
- Related plan: [GH-132 plan](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-19-GH-0132-agent-skill-invocation-patterns.md) (allowed_tools + result format contracts -- separate scope)
