---
date: 2026-02-23
github_issue: 358
github_url: https://github.com/cdubiel08/ralph-hero/issues/358
status: complete
type: research
---

# V4 Phase 6a: Interactive Skills — draft-idea, form-idea, research-codebase

## Problem Statement

Three interactive skills (`draft-idea`, `form-idea`, `research-codebase`) need to exist in the ralph-hero plugin, adapted from workspace Linear-based commands to use GitHub tools (`ralph_hero__*`), with no `context: fork`, and implementing the Artifact Comment Protocol for doc-to-issue linking.

## Key Discovery: Skills Already Implemented in GH-343 Worktree

**All three skills already exist** in `worktrees/GH-343/plugin/ralph-hero/skills/`:

| Skill | Path | Status |
|-------|------|--------|
| `draft-idea` | `worktrees/GH-343/plugin/ralph-hero/skills/draft-idea/SKILL.md` | Complete |
| `form-idea` | `worktrees/GH-343/plugin/ralph-hero/skills/form-idea/SKILL.md` | Complete |
| `research-codebase` | `worktrees/GH-343/plugin/ralph-hero/skills/research-codebase/SKILL.md` | Complete |

Prior research docs also exist for each (dated 2026-02-22): `GH-0343-draft-idea-interactive-skill.md`, `GH-0344-form-idea-interactive-skill.md`, `GH-0345-research-codebase-interactive-skill.md`. A group implementation plan exists at `thoughts/shared/plans/2026-02-22-group-GH-0343-interactive-skills-port.md`.

**The implementation scope for Phase 6a is: verify the GH-343 worktree implementations are complete and correct, then integrate to main.** This is narrower than "create from scratch."

## Current State Analysis

### Workspace Reference Commands (source of truth)

**`draft_idea.md`** (`~/.claude/commands/draft_idea.md`):
- No `context: fork`, no `RALPH_COMMAND`, model: sonnet
- No Linear/GitHub tools — saves ideas to `thoughts/shared/ideas/` only
- 2-3 clarifying questions, optional `codebase-locator` sub-agent spawn
- Output: `thoughts/shared/ideas/YYYY-MM-DD-description.md`

**`form_idea.md`** (`~/.claude/commands/form_idea.md`):
- No `context: fork`, model: opus
- Uses Linear `mcp__plugin_linear_linear__create_issue` — needs GitHub adaptation
- Spawns 4 parallel agents: codebase-locator, codebase-analyzer, thoughts-locator, linear-locator
- Creates tickets with `LAN-NNN` format — needs `#NNN`/`GH-NNNN` adaptation
- 3 explicit user interaction pauses (understanding confirm, format choice, draft approval)

**`research_codebase.md`** (`~/.claude/commands/research_codebase.md`):
- No `context: fork`, model: opus
- No Linear tools — uses sub-agents only
- Spawns parallel agents: codebase-locator, codebase-analyzer, codebase-pattern-finder, thoughts-locator, optionally web-search-researcher
- Output: `thoughts/shared/research/YYYY-MM-DD-[LAN-XXX-]description.md` — needs GH-NNNN adaptation
- No `team_name` in Task() calls (already correct pattern)

### GH-343 Worktree Implementations

**`draft-idea/SKILL.md`**:
- model: sonnet, no `context: fork`, minimal frontmatter
- GitHub-adapted: suggests `/ralph-hero:form-idea`, `/ralph-hero:research-codebase` as next steps
- Saves to `thoughts/shared/ideas/YYYY-MM-DD-description.md`

**`form-idea/SKILL.md`**:
- model: opus, no `context: fork`
- GitHub tools: `ralph_hero__create_issue`, `ralph_hero__list_issues`, `ralph_hero__get_issue`, `ralph_hero__update_estimate`, `ralph_hero__add_sub_issue`, `ralph_hero__add_dependency`
- Linear tools replaced, `GH-NNNN` naming used, Artifact Comment Protocol included
- Creates GitHub issues with XS/S/M/L/XL estimates

**`research-codebase/SKILL.md`**:
- model: opus, no `context: fork`
- Spawns typed sub-agents: `ralph-hero:codebase-locator`, `ralph-hero:codebase-analyzer`, `ralph-hero:codebase-pattern-finder`, `ralph-hero:thoughts-locator`
- File naming: `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-description.md` (zero-padded)
- Creates Artifact Comment Protocol entries via `## Research Document` header
- Accepts optional `#NNN` issue number for linking

### Confirmed Plugin Patterns (from `create-plan` and `form-idea` already on main)

The plugin already has `form-idea/SKILL.md` and `create-plan/SKILL.md` on main with the correct interactive pattern:

