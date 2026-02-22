---
date: 2026-02-22
github_issue: 344
github_url: https://github.com/cdubiel08/ralph-hero/issues/344
status: complete
type: research
---

# Research: Add `form-idea` Interactive Skill (GH-344)

## Problem Statement

The workspace has a `form_idea.md` command at `~/projects/.claude/commands/form_idea.md` that helps
crystallize rough ideas into actionable artifacts (tickets, plans, or research topics). It uses Linear
MCP tools and Linear ticket IDs (`LAN-NNN`). The ralph-hero plugin has no equivalent — users working
within GitHub Projects V2 have no interactive skill to convert idea files into GitHub issues.

This issue asks for a direct port of `form_idea.md` into `plugin/ralph-hero/skills/form-idea/SKILL.md`,
replacing all Linear-specific tooling with `ralph_hero__*` MCP tools.

## Current State Analysis

### What Exists

- **Source command**: `~/projects/.claude/commands/form_idea.md` — fully implemented, 200+ lines
  - Interactive 5-step workflow: understand → research → context → choose output → execute
  - `model: opus` (correct for deep interactive reasoning)
  - Uses `mcp__plugin_linear_linear__create_issue`, `mcp__plugin_linear_linear__list_issues`
  - References `landcrawler-ai/thoughts/shared/ideas/` paths
  - Spawns parallel research: `codebase-locator`, `codebase-analyzer`, `thoughts-locator`, `linear-locator`
  - Linear ticket frontmatter: `linear_ticket: LAN-XXX`, `status: formed`

- **Plan**: `thoughts/shared/plans/2026-02-21-interactive-skills-port.md` — draft, fully specifies all
  6 skill ports including this one. All adaptations are documented.

- **12 existing autonomous skills** in `plugin/ralph-hero/skills/ralph-*/SKILL.md` — all use
  `context: fork`, hooks, and `RALPH_COMMAND` env. Interactive skills must NOT follow this pattern.

### What Does NOT Exist

- `plugin/ralph-hero/skills/form-idea/` directory — not created yet
- `plugin/ralph-hero/skills/draft-idea/` — confirmed absent; no interactive skills exist in plugin yet
- `thoughts/shared/ideas/` directory in ralph-hero repo — builder should verify or create it

## Key Discoveries

### Interactive vs Autonomous Skill Differences

Critical architectural distinction documented in the plan:

| | Autonomous Skills | Interactive Skills |
|---|---|---|
| `context` | `fork` | *(omit — inline conversation)* |
| Hooks | PreToolUse, PostToolUse, Stop | None |
| `RALPH_COMMAND` env | Required | Omit |
| Initiated by | Agent teams / ralph-loop | User directly |
| State gates | Yes (hook-enforced) | No (human-guided) |

Interactive skills must omit `context: fork` to maintain conversational flow with the user.

### Standard Frontmatter for Interactive Skills

From `thoughts/shared/plans/2026-02-21-interactive-skills-port.md:62-82`:

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

Note: `ralph_hero__*` MCP tools are automatically available via the plugin's `.mcp.json` and do NOT
need to be listed in `allowed_tools`.

### Tool Mappings (Linear → GitHub)

All substitutions for `form-idea` specifically (from plan line 111-118):

| Linear | GitHub |
|--------|--------|
| `mcp__plugin_linear_linear__create_issue` | `ralph_hero__create_issue` |
| `mcp__plugin_linear_linear__list_issues` | `ralph_hero__list_issues` |
| `linear-locator` agent for duplicate search | `ralph_hero__list_issues(query=...)` inline |
| `LAN-XXX` ticket reference | `#NNN` issue reference |
| `linear_ticket: LAN-XXX` frontmatter | `github_issue: NNN` |
| `linear_url: ...` frontmatter | `github_url: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN` |
| Estimate as integer (1-5) | Estimate as string via `ralph_hero__update_estimate("XS"/"S"/"M"/"L"/"XL")` |
| `linear_ticket: LAN-XXX` in idea file | `github_issue: NNN` in idea file |
| Next steps referencing `/ralph_research`, `/create_plan` | `/ralph-hero:ralph-research`, `/ralph-hero:create-plan` |

