---
date: 2026-02-18
status: draft
github_issue: 69
github_url: https://github.com/cdubiel08/ralph-hero/issues/69
---

# Move PR Creation Responsibility from Team-Lead to Integrator Worker

## Overview

The team-lead currently performs PR creation (git push + `gh pr create`) as its "only direct work." This violates the lead's pure-coordinator role and creates a bottleneck. The integrator already handles the post-PR lifecycle (merge, worktree cleanup, state transitions) and is single-instance/serialized -- making it the natural owner of the entire PR lifecycle.

This change moves PR creation logic from the team-lead's SKILL.md into the integrator agent definition, updates all downstream references in builder, spawn templates, and conventions, and makes the lead a pure coordinator with zero direct work.

## Current State Analysis

PR creation is referenced across 6 files:

1. **SKILL.md** -- Lead identity lists PR creation as direct work (Section 1). Section 4.2 marks PR task as "lead's direct work." Section 4.4 dispatch loop responsibility #4 handles PR creation. Section 4.5 contains the full PR creation procedure. Section 6 spawn table does not list "Create PR" for integrator.
2. **ralph-integrator.md** -- Task loop only claims "Merge" or "Integrate" tasks (line 13). No PR creation awareness.
3. **ralph-builder.md** -- Step 6 hands off to team-lead for PR creation (line 22). "DO NOT push" instruction references lead (line 30).
4. **templates/spawn/implementer.md** -- "The lead handles pushing and PR creation" (line 7).
5. **templates/spawn/integrator.md** -- Only mentions "Merge PR" tasks (line 1). No "Create PR" awareness.
6. **conventions.md** -- Pipeline Handoff Protocol sends builder (impl done) to `team-lead` (line 101).

## Desired End State

The integrator owns the full PR lifecycle: create PR, then merge PR. The lead is a pure coordinator with zero direct work. Builders hand off to the integrator (not the lead) when implementation completes.

### Verification
- [ ] SKILL.md Section 1 no longer lists "PR creation" as lead's direct work
- [ ] SKILL.md Section 4.2 no longer marks PR task as "lead's direct work"
- [ ] SKILL.md Section 4.4 no longer lists PR creation as a dispatch responsibility
- [ ] SKILL.md Section 4.5 is removed entirely
- [ ] SKILL.md Section 6 spawn table includes "Create PR" mapping to integrator
- [ ] ralph-integrator.md task loop claims "Create PR" tasks alongside "Merge" tasks
- [ ] ralph-integrator.md contains the full PR creation procedure (push + gh pr create + state transitions)
- [ ] ralph-builder.md step 6 hands off to integrator, not team-lead
- [ ] ralph-builder.md "DO NOT push" instruction references integrator, not lead
- [ ] templates/spawn/implementer.md references integrator, not lead
- [ ] templates/spawn/integrator.md includes "Create PR" task awareness
- [ ] conventions.md Pipeline Handoff Protocol sends builder (impl done) to `ralph-integrator`

## What We're NOT Doing

- Changing the builder's "DO NOT push" constraint (integrator still owns push)
- Adding new MCP tools or TypeScript changes
- Changing the integrator's serialization model
- Adding a dedicated PR creation skill (over-engineering for this scope)
- Changing the task subject pattern "Create PR for GH-NNN" (already exists)

## Implementation Approach

A single pass through 6 markdown files, moving PR creation logic from SKILL.md into ralph-integrator.md and updating all references. The changes are purely documentation/instruction changes with no code involved.

---

## Phase 1: Update SKILL.md -- Remove Lead's PR Creation Role

### Overview

Remove all PR creation responsibilities from the team-lead's skill definition. The lead becomes a pure coordinator.

### Changes Required

