---
date: 2026-02-22
github_issue: 347
github_url: https://github.com/cdubiel08/ralph-hero/issues/347
status: complete
type: research
---

# Add `iterate-plan` Interactive Skill — Research Findings

## Problem Statement

Port the workspace-level `iterate_plan.md` command into the ralph-hero plugin as
`plugin/ralph-hero/skills/iterate-plan/SKILL.md`, making it available as
`/ralph-hero:iterate-plan`. The skill lets users update existing implementation plan documents
based on feedback, with interactive confirmation steps and optional codebase research.

## Current State Analysis

### Source Command

**Location**: `~/.claude/commands/iterate_plan.md` (full content reviewed)

The command implements a multi-phase interactive workflow:

1. **Ticket Resolution** — Resolve a `LAN-\d+` ticket or file path to a plan document; create Linear ticket if missing
2. **State transition** — Move Linear ticket to "Plan in Progress", post iteration start comment
3. **Initial Response** — Handle input scenarios (no plan, no feedback, or both provided)
4. **Read & Understand** — Read plan fully, parse requested changes, check for ticket link
5. **Research if needed** — Spawn parallel codebase sub-tasks only when feedback requires new technical understanding
6. **Confirm before changing** — Present understanding + approach, get user approval
7. **Update the plan** — Surgical edits using Edit tool; maintain structure and quality
8. **Review changes** — Show what changed, offer further adjustments
9. **Update Linear ticket** — Offer to update ticket description + comment

Key characteristics:
- Model: `opus` (quality over speed for skeptical plan review)
- Highly interactive — multiple confirmation checkpoints
- No `context: fork` (inline conversation required)
- Spawns research sub-tasks only when changes require new technical understanding
- Skeptical: questions vague feedback, verifies feasibility, points out conflicts

### Target Skill

**Does not exist**: `plugin/ralph-hero/skills/iterate-plan/` is absent.

### Plan Document Specification

From `thoughts/shared/plans/2026-02-21-interactive-skills-port.md`, the required adaptations:

| Source (Linear) | Target (GitHub) |
|-----------------|-----------------|
| `LAN-\d+` issue resolution | `#NNN` GitHub issue number |
| `mcp__plugin_linear_linear__get_issue` | `ralph_hero__get_issue` |
| Check ticket attachments for plan URL | Search issue comments for `## Implementation Plan` header (Artifact Comment Protocol) |
| `linear_ticket` frontmatter | `github_issue` / `github_issues` frontmatter |
| `linear_url` | `github_url` (`https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN`) |
| `mcp__plugin_linear_linear__update_issue` state | `ralph_hero__update_workflow_state(state="Plan in Progress")` |
| `mcp__plugin_linear_linear__create_comment` | `ralph_hero__create_comment` |

### Artifact Comment Protocol (plan discovery)

From `plugin/ralph-hero/skills/shared/conventions.md`:

1. Fetch issue with comments via `ralph_hero__get_issue`
2. Search comments for `## Implementation Plan` header
3. Use **most recent** match if multiple found
4. Extract GitHub URL from the line immediately after the header
5. Strip `https://github.com/OWNER/REPO/blob/main/` prefix → local path
6. Read local file
7. **Fallback globs** if no comment:
   - `thoughts/shared/plans/*GH-${number}*`
   - `thoughts/shared/plans/*GH-$(printf '%04d' ${number})*`
8. **Self-heal**: post the `## Implementation Plan` comment if found only via glob

This is the same discovery logic used by `ralph-impl` (verified in `ralph-impl/SKILL.md`).

### State Transition Behavior

The source offers state management at two points:
- **Start**: transition to "Plan in Progress" if not already there or in "Plan in Review"
- **Major changes**: if plan was in "Plan in Review" and significant changes made, offer to revert to "Plan in Progress"

GitHub workflow states are identical to Linear states here — "Plan in Progress" and "Plan in Review" are valid states in the GitHub Projects V2 workflow.

### Plan File Conventions

From `shared/conventions.md`:
- Single issue plan: `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md`
- Group plan: `thoughts/shared/plans/YYYY-MM-DD-group-GH-NNNN-description.md`
- Frontmatter fields: `github_issues: [NNN]`, `github_urls: [...]`, `primary_issue: NNN`

## Key Discoveries

1. **This is the most GitHub-integrated of the interactive skills** (alongside `create-plan` and
   `implement-plan`). It requires `ralph_hero__get_issue`, `ralph_hero__update_workflow_state`,
   and `ralph_hero__create_comment` — making it S-estimate appropriate.

2. **Plan discovery is the critical adaptation**. The source uses Linear ticket attachments; the
   port must use the Artifact Comment Protocol (`## Implementation Plan` header in issue
   comments). This pattern is already established and used by `ralph-impl`.

3. **No "create issue if missing" step needed**. The source creates a Linear ticket if one
   doesn't exist. For the GitHub port, the issue always exists (user provides `#NNN`), so this
   step is eliminated.

