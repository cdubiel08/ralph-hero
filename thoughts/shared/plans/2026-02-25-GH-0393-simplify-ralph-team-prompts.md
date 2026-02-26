---
date: 2026-02-25
status: draft
github_issues: [393]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/393
primary_issue: 393
---

# Simplify Ralph Team Prompts

## Overview

Rewrite all ralph-team prompts — coordinator skill and 3 worker agents — from procedural tool-call style to natural language. Remove code examples, flatten two-level delegation, and align with the team design documented in `docs/agent-teams.md`.

## Current State Analysis

The coordinator (`skills/ralph-team/SKILL.md`) has already been condensed to ~8 lines of body but is now too sparse — it doesn't mention task creation, metadata, or incremental phase progression. Workers (`agents/ralph-analyst.md`, `ralph-builder.md`, `ralph-integrator.md`) still contain numbered "Task Loop" sections with code examples showing how to nest Skill() calls inside Task() subagents.

### Key Problems:
- Coordinator body is too minimal — no guidance on task creation, assignment, or phase progression
- Workers still use two-level delegation (worker → Task() → Skill())
- Workers have no guidance on self-assignment or waiting for upstream work
- No mention of metadata for inter-phase information passing

### Key Discoveries:
- Official Claude docs: "Give teammates enough context in spawn prompts — they do NOT inherit the lead's conversation history"
- Official docs: "Claude Opus 4.6 has a strong predilection for subagents and may spawn them where a simpler approach suffices"
- Official docs: normal prompting works better than `CRITICAL/MUST` style on current models
- Official docs: "Three focused teammates often outperform five scattered ones"
- Resumability operates at the workflow level (GitHub state + idempotent skills), not session level

## Desired End State

After this plan:
- All prompts read as natural language descriptions of behavior, with zero tool call examples
- Coordinator creates tasks incrementally, enriches them with context, assigns owners, and uses metadata for inter-phase handoff
- Workers invoke skills directly (no Task() wrapping) and self-assign from TaskList
- Spawn prompts give workers issue context and describe what kinds of tasks to look for
- Behavior matches `docs/agent-teams.md`

### How to verify:
- Read all 4 files and confirm no code blocks or tool call syntax remain
- Confirm alignment with `docs/agent-teams.md`
- Run `/ralph-hero:ralph-team` against a real issue and confirm workers pick up and complete tasks

## What We're NOT Doing

