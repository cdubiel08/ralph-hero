---
date: 2026-02-17
github_issue: 48
github_url: https://github.com/cdubiel08/ralph-hero/issues/48
status: complete
type: research
---

# Integrator Worker Agent Definition - Research Findings

## Problem Statement

Issue #48 requires creating an entirely new Integrator worker agent (`ralph-integrator.md`) that handles merge, deploy, and git operations. Unlike the other three workers (#45-#47) which consolidate existing agents, the Integrator is **new** -- it extracts responsibilities currently split between the team lead (PR creation) and the human operator (merge, worktree cleanup).

## Current State Analysis

### Where PR/Merge Logic Lives Today

**1. ralph-team SKILL.md -- Section 4.5 (Lead Creates PR)**

The team lead currently handles PR creation after implementation completes:
- Single issue: `git push -u origin feature/GH-NNN` from worktree, `gh pr create` with `Closes #NNN`
- Group: Push from `worktrees/GH-[PRIMARY]`, body lists all `Closes #NNN` entries
- After PR: moves all issues to "In Review" via `advance_children`
- Lead NEVER moves to "Done" -- that requires PR merge (external event)

**2. ralph-impl SKILL.md -- Step 9 (Create PR, Final Phase Only)**

The implementer creates PRs after all phases complete:
- `gh pr create --title "[Title]" --body "..."` with `Closes #NNN` for each issue
- Epic-aware: checks sibling completion before PR
- After PR: moves issues to "In Review" via `__COMPLETE__` intent on `ralph_impl` command

**3. Human operations (currently manual)**:
- PR merge after review approval
- Worktree cleanup after merge (`scripts/remove-worktree.sh`)
- Branch cleanup (delete merged feature branches)
- Version tagging (if applicable)

### State Machine Context

Per #44 research:
- Integrator owns: In Review (for merge operations only)
- State range: In Review -> Done
- Terminal state: Done (no further processing)
- Serialized: only one Integrator operates at a time on main branch

### Relevant MCP Tools

From `issue-tools.ts` and `relationship-tools.ts`:
- `get_issue` -- check issue state and PR links
- `update_workflow_state` -- move to Done
- `create_comment` -- post merge completion comment
- `advance_children` -- update parent epic when children complete
- `list_sub_issues` -- check sibling status for epic completion

### Git Operations Available

Via Bash tool:
- `gh pr view [number] --json state,reviews,mergeable` -- check PR readiness
- `gh pr merge [number] --merge --delete-branch` -- merge PR and clean up branch
- `gh pr list --state merged` -- find recently merged PRs
- `git worktree remove [path]` or `scripts/remove-worktree.sh [ID]` -- clean up worktree
- `git tag v1.2.3 && git push origin v1.2.3` -- version tagging (future)

## Key Discoveries

### 1. Two Distinct Responsibilities to Absorb

The Integrator absorbs two currently separate responsibilities:

**A. PR Creation** (currently: team lead in ralph-team, or implementer in ralph-impl)
- Push branch to remote
- Create PR with proper body (Closes #NNN, change summary, test plan)
- Move issues from In Progress -> In Review

**B. PR Merge + Cleanup** (currently: human manual)
- Verify PR is approved (has review approval, CI passes)
- Merge PR
- Clean up worktree
- Clean up remote branch
- Move issues from In Review -> Done
- Advance parent epic if applicable

### 2. Serialization Constraint

The Integrator MUST be serialized on main branch. Reasons:
- Merges can create conflicts if concurrent
- `advance_children` on parent epics must be atomic
- Version tagging must be sequential

**Enforcement mechanism**: The orchestrator spawns only 1 Integrator. The agent definition should document this constraint but doesn't need to enforce it (orchestrator's responsibility).

### 3. PR Readiness Detection

Before merging, the Integrator must verify:

| Check | Command | Criteria |
|-------|---------|----------|
| PR exists | `gh pr list --head feature/GH-NNN` | PR found |
| PR approved | `gh pr view N --json reviews` | At least 1 approved review |
| CI passes | `gh pr view N --json statusCheckRollup` | All checks pass (or no required checks) |
| Mergeable | `gh pr view N --json mergeable` | No merge conflicts |