#### 1. Remove PR creation from lead's identity
**File**: [`plugin/ralph-hero/skills/ralph-team/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md)

**Section 1 - Identity** (line 35): Remove `- PR creation (after implementation completes)` from "Your ONLY direct work" list.

**Before**:
```markdown
**Your ONLY direct work**:
- Task list management (create/assign/monitor)
- GitHub issue queries (read-only to detect pipeline position)
- PR creation (after implementation completes)
- Team lifecycle (TeamCreate, teammate spawning, shutdown, TeamDelete)
- **Finding new work for idle teammates** (this is your most important job)
```

**After**:
```markdown
**Your ONLY direct work**:
- Task list management (create/assign/monitor)
- GitHub issue queries (read-only to detect pipeline position)
- Team lifecycle (TeamCreate, teammate spawning, shutdown, TeamDelete)
- **Finding new work for idle teammates** (this is your most important job)
```

#### 2. Make PR task delegatable
**Section 4.2** (line 128): Remove `**PR task** is always lead's direct work (not delegated to a teammate).`

#### 3. Remove PR creation from dispatch responsibilities
**Section 4.4** (line 147): Remove dispatch responsibility #4 about PR creation. Renumber if needed.

**Before** (line 147):
```markdown
4. **PR creation**: When all implementation tasks for an issue/group complete, push and create PR (Section 4.5). This is your only direct work.
```

Remove this line entirely.

#### 4. Remove Section 4.5 entirely
**Section 4.5** (lines 151-157): Delete the entire "Lead Creates PR (Only Direct Work)" section. Renumber subsequent sections (4.6 becomes 4.5).

**Remove**:
```markdown
### 4.5 Lead Creates PR (Only Direct Work)

After implementation completes, lead pushes and creates PR via `gh pr create`:
- **Single issue**: `git push -u origin feature/GH-NNN` from `worktrees/GH-NNN`. Title: `feat: [title]`. Body: summary, `Closes #NNN` (bare `#NNN` here is GitHub PR syntax, not our convention), change summary from builder's task description.
- **Group**: Push from `worktrees/GH-[PRIMARY]`. Body: summary, `Closes #NNN` for each issue (bare `#NNN` is GitHub PR syntax), changes by phase.

**After PR creation**: Move ALL issues (and children) to "In Review" via `advance_children`. NEVER to "Done" -- that requires PR merge (external event). Create "Merge PR for #NNN" task for Integrator to pick up. Then return to dispatch loop.
```

#### 5. Add "Create PR" to integrator spawn table
**Section 6** (line 188): Add "Create PR" to the integrator row in the spawn table.

**Before**:
```markdown
| "Merge" or "Integrate" | integrator | `integrator.md` | ralph-integrator |
```

**After**:
```markdown
| "Create PR" | integrator | `integrator.md` | ralph-integrator |
| "Merge" or "Integrate" | integrator | `integrator.md` | ralph-integrator |
```

### Success Criteria

#### Automated Verification
- [ ] `grep -c "PR creation" plugin/ralph-hero/skills/ralph-team/SKILL.md` returns 0
- [ ] `grep -c "Section 4.5" plugin/ralph-hero/skills/ralph-team/SKILL.md` returns 0
- [ ] `grep -c "Lead Creates PR" plugin/ralph-hero/skills/ralph-team/SKILL.md` returns 0
- [ ] `grep "Create PR" plugin/ralph-hero/skills/ralph-team/SKILL.md` matches in spawn table

#### Manual Verification
- [ ] Section 1 identity no longer mentions PR creation
- [ ] Section 4.4 dispatch loop has no PR creation responsibility
- [ ] Section 4.5 is "Shutdown and Cleanup" (renumbered from 4.6)
- [ ] Spawn table routes "Create PR" tasks to integrator

---

## Phase 2: Update ralph-integrator.md -- Add PR Creation Capability

### Overview

Expand the integrator agent to handle both "Create PR" and "Merge PR" tasks. Move the full PR creation procedure from SKILL.md Section 4.5 into the integrator.

### Changes Required

#### 1. Expand task matching
**File**: [`plugin/ralph-hero/agents/ralph-integrator.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-integrator.md)

**Line 13**: Expand task matching to include "Create PR".

**Before**:
```markdown
1. `TaskList()` — find tasks with "Merge" or "Integrate" in subject, `pending`, empty `blockedBy`, no `owner`
```

**After**:
```markdown
1. `TaskList()` — find tasks with "Create PR", "Merge", or "Integrate" in subject, `pending`, empty `blockedBy`, no `owner`
```

#### 2. Add dispatch by task type
**After line 3** (TaskGet step): Add dispatch logic that routes to either PR creation or merge.

**Before**:
```markdown
3. `TaskGet(taskId)` — extract issue number from description
4. Fetch issue: `get_issue(number)` — verify In Review state, find PR link in comments
```

