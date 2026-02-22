---
date: 2026-02-22
github_issue: 345
github_url: https://github.com/cdubiel08/ralph-hero/issues/345
status: complete
type: research
---

# Research: Add `research-codebase` Interactive Skill (GH-345)

## Problem Statement

Port the workspace-level `research_codebase.md` command into the ralph-hero plugin as `plugin/ralph-hero/skills/research-codebase/SKILL.md`. This is one of 6 interactive skills being ported from Linear-based workspace commands to GitHub-based plugin skills (parent: #342).

The skill enables inline, interactive codebase research sessions — the user asks a question, the skill spawns parallel sub-agents, synthesizes findings, and saves a research document. Unlike autonomous ralph skills, this runs in the user's active session as a collaborative, human-in-the-loop workflow.

## Current State Analysis

### Source Command

The source command exists at `/home/chad_a_dubiel/projects/.claude/commands/research_codebase.md` (212 lines). It is a complete, mature workflow with:
- Interactive prompt pattern (asks user for research question after invocation)
- Parallel sub-agent orchestration (codebase-locator, codebase-analyzer, codebase-pattern-finder, thoughts-locator)
- Research document generation with YAML frontmatter
- GitHub permalink generation (on main branch)
- Follow-up question handling with document updates
- "Documentarian" discipline — describe what IS, no critiques or recommendations

### Existing Skill Infrastructure

No `research-codebase` skill exists yet in `plugin/ralph-hero/skills/`. The existing skills are all autonomous (`ralph-*`) and use `context: fork`.

The analogous autonomous skill is `ralph-research` (`plugin/ralph-hero/skills/ralph-research/SKILL.md`), which is NOT the same — it autonomously picks and researches GitHub issues without user interaction. The new `research-codebase` skill is user-directed, topic-agnostic, and interactive.

### Key Structural Difference: Autonomous vs Interactive

| Aspect | Autonomous (`ralph-research`) | Interactive (`research-codebase`) |
|--------|-------------------------------|-----------------------------------|
| `context` | `fork` | None (inline) |
| User interaction | None | Prompts for research question |
| Hooks | PreToolUse, PostToolUse, Stop | None |
| `RALPH_COMMAND` env | Yes (for state gates) | No |
| State transitions | Automatic | Optional, user-controlled |
| Model | `sonnet` | `opus` |
| Issue scope | Fixed (one GitHub issue) | Any topic the user specifies |

## Key Discoveries

### 1. Frontmatter Pattern for Interactive Skills

Per `thoughts/shared/plans/2026-02-21-interactive-skills-port.md`, all interactive skills share this frontmatter:

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

No `context: fork`, no hooks, no `RALPH_COMMAND`. The `Edit` tool is included (autonomous skills omit it).

### 2. Required Adaptations from Source Command

The source uses Linear/Landcrawler conventions that must be replaced:

| Source Convention | Replacement |
|------------------|-------------|
| `LAN-XXX` ticket IDs | `GH-NNNN` issue IDs |
| `linear_ticket: LAN-XXX` frontmatter | `github_issue: NNN` |
| `linear_url: ...` frontmatter | `github_url: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN` |
| `landcrawler-ai/thoughts/shared/research/YYYY-MM-DD-LAN-XXX-*.md` | `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-description.md` |
| `landcrawler-ai/scripts/thoughts/spec_metadata.sh` | Not needed (gather git data via bash directly) |
| `landcrawler-ai/thoughts/shared/` paths | `thoughts/shared/` paths |
| `thoughts/searchable/` path handling | Not applicable (no searchable dir in this repo) |
| Optional issue linking: `mcp__plugin_linear_linear__create_comment` | `ralph_hero__create_comment` with `## Research Document` header |

### 3. Artifact Comment Protocol

When the user optionally links the research to a GitHub issue, the comment must use the `## Research Document` header per `plugin/ralph-hero/skills/shared/conventions.md`. This is the standard Artifact Comment Protocol that allows downstream tools (ralph-plan, ralph-impl) to find linked artifacts via comment parsing.

Format:
```markdown
## Research Document

https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/research/[filename].md

Key findings: [1-3 line summary]
```

### 4. GitHub Permalink Format

Source command already generates GitHub permalinks. The format for this plugin:
```
https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/{commit}/{file}#L{line}
```

Gather commit via `git rev-parse HEAD` and repo info via `gh repo view --json owner,name`.

### 5. Sub-agent Availability

The source command references a `thoughts-analyzer` agent. The ralph-hero plugin does NOT define a `thoughts-analyzer` agent — only `thoughts-locator`. The skill should use `thoughts-locator` for document discovery and let the main context handle synthesis from returned content.

Available sub-agents (confirmed in ralph-hero plugin):
- `ralph-hero:codebase-locator`
- `ralph-hero:codebase-analyzer`
- `ralph-hero:codebase-pattern-finder`
- `ralph-hero:thoughts-locator`
- `ralph-hero:web-search-researcher`

### 6. No State Transitions Required

The source command has no state transition logic. The issue says "No state transitions (human decides)." The new skill should offer optional issue linking only — no automatic workflow state changes. This keeps the skill purely interactive and human-controlled.

### 7. Research Document Frontmatter

The skill's output documents use a simplified frontmatter compared to the source (which has many Linear/Landcrawler-specific fields):

```yaml
---
date: YYYY-MM-DD
github_issue: NNN        # optional — only if linked to an issue
github_url: https://...  # optional — only if linked to an issue
topic: "[Research Question]"
tags: [research, codebase, relevant-component-names]
status: complete
type: research
---
```

## Potential Approaches

### Approach A: Direct Port with Minimal Changes (Recommended)

Keep the source command's workflow structure intact, apply only the required adaptations (naming, tools, paths), and simplify the frontmatter. The source is already high-quality — the main work is search-and-replace of conventions.

**Pros**: Low risk, preserves proven workflow, fast to implement
**Cons**: Inherits some complexity from source (follow-up question handling, permalink logic)

### Approach B: Simplified Port

Strip the source to its essentials: prompt, spawn, synthesize, write. Remove follow-up question handling and permalink generation to keep the skill lightweight.

**Pros**: Simpler skill file, easier to maintain
**Cons**: Loses useful features (follow-up questions, permalinks) that are already implemented

**Recommendation**: Approach A. The source's complexity is all additive value. The adaptations are mechanical, not architectural.

## Risks

1. **`thoughts-analyzer` agent referenced in source**: Adapt to use `thoughts-locator` only (the skill body can synthesize from returned content directly).
2. **`spec_metadata.sh` script**: This Landcrawler-specific script doesn't exist in ralph-hero. Replace with direct `git rev-parse HEAD` and `date` calls.
3. **`context: fork` omission**: Must ensure the frontmatter does NOT include `context: fork` — interactive skills need inline conversation.
4. **`allowed_tools` completeness**: Interactive skills need `Edit` in addition to what autonomous skills declare.
5. **Optional issue arg**: The source doesn't accept an issue number argument — the new skill should optionally accept one to pre-link the research document to an issue.

## Recommended Next Steps

1. Create `plugin/ralph-hero/skills/research-codebase/SKILL.md`
2. Use the interactive frontmatter pattern (model: opus, no context: fork, no hooks)
3. Preserve the source's workflow steps 1–9 with these adaptations:
   - Replace `spec_metadata.sh` with direct git/date commands
   - Replace Linear frontmatter with `github_issue`/`github_url`
   - Replace `LAN-XXX` naming with `GH-NNNN`
   - Replace `thoughts-analyzer` references with `thoughts-locator`
   - Replace `landcrawler-ai/thoughts/shared/` paths with `thoughts/shared/`
   - Remove `thoughts/searchable/` path handling
   - Add optional issue arg: if `ARGUMENTS` is provided, pre-populate `github_issue` and offer to post Artifact Comment Protocol comment
4. Add Team Isolation note for sub-agent Task calls
5. Reference `shared/conventions.md` for link formatting

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/research-codebase/SKILL.md` - New file to create (skill definition)

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/shared/conventions.md` - Artifact Comment Protocol and link formatting reference
- `plugin/ralph-hero/skills/ralph-research/SKILL.md` - Autonomous research skill for structural reference
