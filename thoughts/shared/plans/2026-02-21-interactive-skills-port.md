---
date: 2026-02-21
status: draft
github_issues: []
---

# Interactive Skills Port - Implementation Plan

## Overview

Port 6 interactive, human-collaborative skills into the ralph-hero plugin. These are "higher order" skills that run inline in the user's session, ask questions, and orchestrate the `ralph_hero__*` MCP tools. They sit above the autonomous `ralph-*` skills in the workflow hierarchy.

## Current State Analysis

- Workspace-level interactive commands exist at `~/projects/.claude/commands/` (create_plan, implement_plan, iterate_plan, research_codebase, draft_idea, form_idea)
- These use Linear MCP tools (`mcp__plugin_linear_linear__*`) and Linear ticket IDs (`LAN-NNN`)
- The ralph-hero plugin has autonomous skills at `plugin/ralph-hero/skills/ralph-*/SKILL.md`
- The plugin uses GitHub Projects V2 via `ralph_hero__*` MCP tools and `GH-NNNN` naming
- No interactive skills exist in the plugin yet

## Desired End State

6 new skill directories in `plugin/ralph-hero/skills/`:
```
skills/
  create-plan/SKILL.md       -> /ralph-hero:create-plan
  implement-plan/SKILL.md    -> /ralph-hero:implement-plan
  iterate-plan/SKILL.md      -> /ralph-hero:iterate-plan
  research-codebase/SKILL.md -> /ralph-hero:research-codebase
  draft-idea/SKILL.md        -> /ralph-hero:draft-idea
  form-idea/SKILL.md         -> /ralph-hero:form-idea
```

### Verification
- [ ] All 6 skills appear in Claude Code's `/` autocomplete as `/ralph-hero:<name>`
- [ ] Each skill runs inline (no fork) and maintains interactive conversation
- [ ] GitHub tools work: `ralph_hero__create_issue`, `ralph_hero__get_issue`, `ralph_hero__update_workflow_state`, `ralph_hero__create_comment`
- [ ] Artifact Comment Protocol is followed for research docs and plan docs
- [ ] File naming uses `GH-NNNN` pattern
- [ ] Link formatting uses `$RALPH_GH_OWNER/$RALPH_GH_REPO`

### Key Discoveries:
- Autonomous skills use `context: fork` - interactive skills must NOT use this (need inline conversation)
- Autonomous skills declare `RALPH_COMMAND` env for hook-based state gates - interactive skills skip this
- Autonomous skills have PreToolUse/PostToolUse/Stop hooks - interactive skills use minimal or no hooks
- The `allowed_tools` frontmatter restricts what a skill can access - interactive skills need broader access
- Artifact Comment Protocol (`## Research Document`, `## Implementation Plan` headers) is the standard for linking docs to issues

## What We're NOT Doing