**After**:
```markdown
3. `TaskGet(taskId)` — extract issue number (and group info if present) from description
4. Dispatch by task subject:
   - **"Create PR"**: Go to PR Creation Procedure below
   - **"Merge" or "Integrate"**: Go to Merge Procedure below
```

#### 3. Add PR Creation Procedure section
**After the dispatch step**, add the full PR creation procedure (moved from SKILL.md Section 4.5):

```markdown
## PR Creation Procedure

When task subject contains "Create PR":

1. Fetch issue: `get_issue(number)` — extract title, group context
2. Determine worktree and branch:
   - **Single issue**: Worktree at `worktrees/GH-NNN`, branch `feature/GH-NNN`
   - **Group**: Worktree at `worktrees/GH-[PRIMARY]`, branch `feature/GH-[PRIMARY]`
3. Push branch: `git push -u origin [branch]` from the worktree directory
4. Create PR via `gh pr create`:
   - **Single issue**: Title: `feat: [title]`. Body: summary + `Closes #NNN` (bare `#NNN` is GitHub PR syntax) + change summary from task description.
   - **Group**: Body: summary + `Closes #NNN` for each issue (bare `#NNN` is GitHub PR syntax) + changes by phase.
5. Move ALL issues (and children) to "In Review" via `advance_children`. NEVER to "Done" -- that requires PR merge.
6. `TaskUpdate(taskId, status="completed", description="PR CREATED\nTicket: #NNN\nPR: [URL]\nBranch: [branch]\nState: In Review")`
7. **CRITICAL**: Full result MUST be in task description -- lead cannot see your command output.
8. Return to task loop (step 1).
```

#### 4. Rename existing merge flow
**Rename the existing steps 4-7** under a "Merge Procedure" heading for clarity:

```markdown
## Merge Procedure

When task subject contains "Merge" or "Integrate":

1. Fetch issue: `get_issue(number)` — verify In Review state, find PR link in comments
2. Check PR readiness: `gh pr view [N] --json state,reviews,mergeable,statusCheckRollup`
   - If not ready: report status, keep task in_progress, go idle (will be re-checked)
3. If ready:
   a. Merge: `gh pr merge [N] --merge --delete-branch`
   b. Clean worktree: `scripts/remove-worktree.sh GH-NNN` (from git root)
   c. Update state: `update_workflow_state(number, state="Done")` for each issue
   d. Advance parent: `advance_children(parentNumber=EPIC)` if epic member
   e. Post comment: merge completion summary
4. `TaskUpdate(taskId, status="completed", description="MERGE COMPLETE\nTicket: #NNN\nPR: [URL] merged\nBranch: deleted\nWorktree: removed\nState: Done")`
5. **CRITICAL**: Full result MUST be in task description — lead cannot see your command output.
6. Return to task loop (step 1). If no tasks, go idle.
```

#### 5. Update description in frontmatter
**Line 3**: Update description to include PR creation.

**Before**:
```yaml
description: Integration specialist - handles PR merge, worktree cleanup, and git operations for completed implementations
```

**After**:
```yaml
description: Integration specialist - handles PR creation, merge, worktree cleanup, and git operations for completed implementations
```

### Success Criteria

#### Automated Verification
- [ ] `grep "Create PR" plugin/ralph-hero/agents/ralph-integrator.md` matches in task matching and procedure
- [ ] `grep "gh pr create" plugin/ralph-hero/agents/ralph-integrator.md` matches in PR creation procedure
- [ ] `grep "Merge Procedure" plugin/ralph-hero/agents/ralph-integrator.md` matches

#### Manual Verification
- [ ] Integrator claims "Create PR" tasks from task list
- [ ] PR creation procedure includes push, gh pr create, state transitions
- [ ] Merge procedure remains unchanged functionally

---

## Phase 3: Update Builder and Templates -- Point to Integrator

### Overview

Update the builder agent, implementer spawn template, and integrator spawn template to reference the integrator instead of the team-lead for PR creation handoff.

### Changes Required

#### 1. Update builder handoff
**File**: [`plugin/ralph-hero/agents/ralph-builder.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-builder.md)

**Line 22**: Change handoff target from team-lead to integrator.

**Before**:
```markdown
6. Repeat from step 1. If no tasks, SendMessage `team-lead` that implementation is complete (lead handles PR creation).
```