If any check fails, the Integrator should wait (not escalate immediately). If blocked for extended time, escalate to Human Needed.

### 4. Tool Requirements

The Integrator needs a focused toolset:

**Required**:
- Bash (git operations, gh CLI, worktree cleanup)
- Read, Glob (read plan documents, check worktree state)
- TaskList, TaskGet, TaskUpdate, SendMessage (team coordination)
- MCP: get_issue, list_issues, update_issue, update_workflow_state, create_comment, advance_children, list_sub_issues

**Not needed**:
- Write, Edit (no document creation or code changes)
- Grep (no codebase searching)
- Skill (no skill invocations -- Integrator operates directly)
- Task (no subagent spawning)

### 5. Model Selection

The Integrator performs straightforward operations (merge, cleanup, state updates). It does NOT require deep reasoning like plan review or research synthesis.

**Recommendation**: `sonnet` model. Operations are procedural, not analytical. This saves cost while maintaining reliability.

### 6. Task Loop Pattern

The Integrator's task loop:

```
1. TaskList() -- find tasks with "PR" or "Merge" or "Integrate" in subject, pending, empty blockedBy, no owner
2. Claim lowest-ID match: TaskUpdate(taskId, status="in_progress", owner="integrator")
3. TaskGet(taskId) -- extract issue number and operation type from description

4. If task is "Create PR":
   a. Find worktree: GIT_ROOT/worktrees/GH-NNN
   b. Push branch: git push -u origin feature/GH-NNN
   c. Create PR: gh pr create --title "..." --body "..."
   d. Move issues to In Review: update_workflow_state(state="__COMPLETE__", command="ralph_impl")
   e. Post comment with PR link

5. If task is "Merge PR":
   a. Find PR: gh pr list --head feature/GH-NNN
   b. Verify readiness (approved, CI pass, mergeable)
   c. If not ready: wait/report, keep task in_progress
   d. If ready: gh pr merge N --merge --delete-branch
   e. Clean up worktree: scripts/remove-worktree.sh GH-NNN
   f. Move issues to Done: update_workflow_state(state="Done", command="ralph_impl")
   g. Advance parent: advance_children(parentNumber=EPIC)
   h. Post completion comment

6. TaskUpdate(taskId, status="completed", description="INTEGRATION COMPLETE\nTicket: #NNN\nPR: [URL]\nAction: [created/merged]\nBranch: [cleaned up]\nWorktree: [removed]")
7. Repeat from step 1. If no tasks, go idle.
```

### 7. Spawn Template

New template needed: `integrator.md`

```
{TASK_TYPE} #{ISSUE_NUMBER}: {TITLE}.

Check PR status and perform git operations per your agent definition.
Report results. Then check TaskList for more integration tasks.
```

Alternatively, since the Integrator has two modes (PR creation and PR merge), the template could be simpler:

```
Integrate #{ISSUE_NUMBER}: {TITLE}.

Invoke git operations per your agent definition.
Report results. Then check TaskList for more integration tasks.
```

### 8. State Transition Authority

The Integrator needs authority for these state transitions:

| Transition | Command | When |
|-----------|---------|------|
| In Progress -> In Review | `ralph_impl` | After PR creation |
| In Review -> Done | `ralph_impl` or new `ralph_integrate` | After PR merge |

**Decision point**: Should there be a new `ralph_integrate` command in the state machine, or reuse `ralph_impl`?