4. **State transition offer should be conditional**. Only transition to "Plan in Progress" if
   the issue is currently in "Plan in Review" or "Ready for Plan". If already "Plan in
   Progress", skip. Use `ralph_hero__update_workflow_state` with explicit state name (not
   `__LOCK__` — this is an interactive skill, not an autonomous lock).

5. **Research sub-tasks must follow team isolation**. The optional codebase research spawns
   (codebase-locator, codebase-analyzer, etc.) must NOT pass `team_name` per ADR-001 in
   `shared/conventions.md`.

6. **`allowed_tools` should include MCP tools**. Unlike `draft-idea`, this skill needs
   `ralph_hero__get_issue`, `ralph_hero__update_workflow_state`, `ralph_hero__create_comment`
   — which are available as MCP tools automatically. No explicit `allowed_tools` restriction
   needed; default access is sufficient.

7. **Model is `opus`**. Source command uses opus for skeptical review quality. Confirmed in the
   plan doc's common frontmatter pattern.

8. **No `context: fork`**. Must run inline for interactive confirmation checkpoints.

9. **Argument parsing**: Accept either `#NNN` issue number or a local file path. If neither, prompt
   interactively. Remaining arguments are the feedback/requested changes.

## Potential Approaches

### Option A: Full port with all interactive features (recommended)

Port the complete workflow: resolve → read → research if needed → confirm → edit → review →
update issue. Preserve all confirmation checkpoints.

**Pros**: Matches source behavior; skeptical/interactive quality maintained; users can course-correct.
**Cons**: More lines than simpler skills — but complexity is warranted for plan updates.

### Option B: Simplified port (skip confirmation step)

Remove the "present understanding and confirm" step (Step 3 in source), go directly from
reading the plan to making changes.

**Pros**: Faster to implement.
**Cons**: Eliminates the most valuable safety check (user confirms before changes are made).
Not recommended — the confirmation step is core to the skill's value.

## Recommended Implementation

Use **Option A**. The SKILL.md should:

```yaml
---
description: Iterate on an existing implementation plan — reads the linked plan, understands your feedback, confirms approach, and makes surgical updates. Use when you want to refine, extend, or correct an approved plan.
argument-hint: "[#NNN or plan-path] [optional: feedback]"
model: opus
---
```

**Workflow** (6 active steps):

1. **Resolve plan**: Accept `#NNN` or file path. If `#NNN`, use `ralph_hero__get_issue` to get
   comments, search for `## Implementation Plan` header, convert URL to local path. If file
   path, read frontmatter for `github_issue`. If no feedback provided, prompt interactively.

2. **State transition** (conditional): If issue in "Plan in Review" or "Ready for Plan",
   offer to move to "Plan in Progress" via `ralph_hero__update_workflow_state`. Post
   `## Plan Iteration Started` comment via `ralph_hero__create_comment`.

3. **Read & understand**: Read plan fully. Parse requested changes. Determine if research needed.

4. **Research if needed**: Spawn parallel sub-agents (codebase-locator, codebase-analyzer,
   codebase-pattern-finder) only when feedback requires new technical knowledge. Wait for all.

5. **Confirm before changing**: Present understanding + planned edits. Wait for user approval.

6. **Edit plan**: Use Edit tool for surgical changes. Maintain structure, file:line accuracy,
   success criteria quality. Present changes. Offer further adjustments.

7. **Update issue**: Post `## Plan Updated` comment via `ralph_hero__create_comment`. If major
   changes and issue was in "Plan in Review", offer to move back to "Plan in Progress".

## Risks

- **Plan comment not found**: Issue may have no `## Implementation Plan` comment if plan was
  created before the Artifact Comment Protocol was enforced. Fallback glob
  `thoughts/shared/plans/*GH-${number}*` handles this. Self-heal by posting the missing comment.
- **Multiple plan versions**: If plan was iterated multiple times, there may be multiple
  `## Implementation Plan` comments. Always use the **most recent** (last) match.
- **State confusion**: `update_workflow_state` with `__LOCK__` would be wrong here (autonomous
  intent). Must use explicit state name `"Plan in Progress"`.
- **Research sub-agent team isolation**: Sub-tasks for codebase research must not inherit team
  context. Follow ADR-001.

## Recommended Next Steps

1. Create `plugin/ralph-hero/skills/iterate-plan/SKILL.md` (~80–100 lines)
2. No MCP server changes needed — all required tools (`ralph_hero__get_issue`,
   `ralph_hero__update_workflow_state`, `ralph_hero__create_comment`) already exist
3. No hook changes (interactive skill — no state gate hooks)
4. Verify: `/ralph-hero:iterate-plan #NNN feedback` resolves plan and enters interactive flow
5. Verify: plan discovery via Artifact Comment Protocol works end-to-end

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/iterate-plan/SKILL.md` - Create new interactive skill (new file)

### Will Read (Dependencies)
- `~/.claude/commands/iterate_plan.md` - Source command to port (read-only reference)
- `plugin/ralph-hero/skills/shared/conventions.md` - Artifact Comment Protocol, sub-agent isolation
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md` - Plan discovery pattern reference
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md` - Plan structure and frontmatter conventions
