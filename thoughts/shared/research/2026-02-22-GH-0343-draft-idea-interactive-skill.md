---
date: 2026-02-22
github_issue: 343
github_url: https://github.com/cdubiel08/ralph-hero/issues/343
status: complete
type: research
---

# Add `draft-idea` Interactive Skill — Research Findings

## Problem Statement

Port the existing workspace-level `draft_idea.md` command into the ralph-hero plugin as
`plugin/ralph-hero/skills/draft-idea/SKILL.md`, making it available as `/ralph-hero:draft-idea`.
The skill must run inline (not forked), maintain interactive conversation, and save ideas to
`thoughts/shared/ideas/YYYY-MM-DD-description.md`.

## Current State Analysis

### Source Command

**Location**: `~/.claude/commands/draft_idea.md`

The command implements a 4-step workflow:
1. **Quick clarification** — 2–3 non-blocking questions to understand the idea
2. **Light research** (optional) — one codebase-locator search if the idea touches existing code
3. **Write the draft** — save to `landcrawler-ai/thoughts/shared/ideas/YYYY-MM-DD-description.md`
4. **Confirm and suggest next steps** — links to `/form_idea`, `/research_codebase`, `/create_plan`

Key characteristics:
- Model: sonnet (speed over depth)
- No GitHub/Linear integration (ideas are pre-ticket)
- Preserves user's voice; short and scannable output
- Uses a lightweight markdown template (title, motivation, rough shape, open questions, related items)
- Tags generously; no state transitions

### Target Skill Location

**Does not exist yet**: `plugin/ralph-hero/skills/draft-idea/` directory is absent.

### Skill Pattern (from codebase analysis)

All skills in the plugin follow this structure:
- One directory per skill: `plugin/ralph-hero/skills/<skill-name>/`
- Single required file: `SKILL.md` with YAML frontmatter + markdown body
- Auto-discovered by plugin system — no manifest changes needed
- Invocation: `/ralph-hero:<skill-name>`

**Interactive vs autonomous distinction** (critical — from plan doc):
- Autonomous skills use `context: fork` — interactive skills must **NOT** (need inline conversation)
- Autonomous skills declare `RALPH_COMMAND` env for state-gate hooks — interactive skills skip this
- Autonomous skills have PreToolUse/PostToolUse/Stop hooks — interactive skills use minimal/no hooks

### Smallest skill reference pattern

`ralph-status/SKILL.md` (977 bytes) shows the minimal frontmatter:
```yaml
---
description: [user-facing description]
argument-hint: "[optional args]"
model: haiku
env:
  RALPH_COMMAND: "status"
---
```

For `draft-idea`: no `RALPH_COMMAND`, no `context: fork`, model is `sonnet`.

### Existing Plan Document

**File**: `thoughts/shared/plans/2026-02-21-interactive-skills-port.md` (status: draft)

Already specifies the exact adaptations for `draft-idea`:
- Save path: `thoughts/shared/ideas/YYYY-MM-DD-description.md`
- Suggest `/ralph-hero:form-idea` as next step (not the workspace `/form_idea`)
- Minimal frontmatter — no env vars needed (no GitHub tools required)
- No Artifact Comment Protocol (ideas are pre-ticket, no issue to comment on)
- No state transitions

## Key Discoveries

1. **This is the simplest of the 6 interactive skills to port** — no GitHub tool calls, no state
   transitions, no Artifact Comment Protocol. Pure interactive capture + file write.

2. **Save path differs from source**: Source saves to `landcrawler-ai/thoughts/shared/ideas/` (Linear
   project path). Target must save to `thoughts/shared/ideas/` (relative to ralph-hero repo root).

3. **Next step references must change**: Source suggests `/form_idea`, `/research_codebase`,
   `/create_plan`. Port must suggest `/ralph-hero:form-idea`, `/ralph-hero:research-codebase`,
   `/ralph-hero:create-plan`.