**Recommendation**: Reuse `ralph_impl` initially. Adding a new command requires updating `ralph-state-machine.json`, the `__COMPLETE__` intent resolver, and all state gate hooks. This can be done in a future issue if needed. The Integrator can use `state="Done"` directly (terminal states don't need intent resolution).

### 9. Relationship to Current PR Creation in ralph-impl

Today, `ralph-impl` Step 9 creates PRs. With the Integrator:

**Option A**: Remove PR creation from ralph-impl, Integrator creates all PRs
- Pro: Clean separation of concerns
- Con: Requires modifying ralph-impl skill (out of scope per issue #48)

**Option B**: Keep PR creation in ralph-impl, Integrator only handles merge
- Pro: No skill modifications needed
- Con: PR creation split between two agents

**Option C**: Integrator handles PR creation AND merge, ralph-impl stops at "push branch"
- Pro: All git-to-remote operations in one place
- Con: Requires ralph-impl modification (out of scope)

**Recommendation**: Option B for now (Integrator handles merge only). PR creation stays where it is (ralph-impl or team lead). The Integrator's primary new value is automating the merge/cleanup that's currently manual. Option A/C can be pursued in a future issue.

## Recommended Agent Definition Structure

```yaml
---
name: ralph-integrator
description: Integration specialist - handles PR merge, worktree cleanup, and git operations for completed implementations
tools: Read, Glob, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__get_issue, ralph_hero__list_issues, ralph_hero__update_issue, ralph_hero__update_workflow_state, ralph_hero__create_comment, ralph_hero__advance_children, ralph_hero__list_sub_issues
model: sonnet
color: green
---
```

**Worker loop pseudocode** (merge-focused, Option B):
```
1. TaskList() -- find tasks with "Merge" or "Integrate" in subject, pending, empty blockedBy, no owner
2. Claim lowest-ID match: TaskUpdate(taskId, status="in_progress", owner="integrator")
3. TaskGet(taskId) -- extract issue number from description
4. Fetch issue: get_issue(number) -- verify In Review state, find PR link in comments
5. Check PR readiness:
   - gh pr view [N] --json state,reviews,mergeable,statusCheckRollup
   - If not ready: report status, keep task in_progress, go idle (will be re-checked)
6. If ready:
   a. Merge: gh pr merge [N] --merge --delete-branch
   b. Clean worktree: GIT_ROOT=$(git rev-parse --show-toplevel) && scripts/remove-worktree.sh GH-NNN
   c. Update state: update_workflow_state(state="Done", command="ralph_impl") for each issue
   d. Advance parent: advance_children(parentNumber=EPIC) if epic member
   e. Post comment: "## Merged\n\nPR merged and branch cleaned up. Worktree removed."
7. TaskUpdate(taskId, status="completed", description="MERGE COMPLETE\nTicket: #NNN\nPR: [URL] merged\nBranch: deleted\nWorktree: removed\nState: Done")
8. CRITICAL: Full result MUST be in task description.
9. Repeat from step 1. If no tasks, go idle.
```

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Merge conflicts on main | Medium | Integrator escalates to Human Needed with conflicted file list |
| PR not approved (stalled in review) | Low | Integrator checks periodically; doesn't block pipeline for other issues |
| Worktree cleanup fails (locked files, active processes) | Low | Retry once, then report. Worktree can be manually cleaned later. |
| advance_children race condition (two Integrators) | Medium | Serialization enforced by orchestrator (max 1 Integrator) |
| No existing skills to compose (unlike other workers) | Low | Integrator operates directly via Bash/gh CLI. Simpler than skill composition. |

## Comparison: Integrator vs Other Workers

| Aspect | Analyst | Builder | Validator | **Integrator** |
|--------|---------|---------|-----------|---------------|
| Skills composed | triage, split, research | plan, impl, review | review | **None (direct git ops)** |
| State range | Backlog -> Ready for Plan | Ready for Plan -> In Review | Observes Plan in Review, In Review | **In Review -> Done** |
| Max parallel | 3 | 3 | 1 | **1 (serialized)** |
| Model | sonnet | opus | opus | **sonnet** |
| Worktree access | None | Read/write | Read-only | **Cleanup only** |
| Branch | main | worktree branch | main | **main** |
| Novel? | Merges 2 agents | Merges 2 agents | Replaces 1 agent | **Entirely new** |

## Recommended Next Steps

1. Create `plugin/ralph-hero/agents/ralph-integrator.md` following the structure above
2. Create `plugin/ralph-hero/templates/spawn/integrator.md` spawn template
3. Document serialization constraint in agent definition
4. In #49: update orchestrator to spawn Integrator after implementation completes
5. Future: add `ralph_integrate` command to state machine for cleaner separation
6. Future: extract PR creation from ralph-impl into Integrator (Option A/C)