### Ticket Tree Creation Pattern

For the "Ticket tree" output option, the three-step pattern:

1. `ralph_hero__create_issue(title=...)` → returns `number`
2. `ralph_hero__add_sub_issue(parentNumber=..., childNumber=number)`
3. `ralph_hero__update_estimate(number=..., estimate="XS")` (string format)
4. `ralph_hero__add_dependency(blockedNumber=..., blockingNumber=...)` for ordering

### Idea File Path

The source command saves to `landcrawler-ai/thoughts/shared/ideas/YYYY-MM-DD-description.md`.
For ralph-hero, the target path is `thoughts/shared/ideas/YYYY-MM-DD-description.md` (relative
to repo root). Builder should verify this directory exists or create it.

### Research Agent Substitutions

The source command's Step 2 spawns `linear-locator` for duplicate ticket search. In the plugin:
- Replace `linear-locator` with an inline `ralph_hero__list_issues(query=...)` call
- Keep `codebase-locator` → `ralph-hero:codebase-locator`
- Keep `codebase-analyzer` → `ralph-hero:codebase-analyzer`
- Keep `thoughts-locator` → `ralph-hero:thoughts-locator`
- Add Team Isolation reminder (no `team_name` param in sub-agent Task calls)

## Potential Approaches

### Approach A: Straight Port with Substitutions (Recommended)

Directly adapt `form_idea.md` into `SKILL.md` format with the tool/naming substitutions above.
Preserve all 5 interactive steps intact. Add GitHub-specific ticket tree creation pattern.

**Pros**: Minimal cognitive overhead, well-specified, preserves proven UX
**Cons**: None significant

### Approach B: Simplified Version

Create a slimmer skill that only handles the "GitHub ticket" and "ticket tree" output options,
dropping "implementation plan" and "research topic" handoffs.

**Pros**: Smaller file
**Cons**: Loses value; the handoff options (`/ralph-hero:create-plan`, `/ralph-hero:ralph-research`)
are exactly what makes this skill useful in the GitHub workflow

**Recommendation**: Approach A. The source command is well-structured and the adaptations are mechanical.

## Risks

1. **`thoughts/shared/ideas/` directory**: May not exist in ralph-hero repo. Builder should create
   it with a `.gitkeep` if absent, or use the existing ideas path pattern.

2. **`context: fork` omission**: Builder must NOT add `context: fork` — this is the critical
   difference between interactive and autonomous skills. Omitting it is correct.

3. **Estimate format**: Linear uses integers (1-5); GitHub uses strings (XS/S/M/L/XL). The ticket
   draft template in the source command shows `estimate: [1-5]` — this must be updated to show the
   string options.

4. **No `linear-locator` in plugin context**: The plugin doesn't have a `linear-locator` agent.
   Duplicate search must use `ralph_hero__list_issues(query=...)` directly, which is simpler anyway.

## Recommended Next Steps

1. Create `plugin/ralph-hero/skills/form-idea/SKILL.md` using standard interactive frontmatter
2. Adapt the 5-step workflow from `form_idea.md` with the substitutions above
3. Verify/create `thoughts/shared/ideas/` directory
4. Test: run `/ralph-hero:form-idea` with no args and with an idea file path
5. Move issue to "Ready for Plan" (or directly to "Todo" for implementation since the plan is complete)

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/form-idea/SKILL.md` - New file to create (the skill itself)

### Will Read (Dependencies)
- `~/projects/.claude/commands/form_idea.md` - Source command to adapt
- `plugin/ralph-hero/skills/shared/conventions.md` - Link formatting, escalation protocol
- `plugin/ralph-hero/skills/ralph-triage/SKILL.md` - Reference for SKILL.md structure pattern
- `thoughts/shared/plans/2026-02-21-interactive-skills-port.md` - Full port specification
