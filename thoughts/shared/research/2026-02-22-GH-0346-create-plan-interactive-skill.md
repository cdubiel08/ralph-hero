---
date: 2026-02-22
github_issue: 346
github_url: https://github.com/cdubiel08/ralph-hero/issues/346
status: complete
type: research
---

# Research: Add `create-plan` Interactive Skill (GH-346)

## Problem Statement

Port the workspace-level `create_plan.md` command into the ralph-hero plugin as `plugin/ralph-hero/skills/create-plan/SKILL.md`. This is skill #4 of 6 in the interactive skills port (parent: #342).

The skill enables interactive, iterative implementation planning sessions. The user provides a ticket/description, the skill researches the codebase, produces a phased plan document, and optionally links it to a GitHub issue and transitions to "Plan in Review". Unlike the autonomous `ralph-plan` skill, this runs inline with full user collaboration at each step.

## Current State Analysis

### Source Command

Source: `/home/chad_a_dubiel/projects/.claude/commands/create_plan.md` (491 lines — the most substantial of the 6 interactive skills).

The source is a mature, multi-step interactive workflow:
1. **Initial Response**: prompts user for context, or accepts a file/ticket reference as argument
2. **Context Gathering**: reads mentioned files fully, spawns parallel codebase research agents
3. **Research & Discovery**: iterative — respawns agents if user corrects misunderstandings
4. **Plan Structure Development**: proposes phased structure, gets user buy-in before writing details
5. **Detailed Plan Writing**: writes to `landcrawler-ai/thoughts/shared/plans/YYYY-MM-DD-LAN-XXX-description.md`
6. **Review**: presents draft, iterates until user satisfied
7. **Linear Integration (Optional)**: offers to create/link a Linear ticket, posts comment with state transition

### No `create-plan` Skill Exists

No `plugin/ralph-hero/skills/create-plan/` directory or SKILL.md exists. Target is a new file.

### Analogous Autonomous Skill: `ralph-plan`

`plugin/ralph-hero/skills/ralph-plan/SKILL.md` is the autonomous counterpart. Key contrast:

| Aspect | Autonomous (`ralph-plan`) | Interactive (`create-plan`) |
|--------|---------------------------|-----------------------------|
| `context` | `fork` | None (inline) |
| Hooks | PreToolUse (branch-gate, convergence-gate, plan-research-required), PostToolUse (plan-state-gate), Stop (plan-postcondition) | None |
| `RALPH_COMMAND` env | `"plan"` | Not set |
| `RALPH_REQUIRES_RESEARCH` env | `"true"` | Not set |
| Issue selection | Automatic (picks from "Ready for Plan") | User-provided |
| State transitions | Automatic (`__LOCK__` → `__COMPLETE__`) | Optional, user-triggered |
| Model | `opus` | `opus` |
| User interaction | None | Full collaborative workflow |

## Key Discoveries

### 1. Frontmatter Pattern for Interactive Skills

Same as all 6 interactive skills (established in GH-345 research):

```yaml
---
description: Create detailed implementation plans through interactive research and iteration
argument-hint: [optional issue number or file path]
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

No `context: fork`, no hooks, no `RALPH_COMMAND`.

### 2. Plan Document Frontmatter (Output Format)

Per `thoughts/shared/plans/2026-02-21-interactive-skills-port.md`, plan docs written by this skill use:

```yaml
---
date: YYYY-MM-DD
status: draft
github_issues: [NNN]           # list for group plans
github_urls:
  - https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
primary_issue: NNN             # main issue this plan addresses
---
```

For group plans (multi-issue): `github_issues: [343, 344, 345]`, `primary_issue: 343`.

### 3. File Naming Conventions

| Plan type | Pattern |
|-----------|---------|
| Single issue | `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md` |
| Group plan | `thoughts/shared/plans/YYYY-MM-DD-group-GH-NNNN-description.md` |

Where `NNNN` is zero-padded to 4 digits. No `landcrawler-ai/` prefix. No `LAN-XXX` naming.

### 4. Artifact Comment Protocol: `## Implementation Plan` Header

When linking the plan to a GitHub issue, the comment uses the `## Implementation Plan` header (not `## Research Document`). This is the Artifact Comment Protocol standard that allows `ralph-impl` and `iterate-plan` to find the plan via comment parsing.

```markdown
## Implementation Plan

https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/plans/[filename].md

Summary: [1-3 line summary of the plan]
```

### 5. State Transition: "Plan in Review"

The source offers to set Linear state `f6519c50-d44b-490e-ae7f-d6409086024b` ("Plan in Review"). In the ported skill, this becomes:

```
ralph_hero__update_workflow_state(number=NNN, state="Plan in Review", command="create_plan")
```

This is optional — the user decides whether to transition. The skill offers it after the plan is finalized and the user is satisfied.

### 6. Agent Availability Differences

Source references agents not available in ralph-hero plugin:

| Source agent | Replacement |
|-------------|-------------|
| `github-repo-manager` | Use `ralph_hero__get_issue` directly in main context |
| `thoughts-analyzer` | Use `thoughts-locator` only; main context synthesizes |

Available sub-agents:
- `ralph-hero:codebase-locator`
- `ralph-hero:codebase-analyzer`
- `ralph-hero:codebase-pattern-finder`
- `ralph-hero:thoughts-locator`
- `ralph-hero:web-search-researcher`

