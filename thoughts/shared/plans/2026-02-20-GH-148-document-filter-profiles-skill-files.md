---
date: 2026-02-20
status: draft
github_issues: [148]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/148
primary_issue: 148
---

# Document Filter Profiles in Agent Skill Files - Implementation Plan

## Overview
1 issue for implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-148 | Document filter profiles in agent skill files | XS |

## Current State Analysis
Six skill files call `ralph_hero__list_issues` with hard-coded inline filter parameters. Sibling issues #147 (filter profile registry) and #149 (`profile` param on list tools) will enable agents to use named profiles instead. This issue updates the skill documentation to reference profiles alongside existing inline params.

Research document: [GH-0148 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0148-document-filter-profiles-agent-skill-files.md)

## Desired End State
### Verification
- [ ] ralph-triage SKILL.md references `analyst-triage` profile in primary `list_issues` calls
- [ ] ralph-research SKILL.md references `analyst-research` profile
- [ ] ralph-plan SKILL.md references `builder-planned` profile
- [ ] ralph-impl SKILL.md references `builder-active` profile
- [ ] ralph-review SKILL.md references `validator-review` profile
- [ ] ralph-split SKILL.md has note explaining no matching profile
- [ ] Each updated skill shows profile param with inline params as comments
- [ ] Each updated skill has a role-specific "Available Filter Profiles" table

## What We're NOT Doing
- Modifying any TypeScript code (that's #147 and #149)
- Changing skill behavior or hooks
- Adding profiles for skills that don't call `list_issues` (ralph-status, ralph-hero, ralph-team, ralph-report, ralph-setup)
- Creating new profile definitions (that's #147)

## Implementation Approach
Single phase: update 6 SKILL.md files with profile references and tables. Each change follows the same pattern -- add `profile` param to `list_issues` examples and add a profile reference table.

---

## Phase 1: GH-148 - Document Filter Profiles in Skill Files
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/148 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0148-document-filter-profiles-agent-skill-files.md

### Changes Required

#### 1. Update `ralph-triage/SKILL.md`
**File**: `plugin/ralph-hero/skills/ralph-triage/SKILL.md`

**Change A** (lines 66-72): Update Query 1 (triaged issues) to show profile:
```
ralph_hero__list_issues
- profile: "analyst-triage"
- label: "ralph-triage"
# Profile expands to: workflowState: "Backlog"
# Explicit label param composes with profile defaults
- limit: 250
```

**Change B** (lines 75-83): Update Query 2 (all Backlog) to show profile:
```
ralph_hero__list_issues
- profile: "analyst-triage"
# Profile expands to: workflowState: "Backlog"
- orderBy: "createdAt"
- limit: 250
```

**Change C** (lines 251-265): Update Step 5 related issue queries to show profile alternatives:
```
ralph_hero__list_issues
- profile: "analyst-triage"
# Profile expands to: workflowState: "Backlog"
- limit: 50
```
And for Research Needed query:
```
ralph_hero__list_issues
- profile: "analyst-research"
# Profile expands to: workflowState: "Research Needed"
- limit: 50
```

**Change D**: Add "Available Filter Profiles" section before `## Constraints` (line 424):
```markdown
## Available Filter Profiles

| Profile | Expands To | Use Case |
|---------|-----------|----------|
| `analyst-triage` | `workflowState: "Backlog"` | Find untriaged backlog items |
| `analyst-research` | `workflowState: "Research Needed"` | Find items needing research |

Profiles set default filters. Explicit params (e.g., `label`) override or compose with profile defaults.
```

#### 2. Update `ralph-research/SKILL.md`
**File**: `plugin/ralph-hero/skills/ralph-research/SKILL.md`

**Change A** (line 47): Update Step 1 query:
```
ralph_hero__list_issues
- profile: "analyst-research"
# Profile expands to: workflowState: "Research Needed"
- limit: 50
```

**Change B**: Add "Available Filter Profiles" section before `## Constraints` (line 167):
```markdown
## Available Filter Profiles

| Profile | Expands To | Use Case |
|---------|-----------|----------|
| `analyst-research` | `workflowState: "Research Needed"` | Find items needing research |

Profiles set default filters. Explicit params override profile defaults.
```

#### 3. Update `ralph-plan/SKILL.md`
**File**: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`

**Change A** (line 85): Update Step 1b query:
```
ralph_hero__list_issues
- profile: "builder-planned"
# Profile expands to: workflowState: "Ready for Plan"
- limit: 50
```

**Change B**: Add "Available Filter Profiles" section before `## Constraints` (line 249):
```markdown
## Available Filter Profiles

| Profile | Expands To | Use Case |
|---------|-----------|----------|
| `builder-planned` | `workflowState: "Ready for Plan"` | Find issues ready for planning |

Profiles set default filters. Explicit params override profile defaults.
```

#### 4. Update `ralph-impl/SKILL.md`
**File**: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`

**Change A** (lines 51-58): Update Step 1 query:
```
ralph_hero__list_issues
- profile: "builder-active"
# Profile expands to: workflowState: "In Progress"
- orderBy: "priority"
- limit: 1
```

**Change B**: Add "Available Filter Profiles" section before `## Resumption Behavior` (line 332):
```markdown
## Available Filter Profiles

| Profile | Expands To | Use Case |
|---------|-----------|----------|
| `builder-active` | `workflowState: "In Progress"` | Find active implementation work |

Profiles set default filters. Explicit params override profile defaults.
```

#### 5. Update `ralph-review/SKILL.md`
**File**: `plugin/ralph-hero/skills/ralph-review/SKILL.md`

**Change A** (lines 65-72): Update Step 1 query:
```
ralph_hero__list_issues
- profile: "validator-review"
# Profile expands to: workflowState: "Plan in Review"
- orderBy: "priority"
- limit: 1
```

**Change B**: Add "Available Filter Profiles" section before `## Constraints` (line 388):
```markdown
## Available Filter Profiles

| Profile | Expands To | Use Case |
|---------|-----------|----------|
| `validator-review` | `workflowState: "Plan in Review"` | Find plans awaiting review |

Profiles set default filters. Explicit params override profile defaults.
```

#### 6. Update `ralph-split/SKILL.md`
**File**: `plugin/ralph-hero/skills/ralph-split/SKILL.md`

**Change A** (lines 55-73): Add a comment above the existing `list_issues` calls:
```
# Note: No filter profile for split candidate selection.
# Split uses multi-query pattern across estimates (M, L, XL) and workflow states.
ralph_hero__list_issues
- workflowState: "Backlog"
- estimate: "M"
- limit: 50
```

No profile table needed since split has no matching profile.

### Success Criteria
- [ ] Automated: `grep -l "profile:" plugin/ralph-hero/skills/*/SKILL.md | wc -l` returns 5 (all except ralph-split)
- [ ] Automated: `grep -l "Available Filter Profiles" plugin/ralph-hero/skills/*/SKILL.md | wc -l` returns 5
- [ ] Automated: `grep "No filter profile" plugin/ralph-hero/skills/ralph-split/SKILL.md` returns match
- [ ] Manual: Each profile reference shows correct expansion comment
- [ ] Manual: No skill hook or frontmatter changes

---

## Integration Testing
- [ ] Verify no YAML frontmatter changes (skills still parse correctly)
- [ ] Verify all profile names match the registry defined in #147

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0148-document-filter-profiles-agent-skill-files.md
- Parent: https://github.com/cdubiel08/ralph-hero/issues/109
- Registry definition: https://github.com/cdubiel08/ralph-hero/issues/147
- Tool wiring: https://github.com/cdubiel08/ralph-hero/issues/149