**After**:
```markdown
6. Repeat from step 1. If no tasks, SendMessage `team-lead` that implementation is complete (integrator handles PR creation).
```

**Line 30**: Update "DO NOT push" instruction.

**Before**:
```markdown
- DO NOT push to remote for implementation — lead handles PR creation.
```

**After**:
```markdown
- DO NOT push to remote for implementation — integrator handles PR creation.
```

#### 2. Update implementer spawn template
**File**: [`plugin/ralph-hero/templates/spawn/implementer.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/implementer.md)

**Line 7**: Change reference from lead to integrator.

**Before**:
```markdown
DO NOT push to remote. The lead handles pushing and PR creation.
```

**After**:
```markdown
DO NOT push to remote. The integrator handles pushing and PR creation.
```

#### 3. Update integrator spawn template
**File**: [`plugin/ralph-hero/templates/spawn/integrator.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/templates/spawn/integrator.md)

**Add "Create PR" awareness**. The template is used when spawning the integrator for any integration task. Update to handle both PR creation and merge tasks.

**Before**:
```markdown
Merge PR for #{ISSUE_NUMBER}: {TITLE}.

Check PR status and merge if ready per your agent definition.
Report results. Then check TaskList for more integration tasks.
```

**After**:
```markdown
Integration task for GH-{ISSUE_NUMBER}: {TITLE}.

Check your task subject to determine the operation (Create PR or Merge PR).
Follow the corresponding procedure in your agent definition.
Report results. Then check TaskList for more integration tasks.
```

### Success Criteria

#### Automated Verification
- [ ] `grep "lead handles PR" plugin/ralph-hero/agents/ralph-builder.md` returns 0 matches
- [ ] `grep "integrator handles PR" plugin/ralph-hero/agents/ralph-builder.md` returns matches
- [ ] `grep "lead handles" plugin/ralph-hero/templates/spawn/implementer.md` returns 0 matches
- [ ] `grep "integrator handles" plugin/ralph-hero/templates/spawn/implementer.md` returns matches
- [ ] `grep "Create PR" plugin/ralph-hero/templates/spawn/integrator.md` returns matches

#### Manual Verification
- [ ] Builder agent no longer references lead for PR creation
- [ ] Implementer template no longer references lead
- [ ] Integrator template handles both Create PR and Merge PR scenarios

---

## Phase 4: Update Conventions -- Pipeline Handoff Protocol

### Overview

Update the Pipeline Handoff Protocol table in conventions.md to route builder (impl done) to integrator instead of team-lead.

### Changes Required

#### 1. Update pipeline handoff table
**File**: [`plugin/ralph-hero/skills/shared/conventions.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md)

**Line 101**: Change handoff target.

**Before**:
```markdown
| `ralph-builder` (impl done) | Lead (PR creation) | `team-lead` |
```

**After**:
```markdown
| `ralph-builder` (impl done) | Integrator (PR creation) | `ralph-integrator` |
```

### Success Criteria

#### Automated Verification
- [ ] `grep "Lead (PR creation)" plugin/ralph-hero/skills/shared/conventions.md` returns 0 matches
- [ ] `grep "Integrator (PR creation)" plugin/ralph-hero/skills/shared/conventions.md` returns matches

#### Manual Verification
- [ ] Pipeline Handoff Protocol table correctly routes builder -> integrator for impl completion

---

## Testing Strategy

Since all changes are to markdown instruction files, testing is verification-based:

1. **Grep checks**: Verify old patterns are gone and new patterns exist across all 6 files
2. **No broken references**: Ensure Section 4.5 removal doesn't leave dangling references in SKILL.md
3. **Section numbering**: Verify SKILL.md sections renumber correctly (4.6 Shutdown -> 4.5 Shutdown)
4. **Spawn table consistency**: Verify SKILL.md spawn table and conventions.md pipeline table are consistent
5. **No TypeScript/test changes needed**: All changes are markdown-only

## References

- [Issue #69](https://github.com/cdubiel08/ralph-hero/issues/69)
- [Research: GH-69](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-18-GH-0069-move-pr-creation-to-integrator.md)
- [SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-team/SKILL.md)
- [ralph-integrator.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-integrator.md)
- [ralph-builder.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-builder.md)
- [conventions.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/conventions.md)