4. **No `allowed_tools` restriction needed** for draft-idea — it only needs `Read`, `Write`, `Task`
   (for optional codebase-locator search). The plan doc lists `allowed_tools` only for skills
   needing broader access (GitHub tools). Draft-idea can omit it (defaults are sufficient).

5. **Model choice confirmed**: `sonnet` — speed over depth for quick idea capture. Consistent with
   source command and plan doc.

6. **Inline execution required**: Must omit `context: fork` so the skill runs in the user's session
   and can hold an interactive conversation.

7. **Ideas directory may not exist**: `thoughts/shared/ideas/` directory should be created if
   absent. The skill should handle this gracefully (Write tool creates parent directories).

## Potential Approaches

### Option A: Direct port with minimal changes (recommended)

Translate the workflow from `draft_idea.md` directly into a `SKILL.md`, substituting:
- Save path: `landcrawler-ai/thoughts/shared/ideas/` → `thoughts/shared/ideas/`
- Next step refs: `/form_idea` → `/ralph-hero:form-idea`, etc.
- Frontmatter: workspace command style → plugin SKILL.md style (add `description`, `argument-hint`, `model`)

**Pros**: Minimal risk, preserves proven workflow, fast to implement.
**Cons**: None — this is a straightforward port.

### Option B: Simplify workflow further

Strip the optional codebase research step, making it a pure "capture and save" flow.

**Pros**: Even simpler.
**Cons**: Loses useful behavior; source command's light research step is valuable for ideas that
touch existing code.

## Recommended Implementation

Use **Option A**. The SKILL.md should:

```yaml
---
description: Quickly capture an idea or thought for later refinement. Runs inline, asks 2-3 clarifying questions, saves to thoughts/shared/ideas/. Suggest /ralph-hero:form-idea as next step.
argument-hint: "[optional: topic or idea to capture]"
model: sonnet
---
```

Workflow (4 steps, matching source):
1. Quick clarification — 2–3 focused questions (non-blocking if user provides enough upfront)
2. Optional light research — spawn codebase-locator sub-task if idea touches existing code
3. Write draft — save to `thoughts/shared/ideas/YYYY-MM-DD-<description>.md` with template
4. Confirm and suggest next steps — `/ralph-hero:form-idea`, `/ralph-hero:research-codebase`

**Template** (from source, adapted):
```markdown
---
date: YYYY-MM-DD
status: draft
tags: [tag1, tag2]
---

# [Idea Title]

## Motivation
[Why this idea?]

## Rough Shape
[What would this look like? Key behaviors or components]

## Open Questions
- [Question 1]

## Related
- [Related files, issues, or ideas]
```

## Risks

- **Ideas directory missing**: `thoughts/shared/ideas/` may not exist. The Write tool will create
  it, but the skill should not assume it exists.
- **Naming collision**: Two ideas captured on the same day with similar descriptions would produce
  the same filename. Low risk; user can rename if needed.
- **Sub-agent team isolation**: The optional codebase-locator Task call must NOT pass `team_name`
  (per `shared/conventions.md` ADR-001).

## Recommended Next Steps

1. Create `plugin/ralph-hero/skills/draft-idea/SKILL.md` (new file, ~40–60 lines)
2. No other files to modify
3. No MCP server changes
4. No hook changes
5. Verify: skill appears in `/` autocomplete as `/ralph-hero:draft-idea`
6. Verify: runs inline, saves file to correct path, suggests `/ralph-hero:form-idea`

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/draft-idea/SKILL.md` - Create new interactive skill (new file)

### Will Read (Dependencies)
- `~/.claude/commands/draft_idea.md` - Source command to port (read-only reference)
- `plugin/ralph-hero/skills/shared/conventions.md` - Sub-agent isolation and conventions
- `plugin/ralph-hero/skills/ralph-status/SKILL.md` - Minimal skill frontmatter pattern
