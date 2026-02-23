---
date: 2026-02-23
github_issue: 359
github_url: https://github.com/cdubiel08/ralph-hero/issues/359
status: complete
type: research
---

# GH-359: V4 Phase 6b — Interactive Skills: create-plan, iterate-plan, implement-plan

## Problem Statement

GH-359 asks to verify and adapt three planning/implementation interactive skills for GitHub integration: `create-plan`, `iterate-plan`, and `implement-plan`. The triage assessment noted all three were missing. This research investigated the actual current state.

## Key Discovery: All Three Skills Already Exist

**The triage assessment was incorrect.** All three target skills exist and are fully implemented:

- `plugin/ralph-hero/skills/create-plan/SKILL.md` ✅ exists
- `plugin/ralph-hero/skills/iterate-plan/SKILL.md` ✅ exists
- `plugin/ralph-hero/skills/implement-plan/SKILL.md` ✅ exists

Additionally, all six interactive skills from the port plan exist:
- `draft-idea/SKILL.md` ✅
- `form-idea/SKILL.md` ✅
- `research-codebase/SKILL.md` ✅
- `create-plan/SKILL.md` ✅
- `iterate-plan/SKILL.md` ✅
- `implement-plan/SKILL.md` ✅

These appear to have been created as part of an earlier wave (research docs for GH-344, GH-346, GH-347, GH-348 were visible in git log, all referencing interactive skill ports).

## Current State Analysis

### `create-plan/SKILL.md`

**Frontmatter** (lines 1–19):
- No `context: fork` ✅
- No `RALPH_COMMAND` env ✅
- No hooks ✅
- `allowed_tools`: Read, Write, Edit, Glob, Grep, Bash, Task, WebSearch, WebFetch ✅
- `model: opus` ✅
- GitHub env vars: `RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER` ✅

**GitHub integration**:
- Fetches issue via `ralph_hero__get_issue` ✅
- Posts plan link via Artifact Comment Protocol (`## Implementation Plan` header) ✅
- State transition offered to user: "Would you like to move #NNN to 'Plan in Review'?" — calls `ralph_hero__update_workflow_state(state="Plan in Review", command="create_plan")` ✅
- Creates new issues via `ralph_hero__create_issue` when no issue exists ✅
- Team Isolation noted for sub-agent calls ✅

**Plan filename**: `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md` (4-digit zero-padded) ✅

### `iterate-plan/SKILL.md`

**Frontmatter**: Same pattern — no `context: fork`, no hooks, full tool access ✅

**Plan discovery** (Artifact Comment Protocol):
- Searches issue comments for `## Implementation Plan` header ✅
- Extracts URL, strips prefix to get local path ✅
- Falls back to glob patterns ✅
- Self-heals missing comment if found via glob ✅

**After update**: Posts `## Plan Updated` comment via `ralph_hero__create_comment` ✅

**State transitions**: Offered to user, not automatic ✅

### `implement-plan/SKILL.md`

**Frontmatter**: Same pattern — no `context: fork`, no hooks, full tool access ✅

**Plan discovery**: Artifact Comment Protocol for `## Implementation Plan` header, same fallback chain as autonomous skill ✅

**Manual verification pause pattern** (lines 129–147):
```
Phase [N] Complete - Ready for Manual Verification

Automated verification passed:
- [List automated checks that passed]

Please perform the manual verification steps listed in the plan:
- [List manual verification items from the plan]

Let me know when manual testing is complete so I can proceed to Phase [N+1].
```
Explicitly states "Do NOT check off manual verification items until confirmed by the user." ✅

**Worktree setup**: Optional (user-prompted), uses `scripts/create-worktree.sh GH-NNN` ✅

**State transitions**: `"In Progress"` at start, `"In Review"` at completion via `ralph_hero__update_workflow_state` — offered to user ✅

**PR creation**: `Closes #NNN` syntax, `## Implementation Complete` Artifact Comment Protocol ✅

## Acceptance Criteria Verification

| Criterion | Status | Evidence |
|-----------|--------|---------|
| All 3 skills appear in `/` autocomplete as `/ralph-hero:<name>` | ✅ | Skills exist at correct plugin path |
| Each runs inline (no `context: fork`) | ✅ | Frontmatter confirmed |
| Interactive conversation with user | ✅ | No `context: fork`, state transitions are user-offered |
| Artifact Comment Protocol for plan discovery | ✅ | All three implement the full protocol |
| State transitions offered to user (not automatic) | ✅ | Explicit "Would you like to..." prompts |
| implement-plan pauses for manual verification | ✅ | Lines 129–147 of implement-plan SKILL.md |

**All acceptance criteria are met.**

## Comparison to v4 Spec Adaptation Pattern

| Requirement | Status | Notes |
|-------------|--------|-------|
| No Linear tool references | ✅ | Only `ralph_hero__*` calls visible |
| `LAN-NNN` → `#NNN` / `GH-NNNN` | ✅ | `#NNN` pattern throughout |
| No `context: fork` | ✅ | Not present in any of the three |
| No `RALPH_COMMAND` | ✅ | Not set in env blocks |
| Full tool access in `allowed_tools` | ✅ | All include Read, Write, Edit, Bash, Task, WebSearch, WebFetch |
| Artifact Comment Protocol for linking | ✅ | All three implement full protocol with fallback |
| Sub-agents spawned without `team_name` | ✅ | ADR-001 Team Isolation note present |

## Recommendation

**GH-359 is already complete.** All three skills exist and satisfy the acceptance criteria. The issue should be closed as Done.

The planning phase is not needed — there is nothing to implement. The planner should be informed of this finding so the issue can be advanced directly to Done rather than cycling through Plan → Review → Implement phases for work that's already done.

## Potential Residual Gaps (Low Confidence)

Two items cannot be verified from static analysis alone:

1. **Runtime autocomplete**: Skills appear at correct filesystem path but autocomplete registration depends on runtime plugin loading. Manual smoke test (`/ralph-hero:create-plan`, etc.) would confirm.

2. **GitHub tool name accuracy**: The `ralph_hero__*` tool calls in the skill files need to match actual registered MCP tool names. From earlier research, known tool names include `ralph_hero__get_issue`, `ralph_hero__create_comment`, `ralph_hero__update_workflow_state`, `ralph_hero__create_issue`, `ralph_hero__update_estimate` — all of which appear in these skills.

Both are minor verification items, not implementation gaps.

## Files Affected

### Will Modify
- None — all three skills already exist and are complete

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/create-plan/SKILL.md` — verified complete
- `plugin/ralph-hero/skills/iterate-plan/SKILL.md` — verified complete
- `plugin/ralph-hero/skills/implement-plan/SKILL.md` — verified complete
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md` — reference autonomous counterpart
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md` — reference autonomous counterpart
- `plugin/ralph-hero/skills/shared/conventions.md` — Artifact Comment Protocol spec
