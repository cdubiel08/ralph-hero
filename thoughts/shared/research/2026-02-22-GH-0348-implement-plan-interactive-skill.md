---
date: 2026-02-22
github_issue: 348
github_url: https://github.com/cdubiel08/ralph-hero/issues/348
status: complete
type: research
---

# Research: Add `implement-plan` Interactive Skill (GH-348)

## Problem Statement

Port the workspace-level `implement_plan.md` command into the ralph-hero plugin as
`plugin/ralph-hero/skills/implement-plan/SKILL.md`. This is the 6th and most complex of 6
interactive skills being ported (parent: #342). It bridges the gap between an approved plan
document and actual code changes — finding the plan via Artifact Comment Protocol, setting up a
worktree, implementing phase by phase, and pausing for human verification between phases.

## Current State Analysis

### Source Command

**Location**: `~/projects/.claude/commands/implement_plan.md` — fully implemented (~150 lines)

4-step workflow:
1. **Ticket resolution** — accepts `LAN-XXX` ID or plan file path; discovers linked plan via Linear
   attachments or glob fallback
2. **Ensure Linear ticket exists** — creates one if plan has no ticket link
3. **Transition to "In Progress"** — updates Linear state, posts start comment
4. **Implement** — reads plan phases, checks off items, verifies each phase, pauses for human review

Key characteristics:
- Uses `mcp__plugin_linear_linear__get_issue`, `mcp__plugin_linear_linear__update_issue`,
  `mcp__plugin_linear_linear__create_comment`
- `LAN-XXX` ticket ID format; `linear_ticket` frontmatter in plan files
- Manual verification pause after each phase (human-in-the-loop)
- No `context:` or model specified in frontmatter (defaults apply)
- No worktree setup — assumes working directory (this differs from the ralph-hero pattern)

### What Does NOT Exist

- `plugin/ralph-hero/skills/implement-plan/` — not created yet
- No interactive skills exist in the plugin yet (all 6 are new)

### Related: Autonomous `ralph-impl` Skill

`plugin/ralph-hero/skills/ralph-impl/SKILL.md` (427 lines) is the autonomous counterpart.
Key differences:

| Aspect | Autonomous (`ralph-impl`) | Interactive (`implement-plan`) |
|--------|--------------------------|-------------------------------|
| `context` | `fork` | None (inline conversation) |
| Hooks | 6+ hooks (plan required, worktree gate, state gate, staging gate, branch gate, verify commit, verify PR, postcondition) | None |
| `RALPH_COMMAND` | `impl` | Omit |
| User interaction | None | Prompts, pauses for verification |
| Phase execution | One phase per invocation | All phases, pause between each |
| Model | `opus` | `opus` |
| Worktree setup | Yes (mandatory, via `create-worktree.sh`) | Yes (recommended, same script) |

## Key Discoveries

### 1. Plan Discovery via Artifact Comment Protocol

The plan file is found by searching issue comments for `## Implementation Plan` header
(per `shared/conventions.md`). The source uses Linear attachments; the port uses comment parsing:

1. `ralph_hero__get_issue(number)` — returns up to 10 comments
2. Search comments for `## Implementation Plan` header
3. Extract GitHub URL from first line after header
4. Convert to local path: strip `https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/`
5. Glob fallback if comment not found: `thoughts/shared/plans/*GH-{number}*` (try both padded/unpadded)

### 2. Worktree Setup Pattern

The source command does NOT set up a worktree. The ralph-hero plugin has a well-established worktree
pattern (used by `ralph-impl`). The port should adopt it:

```bash
./scripts/create-worktree.sh GH-NNN
# Creates: worktrees/GH-NNN/ on branch feature/GH-NNN
```

Script location: `scripts/create-worktree.sh` (repo root, not `plugin/ralph-hero/scripts/`).
The script is idempotent — safe to call if worktree already exists.

Worktree path: `$PROJECT_ROOT/worktrees/$TICKET_ID` (e.g., `worktrees/GH-348/`)

The interactive skill should **suggest** worktree setup (not enforce it) since the user may prefer
to implement in the main working directory for small changes.

### 3. State Transitions

| Event | State | Tool |
|-------|-------|------|
| Implementation starts | "In Progress" | `ralph_hero__update_workflow_state(state="In Progress")` |
| All phases complete | "In Review" | `ralph_hero__update_workflow_state(state="In Review")` |

No `__LOCK__`/`__COMPLETE__` semantic intents needed — direct state names work for interactive skills
since there are no hook-enforced state gates.

### 4. Comment Protocol

| Event | Header | Content |
|-------|--------|---------|
| Start | `## Implementation Started` | "Beginning implementation of [plan title]." |
| Complete | `## Implementation Complete` | PR URL, branch, automated checks passed, ready for review |

The `## Implementation Complete` header is required by the Artifact Comment Protocol — downstream
tools parse it to find the PR.

### 5. Tool Substitutions (Linear → GitHub)

| Linear | GitHub |
|--------|--------|
| `mcp__plugin_linear_linear__get_issue` | `ralph_hero__get_issue` |
| `mcp__plugin_linear_linear__update_issue(state="In Progress")` | `ralph_hero__update_workflow_state(state="In Progress")` |
| `mcp__plugin_linear_linear__update_issue(state="In Review")` | `ralph_hero__update_workflow_state(state="In Review")` |
| `mcp__plugin_linear_linear__create_comment` | `ralph_hero__create_comment` |
| `LAN-\d+` pattern | `#NNN` or `GH-NNN` pattern |
| `linear_ticket: LAN-XXX` in plan frontmatter | `github_issue: NNN` |
| `linear_url: ...` in plan frontmatter | `github_url: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN` |
| Linear attachment URL for plan discovery | Comment-based Artifact Comment Protocol |
| "In Review" Linear state | `ralph_hero__update_workflow_state(state="In Review", command="implement_plan")` |

### 6. PR Creation

The source says "Create PR with `/commit-push-pr`". The ralph-hero equivalent uses `gh pr create`
directly. The completion comment should include the PR URL. PR body must use `Closes #NNN` syntax
(per conventions.md — GitHub requires bare `#NNN`, not `GH-NNN`).

### 7. Phase Verification Pattern (Preserve as-is)

The source command's verification approach is robust and must be preserved:

```
Phase [N] Complete - Ready for Manual Verification

Automated verification passed:
- [List automated checks that passed]

Please perform the manual verification steps listed in the plan:
- [List manual verification items from the plan]

Let me know when manual testing is complete so I can proceed to Phase [N+1].
```

Do not check off manual verification items until confirmed by user.
If instructed to execute multiple phases consecutively, skip pauses until last phase.

### 8. Interactive Frontmatter

From `thoughts/shared/plans/2026-02-21-interactive-skills-port.md:62-82`:

```yaml
---
description: Implement an approved plan for a GitHub issue, phase by phase with manual verification pauses. Finds plan via Artifact Comment Protocol, sets up worktree, tracks progress. Use when you want to implement a planned issue interactively.
argument-hint: <issue-number-or-plan-path>
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

## Complexity Assessment

This is the **most complex** of the 6 interactive skills:
- Plan discovery via Artifact Comment Protocol (multi-step, with fallback)
- Worktree management
- State transitions at start and end
- Multi-phase implementation with checkboxes
- Human verification pauses between phases
- PR creation and `## Implementation Complete` comment

Estimate S is correct — it is still a single-file port with well-specified adaptations, but the
builder should budget more time than for simpler skills (draft-idea, form-idea).

## Potential Approaches

### Approach A: Full Port with Worktree Support (Recommended)

Port the complete source workflow with all adaptations plus worktree setup (which the source lacks).
Preserve the human verification pause pattern exactly.

**Pros**: Feature-complete, consistent with ralph-hero conventions, most useful to users
**Cons**: Most code to write among the 6 skills

### Approach B: Minimal Port Without Worktree

Port the workflow without worktree setup — user manages their working directory.

**Pros**: Simpler
**Cons**: Diverges from ralph-hero conventions; users implementing in main directory risk polluting
the main branch with in-progress work

**Recommendation**: Approach A. Worktree setup is a short addition (4-5 lines of bash) and is the
established ralph-hero pattern. The manual verification pause is the core value of this skill —
preserve it exactly.

## Risks

1. **Plan not found**: If the issue has no `## Implementation Plan` comment and no glob match,
   the skill must error clearly: "No plan found for #NNN. Create one with `/ralph-hero:create-plan`."

2. **Worktree already exists**: `create-worktree.sh` is idempotent (exits 0 if path exists). The
   skill should detect this and resume from the existing worktree.

3. **Multi-issue group plans**: Group plans cover multiple issues. If the plan frontmatter has
   `github_issues: [343, 344, 345]`, the skill should note which issue's portion it's implementing.
   For simplicity, implement the single-issue case first; group support is a follow-up.

4. **`context: fork` omission**: Must NOT be added. This is an interactive skill.

5. **Verification step commands**: The source references `pnpm lint && pnpm type-check && uv run pytest`.
   The ralph-hero repo uses `npm test` in the MCP server. The skill should read the plan's success
   criteria for the actual verification commands rather than hardcoding any.

## Recommended Next Steps

1. Create `plugin/ralph-hero/skills/implement-plan/SKILL.md` using the interactive frontmatter
2. Implement 4-step workflow:
   - Step 1: Parse argument (#NNN or file path)
   - Step 2: Discover plan via Artifact Comment Protocol (comment search → glob fallback)
   - Step 3: Set up worktree (`scripts/create-worktree.sh GH-NNN`)
   - Step 4: Transition to "In Progress", post start comment, implement phases with verification pauses
   - Step 5: Transition to "In Review", post `## Implementation Complete` comment with PR URL
3. Preserve manual verification pause pattern exactly
4. Test: run with an issue that has a linked plan, verify it finds the plan and pauses correctly

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/implement-plan/SKILL.md` - New file to create (the skill itself)

### Will Read (Dependencies)
- `~/projects/.claude/commands/implement_plan.md` - Source command to adapt
- `plugin/ralph-hero/skills/shared/conventions.md` - Artifact Comment Protocol, link formatting
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md` - Autonomous impl skill for worktree pattern reference
- `scripts/create-worktree.sh` - Worktree creation script (used at runtime)
- `thoughts/shared/plans/2026-02-21-interactive-skills-port.md` - Port specification