- Not modifying existing autonomous skills
- Not adding state gate hooks (interactive = human-guided)
- Not adding postcondition hooks
- Not creating new hook scripts
- Not modifying the MCP server or its tools
- Not creating agent definitions for these (they're user-invoked only)

## Implementation Approach

Adapt each workspace command's core workflow to use GitHub instead of Linear while preserving the interactive, collaborative nature. Each skill shares a common frontmatter pattern:

```yaml
---
description: [user-facing description]
argument-hint: [optional args]
model: opus
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - WebSearch
  - WebFetch
env:
  RALPH_GH_OWNER: "${RALPH_GH_OWNER}"
  RALPH_GH_REPO: "${RALPH_GH_REPO}"
  RALPH_GH_PROJECT_NUMBER: "${RALPH_GH_PROJECT_NUMBER}"
---
```

Key adaptations applied to ALL skills:
1. `mcp__plugin_linear_linear__*` -> `ralph_hero__*` tool calls
2. `LAN-NNN` -> `#NNN` issue references, `GH-NNNN` file naming
3. `linear_ticket` frontmatter -> `github_issue` / `github_issues`
4. `linear_url` -> `github_url` with `https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN`
5. Linear state names -> GitHub Projects V2 workflow states (same names, different backend)
6. Link formatting per shared/conventions.md
7. Artifact Comment Protocol for linking docs to issues
8. Reference to shared/conventions.md for escalation and link formatting
9. Sub-agent Team Isolation reminder where applicable

## Phase 1: Create Interactive Skills

### 1. `skills/draft-idea/SKILL.md`

**Source**: `~/projects/.claude/commands/draft_idea.md`
**Adaptations**:
- Model: sonnet (speed over depth for quick capture)
- Save to `thoughts/shared/ideas/YYYY-MM-DD-description.md`
- No GitHub integration (ideas are pre-ticket)
- Suggest `/ralph-hero:form-idea` as next step instead of `/form_idea`
- Minimal frontmatter (no env vars needed since no GitHub tools)

### 2. `skills/form-idea/SKILL.md`

**Source**: `~/projects/.claude/commands/form_idea.md`
**Adaptations**:
- Use `ralph_hero__create_issue` instead of `mcp__plugin_linear_linear__create_issue`
- Use `ralph_hero__list_issues` to find duplicates/related work
- Use `ralph_hero__get_issue` for fetching issue details
- Ticket tree creation via `ralph_hero__create_issue` + `ralph_hero__add_sub_issue` + `ralph_hero__add_dependency`
- Estimates use string format ("XS"/"S"/"M"/"L"/"XL") via `ralph_hero__update_estimate`
- Idea file frontmatter: `github_issue: NNN` instead of `linear_ticket: LAN-XXX`
- Status: `github_url: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN`
- Suggest `/ralph-hero:ralph-research`, `/ralph-hero:create-plan` as next steps

### 3. `skills/research-codebase/SKILL.md`

**Source**: `~/projects/.claude/commands/research_codebase.md`
**Adaptations**:
- Research doc frontmatter: `github_issue: NNN`, `github_url: https://github.com/...`
- File naming: `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-description.md`
- If linked to an issue, post Artifact Comment Protocol comment (`## Research Document` header)
- GitHub permalinks: `https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/{commit}/{file}#L{line}`
- No state transitions (interactive - user decides when to move states)
- Optional: offer to link research to issue via `ralph_hero__create_comment`

### 4. `skills/create-plan/SKILL.md`

**Source**: `~/projects/.claude/commands/create_plan.md`
**Adaptations**:
- Plan doc frontmatter: `github_issues: [NNN]`, `github_urls: [...]`, `primary_issue: NNN`
- File naming: `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md`
- Group plans: `thoughts/shared/plans/YYYY-MM-DD-group-GH-NNNN-description.md`
- GitHub integration step: use `ralph_hero__create_issue` or `ralph_hero__get_issue` + `ralph_hero__create_comment`
- Artifact Comment Protocol: post `## Implementation Plan` header comment
- State transition offer: move to "Plan in Review" via `ralph_hero__update_workflow_state(state="Plan in Review")`
- Suggest `/ralph-hero:implement-plan` as next step

### 5. `skills/iterate-plan/SKILL.md`

**Source**: `~/projects/.claude/commands/iterate_plan.md`
**Adaptations**:
- Issue resolution: `#NNN` pattern instead of `LAN-\d+`
- Use `ralph_hero__get_issue` to fetch issue details
- Artifact Comment Protocol for finding linked plan (search comments for `## Implementation Plan`)
- Convert GitHub URL to local path for reading
- State transition: offer "Plan in Progress" via `ralph_hero__update_workflow_state`
- Update comments via `ralph_hero__create_comment`

### 6. `skills/implement-plan/SKILL.md`

**Source**: `~/projects/.claude/commands/implement_plan.md`
**Adaptations**:
- Issue resolution: `#NNN` pattern
- Use `ralph_hero__get_issue` to fetch issue + find plan via Artifact Comment Protocol
- Plan doc frontmatter: `github_issue`/`github_issues` fields
- State transitions: "In Progress" at start, "In Review" at completion via `ralph_hero__update_workflow_state`
- Comments via `ralph_hero__create_comment` (start comment, completion comment with `## Implementation Complete` header)
- Worktree setup: use `scripts/create-worktree.sh GH-NNN`
- Manual verification pause pattern preserved (human-in-the-loop)
- PR creation: `Closes #NNN` syntax in PR body

### Success Criteria:

#### Automated Verification:
- [ ] All 6 skill directories exist with SKILL.md files
- [ ] No syntax errors in frontmatter (validate YAML)
- [ ] All `ralph_hero__*` tool references match actual MCP server tools
- [ ] All file path patterns match existing conventions (`thoughts/shared/{type}/YYYY-MM-DD-GH-NNNN-*.md`)

#### Manual Verification:
- [ ] `/ralph-hero:draft-idea` appears in autocomplete and runs interactively
- [ ] `/ralph-hero:form-idea` can create a GitHub issue from an idea
- [ ] `/ralph-hero:create-plan` creates a plan document and links it to an issue
- [ ] `/ralph-hero:implement-plan` finds a plan via Artifact Comment Protocol and implements it
- [ ] `/ralph-hero:iterate-plan` finds and updates an existing plan
- [ ] `/ralph-hero:research-codebase` creates a research document and optionally links it

---

## Phase 2: Documentation Updates

### Changes Required:

#### 1. Plugin README.md
**File**: `plugin/ralph-hero/README.md`
**Changes**: Add "Interactive Skills" section documenting the 6 new skills, their purpose, and how they differ from autonomous skills

#### 2. Shared conventions reference
**File**: `plugin/ralph-hero/skills/shared/conventions.md`
**Changes**: Add section noting that interactive skills reference these conventions but are not bound by the state machine

### Success Criteria:
- [ ] README documents all 6 interactive skills
- [ ] Conventions doc acknowledges interactive skill category

---

## Testing Strategy

### Manual Testing Steps:
1. Run `/ralph-hero:draft-idea` with no args - verify prompt appears
2. Run `/ralph-hero:draft-idea my cool idea` - verify it captures and saves
3. Run `/ralph-hero:form-idea` with a saved idea path - verify it researches and offers options
4. Run `/ralph-hero:create-plan` with an issue number - verify it creates plan and links to issue
5. Run `/ralph-hero:implement-plan` with an issue number - verify it finds plan and implements
6. Run `/ralph-hero:iterate-plan` with an issue number - verify it finds and updates plan
7. Run `/ralph-hero:research-codebase` - verify it creates research doc

## References

- Workspace commands: `~/projects/.claude/commands/{create_plan,implement_plan,iterate_plan,research_codebase,draft_idea,form_idea}.md`
- Existing autonomous skills: `plugin/ralph-hero/skills/ralph-*/SKILL.md`
- Shared conventions: `plugin/ralph-hero/skills/shared/conventions.md`
- Artifact Comment Protocol: documented in shared/conventions.md
- GitHub state machine: `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json`