### 7. `TodoWrite` Reference

The source mentions `TodoWrite` for tracking planning tasks (Step 2: "Create a research todo list using TodoWrite"). This tool is available in interactive skill contexts (broader `allowed_tools`). It can be preserved or removed — it provides useful planning scaffolding but is not essential. Recommend preserving as a helpful workflow aid.

### 8. Full Adaptations Table

| Source Convention | Replacement |
|------------------|-------------|
| `LAN-XXX` ticket IDs | `GH-NNNN` / `#NNN` issue refs |
| `linear_ticket: LAN-XXX` frontmatter | `github_issues: [NNN]`, `primary_issue: NNN` |
| `linear_url: ...` frontmatter | `github_urls: [...]` |
| `landcrawler-ai/thoughts/shared/plans/YYYY-MM-DD-LAN-XXX-*.md` | `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-*.md` |
| `landcrawler-ai/thoughts/shared/tickets/issue_XXX.md` | `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-*.md` (research docs) |
| `landcrawler-ai/thoughts/shared/` | `thoughts/shared/` |
| `mcp__plugin_linear_linear__create_issue` | `ralph_hero__create_issue` |
| `mcp__plugin_linear_linear__get_issue` | `ralph_hero__get_issue` |
| Linear state ID UUID for "Plan in Review" | `ralph_hero__update_workflow_state(state="Plan in Review")` |
| `github-repo-manager` agent | `ralph_hero__get_issue` directly |
| `thoughts-analyzer` agent | `thoughts-locator` only |
| `/implement_plan` next-step suggestion | `/ralph-hero:implement-plan` |
| `/create_plan ticket.md` arg example | `/ralph-hero:create-plan #NNN` or research doc path |
| `## Research Document` comment header (wrong for plans) | `## Implementation Plan` header |

## Potential Approaches

### Approach A: Full Port Preserving All Steps (Recommended)

Preserve all 7 steps of the source workflow with only the required convention substitutions. This is the most faithful adaptation and preserves the rich interactive experience (structure approval, skeptical questioning, iteration).

**Pros**: Full-featured from day one, proven workflow, maintains quality guardrails
**Cons**: Largest skill file of the 6 (~400+ lines after adaptation)

### Approach B: Simplified Port (Steps 1-5 Only)

Port only the core planning flow, omitting Step 7 (GitHub integration / state transition). The user would manually link the plan to the issue.

**Pros**: Simpler, faster to implement
**Cons**: Loses the GitHub integration step that makes this skill complete; user must manually do what the skill could automate

**Recommendation**: Approach A. The GitHub integration step (Step 6 in ported version) is a key differentiator of this plugin's workflow and takes minimal additional implementation. The complexity is in the interactive planning flow, not the GitHub step.

## Risks

1. **Largest skill file**: At ~491 source lines, this requires the most adaptation work. Risk of missing a Linear reference in a long file.
2. **Group plan naming**: The `group-GH-NNNN` naming convention must be handled correctly — the skill needs to detect when the user is planning across multiple issues.
3. **`TodoWrite` availability**: If the skill context doesn't support `TodoWrite`, calls to it will silently fail or error. Can be removed without loss of functionality.
4. **`github-repo-manager` removal**: Source uses it to "get full details of a specific issue" in Step 1. Replace with `ralph_hero__get_issue` called directly in the main context — do not delegate to a sub-agent since it's a simple API call.
5. **Interactive flow must be inline**: Must not add `context: fork` — the entire value of this skill is the user being able to correct misunderstandings and steer the plan.
6. **State transition command parameter**: `ralph_hero__update_workflow_state` requires a `command` parameter. Use `"create_plan"` (the skill name).

## Recommended Next Steps

1. Create `plugin/ralph-hero/skills/create-plan/SKILL.md`
2. Use the interactive frontmatter pattern (model: opus, no context:fork, no hooks, includes Edit)
3. Preserve all 7 source steps with these adaptations:
   - Replace all Linear tool calls with `ralph_hero__*` equivalents
   - Replace `LAN-XXX` with `GH-NNNN` throughout
   - Replace plan frontmatter fields (`linear_ticket`/`linear_url` → `github_issues`/`github_urls`/`primary_issue`)
   - Replace file naming conventions
   - Remove `github-repo-manager` agent; call `ralph_hero__get_issue` directly
   - Replace `thoughts-analyzer` with `thoughts-locator`
   - Step 7 (Linear Integration) becomes "GitHub Integration": offer `ralph_hero__create_comment` with `## Implementation Plan` header + `ralph_hero__update_workflow_state(state="Plan in Review")`
   - Update next-step suggestion to `/ralph-hero:implement-plan`
   - Add Team Isolation note for sub-agent Task calls
   - Reference `shared/conventions.md` for link formatting and Artifact Comment Protocol

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/create-plan/SKILL.md` - New file to create (skill definition)

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/shared/conventions.md` - Artifact Comment Protocol (`## Implementation Plan` header) and link formatting
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md` - Autonomous plan skill for structural reference
- `thoughts/shared/plans/2026-02-21-interactive-skills-port.md` - Port plan with specific adaptation requirements