- Changing hooks (they're already simple shell scripts that work fine)
- Changing the 3-station model (analyst/builder/integrator)
- Changing the MCP server or `detect_pipeline_position` tool
- Removing agent teams in favor of subagents
- Changing `ralph-team-loop.sh`

## Implementation Approach

Single phase — these are 4 prompt files, not code. Rewrite them all at once.

## Phase 1: Rewrite All Prompts

### Changes Required:

#### 1. Coordinator Skill
**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`

**Frontmatter**: Keep as-is (model, allowed_tools, env, hooks are all correct).

**Body rewrite** — describe the coordinator's job in natural language, following `docs/agent-teams.md`:

The coordinator's algorithm:

1. **Assess** — fetch the issue and detect its pipeline position. If no issue number given, scan the project board for actionable work. If terminal, report and stop.
2. **Create team** — named after the issue.
3. **Spawn workers** — one per role needed. Spawn prompts include the issue number, title, current state, and what kinds of tasks the worker should look for. Workers are autonomous — they check TaskList, self-assign, invoke skills, and report results.
4. **Build task list** — create tasks for the current and upcoming phases. Enrich each task with issue context (number, title, estimate, group membership, artifact paths from prior phases). Assign an owner to every task. Use metadata to pass information between phases (artifact paths, verdicts).
5. **Respond to events** — when a task completes, create follow-up tasks for the next phase if ready. When a review returns NEEDS_ITERATION, create a new planning task. When validation fails, create a new implementation task. When all work is done, shut down the team.

Key principles:
- No code blocks or tool call syntax
- Tasks are the coordination mechanism — assignment is communication
- Task descriptions enriched with everything the worker needs to do the job
- Metadata carries inter-phase artifacts (research doc paths, plan doc paths, verdicts)
- Tasks added incrementally as phases complete, not all predicted upfront

#### 2. Analyst Agent
**File**: `plugin/ralph-hero/agents/ralph-analyst.md`

**Frontmatter**: Remove `Task` from tools list (no longer nesting). Keep everything else.

**Body rewrite** — natural language, no code blocks:

You are an analyst. You handle triage, splitting large issues, researching codebases, and creating implementation plans.

Your loop:
- Check TaskList for unblocked tasks matching your role (triage, split, research, planning)
- Claim an unclaimed task by setting yourself as owner and marking it in-progress
- If no tasks are available, wait briefly — upstream work may still be completing
- Invoke the appropriate skill directly (ralph-triage, ralph-split, ralph-research, ralph-plan)
- When done, update the task as completed with results in the description and any artifact paths in metadata
- Check TaskList again for more work before stopping

For split/triage work, include sub-ticket IDs and estimates in the task update.

#### 3. Builder Agent
**File**: `plugin/ralph-hero/agents/ralph-builder.md`

**Frontmatter**: Remove `Task` from tools list. Keep everything else.

**Body rewrite** — natural language, no code blocks:

You are a builder. You review plans and implement code.

Your loop:
- Check TaskList for unblocked tasks matching your role (plan review, implementation)
- Claim an unclaimed task by setting yourself as owner and marking it in-progress
- If no tasks are available, wait briefly — upstream work may still be completing
- Invoke the appropriate skill directly (ralph-review for reviews, ralph-impl for implementation)
- When done, update the task as completed with results in the description
- For reviews, include the full verdict (APPROVED or NEEDS_ITERATION) in both description and metadata so the coordinator can act on it
- Do not push to remote — the integrator handles PR creation
- Check TaskList again for more work before stopping

#### 4. Integrator Agent
**File**: `plugin/ralph-hero/agents/ralph-integrator.md`

**Frontmatter**: Remove `Task` from tools list. Keep everything else.

**Body rewrite** — natural language, no code blocks:

You are an integrator. You validate implementations, create PRs, and merge them.

Your loop:
- Check TaskList for unblocked tasks matching your role (validation, PR creation, merging)
- Claim an unclaimed task by setting yourself as owner and marking it in-progress
- If no tasks are available, wait briefly — upstream work may still be completing
- For validation: invoke ralph-val directly, report pass/fail verdict in task description and metadata
- For PR creation: push the branch, create the PR via gh, move issues to "In Review" via advance_children, update task with PR URL
- For merging: check PR readiness, merge when ready, clean up worktree via remove-worktree script, move issues to "Done", advance parent if applicable
- Check TaskList again for more work before stopping

Preserve the PR creation and merge procedural knowledge as natural language — these are inline git/gh operations, not skill invocations.

### Success Criteria:

#### Automated Verification:
- [x] No code blocks (triple-backtick) remain in any of the 4 files
- [x] `Task` is removed from tools list in all 3 worker agents
- [x] All files parse valid YAML frontmatter
- [x] Prompts align with `docs/agent-teams.md`

#### Manual Verification:
- [ ] Run `/ralph-hero:ralph-team [issue]` against a real issue
- [ ] Workers pick up tasks and invoke skills directly
- [ ] Pipeline progresses through at least research → plan stages
- [ ] No "Task() subagent" nesting observed in worker behavior

## References

- Design doc: `docs/agent-teams.md`
- Current files: `plugin/ralph-hero/skills/ralph-team/SKILL.md`, `plugin/ralph-hero/agents/ralph-{analyst,builder,integrator}.md`
- Official docs: https://code.claude.com/docs/en/agent-teams
- Official prompting guidance: https://platform.claude.com/docs/en/docs/build-with-claude/prompt-engineering/claude-4-best-practices
- Git history: `141a21f` (original 690-line v1), `26d4954` (first simplification), `1d50f57` (current 3-station)