```yaml
---
description: [user-facing description]
argument-hint: "[optional args]"
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

No `context: fork`. No `RALPH_COMMAND`. No lifecycle hooks. Full tool access via `allowed_tools`.

**Note**: `ralph_hero__*` tools are NOT in `allowed_tools` — they appear to be called directly without explicit whitelisting in interactive skills.

## Verification Checklist for GH-343 Implementations

Before integrating to main, verify each SKILL.md against these criteria:

### draft-idea/SKILL.md
- [ ] No `context: fork`
- [ ] No `RALPH_COMMAND` env var
- [ ] model: sonnet
- [ ] Saves to `thoughts/shared/ideas/YYYY-MM-DD-description.md`
- [ ] Suggests `/ralph-hero:form-idea` as next step (not `/form_idea`)
- [ ] No Linear tool references

### form-idea/SKILL.md
- [ ] No `context: fork`
- [ ] No `RALPH_COMMAND` env var
- [ ] model: opus
- [ ] `allowed_tools` includes Read, Write, Edit, Glob, Grep, Bash, Task, WebSearch, WebFetch
- [ ] env block with RALPH_GH_OWNER, RALPH_GH_REPO, RALPH_GH_PROJECT_NUMBER
- [ ] Uses `ralph_hero__create_issue` (not `mcp__plugin_linear_linear__create_issue`)
- [ ] Uses `#NNN` / `GH-NNNN` references (not `LAN-NNN`)
- [ ] Sub-agents spawned without `team_name`
- [ ] Searches for duplicates via `ralph_hero__list_issues` (not linear-locator)
- [ ] Artifact Comment Protocol if linking to existing issue

### research-codebase/SKILL.md
- [ ] No `context: fork`
- [ ] No `RALPH_COMMAND` env var
- [ ] model: opus
- [ ] `allowed_tools` includes Read, Write, Edit, Glob, Grep, Bash, Task, WebSearch, WebFetch
- [ ] env block with GitHub env vars
- [ ] Uses `ralph-hero:codebase-locator` etc. (prefixed agent names)
- [ ] Sub-agents spawned without `team_name`
- [ ] File naming: `YYYY-MM-DD-GH-NNNN-description.md` (zero-padded 4 digits)
- [ ] Creates `## Research Document` artifact comment when linked to issue
- [ ] No Linear tool references or `LAN-NNN` naming

## Recommended Approach

**Phase 6a scope is a merge/integration task, not a creation task.**

1. Check GH-343 worktree branch for existing PR (may already have one)
2. If PR exists: review against verification checklist, merge
3. If no PR: run verification checklist on GH-343 implementations, fix any gaps, create PR

The prior research docs (GH-0343–0345) and group plan (`2026-02-22-group-GH-0343`) contain detailed per-skill change lists. Implementer should read these before verifying the worktree implementations.

**S estimate assessment**: With implementations already in the worktree, Phase 6a is likely XS-S. If the worktree implementations fully pass the verification checklist, it reduces to XS (just PR creation and merge). If gaps exist, it's S to fix them.

## Risks

1. **Worktree branch divergence**: GH-343 worktree may be behind main (especially if main has received commits since the worktree was created). Rebase/merge conflict possible.
2. **`form-idea` already on main**: The plugin already has `form-idea/SKILL.md` on main (confirmed by pattern-finder). Check if the GH-343 version supersedes it or if they're the same file — avoid overwriting a more recent version with an older one.
3. **`allowed_tools` completeness**: The `draft-idea` skill uses minimal frontmatter (no `allowed_tools`). Verify if tool access is unrestricted without the `allowed_tools` field, or if it needs to be added for consistent behavior.
4. **Agent name prefixes**: GH-343 implementations reference `ralph-hero:codebase-locator` etc. Verify these prefixed agent names work correctly in the plugin context.

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/draft-idea/SKILL.md` — create from GH-343 worktree (verify and copy/merge)
- `plugin/ralph-hero/skills/research-codebase/SKILL.md` — create from GH-343 worktree (verify and copy/merge)

### Will Read (Dependencies)
- `worktrees/GH-343/plugin/ralph-hero/skills/draft-idea/SKILL.md` — source implementation to verify
- `worktrees/GH-343/plugin/ralph-hero/skills/form-idea/SKILL.md` — source implementation to verify
- `worktrees/GH-343/plugin/ralph-hero/skills/research-codebase/SKILL.md` — source implementation to verify
- `plugin/ralph-hero/skills/form-idea/SKILL.md` — already on main; compare with GH-343 version
- `plugin/ralph-hero/skills/shared/conventions.md` — Artifact Comment Protocol reference
- `thoughts/shared/plans/2026-02-22-group-GH-0343-interactive-skills-port.md` — detailed per-skill change list
- `thoughts/shared/research/2026-02-22-GH-0343-draft-idea-interactive-skill.md` — draft-idea research
- `thoughts/shared/research/2026-02-22-GH-0344-form-idea-interactive-skill.md` — form-idea research
- `thoughts/shared/research/2026-02-22-GH-0345-research-codebase-interactive-skill.md` — research-codebase research
